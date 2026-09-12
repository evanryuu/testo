import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { expect } from '@playwright/test';
import { _electron as electron, type ElectronApplication } from 'playwright';

test('first-time Chrome connection is reachable on a small screen and guides pairing, retry and exact tab selection', { timeout: 60000 }, async () => {
  mkdirSync('artifacts', { recursive: true });
  const directory = mkdtempSync(path.resolve('artifacts/chrome-onboarding-'));
  let app: ElectronApplication | undefined;
  try {
    app = await electron.launch({ args: [process.cwd()], env: {
      ...Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined && e[0] !== 'ELECTRON_RUN_AS_NODE')),
      WORKSPACE_DATA_DIR: path.join(directory, 'data'), WORKSPACE_PROJECTS_DIR: path.join(directory, 'projects'),
    } });
    const page = await app.firstWindow();
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await page.getByRole('button', { name: '新建项目', exact: true }).waitFor();
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]!.setSize(1024, 680); });
    await page.evaluate(async () => {
      const projectId = await window.workspace.createProject({ name: '连接引导测试', description: '' });
      const project = (await window.workspace.state()).projects[0]!;
      await window.workspace.createCase({ projectId, name: '新建知识库', suiteId: project.suites[0]!.id, platforms: ['web'] });
    });
    await page.getByRole('button', { name: /连接引导测试/ }).click();
    await page.getByRole('button', { name: /新建知识库/ }).click();
    await page.getByLabel('浏览器会话', { exact: true }).selectOption('bridge');
    await page.screenshot({ animations: 'disabled', path: path.join(directory, 'before-connect.png') });
    const connect = page.getByTestId('workflow-row').getByRole('button', { name: '连接 Chrome', exact: true });
    await expect(connect).toBeEnabled();
    await connect.click();
    const guide = page.getByRole('dialog', { name: '连接 Chrome 与选择标签页' });
    await expect(guide).toBeVisible();
    await expect(guide).toContainText('http://localhost:3000');
    await expect(guide).toContainText('chrome://extensions');
    await expect(guide).toContainText('Testo Chrome Connector');
    await expect(guide.getByRole('button', { name: '完成', exact: true })).toBeInViewport();
    await page.screenshot({ animations: 'disabled', path: path.join(directory, 'connection-guide.png') });
    const footer = guide.getByRole('button', { name: '完成', exact: true });
    const before = await footer.boundingBox();
    const content = guide.getByTestId('chrome-guide-content');
    await content.hover(); await page.mouse.wheel(0, 700);
    await expect.poll(() => content.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
    const after = await footer.boundingBox();
    assert.ok(before && after && Math.abs(before.y - after.y) < 2);
    await page.screenshot({ animations: 'disabled', path: path.join(directory, 'guide-scrolled.png') });
    const fixture = await page.evaluate(() => window.workspace.state());
    await app.evaluate(({ ipcMain, BrowserWindow }, fixture: any) => {
      const profiles: any[] = [];
      let failList = true, attempts = 0;
      (globalThis as any).connectionCalls = [];
      ipcMain.removeHandler('workspace:call');
      ipcMain.handle('workspace:call', async (_event, method, input) => {
        (globalThis as any).connectionCalls.push({ method, input });
        let value: unknown;
        if (method === 'state') value = fixture;
        else if (method === 'history') value = { runs: [], total: 0 };
        else if (method === 'browserProfiles') {
          if (failList) { failList = false; return { ok: false, error: '连接列表暂时不可用' }; }
          value = profiles;
        } else if (method === 'addBrowserProfile') {
          value = { id: 'profile', name: 'Chrome 配置 1', status: 'unconnected', tabs: [], pairingCode: 'synthetic-pairing' };
          profiles.push(value);
        } else if (method === 'refreshBrowserProfile') {
          await new Promise(resolve => setTimeout(resolve, 500));
          if (attempts++ === 0) {
            profiles[0].status = 'disconnected';
            return { ok: false, error: '浏览器连接超过 30 秒，请检查扩展配对并重试' };
          }
          profiles[0].status = 'ready';
          profiles[0].tabs = [
            { tabId: '6', windowId: 10, index: 5, title: '知识库', url: 'http://localhost:3000/knowledge', active: true },
            { tabId: '8', windowId: 20, index: 1, title: '知识库', url: 'http://localhost:3000/knowledge', active: false },
          ]; value = profiles[0];
        } else if (method === 'useBrowserTab') {
          const tab = profiles[0].tabs.find((tab: any) => tab.tabId === input.tabId);
          fixture.sessions = [{ id: 'chosen', name: 'Chrome 配置 1 · 窗口 ' + tab.windowId + ' · 知识库',
            projectId: input.projectId, environmentId: input.environmentId, origin: 'http://localhost:3000',
            profileId: 'profile', tabId: tab.tabId, windowId: tab.windowId, title: tab.title, url: tab.url }];
          value = 'chosen';
        } else if (!['openBrowserConnector', 'copyBrowserPairingCode', 'focusBrowserTab'].includes(method)) throw new Error('Unexpected API: ' + method);
        if (['state', 'history', 'browserProfiles'].includes(method)) return { ok: true, value };
        for (const window of BrowserWindow.getAllWindows()) window.webContents.send('workspace:changed');
        return { ok: true, value };
      });
    }, fixture as any);
    await guide.getByRole('button', { name: '完成', exact: true }).click();
    await connect.click();
    await expect(guide.getByRole('alert')).toContainText('连接列表暂时不可用');
    await guide.getByRole('button', { name: '刷新 Profile 列表', exact: true }).click();
    await expect(guide.getByRole('alert')).toHaveCount(0);
    await guide.getByRole('button', { name: '打开扩展目录', exact: true }).click();
    await expect(guide.getByRole('status')).toContainText('已打开扩展目录');
    await guide.getByRole('button', { name: '添加 Chrome Profile', exact: true }).click();
    await expect(guide.getByRole('button', { name: '复制配对码 Chrome 配置 1', exact: true })).toBeInViewport();
    await guide.getByRole('button', { name: '复制配对码 Chrome 配置 1', exact: true }).click();
    await expect(guide.getByRole('status')).toContainText('配对码已复制');
    const retry = guide.getByRole('button', { name: '刷新 Profile Chrome 配置 1', exact: true });
    await retry.click();
    await expect(guide.getByRole('status')).toContainText('最长等待 30 秒');
    await expect(guide.getByRole('alert')).toContainText('浏览器连接超过 30 秒');
    await expect(retry).toHaveText('重试连接');
    await page.screenshot({ animations: 'disabled', path: path.join(directory, 'connection-error.png') });
    await retry.click();
    await expect(guide.getByTestId('chrome-tab')).toHaveCount(2);
    const target = guide.locator('[data-tab-id="8"]');
    await target.getByRole('button', { name: '在 Chrome 中查看', exact: true }).click();
    await target.getByRole('button', { name: '使用此标签页', exact: true }).click();
    await expect(guide).toHaveCount(0);
    await expect(page.getByRole('complementary').last()).toContainText('窗口 20');
    await expect(page.getByTestId('workflow-row').getByRole('button', { name: '开始录制', exact: true })).toBeEnabled();
    await expect(page.getByTestId('workflow-row').getByRole('button', { name: '运行', exact: true })).toBeDisabled();
    const calls = await app.evaluate(() => (globalThis as any).connectionCalls as { method: string; input: any }[]);
    assert.equal(calls.find(call => call.method === 'focusBrowserTab')?.input.tabId, '8');
    assert.equal(calls.find(call => call.method === 'useBrowserTab')?.input.tabId, '8');
    assert.equal(calls.some(call => ['run', 'startRecording'].includes(call.method)), false);
    await page.screenshot({ animations: 'disabled', path: path.join(directory, 'selected-tab.png') });
    assert.deepEqual(errors, []);
  } finally { await app?.close(); }
});
