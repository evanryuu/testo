import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RecordingService } from '../src/main/recording.js';
import { io } from 'socket.io-client';
import { BrowserProfileService, type StoredProfile } from '../src/main/browser-profiles.js';
import { captureChromeSession, connectChrome, createChromeBridge, readChromeProfileCatalog, type ChromeTarget } from '../src/recording/chrome-bridge.js';
import type { ChromeProfileCatalog, ChromeProfileInfo } from '../src/shared/browser.js';

const origin = 'https://example.test';
function catalog(token = 'paired-token', installation = 'profile-A'): ChromeProfileCatalog {
  return { version: 1, connectionToken: token, profileInstallationId: installation, name: 'Work Chrome', tabs: [{ tabId: '42', windowId: 5, index: 0, title: 'Target', url: origin + '/target', active: false }] };
}
function target(): ChromeTarget {
  return { tabId: '42', origin, sessionToken: 'session-A', profile: { connectorId: 'connector-A', port: 13766, connectionToken: 'paired-token', profileInstallationId: 'profile-A' } };
}
function fakeAgent(value: unknown = catalog()) {
  const calls: string[] = [];
  const agent = {
    getBrowserTabList: async () => value,
    setActiveTabId: async (id: string) => { calls.push('select:' + id); },
    destroy: async () => { calls.push('destroy'); },
    interface: {
      connectCurrentTab: async () => { calls.push('fallback'); throw new Error('Must never use current tab'); },
      url: async () => origin + '/target', getActiveTabId: async () => 42,
      evaluateJavaScript: async (expression: string) => {
        calls.push(expression);
        return { result: { value: expression.includes('setItem') ? 'true' : JSON.stringify('session-A') } };
      },
    },
  } as unknown as ReturnType<typeof createChromeBridge>;
  return { agent, calls };
}

test('bound profile validates installation and pairing before selecting duplicate cross-profile tab IDs', async () => {
  for (const value of [catalog('wrong-token'), catalog('paired-token', 'profile-B'), { ...catalog(), tabs: [] }, { ...catalog(), tabs: [{ ...catalog().tabs[0]!, url: 'https://other.test/' }] }]) {
    const { agent, calls } = fakeAgent(value);
    await assert.rejects(connectChrome(agent, origin, target()), /配对|不同的 Chrome|已关闭或离开/);
    assert.deepEqual(calls, [], 'identity and tab validation must happen before selecting any tab');
  }
  const { agent, calls } = fakeAgent();
  const result = await connectChrome(agent, origin, target());
  assert.deepEqual(result.profile, target().profile);
  assert.equal(calls[0], 'select:42');
  assert.ok(!calls.includes('fallback'));
});

test('unreadable catalog and duplicate IDs cannot fall back to an active tab', async () => {
  for (const value of [[], null, { ...catalog(), tabs: [catalog().tabs[0], catalog().tabs[0]] }]) {
    const { agent, calls } = fakeAgent(value);
    await assert.rejects(readChromeProfileCatalog(agent, target().profile!), /无法读取|重复/);
    await assert.rejects(connectChrome(agent, origin, target()));
    assert.deepEqual(calls, []);
  }
  const { agent, calls } = fakeAgent();
  agent.getBrowserTabList = async () => { throw new Error('catalog unavailable'); };
  await assert.rejects(connectChrome(agent, origin, target()), /catalog unavailable/);
  assert.deepEqual(calls, []);
});

test('capture keeps profile binding and writes a fresh confirmation token without navigating', async () => {
  const { agent, calls } = fakeAgent();
  const result = await captureChromeSession(origin, { ...target(), sessionToken: undefined }, agent);
  assert.deepEqual(result.profile, target().profile);
  assert.ok(result.sessionToken);
  assert.notEqual(result.sessionToken, 'session-A');
  assert.equal(calls[0], 'select:42');
  assert.ok(calls.some(call => call.includes('__testing_workspace_bridge_session') && call.includes(result.sessionToken!)));
  assert.ok(!calls.includes('destroy'), 'the service owns this connection and releases it after capture');
});

test('legacy targets still bind exact tabs without requiring Testo profile metadata', async () => {
  const { agent, calls } = fakeAgent(null);
  const legacy = { tabId: '42', origin, sessionToken: 'session-A' };
  assert.deepEqual(await connectChrome(agent, origin, legacy), { tabId: '42', origin });
  assert.equal(calls[0], 'select:42');
});

