import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { chromium, type BrowserContext, type Page, type Worker } from 'playwright';
import { expect } from '@playwright/test';
import { BrowserProfileService } from '../src/main/browser-profiles.js';
import { startRun } from '../src/runner/run.js';
import { stringify } from 'yaml';

test('connector pairing accepts only a local Testo endpoint', async () => {
  const { parsePairingCode, validateSettings } = await import(pathToFileURL(path.resolve('browser-extension/config.js')).href);
  assert.deepEqual(parsePairingCode('testo://connect?port=18766&token=abcdefghijklmnop'), { port: 18766, token: 'abcdefghijklmnop', endpoint: 'http://127.0.0.1:18766' });
  for (const code of ['https://remote.example:18766', 'testo://remote.example?port=18766&token=abcdefghijklmnop',
    'testo://connect?port=80&token=abcdefghijklmnop', 'testo://connect?port=65536&token=abcdefghijklmnop',
    'testo://connect?port=18766&token=short', 'testo://connect?port=18766&port=19000&token=abcdefghijklmnop',
    'testo://connect?port=18766&token=abcdefghijklmnop&endpoint=https://remote.example',
    'testo://user@connect?port=18766&token=abcdefghijklmnop', 'testo://connect/path?port=18766&token=abcdefghijklmnop']) assert.throws(() => parsePairingCode(code));
  assert.throws(() => validateSettings({ name: ' ', pairingCode: 'testo://connect?port=18766&token=abcdefghijklmnop' }));
});

