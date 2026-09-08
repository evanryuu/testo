import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { findAvailablePort } from '@midscene/shared/node';
import stdlib from 'node-stdlib-browser';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { chromium, _electron as electron, type BrowserContext, type ElectronApplication, type Page } from 'playwright';
import { expect } from '@playwright/test';
import { createChromeBridge, connectChrome } from '../src/recording/chrome-bridge.js';
import { createBridgeNodes } from '../src/runner/bridge-nodes.js';
import { buildRecordedWorkflow } from '../src/recording/workflow.js';
import { waitForStableViewport } from '../src/recording/viewport.js';

const runtimeEnv = () => Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined && e[0] !== 'ELECTRON_RUN_AS_NODE' && !e[0].startsWith('MIDSCENE_MODEL')));

test('Chrome manual login stays outside recording; official Bridge records and replays in the same authenticated tab', { timeout: 180_000 }, async () => {
  const previousPort = process.env.WORKSPACE_BRIDGE_PORT;
  const bridgePort = await findAvailablePort(14766, 100);
  process.env.WORKSPACE_BRIDGE_PORT = String(bridgePort);
  const root = process.cwd(); mkdirSync('artifacts', { recursive: true });
  const dir = mkdtempSync(path.resolve('artifacts/chrome-bridge-'));
  const ext = path.join(dir, 'extension'); mkdirSync(ext);
  writeFileSync(path.join(ext, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'Workspace Bridge verification', version: '1.0', permissions: ['tabs', 'debugger'], host_permissions: ['http://127.0.0.1/*'], background: { service_worker: 'background.js' } }));
  writeFileSync(path.join(ext, 'background.js'), 'chrome.runtime.onInstalled.addListener(() => {});');
  writeFileSync(path.join(ext, 'index.html'), '<script src="bridge.js"></script>');
  const bundleOptions = { bundle: true, platform: 'browser' as const, format: 'iife' as const, alias: Object.fromEntries(Object.entries({ ...stdlib, 'node:fs/promises': stdlib.fs, 'fs/promises': stdlib.fs }).map(([key, value]) => [key, value.replace('/esm/mock/empty.js', '/cjs/mock/empty.js')])), inject: [path.join(root, 'node_modules/node-stdlib-browser/helpers/esbuild/shim.js')] };
  await build({ ...bundleOptions, entryPoints: ['tests/fixtures/chrome-bridge-extension.js'], outfile: path.join(ext, 'bridge.js') });
  mkdirSync(path.join(ext, 'scripts'));
  await build({ ...bundleOptions, entryPoints: ['node_modules/@midscene/shared/dist/es/extractor/index.mjs'], globalName: 'midscene_element_inspector', outfile: path.join(ext, 'scripts/htmlElement.js') });
  // The test extension disables the optional animation, so there is none to stop.
  writeFileSync(path.join(ext, 'scripts/stop-water-flow.js'), 'void 0;');
  const submitted: string[] = [];
  const submittedSizes: { width: number; height: number }[] = [];
  let waitCalls = 0, holdWait = false;
  const server = createServer((req, res) => {
    if (req.url === '/v1/chat/completions') {
      let body = ''; req.on('data', chunk => body += chunk); req.on('end', () => {
        const payload = JSON.parse(body); waitCalls++;
        assert.ok(payload.messages.some((message: any) => Array.isArray(message.content) && message.content.some((part: any) => part.type === 'image_url')));
        if (holdWait) return;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ id: 'bridge-wait', object: 'chat.completion', created: 1700000000, model: payload.model,
          choices: [{ index: 0, message: { role: 'assistant', content: `<observation>Bridge page observed</observation><data-json>${JSON.stringify({ StatementIsTruthy: waitCalls >= 2 })}</data-json>` }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }));
      }); return;
    }

    if (req.url === '/never.png' || req.url === '/never-document') return;
    if (req.url === '/redirect') { res.writeHead(302, { Location: '/slow-resource' }); res.end(); return; }
    if (req.url?.startsWith('/slow-resource')) { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><input aria-label="ready"><img src="/never.png">'); return; }
    if (req.url === '/submit') {
      assert.match(req.headers.cookie ?? '', /session=fixture/);
      submittedSizes.push(JSON.parse(String(req.headers['x-test-viewport'])));
      let value = ''; req.on('data', data => value += data); req.on('end', () => { submitted.push(value); res.end('ok'); }); return;
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`<!doctype html><style>input{position:absolute;left:30px;top:100px;width:250px;height:35px}#send{position:absolute;left:310px;top:100px;width:100px;height:40px}</style><button id="login" onclick="document.cookie='session=fixture;path=/';localStorage.setItem('loggedIn','yes');render()">手动登录</button><h1 id="status"></h1><input aria-label="消息"><button id="send" onclick="fetch('/submit',{method:'POST',headers:{'X-Test-Viewport':JSON.stringify({width:innerWidth,height:innerHeight})},body:document.querySelector('input').value}).then(()=>document.getElementById('result').textContent='发送成功')">发送</button><p id="result" style="position:absolute;top:170px"></p><script>function render(){document.getElementById('status').textContent=localStorage.getItem('loggedIn')==='yes'?'已登录':'未登录'}render()</script>`);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  let chrome: BrowserContext | undefined, app: ElectronApplication | undefined;
  try {
    chrome = await chromium.launchPersistentContext(path.join(dir, 'chrome'), { channel: 'chromium', executablePath: process.env.TEST_CHROME_EXECUTABLE, headless: false, viewport: null, args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`] });
    const sw = chrome.serviceWorkers()[0] ?? await chrome.waitForEvent('serviceworker');
    const extensionPage = await chrome.newPage();
    await extensionPage.goto(`chrome-extension://${new URL(sw.url()).host}/index.html`);
    const target = await chrome.newPage(); await target.goto(baseUrl); await target.bringToFront();
    app = await electron.launch({ args: [root], env: { ...runtimeEnv(), WORKSPACE_DATA_DIR: path.join(dir, 'app'), WORKSPACE_PROJECTS_DIR: path.join(dir, 'projects') } });
    const ui = await app.firstWindow(); ui.setDefaultTimeout(15_000);
    const errors: string[] = []; ui.on('pageerror', e => errors.push(e.message));
    const refs = await ui.evaluate(async (baseUrl) => {
      const projectId = await window.workspace.createProject({ name: 'Chrome 登录会话验证', description: '' });
      let project = (await window.workspace.state()).projects.find(p => p.id === projectId)!;
      await window.workspace.saveEnvironment({ projectId, id: project.environments[0]!.id, name: '本地验证', baseUrl });
      const caseId = await window.workspace.createCase({ projectId, name: '已登录用户发送消息', suiteId: project.suites[0]!.id, platforms: ['web'] });
      project = (await window.workspace.state()).projects.find(p => p.id === projectId)!;
      return { projectId, caseId, workflowId: project.cases[0]!.workflows[0]!.id, environmentId: project.environments[0]!.id };
    }, baseUrl);
    await ui.getByRole('button', { name: /Chrome 登录会话验证/ }).click();
    await ui.getByRole('button', { name: /已登录用户发送消息/ }).click();
    await ui.getByLabel('浏览器会话', { exact: true }).selectOption('bridge');
    await target.goto('about:blank');
    await ui.getByRole('button', { name: '连接 Chrome', exact: true }).click();
    const attach = async () => {
      await expect.poll(async () => { try { await fetch(`http://127.0.0.1:${bridgePort}`); return true; } catch { return false; } }).toBeTruthy();
      await extensionPage.evaluate(url => (window as any).attachBridge(url), `http://127.0.0.1:${bridgePort}`);
    };
    await attach();
    await ui.getByRole('button', { name: '重新连接 Chrome', exact: true }).waitFor();
    const failedDraft = (await ui.evaluate(() => window.workspace.state())).recording!;
    assert.equal(failedDraft.status, 'interrupted');
    await expect(ui.getByText('正在准备官方录制界面', { exact: true })).toHaveCount(0);
    await expect(ui.getByRole('button', { name: '保存到当前用例', exact: true })).toBeDisabled();
    await ui.screenshot({ path: path.join(dir, 'retry-connection.png'), fullPage: true });
    await target.goto(baseUrl); await target.bringToFront();
    await ui.getByRole('button', { name: '重新连接 Chrome', exact: true }).click();
    await attach();
    await ui.getByText('等待手动登录', { exact: true }).waitFor();
    assert.equal((await ui.evaluate(() => window.workspace.state())).recording!.id, failedDraft.id);
    assert.equal((await ui.evaluate(() => window.workspace.state())).recording!.error, undefined);
    assert.deepEqual((await ui.evaluate(() => window.workspace.state())).recording!.events, []);
    assert.equal(readFileSync(path.join(dir, 'app/recording-preview.json'), 'utf8'), 'null');
    // Prepare must not attach the debugger: security verification happens manually first.
    assert.equal(await extensionPage.evaluate(() => (window as any).debuggerAttachCalls), 0);
    await ui.screenshot({ path: path.join(dir, 'prepare.png'), fullPage: true });
    await target.getByRole('button', { name: '手动登录', exact: true }).click();
    await expect(target.getByRole('heading')).toHaveText('已登录');
    await ui.getByRole('button', { name: '已准备好，开始录制', exact: true }).click();
    const preview = ui.frameLocator('iframe[title="Midscene 官方录制预览"]');
    await preview.locator('[data-midscene-device-interaction-layer]').waitFor({ timeout: 40_000 });
    await expect.poll(() => preview.locator('.screenshot-image').evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    const recordedViewport = (await ui.evaluate(() => window.workspace.state())).recording!.viewport!;
    const click = async (x: number, y: number) => {
      const box = await preview.locator('.screenshot-image').boundingBox(); assert.ok(box);
      await ui.mouse.click(box.x + x * box.width / recordedViewport.width, box.y + y * box.height / recordedViewport.height);
    };
    await click(110, 118); await ui.keyboard.type('Bridge hello'); await click(355, 118);
    await expect.poll(() => submitted.length).toBe(1);
    await ui.getByRole('button', { name: '停止录制并检查', exact: true }).click();
    await ui.getByRole('button', { name: '添加断言', exact: true }).click();
    await ui.getByLabel('断言 1 内容', { exact: true }).fill('发送成功');
    await ui.screenshot({ path: path.join(dir, 'review.png'), fullPage: true });
    await ui.getByRole('button', { name: '保存到当前用例', exact: true }).click();
    assert.equal(target.isClosed(), false);
    assert.equal(await target.evaluate(() => localStorage.getItem('loggedIn')), 'yes');
    // Native Chrome window dimensions change between recording and replay.
    const cdp = await chrome.newCDPSession(target);
    const { windowId } = await cdp.send('Browser.getWindowForTarget');
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { width: 950, height: 740 } });
    const naturalViewport = await waitForStableViewport(() => target.evaluate(() => ({ width: innerWidth, height: innerHeight })));
    assert.notDeepEqual(naturalViewport, recordedViewport);
    // Another tab is active. Replay must still select the recorded tab.
    const other = await chrome.newPage(); await other.goto(baseUrl); await other.bringToFront();
    await ui.getByRole('button', { name: '运行', exact: true }).click();
    await attach();
    await expect.poll(async () => (await ui.evaluate(() => window.workspace.state())).runs[0]?.status, { timeout: 60_000 }).toBe('passed');
    assert.deepEqual(submitted, ['Bridge hello', 'Bridge hello']);
    assert.deepEqual(submittedSizes, [recordedViewport, recordedViewport]);
    await expect.poll(() => target.evaluate(() => ({ width: innerWidth, height: innerHeight }))).toEqual(naturalViewport);
    const sendStep = ui.getByTestId('run-step').filter({ hasText: 'button · 发送' });
    await expect(sendStep).toContainText('button · 发送');
    await sendStep.getByRole('button', { name: '执行前截图', exact: true }).click();
    await ui.getByRole('img', { name: '运行步骤截图' }).waitFor();
    await ui.waitForFunction(() => (document.querySelector('[role="dialog"] img') as HTMLImageElement)?.naturalWidth > 0);
    await ui.screenshot({ path: path.join(dir, 'send-evidence.png'), animations: 'disabled' });
    await ui.getByRole('button', { name: 'Close', exact: true }).click();
    assert.equal(target.isClosed(), false); assert.equal(other.isClosed(), false);
    await expect(other.getByLabel('消息')).toHaveValue('');
    const draft = (await ui.evaluate(() => window.workspace.state())).recording!;
    assert.equal(draft.events.some(e => String(e.rawPayload?.value).includes('session=fixture')), false);
    assert.deepEqual(draft.viewport, recordedViewport);
    assert.deepEqual(errors, []);
    await ui.screenshot({ path: path.join(dir, 'passed.png'), fullPage: true });
    // Real official extension: pending images must not block DOM navigation.
    await target.bringToFront();
    const navigationAgent = createChromeBridge();
    try {
      const connecting = connectChrome(navigationAgent, new URL(baseUrl).origin);
      await attach(); await connecting;
      const node = createBridgeNodes(() => navigationAgent, baseUrl)[0]!;
      const navigate = async (url: string, waitUntil = 'domcontentloaded', timeoutMs = 3000, signal = new AbortController().signal) => node.execute({ input: { url, waitUntil, timeoutMs }, signal } as any);
      for (const route of ['/slow-resource', '/slow-resource', '/redirect', '/slow-resource#same-document']) {
        await navigate(route);
        await expect(target.getByLabel('ready')).toBeVisible();
        assert.equal(await target.evaluate(() => document.readyState), 'interactive');
      }
      await assert.rejects(navigate('/slow-resource?wait-load', 'load', 400), /load.*上限 400ms/);
      await assert.rejects(navigate('/never-document', 'domcontentloaded', 400), /导航超时/);
      await assert.rejects(navigate('http://127.0.0.1:1/'), /导航失败|ERR_UNSAFE_PORT/);
      await navigate('/slow-resource', 'commit');
      const controller = new AbortController();
      const pendingNavigation = navigate('/never-document', 'domcontentloaded', 10000, controller.signal);
      setTimeout(() => controller.abort(new Error('cancel navigation test')), 150);
      await assert.rejects(pendingNavigation, /cancel navigation test/);
      await navigate(baseUrl);
      assert.equal(await target.evaluate(() => localStorage.getItem('loggedIn')), 'yes');
      assert.equal(target.isClosed(), false);
    } finally { await navigationAgent.destroy(); }
    // Existing Workflow can reconnect after a local binding has been lost.
    await app.close();
    app = await electron.launch({ args: [root], env: { ...runtimeEnv(), MIDSCENE_MODEL_NAME: 'bridge-wait', MIDSCENE_MODEL_FAMILY: 'gpt-5', MIDSCENE_MODEL_BASE_URL: baseUrl + '/v1', MIDSCENE_MODEL_API_KEY: 'local-bridge-wait-key', MIDSCENE_MODEL_RETRY_COUNT: '0', WORKSPACE_DATA_DIR: path.join(dir, 'app'), WORKSPACE_PROJECTS_DIR: path.join(dir, 'projects') } });
    const reopened = await app.firstWindow(); reopened.setDefaultTimeout(15_000);
    await reopened.getByRole('button', { name: /Chrome 登录会话验证/ }).click();
    await reopened.getByRole('button', { name: /已登录用户发送消息/ }).click();
    await reopened.getByLabel('浏览器会话', { exact: true }).selectOption('bridge');
    await target.bringToFront();
    await reopened.getByRole('button', { name: '连接 Chrome', exact: true }).click();
    await attach();
    await reopened.getByRole('button', { name: '登录完成，返回用例运行', exact: true }).click();
    await reopened.getByRole('button', { name: '连接 Chrome', exact: true }).waitFor();
    // Cancel while a real Bridge assertion is waiting; it must preserve Chrome.
    // The same condition-wait node also uses actual Bridge screenshots and AI transport.
    let saved = await reopened.evaluate(refs => window.workspace.workflow(refs), refs);
    await reopened.evaluate(async ({ refs, saved }) => window.workspace.saveWorkflow({ ...refs, revision: saved.revision, text: 'cases:\n  - name: Bridge wait\n    steps:\n      - aiWaitFor: {prompt: The page is ready, timeoutMs: 10000, checkIntervalMs: 200}\n      - assertText: {text: 已登录}\n' }), { refs, saved });
    const waiting = await reopened.evaluate(refs => window.workspace.run({ ...refs, browserMode: 'bridge' }), refs);
    await attach();
    await expect.poll(async () => (await reopened.evaluate(() => window.workspace.state())).runs.find(r => r.runId === waiting)?.status, { timeout: 15000 }).toBe('passed');
    assert.equal(waitCalls, 2);
    await reopened.screenshot({ path: path.join(dir, 'ai-wait-passed.png') });
    holdWait = true;
    saved = await reopened.evaluate(refs => window.workspace.workflow(refs), refs);
    await reopened.evaluate(async ({ refs, saved }) => window.workspace.saveWorkflow({ ...refs, revision: saved.revision, text: 'cases:\n  - name: Wait\n    steps:\n      - requireViewport: {width: 1100, height: 750}\n      - aiWaitFor:\n          prompt: waiting forever\n          timeoutMs: 30000\n' }), { refs, saved });
    const cancelling = await reopened.evaluate(refs => window.workspace.run({ ...refs, browserMode: 'bridge' }), refs);
    await attach();
    await expect.poll(async () => (await reopened.evaluate(() => window.workspace.state())).runs.find(r => r.runId === cancelling)?.events.some(e => e.type === 'step-started' && e.node === 'aiWaitFor')).toBeTruthy();
    await expect.poll(() => waitCalls).toBe(3);
    await reopened.evaluate(() => window.workspace.cancelRun());
    await expect.poll(async () => (await reopened.evaluate(() => window.workspace.state())).runs.find(r => r.runId === cancelling)?.status).toBe('cancelled');
    assert.equal(waitCalls, 3);
    assert.equal(target.isClosed(), false);
    assert.equal(await target.evaluate(() => localStorage.getItem('loggedIn')), 'yes');
    await expect.poll(() => target.evaluate(() => ({ width: innerWidth, height: innerHeight }))).toEqual(naturalViewport);
    await cdp.detach();
    // Closing the recorded tab must fail, never silently operate another tab.
    await target.close();
    const runId = await reopened.evaluate(refs => window.workspace.run({ ...refs, browserMode: 'bridge' }), refs);
    await attach();
    await expect.poll(async () => (await reopened.evaluate(() => window.workspace.state())).runs.find(r => r.runId === runId)?.status, { timeout: 45_000 }).toBe('error');
    assert.deepEqual(submitted, ['Bridge hello', 'Bridge hello']);
    const closedResult = (await reopened.evaluate(() => window.workspace.state())).runs.find(r => r.runId === runId)?.result;
    assert.match(closedResult?.error ?? '', /原来的 Chrome 标签页/);
    assert.doesNotMatch(closedResult?.error ?? '', /Worker did not exit/);
  } catch (error) {
    const ui = app ? await app.firstWindow() : undefined;
    if (ui) { await ui.screenshot({ path: path.join(dir, 'failure.png'), fullPage: true }).catch(() => {}); writeFileSync(path.join(dir, 'failure-state.json'), JSON.stringify(await ui.evaluate(() => window.workspace.state()).catch(() => null))); }
    throw error;
  } finally {
    if (previousPort === undefined) delete process.env.WORKSPACE_BRIDGE_PORT; else process.env.WORKSPACE_BRIDGE_PORT = previousPort;
    await app?.close(); await chrome?.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('Chrome workflow keeps actual viewport and rejects resized steps or out-of-bounds coordinates', () => {
  const viewport = { width: 1440, height: 900 };
  const event = { hashId: 'tap', actionType: 'Tap', pageInfo: viewport, rawPayload: { x: 1400, y: 850 } };
  const yaml = buildRecordedWorkflow({ name: 'Chrome', events: [event], viewport, startUrl: 'https://example.test/chat' });
  assert.match(yaml, /requireViewport/); assert.match(yaml, /1440/);
  assert.throws(() => buildRecordedWorkflow({ name: 'Chrome', viewport, events: [{ ...event, pageInfo: { width: 1300, height: 900 } }] }), /视口/);
  assert.throws(() => buildRecordedWorkflow({ name: 'Chrome', viewport, events: [{ ...event, rawPayload: { x: 1441, y: 20 } }] }), /坐标/);
});
