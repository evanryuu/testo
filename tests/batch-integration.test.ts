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
import { stringify } from 'yaml';
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
  const hits: { action: string; who: string; cookie: string }[] = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url!, 'http://local.test');
    if (url.pathname === '/hit') {
      hits.push({ action: url.searchParams.get('action')!, who: url.searchParams.get('who')!, cookie: request.headers.cookie ?? '' });
      response.end('ok'); return;
    }
    response.setHeader('Content-Type', 'text/html');
    response.end(`<!doctype html><button style="position:absolute;left:20px;top:20px;width:120px;height:50px" onclick="send('A')">Action A</button><button style="position:absolute;left:200px;top:20px;width:120px;height:50px" onclick="send('B')">Action B</button><p id="result" style="position:absolute;top:100px">Ready</p><script>function send(action){document.querySelector('#result').textContent='Sent '+action;fetch('/hit?action='+action+'&who='+sessionStorage.getItem('who'))}</script>`);
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

    const completed: BatchRun[] = [];
    const runBatch = async (caseIndexes: number[], sessionIds: string[], failurePolicy: BatchInput['failurePolicy'], cancel = false) => {
      const input = { projectId: refs.projectId, environmentId: refs.environmentId, failurePolicy, items: caseIndexes.map((index, position) => ({ ...refs.cases[index]!, sessionId: sessionIds[position]! })) };
      const id = await ui!.evaluate(input => window.workspace.runBatch(input), input);
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
        if (cancel && !cancelled && state.runs.find(run => run.runId === state.activeRunId)?.events.some(event => event.type === 'step-started' && event.node === 'wait')) {
          cancelled = true; await ui!.evaluate(id => window.workspace.cancelBatch({ id }), id);
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

    const sameWindow = await runBatch([0, 1], [firstSession, firstSession], 'stop');
    assert.equal(sameWindow.status, 'passed');
    assert.deepEqual(sameWindow.items.map(item => item.status), ['passed', 'passed']);
    assert.deepEqual(hits.map(hit => [hit.who, hit.action]), [['first', 'A'], ['first', 'B']], 'same-window items execute once and in order');
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
    assert.ok(hits.every(hit => hit.cookie.includes('session=batch-fixture')));
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
    assert.equal(restored.sessions!.length, 0, 'live browser bindings do not survive application restart');
    assert.equal(restored.activeBatchId, undefined);
    assert.deepEqual(restored.batches, beforeRestart.batches);
    assert.equal(restored.runs.length, 8);
    assert.deepEqual(restored.runs.map(run => [run.runId, run.status, run.batchId]), beforeRestart.runs.map(run => [run.runId, run.status, run.batchId]));
    assert.equal(first.isClosed(), false); assert.equal(second.isClosed(), false);
    assert.deepEqual(uiErrors, []);
    const automaticConnections = await extensionPage.evaluate(() => (window as any).autoBridgeConnections);
    assert.equal(automaticConnections, 10, 'two session confirmations and eight runs reconnect automatically without per-run test assistance');
    writeFileSync(path.join(dir, 'observations.json'), JSON.stringify({ automaticConnections, targets, hits, batches: completed, restoredSessionCount: restored.sessions!.length, restoredRuns: restored.runs.length }, null, 2));
    console.log('Batch integration evidence:', dir);
  } catch (error) {
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