async function assertPortReleased(port: number) {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
function paired(info: ChromeProfileInfo) {
  const url = new URL(info.pairingCode);
  return { port: Number(url.searchParams.get('port')), token: url.searchParams.get('token')! };
}

test('profiles allocate isolated ports and pairings; cancellation and removal release owned resources', { timeout: 15_000 }, async () => {
  const service = new BrowserProfileService();
  try {
    const first = await service.create(), second = await service.create();
    assert.notEqual(paired(first).port, paired(second).port);
    assert.notEqual(paired(first).token, paired(second).token);
    assert.match(paired(first).token, /^[A-Za-z0-9_-]{16,256}$/);
    first.name = 'modified clone'; assert.notEqual(service.list()[0]!.name, first.name);
    const pending = assert.rejects(service.refresh(first.id), /已取消/);
    assert.equal(service.busy, true);
    assert.throws(() => service.remove(second.id), /正在连接/);
    await assert.rejects(service.create(), /正在连接/);
    service.cancel(); await pending;
    assert.equal(service.busy, false);
    assert.equal(service.list()[0]!.status, 'disconnected');
    await assertPortReleased(paired(first).port);
    service.remove(first.id);
    assert.deepEqual(service.list().map(profile => profile.id), [second.id]);
    await assert.rejects(service.focus(second.id, '42'), /先刷新/);
  } finally { await service.destroy(); }
  await assert.rejects(service.create(), /已关闭/);
});

// Exercise actual disposable SDK servers and IPC. This simulates only the extension
// transport; real Chrome enumeration/focus is covered by the connector integration.
test('worker refresh pins profile identity and releases the port between operations', { timeout: 35_000 }, async () => {
  const service = new BrowserProfileService();
  const info = await service.create(), pairing = paired(info);
  let current = catalog(pairing.token), selected: unknown[] = [];
  let simulateUnresponsive = false, simulateError = false;
  const socket = io(`http://127.0.0.1:${pairing.port}`, { transports: ['websocket'], query: { version: '1.12.4' }, reconnectionDelay: 50, reconnectionDelayMax: 100 });
  socket.on('bridge-call', (call: { id: string; method: string; args: unknown[] }) => {
    if (simulateUnresponsive) return;
    if (simulateError && call.method === 'getBrowserTabList') {
      socket.emit('bridge-call-response', { id: call.id, error: 'Bad configuration ' + pairing.token }); return;
    }
    let response: unknown;
    if (call.method === 'getBrowserTabList') response = current;
    else if (call.method === 'setActiveTabId') selected.push(call.args[0]);
    else if (call.method === 'url') response = origin + '/target';
    else if (call.method === 'getActiveTabId') response = 42;
    else if (call.method === 'evaluateJavaScript') response = { result: { value: 'true' } };
    socket.emit('bridge-call-response', { id: call.id, response });
  });
  // Socket.IO does not retry server-requested disconnects automatically.
  socket.on('disconnect', () => { if (socket.active === false) socket.connect(); });
  try {
    const ready = await service.refresh(info.id);
    assert.equal(ready.profileInstallationId, 'profile-A');
    assert.equal(ready.status, 'ready');
    await assertPortReleased(pairing.port);
    await service.focus(info.id, '42');
    assert.deepEqual(selected, [42]);
    await assertPortReleased(pairing.port);
    current = catalog(pairing.token, 'profile-B');
    await assert.rejects(service.focus(info.id, '42'), /不同的 Chrome/);
    await assert.rejects(service.refresh(info.id), /不同的 Chrome/);
    assert.deepEqual(selected, [42], 'same tab ID in another profile must not receive focus');
    assert.equal(service.list()[0]!.profileInstallationId, 'profile-A');
    await assertPortReleased(pairing.port);
    current = catalog('wrong-pairing-token');
    await assert.rejects(service.refresh(info.id), /配对码不匹配/);
    assert.deepEqual(selected, [42]);
    current = catalog(pairing.token);
    const captured = await service.capture(info.id, '42', origin);
    assert.equal(captured.target.profile?.connectorId, info.id);
    assert.equal(captured.target.profile?.profileInstallationId, 'profile-A');
    assert.equal(captured.target.profile?.port, pairing.port);
    assert.ok(captured.target.sessionToken);
    await assertPortReleased(pairing.port);
    simulateError = true;
    await assert.rejects(service.refresh(info.id), error => {
      assert.ok(error instanceof Error); assert.ok(!error.message.includes(pairing.token)); return true;
    });
    assert.ok(!service.list()[0]!.error?.includes(pairing.token));
    simulateError = false; simulateUnresponsive = true;
    const hanging = assert.rejects(service.refresh(info.id), /已取消/);
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Test transport did not reconnect')), 5000);
      socket.once('connect', () => { clearTimeout(timeout); resolve(); });
    });
    service.cancel(); await hanging;
    assert.equal(service.busy, false);
    await assertPortReleased(pairing.port);
    service.remove(info.id); assert.deepEqual(service.list(), []);
  } finally { socket.removeAllListeners(); socket.disconnect(); await service.destroy(); }
});


