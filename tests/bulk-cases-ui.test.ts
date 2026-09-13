import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { expect } from '@playwright/test';
import { _electron as electron, type ElectronApplication } from 'playwright';

test('case multi-selection supports filtered actions, confirmation, real Suite/Group updates and deletion', { timeout: 60000 }, async () => {
  mkdirSync('artifacts', { recursive: true });
  const directory = mkdtempSync(path.resolve('artifacts/bulk-cases-ui-'));
  let app: ElectronApplication | undefined;
  try {
    app = await electron.launch({ args: [process.cwd()], env: {
      ...Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined && e[0] !== 'ELECTRON_RUN_AS_NODE')),
      WORKSPACE_DATA_DIR: path.join(directory, 'data'), WORKSPACE_PROJECTS_DIR: path.join(directory, 'projects'),
    } });
    const page = await app.firstWindow(), errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.getByRole('button', { name: '新建项目', exact: true }).waitFor();
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]!.setSize(1100, 700); });
    const fixture = await page.evaluate(async () => {
      const projectId = await window.workspace.createProject({ name: 'Bulk UI', description: '' });
      const original = (await window.workspace.state()).projects[0]!;
      const target = await window.workspace.createSuite({ projectId, name: 'Knowledge' });
      for (const name of ['Alpha create', 'Alpha delete', 'Beta other']) await window.workspace.createCase({ projectId, name, suiteId: original.suites[0]!.id, platforms: ['web'] });
      const group = await window.workspace.saveGroup({ projectId, name: 'Smoke', description: '', caseIds: [] });
      return { projectId, target, group, root: original.root };
    });
    await page.getByRole('button', { name: /Bulk UI/ }).click();
    await expect(page.getByRole('checkbox')).toHaveCount(0);
    await expect(page.getByLabel('用例批量操作', { exact: true })).toHaveCount(0);
    await page.screenshot({ path: path.join(directory, 'normal-list.png'), animations: 'disabled' });
    await page.getByRole('button', { name: '批量操作', exact: true }).click();
    const checkbox = page.getByRole('checkbox', { name: '选择用例 Alpha create', exact: true });
    await checkbox.check();
    await page.getByRole('button', { name: '退出批量操作', exact: true }).click();
    await expect(page.getByRole('checkbox')).toHaveCount(0);
    await expect(page.getByLabel('用例批量操作', { exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: '批量操作', exact: true }).click();
    await expect(checkbox).not.toBeChecked();
    await expect(page.getByRole('status').filter({ hasText: '已选 0 个用例' })).toBeVisible();
    await checkbox.check();
    await expect(page.getByRole('heading', { name: /^Test Cases/ })).toBeVisible();
    await expect(page.getByRole('checkbox', { name: '选择全部筛选结果', exact: true })).toHaveAttribute('data-state', 'indeterminate');
    await page.getByLabel('搜索用例', { exact: true }).fill('Alpha');
    await expect(checkbox).not.toBeChecked();
    await page.getByRole('checkbox', { name: '选择全部筛选结果', exact: true }).check();
    await expect(page.getByRole('status').filter({ hasText: '已选 2 个用例' })).toBeVisible();
    await page.screenshot({ path: path.join(directory, 'selected.png'), animations: 'disabled' });
    await page.getByRole('button', { name: '加入 Group', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('Alpha create'); await expect(dialog).not.toContainText('Beta other');
    await expect(dialog.getByRole('button', { name: '确认操作', exact: true })).toBeDisabled();
    await dialog.getByLabel('目标 Group', { exact: true }).selectOption(fixture.group);
    await dialog.getByRole('button', { name: '确认操作', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    let project = await page.evaluate(async () => (await window.workspace.state()).projects[0]!);
    assert.equal(project.groups![0]!.caseIds.length, 2);
    await page.getByRole('checkbox', { name: '选择全部筛选结果', exact: true }).check();
    await page.getByRole('button', { name: '从 Group 移除', exact: true }).click();
    await dialog.getByLabel('目标 Group', { exact: true }).selectOption(fixture.group);
    await dialog.getByRole('button', { name: '确认操作', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    project = await page.evaluate(async () => (await window.workspace.state()).projects[0]!);
    assert.deepEqual(project.groups![0]!.caseIds, []); assert.equal(project.cases.length, 3);
    await page.getByRole('checkbox', { name: '选择全部筛选结果', exact: true }).check();
    await page.getByRole('button', { name: '移动到 Suite', exact: true }).click();
    await dialog.getByLabel('目标 Suite', { exact: true }).selectOption(fixture.target);
    await dialog.getByRole('button', { name: '确认操作', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    project = await page.evaluate(async () => (await window.workspace.state()).projects[0]!);
    assert.equal(project.cases.filter(item => item.suiteId === fixture.target).length, 2);
    await page.getByRole('checkbox', { name: '选择全部筛选结果', exact: true }).check();
    await page.getByRole('button', { name: '删除所选', exact: true }).click();
    await expect(dialog).toContainText('运行历史和报告保留');
    await expect(dialog.getByRole('button', { name: '确认删除用例', exact: true })).toBeInViewport();
    await page.screenshot({ path: path.join(directory, 'delete-confirmation.png'), animations: 'disabled' });
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    assert.equal((await page.evaluate(() => window.workspace.state())).projects[0]!.cases.length, 3);
    // A concurrent file edit must remain visible as an error, without deleting any case.
    await page.getByRole('button', { name: '删除所选', exact: true }).click();
    const changed = project.cases.find(item => item.name === 'Alpha delete')!;
    const file = path.join(fixture.root, project.suites.find(suite => suite.id === fixture.target)!.directory, changed.id, 'case.yaml');
    writeFileSync(file, readFileSync(file, 'utf8').replace('Alpha delete', 'Alpha updated'));
    await dialog.getByRole('button', { name: '确认删除用例', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('修改或删除');
    assert.equal((await page.evaluate(() => window.workspace.state())).projects[0]!.cases.length, 3);
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    await page.getByRole('button', { name: '刷新', exact: true }).click();
    await expect(page.getByRole('checkbox', { name: '选择用例 Alpha updated', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '删除所选', exact: true }).click();
    await dialog.getByRole('button', { name: '确认删除用例', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByTestId('case-list-row')).toHaveCount(0);
    project = await page.evaluate(async () => (await window.workspace.state()).projects[0]!);
    assert.deepEqual(project.cases.map(item => item.name), ['Beta other']);
    await page.getByLabel('搜索用例', { exact: true }).fill('');
    await page.getByRole('checkbox', { name: '选择用例 Beta other', exact: true }).check();
    await page.getByRole('button', { name: '运行所选', exact: true }).click();
    await expect(page.getByRole('heading', { name: '批量运行', exact: true })).toBeVisible();
    await page.getByRole('button', { name: /^Test Cases/ }).click();
    await expect(page.getByRole('checkbox')).toHaveCount(0);
    await page.getByRole('button', { name: '批量操作', exact: true }).click();
    await page.evaluate(async () => {
      const project = (await window.workspace.state()).projects[0]!;
      for (let index = 0; index < 30; index++) await window.workspace.createCase({ projectId: project.id, name: 'Long list ' + index, suiteId: project.suites[0]!.id, platforms: ['web'] });
    });
    await page.getByRole('button', { name: '刷新', exact: true }).click();
    await expect(page.getByTestId('case-list-row')).toHaveCount(31);
    await page.getByRole('checkbox', { name: '选择全部筛选结果', exact: true }).check();
    await page.getByRole('button', { name: '删除所选', exact: true }).click();
    await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]!; window.setMinimumSize(0, 0); window.setContentSize(800, 560); });
    await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual([800, 560]);
    await dialog.evaluate(async element => { await Promise.all(element.getAnimations().map(animation => animation.finished)); });
    const confirm = dialog.getByRole('button', { name: '确认删除用例', exact: true });
    await expect(confirm).toBeInViewport();
    const top = (await confirm.boundingBox())!.y;
    const scroll = dialog.locator(':scope > div').nth(1);
    await scroll.hover(); await page.mouse.wheel(0, 600);
    await expect.poll(() => scroll.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
    assert.ok(Math.abs((await confirm.boundingBox())!.y - top) < 2);
    await expect(confirm).toBeInViewport();
    await page.screenshot({ path: path.join(directory, 'long-confirmation-small.png'), animations: 'disabled' });
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    assert.equal((await page.evaluate(() => window.workspace.state())).projects[0]!.cases.length, 31);
    assert.deepEqual(errors, []);
    console.log('Bulk cases UI evidence:', directory);
  } finally { await app?.close(); }
});

test('native dragging moves a selection to a sidebar Suite, supports cancellation and preserves stale cases', { timeout: 60000 }, async () => {
  mkdirSync('artifacts', { recursive: true });
  const directory = mkdtempSync(path.resolve('artifacts/drag-cases-ui-'));
  let app: ElectronApplication | undefined;
  try {
    app = await electron.launch({ args: [process.cwd()], env: {
      ...Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined && e[0] !== 'ELECTRON_RUN_AS_NODE')),
      WORKSPACE_DATA_DIR: path.join(directory, 'data'), WORKSPACE_PROJECTS_DIR: path.join(directory, 'projects'),
    } });
    const page = await app.firstWindow(), errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.getByRole('button', { name: '新建项目', exact: true }).waitFor();
    const fixture = await page.evaluate(async () => {
      const projectId = await window.workspace.createProject({ name: 'Drag fixture', description: '' });
      const source = (await window.workspace.state()).projects[0]!.suites[0]!.id;
      const target = await window.workspace.createSuite({ projectId, name: 'Knowledge' });
      for (const name of ['Drag A', 'Drag B', 'Drag C']) await window.workspace.createCase({ projectId, name, suiteId: source, platforms: ['web'] });
      return { projectId, source, target };
    });
    await page.getByRole('button', { name: /Drag fixture/ }).click();
    const suite = (id: string) => page.locator(`[data-testid="suite-drop-target"][data-suite-id="${id}"]`);
    const row = (name: string) => page.getByTestId('case-list-row').filter({ has: page.getByText(name, { exact: true }) });
    async function dragOver(name: string, targetId: string) {
      const source = await row(name).getByRole('button').boundingBox(), target = await suite(targetId).boundingBox();
      assert.ok(source && target);
      await page.mouse.move(source.x + 70, source.y + source.height / 2);
      await page.mouse.down();
      await page.mouse.move(source.x + 85, source.y + source.height / 2, { steps: 4 });
      await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 12 });
      await page.mouse.move(target.x + target.width / 2 + 1, target.y + target.height / 2);
    }
    async function assignments() { return page.evaluate(async () => Object.fromEntries((await window.workspace.state()).projects[0]!.cases.map(item => [item.name, item.suiteId]))); }
    await page.getByRole('button', { name: '批量操作', exact: true }).click();
    await page.getByRole('checkbox', { name: '选择用例 Drag A', exact: true }).check();
    await page.getByRole('checkbox', { name: '选择用例 Drag B', exact: true }).check();
    await dragOver('Drag A', fixture.target);
    await expect(suite(fixture.target)).toHaveAttribute('data-drag-over', 'true');
    await expect(page.getByRole('status').filter({ hasText: '正在拖动 2 个用例' })).toBeVisible();
    await expect.poll(() => suite(fixture.target).evaluate(element => getComputedStyle(element).boxShadow)).not.toBe('none');
    await page.screenshot({ path: path.join(directory, 'drag-hover.png'), animations: 'disabled' });
    await page.mouse.up();
    await expect.poll(assignments).toEqual({ 'Drag A': fixture.target, 'Drag B': fixture.target, 'Drag C': fixture.source });
    await expect(page.getByRole('dialog')).toHaveCount(0);
    // Returning to normal mode clears the selection; single-row dragging still works.
    await page.getByRole('button', { name: '退出批量操作', exact: true }).click();
    await expect(page.getByRole('checkbox')).toHaveCount(0);
    await dragOver('Drag C', fixture.target); await page.mouse.up();
    await expect.poll(assignments).toEqual({ 'Drag A': fixture.target, 'Drag B': fixture.target, 'Drag C': fixture.target });
    await expect(suite(fixture.target)).not.toHaveAttribute('data-drag-over', 'true');
    // Dropping back on the same Suite is a no-op.
    const before = (await page.evaluate(() => window.workspace.state())).projects[0]!.cases;
    await dragOver('Drag C', fixture.target); await page.mouse.up();
    assert.deepEqual((await page.evaluate(() => window.workspace.state())).projects[0]!.cases, before);
    await dragOver('Drag C', fixture.source);
    await page.keyboard.press('Escape'); await page.mouse.up();
    await expect(page.getByRole('status').filter({ hasText: '正在拖动' })).toHaveCount(0);
    assert.deepEqual((await page.evaluate(() => window.workspace.state())).projects[0]!.cases, before);
    await dragOver('Drag C', fixture.source);
    const blank = await page.getByRole('heading', { name: /^Test Cases/ }).boundingBox(); assert.ok(blank);
    await page.mouse.move(blank.x + 10, blank.y + 10, { steps: 8 }); await page.mouse.up();
    await expect(page.getByRole('status').filter({ hasText: '正在拖动' })).toHaveCount(0);
    assert.deepEqual((await page.evaluate(() => window.workspace.state())).projects[0]!.cases, before);
    // File revisions captured when the drag starts are still checked by the existing API.
    await dragOver('Drag C', fixture.source);
    const project = (await page.evaluate(() => window.workspace.state())).projects[0]!;
    const item = project.cases.find(item => item.name === 'Drag C')!;
    const file = path.join(project.root, project.suites.find(s => s.id === fixture.target)!.directory, item.id, 'case.yaml');
    writeFileSync(file, readFileSync(file, 'utf8').replace('Drag C', 'Drag C updated'));
    await page.mouse.up();
    await expect(page.getByRole('alert')).toContainText('修改或删除');
    assert.equal((await assignments())['Drag C updated'], fixture.target);
    await page.screenshot({ path: path.join(directory, 'drag-conflict.png') });
    await page.getByRole('button', { name: '刷新', exact: true }).click();
    await row('Drag C updated').getByRole('button').click();
    await expect(page.getByRole('heading', { name: 'Drag C updated', exact: true })).toBeVisible();
    assert.deepEqual(errors, []);
    console.log('Case drag evidence:', directory);
  } finally { await app?.close(); }
});
