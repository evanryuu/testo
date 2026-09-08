import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { findAvailablePort } from '@midscene/shared/node';
import stdlib from 'node-stdlib-browser';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { chromium, type BrowserContext } from 'playwright';
import { expect } from '@playwright/test';
import { bridgeValue, captureChromeSession, connectChrome, createChromeBridge, pinChromeViewport, type ChromeTarget } from '../src/recording/chrome-bridge.js';

test('confirmed Chrome sessions reconnect across windows without falling back to another tab', { timeout: 90_000 }, async () => {
  const previousPort = process.env.WORKSPACE_BRIDGE_PORT;
  const bridgePort = await findAvailablePort(15766, 100);
  process.env.WORKSPACE_BRIDGE_PORT = String(bridgePort);
  const root = process.cwd(); mkdirSync('artifacts', { recursive: true });
  const dir = mkdtempSync(path.resolve('artifacts/batch-bridge-'));
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

  const server = createServer((_req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><button style="position:absolute;left:20px;top:20px;width:120px;height:60px" onclick="document.body.dataset.hits=String(Number(document.body.dataset.hits||0)+1)">Run action</button>');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  let chrome: BrowserContext | undefined;
  try {
    chrome = await chromium.launchPersistentContext(path.join(dir, 'chrome'), { channel: 'chromium', executablePath: process.env.TEST_CHROME_EXECUTABLE, headless: false, viewport: null, args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`] });
    const sw = chrome.serviceWorkers()[0] ?? await chrome.waitForEvent('serviceworker');
    const extensionPage = await chrome.newPage();
    await extensionPage.goto(`chrome-extension://${new URL(sw.url()).host}/index.html`);
    const attach = async () => {
      await expect.poll(async () => { try { await fetch(`http://127.0.0.1:${bridgePort}`); return true; } catch { return false; } }).toBeTruthy();
      await extensionPage.evaluate(url => (window as any).attachBridge(url), `http://127.0.0.1:${bridgePort}`);
    };
    const first = await chrome.newPage(); await first.goto(origin + '/first'); await first.bringToFront();
    await first.evaluate(() => { document.cookie = 'session=fixture;path=/'; localStorage.setItem('loggedIn', 'yes'); });
    const captureFirst = captureChromeSession(origin); await attach(); const firstTarget = await captureFirst;
    assert.ok(firstTarget.sessionToken);
    assert.equal(first.url(), origin + '/first');
    assert.equal(await first.evaluate(() => sessionStorage.getItem('__testing_workspace_bridge_session')), firstTarget.sessionToken);
    const second = await chrome.newPage(); await second.goto(origin + '/second'); await second.bringToFront();
    const captureSecond = captureChromeSession(origin); await attach(); const secondTarget = await captureSecond;
    assert.notEqual(firstTarget.tabId, secondTarget.tabId);
    assert.notEqual(firstTarget.sessionToken, secondTarget.sessionToken);
    assert.equal(second.url(), origin + '/second');
    const windowIds = await extensionPage.evaluate(async (tabId) => {
      const api = (globalThis as any).chrome;
      const original = await api.windows.getCurrent();
      const moved = await api.windows.create({ tabId: Number(tabId) });
      const currentTabs = await api.tabs.query({ currentWindow: true });
      return { original: original.id, moved: moved.id, currentTabIds: currentTabs.map((tab: any) => String(tab.id)) };
    }, firstTarget.tabId);
    assert.notEqual(windowIds.original, windowIds.moved);
    assert.ok(!windowIds.currentTabIds.includes(firstTarget.tabId), 'the legacy currentWindow lookup excludes the saved target');
    const natural = await first.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    const runIn = async (target: ChromeTarget, expectedError?: RegExp) => {
      const agent = createChromeBridge();
      try {
        const connecting = connectChrome(agent, origin, target);
        // Observe rejection immediately while the test extension attaches.
        const checked = expectedError ? assert.rejects(connecting, expectedError) : connecting;
        await attach(); await checked;
        if (!expectedError) {
          assert.equal(await bridgeValue(agent.interface, 'sessionStorage.getItem("__testing_workspace_bridge_session")'), target.sessionToken);
          await pinChromeViewport(agent, { width: 1000, height: 700 });
          await agent.interface.mouse.click(60, 45);
        }
      } finally { await agent.destroy(); }
    };
    await second.bringToFront();
    await runIn(firstTarget);
    await expect.poll(() => first.evaluate(() => document.body.dataset.hits)).toBe('1');
    assert.equal(await second.evaluate(() => document.body.dataset.hits), undefined);
    await expect.poll(() => first.evaluate(() => ({ width: innerWidth, height: innerHeight }))).toEqual(natural);
    await first.bringToFront();
    await runIn(secondTarget);
    assert.equal(await second.evaluate(() => document.body.dataset.hits), '1');
    assert.equal(await first.evaluate(() => document.body.dataset.hits), '1');
    await first.evaluate(() => sessionStorage.setItem('__testing_workspace_bridge_session', 'changed'));
    await runIn(firstTarget, /会话已更换/);
    assert.equal(await first.evaluate(() => document.body.dataset.hits), '1');
    assert.equal(await second.evaluate(() => document.body.dataset.hits), '1');
    await first.goto('about:blank');
    await runIn(firstTarget, /所选环境的网站/);
    await first.close();
    await runIn(firstTarget, /原来的 Chrome 标签页/);
    assert.equal(await second.evaluate(() => document.body.dataset.hits), '1');
    assert.equal(await second.evaluate(() => localStorage.getItem('loggedIn')), 'yes');
    assert.match(await second.evaluate(() => document.cookie), /session=fixture/);
    assert.equal(second.isClosed(), false);
    await second.screenshot({ path: path.join(dir, 'remaining-session.png') });
    writeFileSync(path.join(dir, 'observations.json'), JSON.stringify({ windowIds, firstUrl: origin + '/first', secondUrl: second.url(), actionsPerSession: [1, 1], rejected: ['changed token', 'wrong origin', 'closed tab'], loginPreserved: true, viewportRestored: true }, null, 2));
  } finally {
    if (previousPort === undefined) delete process.env.WORKSPACE_BRIDGE_PORT; else process.env.WORKSPACE_BRIDGE_PORT = previousPort;
    await chrome?.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