test('installed MV3 connectors isolate two profiles, list all windows and route official actions to exact tabs', { timeout: 150_000 }, async () => {
  mkdirSync('artifacts', { recursive: true });
  const root = process.cwd(), dir = mkdtempSync(path.resolve('artifacts/profile-connector-'));
  const extension = path.resolve('dist-browser-extension');
  const manifest = JSON.parse(readFileSync(path.join(extension, 'manifest.json'), 'utf8'));
  assert.equal(manifest.background.service_worker, 'background.js');
  const service = new BrowserProfileService();
  const contexts: BrowserContext[] = [], options: Page[] = [], workers: Worker[] = [], targets: Page[][] = [];
  const server = createServer((_req, response) => {
    response.setHeader('Content-Type', 'text/html');
    response.end(`<!doctype html><title>Same test page</title><button style="position:absolute;left:20px;top:20px;width:140px;height:50px" onclick="document.body.dataset.hits=String(Number(document.body.dataset.hits||0)+1);document.querySelector('p').textContent='Clicked '+localStorage.getItem('profileLabel')">Run action</button><p style="position:absolute;top:100px">Ready</p>`);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const profiles = [await service.create(), await service.create()];
  try {
    for (let index = 0; index < 2; index++) {
      const context = await chromium.launchPersistentContext(path.join(dir, 'chrome-' + index), {
        channel: 'chromium', executablePath: process.env.TEST_CHROME_EXECUTABLE, headless: false, viewport: null,
        args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
      });
      contexts.push(context);
      const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
      workers.push(worker);
      await worker.evaluate(() => {
        const api = (globalThis as any).chrome;
        const original = api.debugger.attach.bind(api.debugger);
        (globalThis as any).connectorAttachCount = 0;
        api.debugger.attach = (...args: any[]) => { (globalThis as any).connectorAttachCount++; return original(...args); };
      });

      const settings = await context.newPage();
      options.push(settings);
      await settings.goto(`chrome-extension://${new URL(worker.url()).host}/options.html`);
      await expect(settings.getByLabel('连接名称')).toHaveValue('我的 Chrome');
      if (!index) {
        await settings.getByLabel('Testo 连接代码').fill('https://remote.example:12345');
        await settings.getByRole('button', { name: '保存并连接' }).click();
        await expect(settings.getByRole('alert')).toContainText('只支持 Testo');
      }
      const pages = [await context.newPage(), await context.newPage(), await context.newPage()];
      for (const page of pages) await page.goto(origin + '/same');
      await pages[0]!.evaluate(label => { localStorage.setItem('profileLabel', label); document.cookie = 'fixture=' + label + ';path=/'; }, 'profile-' + index);
      targets.push(pages);
      await settings.getByLabel('连接名称').fill('User named profile ' + index);
      await settings.getByLabel('Testo 连接代码').fill(profiles[index]!.pairingCode);
      await settings.getByRole('button', { name: '保存并连接' }).click();
      const catalog = await service.refresh(profiles[index]!.id);
      assert.equal(catalog.status, 'ready'); assert.equal(catalog.name, 'User named profile ' + index);
      assert.equal(catalog.tabs.length, 3, 'extension and Chrome pages are excluded, identical website URLs remain separate');
      assert.equal(new Set(catalog.tabs.map(tab => tab.tabId)).size, 3);
      const moved = catalog.tabs[1]!;
      await worker.evaluate(async tabId => (globalThis as any).chrome.windows.create({ tabId: Number(tabId) }), moved.tabId);
      const allWindows = await service.refresh(profiles[index]!.id);
      assert.equal(new Set(allWindows.tabs.map(tab => tab.windowId)).size, 2);
      assert.equal(allWindows.tabs.length, 3);
      assert.equal(await worker.evaluate(() => (globalThis as any).connectorAttachCount), 0, 'catalog discovery does not attach a debugger');
      // Closing the configuration page does not stop the service-worker connector.
      await settings.close();
    }
    assert.notEqual(service.list()[0]!.profileInstallationId, service.list()[1]!.profileInstallationId);
    const bindings = [];
    for (let index = 0; index < 2; index++) {
      const profile = service.list()[index]!;
      const tab = profile.tabs[1]!;
      await service.focus(profile.id, tab.tabId);
      const focused = await workers[index]!.evaluate(async tabId => {
        const api = (globalThis as any).chrome, tab = await api.tabs.get(Number(tabId)), window = await api.windows.get(tab.windowId);
        return { active: tab.active, focused: window.focused };
      }, tab.tabId);
      assert.deepEqual(focused, { active: true, focused: true });
      const binding = await service.capture(profile.id, tab.tabId, origin);
      assert.equal(binding.target.profile?.profileInstallationId, profile.profileInstallationId);
      bindings.push(binding.target);
      const yaml = path.join(dir, 'run-' + index + '.yaml');
      writeFileSync(yaml, stringify({ cases: [{ name: 'Profile ' + index, steps: [
        { recordedAction: { actionType: 'Tap', payload: { x: 70, y: 40 } } },
        { assertText: { text: 'Clicked profile-' + index } },
      ] }], afterEach: [{ recordToReport: 'Profile action result' }] }));
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'ELECTRON_RUN_AS_NODE' && !key.startsWith('MIDSCENE_MODEL') && !key.startsWith('OPENAI_')));
      const result = await startRun({ workflowPath: yaml, baseUrl: origin, artifactRoot: dir, chromeTarget: binding.target }, () => {}, env).result;
      assert.equal(result.status, 'passed', result.error);
      assert.ok(result.reportPaths.length);
      const counts = await Promise.all(targets[index]!.map(page => page.evaluate(() => Number(document.body.dataset.hits || 0))));
      assert.equal(counts.reduce((sum, value) => sum + value, 0), 1, 'only one chosen tab in the intended profile receives the action');
      if (!index) assert.deepEqual(await Promise.all(targets[1]!.map(page => page.evaluate(() => Number(document.body.dataset.hits || 0)))), [0, 0, 0]);
      const confirmed = await service.refresh(profile.id);
      assert.equal(confirmed.profileInstallationId, profile.profileInstallationId);
    }
    // Disabled connectors stay disabled and cannot silently attach another profile.
    const settings = await contexts[0]!.newPage();
    await settings.goto(`chrome-extension://${new URL(workers[0]!.url()).host}/options.html`);
    await expect(settings.getByLabel('连接名称')).toHaveValue('User named profile 0');
    await settings.getByRole('button', { name: '断开连接' }).click();
    await expect(settings.getByRole('status')).toHaveText('已断开连接');
    const failedRefresh = service.refresh(profiles[0]!.id);
    const rejected = assert.rejects(failedRefresh, /取消/);
    setTimeout(() => service.cancel(), 1500);
    await rejected;
    assert.equal(service.list()[0]!.status, 'disconnected');
    assert.equal((await service.refresh(profiles[1]!.id)).status, 'ready');
    await settings.reload();
    await expect(settings.getByRole('status')).toHaveText('已断开连接');
    assert.equal(await workers[0]!.evaluate(async () => (await (globalThis as any).chrome.storage.local.get('connectorSettings')).connectorSettings.enabled), false);
    for (let index = 0; index < 2; index++) {
      assert.equal(await targets[index]![0]!.evaluate(() => localStorage.getItem('profileLabel')), 'profile-' + index);
      assert.match(await targets[index]![0]!.evaluate(() => document.cookie), new RegExp('fixture=profile-' + index));
    }
    await settings.screenshot({ path: path.join(dir, 'connector-settings.png') });
    writeFileSync(path.join(dir, 'observations.json'), JSON.stringify({ profiles: service.list().map(({ pairingCode: _secret, ...profile }) => profile), selectedTabs: bindings.map(binding => binding.tabId), actionsPerProfile: [1, 1], settingsPageMayClose: true, disconnectedConnectorStayedDisabled: true }, null, 2));
    console.log('Profile connector evidence:', dir);
  } finally {
    await service.destroy();
    for (const context of contexts) await context.close();
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