test('trusted pairings survive service restart without restoring stale tabs or readiness', async () => {
  let saved: StoredProfile[] = [{ id: 'persisted-profile', name: 'Work Chrome', port: 13788, token: 'paired-token-0123456789', profileInstallationId: 'profile-A' }];
  const persistence = { load: () => structuredClone(saved), save: (entries: StoredProfile[]) => { saved = structuredClone(entries); } };
  const first = new BrowserProfileService(() => {}, persistence);
  assert.equal(first.list()[0]!.profileInstallationId, 'profile-A');
  assert.equal(first.list()[0]!.status, 'unconnected');
  assert.deepEqual(first.list()[0]!.tabs, []);
  const created = await first.create();
  assert.equal(saved.length, 2);
  assert.ok(saved.every(entry => !('tabs' in entry) && !('status' in entry) && !('sessionToken' in entry)));
  await first.destroy();
  const second = new BrowserProfileService(() => {}, persistence);
  assert.deepEqual(second.list().map(info => info.id), ['persisted-profile', created.id]);
  assert.ok(second.list().every(info => info.status === 'unconnected' && info.tabs.length === 0));
  assert.equal(paired(second.list()[1]!).token, paired(created).token);
  second.remove(created.id); assert.equal(saved.length, 1);
  await second.destroy();
});

test('invalid or duplicate stored identities cannot silently open a connector', () => {
  const valid = { id: 'p', name: 'Chrome', port: 13788, token: 'paired-token-0123456789' };
  for (const profiles of [[{ ...valid, port: 0 }], [valid, valid], [{ ...valid, token: 'bad' }], [valid, { ...valid, id: 'other' }]]) {
    assert.throws(() => new BrowserProfileService(() => {}, { load: () => profiles, save() {} }), /配对信息无效/);
  }
});


test('recording and retry reconnect the selected profile/tab even when another tab is active', { timeout: 25000 }, async () => {
  const profiles = new BrowserProfileService();
  const info = await profiles.create(), pairing = paired(info);
  const selected: unknown[] = [];
  let unexpectedActiveConnection = false;
  const socket = io(`http://127.0.0.1:${pairing.port}`, { transports: ['websocket'], query: { version: '1.12.4' }, reconnectionDelay: 50, reconnectionDelayMax: 100 });
  socket.on('bridge-call', (call: { id: string; method: string; args: unknown[] }) => {
    let response: unknown;
    if (call.method === 'getBrowserTabList') response = { ...catalog(pairing.token), tabs: [...catalog(pairing.token).tabs, { tabId: '99', windowId: 5, index: 1, title: 'Same website, different tab', url: origin + '/other', active: true }] };
    else if (call.method === 'setActiveTabId') selected.push(call.args[0]);
    else if (call.method === 'url') response = origin + '/target';
    else if (call.method === 'getActiveTabId') response = 42;
    else if (call.method === 'connectCurrentTab') unexpectedActiveConnection = true;
    socket.emit('bridge-call-response', { id: call.id, response });
  });
  socket.on('disconnect', () => { if (socket.active === false) socket.connect(); });
  const recording = new RecordingService(mkdtempSync(path.join(tmpdir(), 'selected-recording-')), () => {});
  const target = { tabId: '42', origin, profile: { connectorId: info.id, port: pairing.port, connectionToken: pairing.token, profileInstallationId: 'profile-A' } };
  try {
    const id = await recording.start({ projectId: 'p', caseId: 'c', workflowId: 'w', caseName: 'Same website tab', environmentId: 'local', baseUrl: origin, browserMode: 'bridge', chromeTarget: target, revision: 'r' });
    assert.equal(recording.draft!.status, 'ready');
    assert.deepEqual(recording.draft!.chromeTarget, target);
    await recording.retry(id);
    assert.deepEqual(selected.map(String), ['42', '42']);
    assert.equal(unexpectedActiveConnection, false);
    assert.deepEqual(recording.draft!.chromeTarget, target);
  } finally {
    await recording.shutdown(); socket.removeAllListeners(); socket.disconnect(); await profiles.destroy();
  }
});


test('profile connection errors name the selected connector and redact pairing tokens', async () => {
  const { agent } = fakeAgent();
  agent.getBrowserTabList = async () => { throw new Error('Transport rejected paired-token'); };
  await assert.rejects(connectChrome(agent, origin, target()), error => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /Testo/);
    assert.doesNotMatch(error.message, /paired-token|Midscene 扩展/);
    return true;
  });
});
