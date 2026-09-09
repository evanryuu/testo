import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { expect } from '@playwright/test';
import { _electron as electron, type ElectronApplication } from 'playwright';

test('Groups UI handles 1000+ entries, CRUD conflicts, bounded graph navigation and ordered multi-group runs', { timeout: 90000 }, async () => {
  mkdirSync('artifacts', { recursive: true });
  const data = mkdtempSync(path.resolve('artifacts/groups-ui-'));
  let app: ElectronApplication | undefined;
  try {
    app = await electron.launch({ args: [process.cwd()], env: { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined && entry[0] !== 'ELECTRON_RUN_AS_NODE')), WORKSPACE_DATA_DIR: path.join(data, 'app'), WORKSPACE_PROJECTS_DIR: path.join(data, 'projects') } });
    const page = await app.firstWindow(); page.setDefaultTimeout(15000);
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await page.getByRole('button', { name: '新建项目', exact: true }).waitFor();
    await app.evaluate(({ ipcMain, BrowserWindow }) => {
      const cases = Array.from({ length: 1005 }, (_, index) => ({ id: 'c' + index, name: '用例' + String(index).padStart(4, '0'), description: '', suiteId: index % 2 ? 'b' : 'a', priority: 'P1', tags: [index % 2 ? 'auth' : 'smoke'], revision: '1', workflows: [{ id: 'w' + index, platform: 'web', definitionPath: 'web.yaml', ready: true }] }));
      cases.push({ id: 'mobile', name: '移动端用例', description: '', suiteId: 'a', priority: 'P1', tags: [], revision: '1', workflows: [{ id: 'mobile-w', platform: 'android', definitionPath: 'android.yaml', ready: true }] });
      const groups = Array.from({ length: 1005 }, (_, index) => ({ id: 'g' + index, name: '分组' + String(index).padStart(4, '0'), description: '', caseIds: index === 0 ? cases.slice(0, 1005).map(item => item.id) : index === 1 ? ['c1', 'c2'] : ['c' + index], revision: '1' }));
      groups[2]!.caseIds = []; groups[3]!.caseIds = ['missing']; groups[4]!.caseIds = ['mobile'];
      const state: any = { projects: [{ id: 'p', name: 'Groups fixture', description: '', root: '/local/fixture', suites: [{ id: 'a', name: 'Suite A', directory: 'a' }, { id: 'b', name: 'Suite B', directory: 'b' }], cases, groups, environments: [{ id: 'env', name: 'Local', web: { baseUrl: 'http://127.0.0.1:43210' } }], errors: [] }], runs: [], batches: [], sessions: [{ id: 's', name: '窗口 A', projectId: 'p', environmentId: 'env', origin: 'http://127.0.0.1:43210' }], model: { name: '', family: '', baseUrl: '', hasApiKey: false }, errors: [] };
      (globalThis as any).groupsFixture = state; (globalThis as any).groupsCalls = []; (globalThis as any).groupConflict = false;
      ipcMain.removeHandler('workspace:call');
      ipcMain.handle('workspace:call', async (_event, method, input) => {
        if (method === 'state') return { ok: true, value: state };
        if (method === 'browserProfiles') return { ok: true, value: [] };
        (globalThis as any).groupsCalls.push({ method, input });
        let value: any;
        if (method === 'saveGroup') {
          const existing = groups.find(item => item.id === input.id);
          if (existing && (globalThis as any).groupConflict) { (globalThis as any).groupConflict = false; existing.revision = '2'; return { ok: false, error: '分组已被其他窗口修改，请重新打开后保存' }; }
          if (existing && existing.revision !== input.revision) return { ok: false, error: '分组版本冲突' };
          value = existing?.id ?? 'created';
          const next = { id: value, name: input.name, description: input.description, caseIds: input.caseIds, revision: String(Number(existing?.revision ?? 0) + 1) };
          if (existing) groups.splice(groups.indexOf(existing), 1, next); else groups.push(next);
        } else if (method === 'deleteGroup') {
          const index = groups.findIndex(item => item.id === input.id); if (index >= 0) groups.splice(index, 1);
        } else if (method === 'runGroups') {
          value = 'group-batch';
          state.batches = [{ id: value, projectId: 'p', environment: 'Local', startedAt: new Date().toISOString(), failurePolicy: input.failurePolicy, status: 'passed', groups: input.groupIds.map((id: string) => ({ id, name: groups.find(group => group.id === id)!.name })), items: [...new Set(input.groupIds.flatMap((id: string) => groups.find(group => group.id === id)!.caseIds))].map(id => ({ caseId: id, caseName: cases.find(item => item.id === id)!.name, workflowId: 'w' + String(id).slice(1), sessionName: '窗口 A', status: 'passed' })) }];
        } else if (method === 'runPlan') value = [];
        else throw new Error('Unexpected UI API: ' + method);
        for (const window of BrowserWindow.getAllWindows()) window.webContents.send('workspace:changed');
        return { ok: true, value };
      });
      for (const window of BrowserWindow.getAllWindows()) window.webContents.send('workspace:changed');
    });
    await page.getByRole('button', { name: /Groups fixture/ }).click();
    await page.getByRole('button', { name: 'Groups', exact: true }).click();
    await expect(page.getByTestId('group-list-row')).toHaveCount(50);
    await page.getByRole('button', { name: '分组列表下一页', exact: true }).click();
    await expect(page.getByTestId('group-list-row').first()).toHaveAttribute('data-group-id', 'g50');
    await page.getByRole('button', { name: '分组列表上一页', exact: true }).click();

    // Invalid groups explain why execution is unavailable.
    for (const [name, reason] of [['分组0002', '是空分组'], ['分组0003', '缺失用例'], ['分组0004', '尚无可运行的 Web']]) {
      await page.getByLabel('选择分组 ' + name, { exact: true }).check();
      await expect(page.getByRole('button', { name: '运行所选分组', exact: true })).toBeDisabled();
      await expect(page.getByRole('alert')).toContainText(reason!);
      await page.getByRole('button', { name: '清空已选分组', exact: true }).click();
    }

    // Graph uses bounded, keyboard-accessible React Flow nodes, not a static image.
    await page.getByRole('tab', { name: '关系图', exact: true }).click();
    await expect(page.locator('[data-graph-node="group"]')).toHaveCount(8);
    await expect(page.locator('[data-graph-node="case"]')).toHaveCount(0);
    await page.getByRole('button', { name: '展开分组 分组0000', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('[data-graph-node="case"]')).toHaveCount(12);
    await page.getByRole('button', { name: '关系图下一页成员', exact: true }).click();
    await expect(page.locator('[data-graph-node="case"]').first()).toHaveAttribute('data-case-id', 'c12');
    const scale = await page.getByLabel('关系图缩放比例').innerText();
    await page.getByRole('button', { name: '放大关系图', exact: true }).click();
    await expect(page.getByLabel('关系图缩放比例')).not.toHaveText(scale);
    const viewport = page.locator('.react-flow__viewport');
    const transform = await viewport.getAttribute('style');
    const canvas = await page.getByTestId('group-graph-canvas').boundingBox(); assert.ok(canvas);
    await page.mouse.move(canvas.x + 16, canvas.y + 20); await page.mouse.down();
    await page.mouse.move(canvas.x + 90, canvas.y + 80, { steps: 5 }); await page.mouse.up();
    await expect(viewport).not.toHaveAttribute('style', transform!);
    await page.getByRole('button', { name: '适应关系图', exact: true }).click();
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: path.join(data, 'groups-graph.png'), fullPage: true });
    await page.getByRole('button', { name: '打开用例 用例0012', exact: true }).click();
    await expect(page.getByRole('heading', { name: '用例0012', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Groups', exact: true }).click();
    await page.getByRole('tab', { name: '关系图', exact: true }).click();
    await page.getByLabel('搜索分组或用例').fill('用例1000');
    await page.getByRole('button', { name: '展开分组 分组0000', exact: true }).click();
    await expect(page.locator('[data-graph-node="case"]')).toHaveCount(1);
    await expect(page.locator('[data-graph-node="case"]').first()).toHaveAttribute('data-case-id', 'c1000');
    await expect(page.getByRole('button', { name: '关系图下一页成员', exact: true })).toBeDisabled();
    await page.getByLabel('搜索分组或用例').fill('');
    await page.getByRole('tab', { name: '分组列表', exact: true }).click();
    await page.getByRole('button', { name: '编辑分组 分组0000', exact: true }).click();
    await expect(page.getByTestId('group-member-row')).toHaveCount(50);
    await page.getByRole('button', { name: '已选成员下一页', exact: true }).click();
    await expect(page.getByTestId('group-member-row').first()).toHaveAttribute('data-case-id', 'c50');
    await page.getByRole('button', { name: '取消编辑', exact: true }).click();

    await page.getByRole('button', { name: '新建分组', exact: true }).click();
    await expect(page.getByTestId('group-candidate-row')).toHaveCount(50);
    await page.getByRole('button', { name: '候选用例下一页', exact: true }).click();
    await expect(page.getByTestId('group-candidate-row').first()).toContainText('用例0050');
    await page.getByLabel('分组成员 Suite').selectOption('a');
    await page.getByLabel('分组成员标签').fill('smoke');
    await page.getByRole('button', { name: '添加全部筛选结果', exact: true }).click();
    await expect(page.getByRole('heading', { name: '已选成员与顺序 · 503', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '添加全部筛选结果', exact: true })).toBeDisabled();
    await expect(page.getByTestId('group-member-row')).toHaveCount(50);
    await page.getByRole('button', { name: '清空已选成员', exact: true }).click();
    await page.getByLabel('搜索分组成员用例').fill('用例0000');
    await expect(page.getByTestId('group-candidate-row')).toHaveCount(1);
    await page.getByLabel('选择成员 用例0000', { exact: true }).check();
    await page.getByLabel('分组成员 Suite').selectOption('all');
    await page.getByLabel('分组成员标签').fill('');
    await page.getByLabel('搜索分组成员用例').fill('用例0001');
    await page.getByLabel('选择成员 用例0001', { exact: true }).check();
    await page.getByLabel('仅显示已选成员').check();
    await expect(page.getByTestId('group-candidate-row')).toHaveCount(1);
    await page.getByRole('button', { name: '上移成员 用例0001', exact: true }).click();
    await expect(page.getByTestId('group-member-row').first()).toHaveAttribute('data-case-id', 'c1');
    await page.getByLabel('分组名称', { exact: true }).fill('新建回归组');
    await page.getByLabel('分组说明', { exact: true }).fill('跨 Suite 的有序组合');
    await page.screenshot({ path: path.join(data, 'group-editor.png') });
    await page.getByRole('button', { name: '保存分组', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.getByLabel('搜索分组或用例').fill('新建回归组');
    await expect(page.getByTestId('group-list-row')).toHaveCount(1);
    await page.getByRole('button', { name: '编辑分组 新建回归组', exact: true }).click();
    await page.getByLabel('分组名称', { exact: true }).fill('已编辑回归组');
    await app.evaluate(() => { (globalThis as any).groupConflict = true; });
    await page.getByRole('button', { name: '保存分组', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('输入内容已保留');
    await expect(page.getByLabel('分组名称', { exact: true })).toHaveValue('已编辑回归组');
    await expect(page.getByTestId('group-member-row').first()).toHaveAttribute('data-case-id', 'c1');
    await page.getByRole('button', { name: '取消编辑', exact: true }).click();
    await page.getByRole('button', { name: '刷新', exact: true }).click();
    await page.getByRole('button', { name: '编辑分组 新建回归组', exact: true }).click();
    await page.getByLabel('分组名称', { exact: true }).fill('已编辑回归组');
    await page.getByRole('button', { name: '保存分组', exact: true }).click();
    await page.getByLabel('搜索分组或用例').fill('已编辑回归组');
    await page.getByLabel('选择分组 已编辑回归组', { exact: true }).check();
    await page.getByLabel('搜索分组或用例').fill('分组0001');
    await page.getByRole('tab', { name: '关系图', exact: true }).click();
    await page.getByRole('checkbox', { name: '关系图选择分组 分组0001', exact: true }).click();
    await page.getByRole('button', { name: '上移已选分组 分组0001', exact: true }).click();
    await expect(page.getByTestId('selected-group-row').first()).toHaveAttribute('data-group-id', 'g1');
    await page.getByRole('button', { name: '运行所选分组', exact: true }).click();
    await expect(page.getByTestId('group-run-summary')).toBeVisible();
    await expect(page.getByTestId('group-run-case')).toHaveCount(3);
    await page.getByRole('button', { name: '开始批量运行', exact: true }).click();
    await expect(page.getByTestId('batch-results')).toBeVisible();
    const runInput = await app.evaluate(() => (globalThis as any).groupsCalls.find((call: any) => call.method === 'runGroups').input);
    assert.deepEqual(runInput, { projectId: 'p', environmentId: 'env', failurePolicy: 'stop', sessionId: 's', groupIds: ['g1', 'created'] });
    await page.screenshot({ path: path.join(data, 'groups-run.png') });

    await page.getByRole('button', { name: 'Groups', exact: true }).click();
    await page.getByLabel('搜索分组或用例').fill('已编辑回归组');
    await page.getByRole('button', { name: '删除分组 已编辑回归组', exact: true }).click();
    await expect(page.getByRole('dialog')).toContainText('用例及其 Workflow 保持不变');
    await page.getByRole('button', { name: '确认删除分组', exact: true }).click();
    await expect(page.getByTestId('group-list-row')).toHaveCount(0);
    const snapshot = await app.evaluate(() => ({ cases: (globalThis as any).groupsFixture.projects[0].cases.length, groups: (globalThis as any).groupsFixture.projects[0].groups.length }));
    assert.deepEqual(snapshot, { cases: 1006, groups: 1005 });
    // Create directly from the project node, including a filtered/paginated graph.
    await page.getByRole('tab', { name: '关系图', exact: true }).click();
    await page.getByLabel('搜索分组或用例').fill('分组0001');
    const projectNode = page.locator('[data-graph-node="project"]');
    const addGroup = page.getByRole('button', { name: '在项目 Groups fixture 下新建分组', exact: true });
    await page.getByLabel('搜索分组或用例').hover();
    await expect(addGroup).toHaveCSS('opacity', '0');
    await projectNode.hover();
    await expect(addGroup).toHaveCSS('opacity', '1');
    await page.getByTestId('group-graph-canvas').screenshot({ path: path.join(data, 'graph-add-hover.png') });
    await addGroup.click();
    await expect(page.getByRole('dialog')).toContainText('新建分组');
    await page.getByRole('button', { name: '取消编辑', exact: true }).click();
    assert.equal(await app.evaluate(() => (globalThis as any).groupsFixture.projects[0].groups.length), 1005);
    await page.getByLabel('搜索分组或用例').fill('没有匹配结果');
    await expect(page.locator('[data-graph-node="group"]')).toHaveCount(0);
    await addGroup.focus();
    await expect(addGroup).toHaveCSS('opacity', '1');
    await page.keyboard.press('Enter');
    await page.getByLabel('分组名称', { exact: true }).fill('从节点新建');
    await page.getByRole('button', { name: '保存分组', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByLabel('搜索分组或用例')).toHaveValue('');
    const created = page.locator('[data-graph-node="group"][data-group-id="created"]');
    await expect(created).toBeVisible();
    await expect(created).toContainText('从节点新建');
    await expect(page.locator('.react-flow__edge[data-id="project-created"]')).toHaveCount(1);
    const parentBox = await projectNode.boundingBox(), createdBox = await created.boundingBox();
    assert.ok(parentBox && createdBox && createdBox.x > parentBox.x + parentBox.width);
    await expect(page.getByRole('button', { name: '关系图上一页分组', exact: true })).toBeEnabled();
    await expect.poll(async () => {
      const node = await created.boundingBox(), canvas = await page.getByTestId('group-graph-canvas').boundingBox();
      return node && canvas ? Math.abs(node.y + node.height / 2 - canvas.y - canvas.height / 2) : Infinity;
    }).toBeLessThan(10);
    await created.getByRole('checkbox').check();
    await created.getByRole('checkbox').uncheck();
    await page.getByTestId('group-graph-canvas').screenshot({ path: path.join(data, 'graph-group-created.png') });
    assert.deepEqual(errors, []);
    console.log('Groups UI evidence:', data);
  } finally { await app?.close(); }
});
