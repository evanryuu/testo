import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { expect } from '@playwright/test';
import { _electron as electron, type ElectronApplication } from 'playwright';

test('batch UI selects explicit Chrome profile tabs, retries pairing, preserves order and exposes results and cancellation', { timeout: 60000 }, async () => {
  mkdirSync('artifacts', { recursive: true });
  const data = mkdtempSync(path.resolve('artifacts/batch-ui-'));
  const env = { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined && entry[0] !== 'ELECTRON_RUN_AS_NODE')),
    WORKSPACE_DATA_DIR: path.join(data, 'app'), WORKSPACE_PROJECTS_DIR: path.join(data, 'projects') };
  let app: ElectronApplication | undefined;
  try {
    app = await electron.launch({ args: [process.cwd()], env });
    const page = await app.firstWindow(); page.setDefaultTimeout(10000);
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await page.getByRole('button', { name: '新建项目', exact: true }).waitFor();
    await app.evaluate(({ ipcMain, BrowserWindow }) => {
      const fixture: any = { projects: [{ id: 'p', name: 'Batch fixture', description: '', root: '/local/fixture',
        groups: [{ id: 'g1', name: '登录检查组', description: '', revision: '1', caseIds: ['send', 'check'] }], suites: [{ id: 'suite', name: 'General', directory: 'general' }], environments: [{ id: 'env', name: 'Local', web: { baseUrl: 'http://127.0.0.1:43210' } }],
        cases: [['send', '批次发送', 'web'], ['check', '批次检查', 'web'], ['hidden', '其他用例', 'web'], ['mobile', '批次移动端', 'android']].map(([id, name, platform]) => ({ id, name, description: '', suiteId: 'suite', priority: 'P1', tags: [], revision: '1', workflows: [{ id: id + '-w', platform, definitionPath: id + '.yaml', ready: true }] })), errors: [] }],
        runs: [], sessions: [], batches: [], model: { name: '', baseUrl: '', family: '', hasApiKey: false }, errors: [] };
      const profiles: any[] = [
        { id: 'profile-a', name: 'Profile A', status: 'ready', pairingCode: 'pair-a', tabs: [{ tabId: 'tab-a', windowId: 10, index: 0, title: '消息页面', url: 'http://127.0.0.1:43210/chat?account=a', active: true }] },
        { id: 'profile-b', name: 'Profile B', status: 'disconnected', pairingCode: 'pair-b', tabs: [{ tabId: 'stale-tab', windowId: 20, index: 0, title: '过期页面', url: 'http://127.0.0.1:43210/stale', active: true }] },
      ];
      let retries = 0, failUse = true;
      (globalThis as any).batchFixture = fixture;
      (globalThis as any).batchCalls = [];
      ipcMain.removeHandler('workspace:call');
      ipcMain.handle('workspace:call', async (_event, method, input) => {
        const calls = (globalThis as any).batchCalls;
        if (method === 'state') return { ok: true, value: fixture };
        calls.push({ method, input });
        let value: unknown;
        if (method === 'browserProfiles') return { ok: true, value: profiles };
        if (method === 'addBrowserProfile') { value = { id: 'profile-new', name: 'Profile C', status: 'unconnected', pairingCode: 'pair-c', tabs: [] }; profiles.push(value); }
        else if (method === 'copyBrowserPairingCode' || method === 'openBrowserConnector' || method === 'focusBrowserTab') value = undefined;
        else if (method === 'removeBrowserProfile') profiles.splice(profiles.findIndex(item => item.id === input.id), 1);
        else if (method === 'refreshBrowserProfile') {
          if (input.id === 'profile-b' && retries++ === 0) return { ok: false, error: 'Profile B 尚未连接，请重试' };
          const profile = profiles.find(item => item.id === input.id);
          profile.status = 'ready'; profile.tabs = [
            { tabId: 'tab-b', windowId: 20, index: 1, title: '账户页面', url: 'http://127.0.0.1:43210/account?account=b', active: false },
            { tabId: 'tab-c', windowId: 21, index: 0, title: '帮助页面', url: 'http://127.0.0.1:43210/help', active: true },
          ]; value = profile;
        } else if (method === 'useBrowserTab') {
          const profile = profiles.find(item => item.id === input.profileId), tab = profile.tabs.find((item: any) => item.tabId === input.tabId);
          if (input.tabId === 'tab-b' && failUse) { failUse = false; profile.status = 'disconnected'; return { ok: false, error: '标签页连接已断开' }; }
          value = 's' + (fixture.sessions.length + 1);
          fixture.sessions.push({ id: value, name: profile.name + ' · 窗口 ' + tab.windowId + ' · ' + tab.title, projectId: input.projectId, environmentId: input.environmentId, origin: 'http://127.0.0.1:43210', profileId: profile.id, profileName: profile.name, tabId: tab.tabId, windowId: tab.windowId, title: tab.title, url: tab.url });
        } else if (method === 'runBatch') {
          value = 'batch-1'; fixture.activeBatchId = value; fixture.activeRunId = 'run-1';
          fixture.batches = [{ id: value, projectId: input.projectId, environment: 'Local', startedAt: new Date().toISOString(), failurePolicy: input.failurePolicy, status: 'running',
            items: input.items.map((item: any, index: number) => ({ ...item, caseName: fixture.projects[0].cases.find((candidate: any) => candidate.id === item.caseId).name,
              sessionName: fixture.sessions.find((session: any) => session.id === item.sessionId).name, status: index === 0 ? 'running' : 'queued', ...(index === 0 ? { runId: 'run-1' } : {}) })) }];
          const first = fixture.batches[0].items[0];
          fixture.runs = [{ runId: 'run-1', projectId: 'p', caseId: first.caseId, caseName: first.caseName, environment: 'Local', status: 'running', startedAt: new Date().toISOString(), batchId: 'batch-1', events: [] }];
        } else if (method === 'cancelBatch') {
          fixture.batches[0].status = 'cancelled';
          fixture.batches[0].items.forEach((item: any) => { item.status = item.status === 'running' ? 'cancelled' : 'skipped'; });
          fixture.runs[0].status = 'cancelled'; delete fixture.activeBatchId; delete fixture.activeRunId;
        } else if (method === 'runPlan') value = [];
        else throw new Error('Unexpected UI API: ' + method);
        for (const window of BrowserWindow.getAllWindows()) window.webContents.send('workspace:changed');
        return { ok: true, value };
      });
      for (const window of BrowserWindow.getAllWindows()) window.webContents.send('workspace:changed');
    });
    await page.getByRole('button', { name: /Batch fixture/ }).click();
    await page.getByLabel('搜索用例').fill('批次');
    await page.getByRole('button', { name: '批量运行', exact: true }).click();
    await expect(page.getByTestId('batch-case-row')).toHaveCount(2);
    await expect(page.getByLabel('批量失败处理')).toHaveValue('stop');
    await expect(page.getByRole('button', { name: '开始批量运行', exact: true })).toBeDisabled();
    await page.getByLabel('全选当前筛选用例').uncheck();
    await page.getByLabel('选择用例 批次发送').check();
    await page.getByLabel('选择用例 批次检查').check();
    await expect(page.getByTestId('chrome-profile')).toHaveCount(2);
    await expect(page.getByTestId('chrome-tab')).toHaveCount(1);
    await expect(page.getByTestId('chrome-tab')).toContainText('http://127.0.0.1:43210/chat?account=a');
    await expect(page.getByText('过期页面', { exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: '打开扩展目录', exact: true }).click();
    await page.getByRole('button', { name: '添加 Chrome Profile', exact: true }).click();
    await page.getByRole('button', { name: '复制配对码 Profile C', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('配对码已复制');
    await page.getByTestId('chrome-tab-picker').screenshot({ path: path.join(data, 'profile-pairing.png') });
    await page.getByRole('button', { name: '解除配对 Profile C', exact: true }).click();
    await page.getByRole('button', { name: '保留配对', exact: true }).click();
    await expect(page.getByTestId('chrome-profile')).toHaveCount(3);
    await page.getByRole('button', { name: '解除配对 Profile C', exact: true }).click();
    await page.getByRole('button', { name: '确认解除配对', exact: true }).click();
    await expect(page.getByTestId('chrome-profile')).toHaveCount(2);
    const firstTab = page.locator('[data-tab-id="tab-a"]');
    await firstTab.getByRole('button', { name: '在 Chrome 中查看', exact: true }).click();
    await firstTab.getByRole('button', { name: '使用此标签页', exact: true }).click();
    await expect(page.getByTestId('confirmed-session')).toContainText('Profile A · 窗口 10 · 消息页面');
    await page.getByLabel('用例 批次检查 运行标签页').selectOption('s1');
    await page.getByRole('button', { name: '刷新 Profile Profile B', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('Profile B 尚未连接，请重试');
    await page.getByRole('button', { name: '刷新 Profile Profile B', exact: true }).click();
    await expect(page.getByTestId('chrome-window')).toHaveCount(3);
    await expect(page.locator('[data-tab-id="tab-b"]')).toContainText('标签页 2');
    await page.locator('[data-tab-id="tab-b"]').getByRole('button', { name: '使用此标签页', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('标签页连接已断开');
    await expect(page.locator('[data-tab-id="tab-b"]')).toHaveCount(0);
    await page.getByRole('button', { name: '刷新 Profile Profile B', exact: true }).click();
    await page.locator('[data-tab-id="tab-b"]').getByRole('button', { name: '使用此标签页', exact: true }).click();
    await expect(page.getByTestId('confirmed-session')).toHaveCount(2);
    await page.getByTestId('chrome-tab-picker').screenshot({ path: path.join(data, 'chrome-tab-picker.png') });
    await expect(page.getByLabel('用例 批次检查 运行标签页')).toHaveValue('s1');
    await expect(page.getByLabel('用例 批次发送 运行标签页')).toHaveValue('s2');
    await page.getByLabel('用例 批次发送 运行标签页').selectOption('s2');
    await page.getByRole('button', { name: '上移用例 批次检查', exact: true }).click();
    await expect(page.getByTestId('batch-case-row').first()).toHaveAttribute('data-case-id', 'check');
    await page.getByLabel('批量失败处理').selectOption('continue');
    await page.screenshot({ path: path.join(data, 'batch-config.png'), fullPage: true });
    await page.getByRole('button', { name: '开始批量运行', exact: true }).click();
    await expect(page.getByTestId('batch-results')).toBeVisible();
    await expect(page.getByTestId('batch-result-item').first()).toContainText('运行中');
    await expect(page.getByTestId('batch-result-item').nth(1)).toContainText('排队中');
    const calls: any[] = await app.evaluate(() => (globalThis as any).batchCalls);
    assert.deepEqual(calls.find(call => call.method === 'runBatch').input, { projectId: 'p', environmentId: 'env', failurePolicy: 'continue', items: [
      { caseId: 'check', workflowId: 'check-w', sessionId: 's1' }, { caseId: 'send', workflowId: 'send-w', sessionId: 's2' },
    ] });
    assert.equal(calls.filter(call => call.method === 'captureSession').length, 0);
    assert.deepEqual(calls.filter(call => call.method === 'useBrowserTab').map(call => call.input), [
      { projectId: 'p', environmentId: 'env', profileId: 'profile-a', tabId: 'tab-a' },
      { projectId: 'p', environmentId: 'env', profileId: 'profile-b', tabId: 'tab-b' },
      { projectId: 'p', environmentId: 'env', profileId: 'profile-b', tabId: 'tab-b' },
    ]);
    assert.deepEqual(calls.find(call => call.method === 'focusBrowserTab').input, { profileId: 'profile-a', tabId: 'tab-a' });
    await page.screenshot({ path: path.join(data, 'batch-running.png') });
    await page.getByTestId('batch-result-item').first().getByRole('button', { name: '查看单例详情' }).click();
    await expect(page.getByTestId('run-summary')).toBeVisible();
    await page.getByRole('button', { name: /^Test Cases/ }).click();
    await page.getByRole('button', { name: /批次发送/ }).click();
    await expect(page.getByRole('button', { name: '运行', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: '开始录制', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: '批次运行中', exact: true }).click();
    await page.getByRole('button', { name: '取消批次', exact: true }).click();
    await expect(page.getByTestId('batch-result-item').first()).toContainText('已取消');
    await expect(page.getByTestId('batch-result-item').nth(1)).toContainText('已跳过');
    await page.getByRole('button', { name: 'Run History', exact: true }).click();
    await expect(page.getByTestId('batch-history-row')).toHaveCount(1);
    await page.getByTestId('batch-history-row').click();
    await expect(page.getByTestId('batch-results')).toContainText('已取消');
    await page.screenshot({ path: path.join(data, 'batch-cancelled.png') });
    await page.getByRole('button', { name: 'Groups', exact: true }).click();
    await page.getByLabel('选择分组 登录检查组', { exact: true }).check();
    await page.getByRole('button', { name: '运行所选分组', exact: true }).click();
    await expect(page.getByLabel('Group 运行标签页')).toHaveValue('s1');
    await page.locator('[data-tab-id="tab-a"]').getByRole('button', { name: '使用此标签页', exact: true }).click();
    await expect(page.getByLabel('Group 运行标签页')).toHaveValue('s3');
    assert.deepEqual(errors, []);
    console.log('Batch UI evidence:', data);
  } finally { await app?.close(); }
});
