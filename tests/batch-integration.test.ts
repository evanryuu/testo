import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { build } from 'esbuild';
import stdlib from 'node-stdlib-browser';
import { findAvailablePort } from '@midscene/shared/node';
import { expect } from '@playwright/test';
import { _electron as electron, chromium, type BrowserContext, type ElectronApplication, type Page } from 'playwright';
import { parse, stringify } from 'yaml';
import type { BatchInput, BatchRun } from '../src/shared/workspace.js';

test('desktop batches reuse confirmed Chrome sessions, isolate results, enforce failure policy and restore history', { timeout: 180_000 }, async () => {
  const root = process.cwd();
  mkdirSync('artifacts', { recursive: true });
  const dir = mkdtempSync(path.resolve('artifacts/batch-integration-'));
  const bridgePort = await findAvailablePort(15966, 100);
  const ext = path.join(dir, 'extension'); mkdirSync(ext);
  writeFileSync(path.join(ext, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'Workspace batch verification', version: '1.0', permissions: ['tabs', 'debugger'], host_permissions: ['http://127.0.0.1/*'], background: { service_worker: 'background.js' } }));
  writeFileSync(path.join(ext, 'background.js'), 'chrome.runtime.onInstalled.addListener(() => {});');
  writeFileSync(path.join(ext, 'index.html'), '<script src="bridge.js"></script>');
  const bundle = { bundle: true, platform: 'browser' as const, format: 'iife' as const, alias: Object.fromEntries(Object.entries({ ...stdlib, 'node:fs/promises': stdlib.fs, 'fs/promises': stdlib.fs }).map(([key, value]) => [key, value.replace('/esm/mock/empty.js', '/cjs/mock/empty.js')])), inject: [path.join(root, 'node_modules/node-stdlib-browser/helpers/esbuild/shim.js')] };
  // Match the official background connector: retry every three seconds only after disconnection.
  const autoConnector = `
window.startAutoBridge = (url) => {
  let current = null, connecting = false;
  window.autoBridgeConnections = 0;
  const connect = async () => {
    if (current || connecting) return;
    connecting = true;
    const bridge = new ExtensionBridgePageBrowserSide(url, () => { if (current === bridge) current = null; }, () => {}, false, async () => true);
    try {
      await bridge.connect();
      current = bridge;
      window.autoBridgeConnections++;
    } catch {
      await bridge.destroy().catch(() => {});
    } finally {
      connecting = false;
    }
  };
  window.autoBridgeTimer = setInterval(() => { void connect(); }, 3000);
  void connect();
};
`;
  await build({ ...bundle, stdin: { contents: readFileSync('tests/fixtures/chrome-bridge-extension.js', 'utf8') + autoConnector, resolveDir: root, sourcefile: 'batch-auto-connector.js' }, outfile: path.join(ext, 'bridge.js') });
  mkdirSync(path.join(ext, 'scripts'));
  await build({ ...bundle, entryPoints: ['node_modules/@midscene/shared/dist/es/extractor/index.mjs'], globalName: 'midscene_element_inspector', outfile: path.join(ext, 'scripts/htmlElement.js') });
  writeFileSync(path.join(ext, 'scripts/stop-water-flow.js'), 'void 0;');
  const hits: { action: string; who: string; cookie: string; clickId: string; method: string }[] = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url!, 'http://local.test');
    if (url.pathname === '/hit') {
      hits.push({ action: url.searchParams.get('action')!, who: url.searchParams.get('who')!, cookie: request.headers.cookie ?? '', clickId: url.searchParams.get('click')!, method: request.method! });
      response.end('ok'); return;
    }
    response.setHeader('Content-Type', 'text/html');
    response.end(`<!doctype html><button style="position:absolute;left:20px;top:20px;width:120px;height:50px" onclick="send('A')">Action A</button><button style="position:absolute;left:200px;top:20px;width:120px;height:50px" onclick="send('B')">Action B</button><p id="result" style="position:absolute;top:100px">Ready</p><script>function send(action){const click=Number(sessionStorage.getItem('clicks')||0)+1;sessionStorage.setItem('clicks',String(click));document.querySelector('#result').textContent='Sent '+action;fetch('/hit?action='+action+'&who='+sessionStorage.getItem('who')+'&click='+click,{method:'POST'})}</script>`);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const env = { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined && entry[0] !== 'ELECTRON_RUN_AS_NODE' && !entry[0].startsWith('MIDSCENE_MODEL') && !entry[0].startsWith('OPENAI_'))),
    WORKSPACE_DATA_DIR: path.join(dir, 'app'), WORKSPACE_PROJECTS_DIR: path.join(dir, 'projects'), WORKSPACE_BRIDGE_PORT: String(bridgePort) };
  let app: ElectronApplication | undefined, chrome: BrowserContext | undefined, ui: Page | undefined;
  try {
    chrome = await chromium.launchPersistentContext(path.join(dir, 'chrome'), { channel: 'chromium', executablePath: process.env.TEST_CHROME_EXECUTABLE, headless: false, viewport: null, args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`] });
    const sw = chrome.serviceWorkers()[0] ?? await chrome.waitForEvent('serviceworker');
    const extensionPage = await chrome.newPage();
    await extensionPage.goto(`chrome-extension://${new URL(sw.url()).host}/index.html`);
    const first = await chrome.newPage(); await first.goto(origin + '/first'); await first.bringToFront();
    await first.evaluate(() => { document.cookie = 'session=batch-fixture;path=/'; localStorage.setItem('loggedIn', 'yes'); sessionStorage.setItem('who', 'first'); });
    app = await electron.launch({ args: [root], env, timeout: 45_000 });
    ui = await app.firstWindow(); ui.setDefaultTimeout(15_000);
    const uiErrors: string[] = []; ui.on('pageerror', error => uiErrors.push(error.message));
    const refs = await ui.evaluate(async baseUrl => {
      const projectId = await window.workspace.createProject({ name: 'Batch integration', description: 'Local Chrome session checks' });
      let project = (await window.workspace.state()).projects.find(p => p.id === projectId)!;
      const environmentId = project.environments[0]!.id;
      await window.workspace.saveEnvironment({ projectId, id: environmentId, name: 'Local', baseUrl });
      const cases = [];
      for (const name of ['Action A', 'Action B', 'Expected failure', 'Cancelable wait']) {
        const caseId = await window.workspace.createCase({ projectId, name, suiteId: project.suites[0]!.id, platforms: ['web'] });
        project = (await window.workspace.state()).projects.find(p => p.id === projectId)!;
        cases.push({ caseId, workflowId: project.cases.find(c => c.id === caseId)!.workflows[0]!.id });
      }
      return { projectId, environmentId, cases };
    }, origin);
    for (let index = 0; index < refs.cases.length; index++) {
      const steps = index < 2 ? [
        { recordedAction: { actionType: 'Tap', payload: { x: index === 0 ? 70 : 250, y: 40 } } },
        { assertText: { text: index === 0 ? 'Sent A' : 'Sent B' } },
      ] : index === 2 ? [{ assertText: { text: 'Absent fixture text', timeoutMs: 200 } }] : [{ wait: { duration: 60, unit: 's' } }];
      const text = stringify({ cases: [{ name: 'Batch item ' + index, steps }], afterEach: [{ recordToReport: 'Batch cleanup evidence' }] });
      await ui.evaluate(async ({ ref, text }) => {
        const original = await window.workspace.workflow(ref);
        await window.workspace.saveWorkflow({ ...ref, text, revision: original.revision });
      }, { ref: { projectId: refs.projectId, ...refs.cases[index]! }, text });
    }
    await first.bringToFront();
    const capturingFirst = ui.evaluate(ref => window.workspace.captureSession(ref), { projectId: refs.projectId, environmentId: refs.environmentId, name: 'First window' });
    await expect.poll(async () => { try { await fetch(`http://127.0.0.1:${bridgePort}`); return true; } catch { return false; } }, { timeout: 15000 }).toBeTruthy();
    await extensionPage.evaluate(url => (window as any).startAutoBridge(url), `http://127.0.0.1:${bridgePort}`);
    const firstSession = await capturingFirst;
    assert.equal(first.url(), origin + '/first', 'confirming a session does not navigate');
    const tabId = await extensionPage.evaluate(async () => {
      const tabs = await (globalThis as any).chrome.tabs.query({});
      return tabs.find((tab: any) => tab.url?.endsWith('/first')).id;
    });
    const second = await chrome.newPage(); await second.goto(origin + '/second');
    await second.evaluate(() => sessionStorage.setItem('who', 'second')); await second.bringToFront();
    const capturingSecond = ui.evaluate(ref => window.workspace.captureSession(ref), { projectId: refs.projectId, environmentId: refs.environmentId, name: 'Second window' });
    const secondSession = await capturingSecond;
    assert.notEqual(firstSession, secondSession);
    assert.equal(second.url(), origin + '/second');
    await extensionPage.evaluate(async id => (globalThis as any).chrome.windows.create({ tabId: id }), tabId);
    const targets = await extensionPage.evaluate(async () => (await (globalThis as any).chrome.tabs.query({})).filter((tab: any) => /\/(first|second)$/.test(tab.url)).map((tab: any) => ({ url: tab.url, windowId: tab.windowId })));
    assert.equal(new Set(targets.map((target: any) => target.windowId)).size, 2);

    const groupIds = await ui.evaluate(async ({ projectId, cases }) => [
      await window.workspace.saveGroup({ projectId, name: 'Group A', description: 'First action', caseIds: [cases[0]!.caseId] }),
      await window.workspace.saveGroup({ projectId, name: 'Group B', description: 'Both actions', caseIds: [cases[0]!.caseId, cases[1]!.caseId] }),
    ], refs);
    const invalidGroups = await ui.evaluate(async ({ refs, sessionId }) => {
      const before = await window.workspace.state();
      const project = before.projects.find(p => p.id === refs.projectId)!;
      const empty = await window.workspace.saveGroup({ projectId: refs.projectId, name: 'Empty group', description: '', caseIds: [] });
      const noWorkflow = await window.workspace.createCase({ projectId: refs.projectId, name: 'Unrecorded case', suiteId: project.suites[0]!.id, platforms: ['web'] });
      const unready = await window.workspace.saveGroup({ projectId: refs.projectId, name: 'Unready group', description: '', caseIds: [noWorkflow] });
      const errors: string[] = [];
      for (const groupIds of [[], ['missing-group'], [empty], [unready]]) {
        try { await window.workspace.runGroups({ projectId: refs.projectId, environmentId: refs.environmentId, failurePolicy: 'stop', sessionId, groupIds }); errors.push(''); }
        catch (error) { errors.push(String(error)); }
      }
      try { await window.workspace.saveGroup({ projectId: refs.projectId, name: 'Missing case group', description: '', caseIds: ['missing-case'] }); errors.push(''); }
      catch (error) { errors.push(String(error)); }
      const after = await window.workspace.state();
      return { errors, beforeBatches: before.batches!.length, afterBatches: after.batches!.length, beforeRuns: before.runs.length, afterRuns: after.runs.length, activeBatchId: after.activeBatchId };
    }, { refs, sessionId: firstSession });
    assert.equal(invalidGroups.errors.length, 5);
    assert.ok(invalidGroups.errors.every(Boolean), 'empty, missing and unrecorded group references are rejected');
    assert.equal(invalidGroups.afterBatches, invalidGroups.beforeBatches, 'invalid groups cannot create an empty batch');
    assert.equal(invalidGroups.afterRuns, invalidGroups.beforeRuns);
    assert.equal(invalidGroups.activeBatchId, undefined);

    const completed: BatchRun[] = [];
    const runBatch = async (caseIndexes: number[], sessionIds: string[], failurePolicy: BatchInput['failurePolicy'], cancel = false, groupIds?: string[]) => {
      const input = { projectId: refs.projectId, environmentId: refs.environmentId, failurePolicy, items: caseIndexes.map((index, position) => ({ ...refs.cases[index]!, sessionId: sessionIds[position]! })) };
      const id = groupIds
        ? await ui!.evaluate(input => window.workspace.runGroups(input), { projectId: refs.projectId, environmentId: refs.environmentId, failurePolicy, sessionId: sessionIds[0]!, groupIds })
        : await ui!.evaluate(input => window.workspace.runBatch(input), input);
      if (!completed.length) {
        const rejected = await ui!.evaluate(async ref => Promise.all([
          window.workspace.startRecording({ ...ref, browserMode: 'bridge' }).then(() => '', error => String(error)),
          window.workspace.run({ ...ref, browserMode: 'bridge' }).then(() => '', error => String(error)),
          window.workspace.captureSession({ projectId: ref.projectId, environmentId: ref.environmentId, name: 'Conflicting session' }).then(() => '', error => String(error)),
        ]), { projectId: refs.projectId, environmentId: refs.environmentId, ...refs.cases[0]! });
        assert.ok(rejected.every(message => /结束|等待|运行/.test(message)), 'an active batch rejects competing recording, run and session capture');
      }
      const connected = new Set<string>();
      let cancelled = false;
      await expect.poll(async () => {
        const state = await ui!.evaluate(() => window.workspace.state());
        const batch = state.batches!.find(b => b.id === id)!;
        if (state.activeRunId) connected.add(state.activeRunId);
        if (cancel && !cancelled && state.activeRunId) {
          const detail = await ui!.evaluate(runId => window.workspace.runDetail({ runId }), state.activeRunId);
          if (detail.events.some(event => event.type === 'step-started' && event.node === 'wait')) {
            cancelled = true; await ui!.evaluate(id => window.workspace.cancelBatch({ id }), id);
          }
        }
        return batch.status;
      }, { timeout: 45_000, intervals: [100, 200, 300] }).not.toBe('running');
      const state = await ui!.evaluate(() => window.workspace.state());
      const batch = state.batches!.find(b => b.id === id)!;
      assert.equal(state.activeBatchId, undefined);
      assert.ok(batch.finishedAt);
      for (const item of batch.items) if (item.runId) {
        const run = state.runs.find(run => run.runId === item.runId)!;
        assert.equal(run.batchId, id); assert.equal(run.sessionName, item.sessionName);
        assert.equal(run.status, item.status); assert.ok(run.result);
        if (run.status === 'passed') assert.ok(run.result.reportPaths.length);
      }
      assert.equal(new Set(batch.items.flatMap(item => item.runId ? [item.runId] : [])).size, connected.size, 'each item has its own worker and run result');
      completed.push(batch); return batch;
    };

    const sameWindow = await runBatch([0, 1], [firstSession, firstSession], 'stop', false, groupIds);
    assert.equal(sameWindow.status, 'passed');
    assert.deepEqual(sameWindow.items.map(item => item.status), ['passed', 'passed']);
    assert.deepEqual(hits.map(hit => [hit.who, hit.action]), [['first', 'A'], ['first', 'B']], 'same-window items execute once and in order');
    const firstBatchGroups = [{ id: groupIds[0], name: 'Group A' }, { id: groupIds[1], name: 'Group B' }];
    assert.deepEqual(sameWindow.groups, firstBatchGroups);
    assert.deepEqual(sameWindow.items.map(item => ({ caseId: item.caseId, groupNames: item.groupNames })), [
      { caseId: refs.cases[0]!.caseId, groupNames: ['Group A', 'Group B'] },
      { caseId: refs.cases[1]!.caseId, groupNames: ['Group B'] },
    ], 'overlapping groups merge group references while executing each case once');
    await ui.evaluate(async ({ refs, groupId }) => {
      const original = (await window.workspace.state()).projects.find(project => project.id === refs.projectId)!.groups!.find(group => group.id === groupId)!;
      await window.workspace.saveGroup({ projectId: refs.projectId, id: original.id, revision: original.revision, name: 'Renamed Group A', description: 'Changed after running', caseIds: [refs.cases[1]!.caseId] });
    }, { refs, groupId: groupIds[0]! });
    const historicalGroupBatch = (await ui.evaluate(() => window.workspace.state())).batches!.find(batch => batch.id === sameWindow.id)!;
    assert.deepEqual(historicalGroupBatch, sameWindow, 'editing a group never changes a previous batch name or membership snapshot');
    await first.bringToFront();
    const separateWindows = await runBatch([0, 1], [secondSession, firstSession], 'stop');
    assert.equal(separateWindows.status, 'passed');
    assert.deepEqual(hits.slice(2).map(hit => [hit.who, hit.action]), [['second', 'A'], ['first', 'B']], 'saved bindings select their window rather than the foreground tab');

    const beforeFailure = hits.length;
    const stopped = await runBatch([2, 0], [firstSession, secondSession], 'stop');
    assert.deepEqual(stopped.items.map(item => item.status), ['failed', 'skipped']);
    assert.equal(hits.length, beforeFailure);
    const continued = await runBatch([2, 0], [firstSession, secondSession], 'continue');
    assert.equal(continued.status, 'failed');
    assert.deepEqual(continued.items.map(item => item.status), ['failed', 'passed']);
    assert.deepEqual(hits.slice(beforeFailure).map(hit => [hit.who, hit.action]), [['second', 'A']]);
    const beforeCancel = hits.length;
    const cancelled = await runBatch([3, 1], [firstSession, secondSession], 'continue', true);
    assert.equal(cancelled.status, 'cancelled');
    assert.deepEqual(cancelled.items.map(item => item.status), ['cancelled', 'skipped']);
    assert.equal(hits.length, beforeCancel, 'cancelled batches never launch later sends');
    assert.ok(hits.every(hit => hit.cookie.includes('session=batch-fixture') && hit.method === 'POST'));
    assert.equal(new Set(hits.map(hit => hit.who + ':' + hit.clickId)).size, hits.length, 'each sent request corresponds to a distinct browser click');
    for (const target of [first, second]) {
      assert.equal(target.isClosed(), false);
      assert.equal(await target.evaluate(() => localStorage.getItem('loggedIn')), 'yes');
      assert.match(await target.evaluate(() => document.cookie), /session=batch-fixture/);
    }
    const beforeRestart = await ui.evaluate(() => window.workspace.state());
    assert.equal(beforeRestart.runs.length, 8); assert.equal(beforeRestart.sessions!.length, 2);
    await app.close(); app = await electron.launch({ args: [root], env, timeout: 45_000 });
    ui = await app.firstWindow();
    const restored = await ui.evaluate(() => window.workspace.state());
    assert.deepEqual(restored.projects.find(project => project.id === refs.projectId)!.groups, beforeRestart.projects.find(project => project.id === refs.projectId)!.groups, 'group YAML definitions survive a restart');
    assert.equal(restored.projects.find(project => project.id === refs.projectId)!.groups!.find(group => group.id === groupIds[0])!.name, 'Renamed Group A');
    assert.equal(restored.sessions!.length, 0, 'live browser bindings do not survive application restart');
    assert.equal(restored.activeBatchId, undefined);
    assert.deepEqual(restored.batches, beforeRestart.batches);
    assert.equal(restored.runs.length, 8);
    assert.deepEqual(restored.runs.map(run => [run.runId, run.status, run.batchId]), beforeRestart.runs.map(run => [run.runId, run.status, run.batchId]));
    assert.equal(first.isClosed(), false); assert.equal(second.isClosed(), false);
    assert.deepEqual(uiErrors, []);
    const automaticConnections = await extensionPage.evaluate(() => (window as any).autoBridgeConnections);
    assert.equal(automaticConnections, 10, 'two session confirmations and eight runs reconnect automatically without per-run test assistance');
    writeFileSync(path.join(dir, 'observations.json'), JSON.stringify({ automaticConnections, invalidGroups, restoredGroups: restored.projects.find(project => project.id === refs.projectId)!.groups, targets, hits, batches: completed, restoredSessionCount: restored.sessions!.length, restoredRuns: restored.runs.length }, null, 2));
    console.log('Batch integration evidence:', dir);
  } catch (error) {
    writeFileSync(path.join(dir, 'failure-hits.json'), JSON.stringify(hits, null, 2));
    if (ui && !ui.isClosed()) {
      writeFileSync(path.join(dir, 'failure-state.json'), JSON.stringify(await ui.evaluate(() => window.workspace.state()).catch(() => null), null, 2));
      await ui.screenshot({ path: path.join(dir, 'failure.png') }).catch(() => {});
    }
    throw error;
  } finally {
    await app?.close(); await chrome?.close(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});


test('desktop connector batches freeze shared inputs and workflows, and retry the intended failed or dependent items', { timeout: 240_000 }, async () => {
  const root = process.cwd();
  mkdirSync('artifacts', { recursive: true });
  const dir = mkdtempSync(path.resolve('artifacts/batch-snapshots-'));
  const extension = path.resolve('dist-browser-extension');
  const hits: { action: string; name: string; who: string; accepted: boolean }[] = [];
  let allowDelete = false;
  const server = createServer((request, response) => {
    const url = new URL(request.url!, 'http://local.test');
    if (url.pathname === '/hit') {
      const action = url.searchParams.get('action')!, name = url.searchParams.get('name')!;
      const accepted = action !== 'delete' || allowDelete;
      hits.push({ action, name, who: url.searchParams.get('who')!, accepted });
      response.setHeader('Content-Type', 'application/json; charset=utf-8');
      response.end(JSON.stringify({ text: accepted ? `${name} ${action} completed` : 'Delete rejected by fixture' }));
      return;
    }
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(`<!doctype html><title>Knowledge base fixture</title>
      <input aria-label="Knowledge base name" style="position:absolute;left:20px;top:20px;width:350px;height:30px">
      <button data-testid="create" style="position:absolute;left:20px;top:80px;width:100px;height:40px" onclick="send('create')">Create</button>
      <button data-testid="delete" style="position:absolute;left:140px;top:80px;width:100px;height:40px" onclick="send('delete')">Delete</button>
      <button data-testid="after" style="position:absolute;left:260px;top:80px;width:100px;height:40px" onclick="send('after')">After</button>
      <p id="result" style="position:absolute;top:150px">Ready</p>
      <script>async function send(action){const query=new URLSearchParams({action,name:document.querySelector('input').value,who:sessionStorage.getItem('who')||'unknown'});const result=await fetch('/hit?'+query,{method:'POST'}).then(r=>r.json());document.querySelector('#result').textContent=result.text}</script>`);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const env = { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined && entry[0] !== 'ELECTRON_RUN_AS_NODE' && !entry[0].startsWith('MIDSCENE_MODEL') && !entry[0].startsWith('OPENAI_'))),
    WORKSPACE_DATA_DIR: path.join(dir, 'app'), WORKSPACE_PROJECTS_DIR: path.join(dir, 'projects') };
  let app: ElectronApplication | undefined, chrome: BrowserContext | undefined, ui: Page | undefined;
  const completed: BatchRun[] = [];
  const flow = { name: 'Fill shared knowledge base name', steps: [{ recordedAction: {
    actionType: 'Input', payload: { x: 70, y: 35, value: '${knowledgeBaseName}', mode: 'replace' },
    target: { tag: 'input', name: 'Knowledge base name' },
  } }] };
  try {
    chrome = await chromium.launchPersistentContext(path.join(dir, 'chrome'), {
      channel: 'chromium', executablePath: process.env.TEST_CHROME_EXECUTABLE, headless: false, viewport: null,
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    });
    const worker = chrome.serviceWorkers()[0] ?? await chrome.waitForEvent('serviceworker');
    const target = await chrome.newPage(); await target.goto(origin + '/target');
    await target.evaluate(() => sessionStorage.setItem('who', 'chosen-tab'));
    const other = await chrome.newPage(); await other.goto(origin + '/other');
    await other.evaluate(() => sessionStorage.setItem('who', 'other-tab'));
    app = await electron.launch({ args: [root], env, timeout: 45_000 });
    ui = await app.firstWindow(); ui.setDefaultTimeout(15000);
    const uiErrors: string[] = []; ui.on('pageerror', error => uiErrors.push(error.message));
    const refs = await ui.evaluate(async ({ baseUrl, flow }) => {
      const projectId = await window.workspace.createProject({ name: 'Batch snapshots', description: 'Real connector and runner checks' });
      let project = (await window.workspace.state()).projects.find(project => project.id === projectId)!;
      const environmentId = project.environments[0]!.id;
      await window.workspace.saveEnvironment({ projectId, id: environmentId, name: 'Local', baseUrl, variables: { knowledgeBaseName: 'environment default' } });
      await window.workspace.saveAssets({ projectId, revision: project.assets!.revision, variables: { knowledgeBaseName: 'project default' }, flows: { fillName: flow } });
      const cases = [];
      for (const name of ['Create knowledge base', 'Delete knowledge base', 'Continue after delete']) {
        const caseId = await window.workspace.createCase({ projectId, name, suiteId: project.suites[0]!.id, platforms: ['web'] });
        project = (await window.workspace.state()).projects.find(project => project.id === projectId)!;
        cases.push({ caseId, workflowId: project.cases.find(item => item.id === caseId)!.workflows[0]!.id });
      }
      return { projectId, environmentId, cases };
    }, { baseUrl: origin + '/target', flow });
    const definitions = ['create', 'delete', 'after'].map((action, index) => stringify({
      testo: { variables: { knowledgeBaseName: 'case default' }, datasets: [{ id: 'smoke', name: 'Smoke', variables: { knowledgeBaseName: 'dataset default' } }] },
      cases: [{ name: action, steps: [
        ...(index === 0 ? [{ wait: { duration: 1, unit: 's' } }] : []),
        { gotoUrl: '${baseUrl}' },
        { useFlow: { id: 'fillName' } },
        { recordedAction: { actionType: 'Tap', payload: { x: 70 + index * 120, y: 100 }, target: { tag: 'button', testId: action } } },
        { assertText: { text: '${knowledgeBaseName} ' + action + ' completed', timeoutMs: 1200 } },
      ] }], afterEach: [{ recordToReport: 'Batch snapshot evidence' }],
    }));
    const saveDefinition = async (index: number, text: string) => ui!.evaluate(async ({ ref, text }) => {
      const source = await window.workspace.workflow(ref);
      await window.workspace.saveWorkflow({ ...ref, revision: source.revision, text });
    }, { ref: { projectId: refs.projectId, ...refs.cases[index]! }, text });
    for (let index = 0; index < definitions.length; index++) await saveDefinition(index, definitions[index]!);

    // Pair the actual shipped extension and select a precise tab through the public desktop API.
    const profile = await ui.evaluate(() => window.workspace.addBrowserProfile());
    const settings = await chrome.newPage();
    await settings.goto(`chrome-extension://${new URL(worker.url()).host}/options.html`);
    await settings.getByLabel('连接名称').fill('Batch integration profile');
    await settings.getByLabel('Testo 连接代码').fill(profile.pairingCode);
    await settings.getByRole('button', { name: '保存并连接' }).click();
    const catalog = await ui.evaluate(id => window.workspace.refreshBrowserProfile({ id }), profile.id);
    assert.equal(catalog.status, 'ready');
    const selected = catalog.tabs.find(tab => tab.url === origin + '/target')!;
    assert.ok(selected); assert.equal(catalog.tabs.length, 2);
    await settings.close(); await other.bringToFront();
    const sessionId = await ui.evaluate(input => window.workspace.useBrowserTab(input), {
      projectId: refs.projectId, environmentId: refs.environmentId, profileId: profile.id, tabId: selected.tabId,
    });
    const input = {
      projectId: refs.projectId, environmentId: refs.environmentId, failurePolicy: 'stop',
      variables: { knowledgeBaseName: 'Shared release 知识库' }, timeoutMs: 30000,
      items: refs.cases.map(item => ({ ...item, sessionId, datasetId: 'smoke' })),
    } satisfies BatchInput;
    const waitForBatch = async (id: string) => {
      await expect.poll(async () => (await ui!.evaluate(() => window.workspace.state())).batches!.find(batch => batch.id === id)?.status,
        { timeout: 65000, intervals: [150, 300, 500] }).not.toBe('running');
      const state = await ui!.evaluate(() => window.workspace.state());
      const batch = state.batches!.find(batch => batch.id === id)!;
      assert.ok(batch.finishedAt); assert.equal(state.activeBatchId, undefined);
      completed.push(batch); return batch;
    };
    const verifySnapshots = async (batch: BatchRun, expectedName: string) => {
      assert.deepEqual(batch.snapshot!.variables, { knowledgeBaseName: expectedName });
      assert.deepEqual(batch.snapshot!.flows!.fillName, flow, 'batch uses the shared flow captured before starting');
      for (const item of batch.items) {
        const index = refs.cases.findIndex(ref => ref.caseId === item.caseId);
        assert.equal(item.datasetId, 'smoke');
        assert.equal(item.definition, definitions[index], 'batch stores the original editable YAML');
        if (!item.runId) continue;
        const detail = await ui!.evaluate(runId => window.workspace.runDetail({ runId }), item.runId);
        assert.ok(detail.events.some(event => event.type === 'step-started'), 'full history exposes real runner steps');
        assert.deepEqual(detail.snapshot, batch.snapshot);
        assert.equal(detail.result!.definitionHash, item.definitionHash);
        const artifact = detail.result!.artifactDirectory;
        assert.equal(readFileSync(path.join(artifact, 'workflow.yaml'), 'utf8'), definitions[index]);
        const configuration = JSON.parse(readFileSync(path.join(artifact, 'run-configuration.json'), 'utf8'));
        assert.equal(configuration.variables.knowledgeBaseName, expectedName);
        assert.equal(configuration.datasetId, 'smoke');
        const compiled = readFileSync(path.join(artifact, 'compiled-workflow.yaml'), 'utf8');
        const compiledSteps = parse(compiled).cases[0].steps;
        assert.ok(compiledSteps.some((step: any) => step.recordedAction?.actionType === 'Input' && step.recordedAction.payload.value === '${knowledgeBaseName}'));
        assert.ok(!compiledSteps.some((step: any) => step.useFlow), 'shared flows are expanded before execution');
        assert.ok(!compiled.includes('poison'), 'queued runs and retries ignore later source edits');
      }
    };

    const firstId = await ui.evaluate(input => window.workspace.runBatch(input), input);
    // Change both the queued case and its shared flow after the batch accepted the definitions.
    await saveDefinition(1, stringify({ cases: [{ name: 'poison edit', steps: [{ assertText: 'poison should not run' }] }] }));
    await ui.evaluate(async projectId => {
      const project = (await window.workspace.state()).projects.find(item => item.id === projectId)!;
      await window.workspace.saveAssets({ projectId, revision: project.assets!.revision, variables: { knowledgeBaseName: 'poison project default' },
        flows: { fillName: { name: 'poison flow edit', steps: [{ assertText: 'poison should not run' }] } } });
    }, refs.projectId);
    const firstBatch = await waitForBatch(firstId);
    assert.deepEqual(firstBatch.items.map(item => item.status), ['passed', 'failed', 'skipped'], JSON.stringify(firstBatch));
    assert.deepEqual(hits.map(hit => [hit.action, hit.name, hit.who]), [
      ['create', input.variables!.knowledgeBaseName, 'chosen-tab'], ['delete', input.variables!.knowledgeBaseName, 'chosen-tab'],
    ], 'create and delete receive exactly the same batch override in the chosen tab');
    await verifySnapshots(firstBatch, String(input.variables!.knowledgeBaseName));

    allowDelete = true;
    const failedRetry = await waitForBatch(await ui.evaluate(input => window.workspace.retryBatch(input), { id: firstId, mode: 'failed' as const, sessionId }));
    assert.equal(failedRetry.status, 'passed', JSON.stringify(failedRetry));
    assert.equal(failedRetry.sourceBatchId, firstId); assert.equal(failedRetry.retryMode, 'failed');
    assert.deepEqual(failedRetry.items.map(item => item.caseId), [refs.cases[1]!.caseId]);
    assert.deepEqual(hits.map(hit => hit.action), ['create', 'delete', 'delete']);
    await verifySnapshots(failedRetry, String(input.variables!.knowledgeBaseName));
    const unfinishedRetry = await waitForBatch(await ui.evaluate(input => window.workspace.retryBatch(input), { id: firstId, mode: 'unfinished' as const, sessionId }));
    assert.equal(unfinishedRetry.status, 'passed', JSON.stringify(unfinishedRetry));
    assert.deepEqual(unfinishedRetry.items.map(item => item.caseId), [refs.cases[2]!.caseId]);
    assert.deepEqual(hits.map(hit => hit.action), ['create', 'delete', 'delete', 'after']);
    await verifySnapshots(unfinishedRetry, String(input.variables!.knowledgeBaseName));

    // A dependent scenario restarts from its first case, even when the user chooses failed only.
    await saveDefinition(1, definitions[1]!);
    await ui.evaluate(async ({ projectId, flow }) => {
      const project = (await window.workspace.state()).projects.find(item => item.id === projectId)!;
      await window.workspace.saveAssets({ projectId, revision: project.assets!.revision, variables: { knowledgeBaseName: 'project default' }, flows: { fillName: flow } });
    }, { projectId: refs.projectId, flow });
    allowDelete = false;
    const dependent = await waitForBatch(await ui.evaluate(input => window.workspace.runBatch(input), { ...input, dependent: true }));
    assert.deepEqual(dependent.items.map(item => item.status), ['passed', 'failed', 'skipped']);
    allowDelete = true;
    const retryName = 'Retry shared 知识库';
    const restarted = await waitForBatch(await ui.evaluate(input => window.workspace.retryBatch(input), {
      id: dependent.id, mode: 'failed' as const, sessionId, variables: { knowledgeBaseName: retryName },
    }));
    assert.equal(restarted.status, 'passed', JSON.stringify(restarted));
    assert.equal(restarted.dependent, true); assert.equal(restarted.sourceBatchId, dependent.id);
    assert.deepEqual(restarted.items.map(item => item.caseId), refs.cases.map(item => item.caseId));
    assert.deepEqual(hits.slice(-3).map(hit => [hit.action, hit.name]), [['create', retryName], ['delete', retryName], ['after', retryName]]);
    await verifySnapshots(restarted, retryName);
    const finalState = await ui.evaluate(() => window.workspace.state());
    assert.deepEqual(finalState.batches!.find(batch => batch.id === firstId), firstBatch, 'retries leave the original batch unchanged');
    assert.deepEqual(finalState.batches!.find(batch => batch.id === dependent.id), dependent);
    assert.equal(hits.length, 9); assert.ok(hits.every(hit => hit.who === 'chosen-tab'));
    assert.equal(await other.locator('#result').textContent(), 'Ready', 'another page with the same origin receives no action');
    const history = await ui.evaluate(projectId => window.workspace.history({ projectId, offset: 0, limit: 2 }), refs.projectId);
    assert.equal(history.total, 9); assert.equal(history.runs.length, 2);
    assert.ok(history.runs.every(run => run.events.length === 0), 'history lists stay light; full events are fetched on demand');
    assert.deepEqual(uiErrors, []);
    await target.screenshot({ path: path.join(dir, 'chosen-tab-result.png') });
    writeFileSync(path.join(dir, 'observations.json'), JSON.stringify({ hits, batches: completed, totalRuns: history.total,
      selectedTabId: selected.tabId, selectedProfile: catalog.name, otherTabUnchanged: true }, null, 2));
    console.log('Batch snapshot integration evidence:', dir);
  } catch (error) {
    writeFileSync(path.join(dir, 'failure-hits.json'), JSON.stringify(hits, null, 2));
    if (ui && !ui.isClosed()) {
      writeFileSync(path.join(dir, 'failure-state.json'), JSON.stringify(await ui.evaluate(() => window.workspace.state()).catch(() => null), null, 2));
      await ui.screenshot({ path: path.join(dir, 'failure.png') }).catch(() => {});
    }
    throw error;
  } finally {
    await app?.close(); await chrome?.close(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
