import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { expect } from '@playwright/test';
import { _electron as electron, type ElectronApplication } from 'playwright';
import { WorkspaceStore } from '../src/main/workspace.js';
import type { RecordingDraft } from '../src/shared/recording.js';

test('single case deletion and project removal confirm, cancel, handle conflicts and preserve project files', { timeout: 60000 }, async () => {
  mkdirSync('artifacts', { recursive: true });
  const directory = mkdtempSync(path.resolve('artifacts/deletion-ui-'));
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined && entry[0] !== 'ELECTRON_RUN_AS_NODE')),
    WORKSPACE_DATA_DIR: path.join(directory, 'data'), WORKSPACE_PROJECTS_DIR: path.join(directory, 'projects'),
  };
  let app: ElectronApplication | undefined;
  try {
    app = await electron.launch({ args: [process.cwd()], env });
    const page = await app.firstWindow(), errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.getByRole('button', { name: '新建项目', exact: true }).waitFor();
    const fixture = await page.evaluate(async () => {
      const projectId = await window.workspace.createProject({ name: 'Deletion fixture', description: '' });
      const project = (await window.workspace.state()).projects[0]!;
      const caseId = await window.workspace.createCase({ projectId, suiteId: project.suites[0]!.id, name: 'Delete this case', platforms: ['web'] });
      const keptId = await window.workspace.createCase({ projectId, suiteId: project.suites[0]!.id, name: 'Keep this case', platforms: ['web'] });
      await window.workspace.saveGroup({ projectId, name: 'Smoke', description: '', caseIds: [caseId, keptId] });
      return { projectId, caseId, keptId, root: project.root, suiteDirectory: project.suites[0]!.directory };
    });
    await page.getByRole('button', { name: /^Deletion fixture/ }).click();
    await page.getByRole('button', { name: /Delete this case/ }).click();
    await page.getByRole('button', { name: '删除用例', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('运行历史和报告保留');
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Delete this case', exact: true })).toBeVisible();
    assert.equal((await page.evaluate(() => window.workspace.state())).projects[0]!.cases.length, 2);
    await page.getByRole('button', { name: '删除用例', exact: true }).click();
    const caseDirectory = path.join(fixture.root, fixture.suiteDirectory, fixture.caseId);
    const caseFile = path.join(caseDirectory, 'case.yaml');
    writeFileSync(caseFile, readFileSync(caseFile, 'utf8').replace('Delete this case', 'Updated case'));
    await dialog.getByRole('button', { name: '确认删除用例', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('修改或删除');
    assert.ok(existsSync(caseFile));
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    await page.getByRole('button', { name: '刷新', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Updated case', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '删除用例', exact: true }).click();
    await page.screenshot({ path: path.join(directory, 'delete-case-confirmation.png'), animations: 'disabled' });
    await dialog.getByRole('button', { name: '确认删除用例', exact: true }).click();
    await expect(page.getByRole('heading', { name: /^Test Cases/ })).toBeVisible();
    await expect(page.getByTestId('case-list-row')).toHaveCount(1);
    assert.ok(!existsSync(caseDirectory));
    const remaining = (await page.evaluate(() => window.workspace.state())).projects[0]!;
    assert.deepEqual(remaining.groups![0]!.caseIds, [fixture.keptId]);
    await page.getByRole('button', { name: /^Projects/ }).click();
    await page.getByRole('button', { name: '移除项目', exact: true }).click();
    await expect(dialog).toContainText('本地项目文件、用例、运行历史和报告都会保留');
    await page.screenshot({ path: path.join(directory, 'remove-project-confirmation.png'), animations: 'disabled' });
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    assert.equal((await page.evaluate(() => window.workspace.state())).projects.length, 1);
    await page.getByRole('button', { name: '移除项目', exact: true }).click();
    await dialog.getByRole('button', { name: '确认移除项目', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Deletion fixture/ })).toHaveCount(0);
    assert.ok(existsSync(path.join(fixture.root, fixture.suiteDirectory, fixture.keptId, 'case.yaml')));
    assert.deepEqual((await page.evaluate(() => window.workspace.state())).projects, []);
    assert.deepEqual(errors, []);
    await app.close();
    app = await electron.launch({ args: [process.cwd()], env });
    const restoredPage = await app.firstWindow();
    await restoredPage.getByRole('button', { name: '新建项目', exact: true }).waitFor();
    assert.deepEqual((await restoredPage.evaluate(() => window.workspace.state())).projects, []);
    // Only the native directory picker is stubbed; opening uses the real IPC and store.
    await app.evaluate(({ dialog }, root) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [root] }); }, fixture.root);
    await restoredPage.getByRole('button', { name: '打开项目', exact: true }).click();
    await expect(restoredPage.getByRole('heading', { name: /^Test Cases/ })).toBeVisible();
    await expect(restoredPage.getByTestId('case-list-row')).toHaveCount(1);
    assert.deepEqual((await restoredPage.evaluate(() => window.workspace.state())).projects[0], remaining);
    await restoredPage.getByRole('button', { name: /^Projects/ }).click();
    await restoredPage.screenshot({ path: path.join(directory, 'project-restored.png'), animations: 'disabled' });
    console.log('Deletion UI evidence:', directory);
  } finally { await app?.close(); }
});

test('UI and IPC prevent deletion during a run or while a stopped recording is unsaved', { timeout: 60000 }, async () => {
  mkdirSync('artifacts', { recursive: true });
  const directory = mkdtempSync(path.resolve('artifacts/deletion-guards-'));
  const dataDir = path.join(directory, 'data'), projectsDir = path.join(directory, 'projects');
  const store = new WorkspaceStore(dataDir, projectsDir);
  const projectId = store.create('Protected project', '');
  const caseId = store.createCase(projectId, 'Protected case', store.project(projectId).suites[0]!.id, ['web']);
  const project = store.project(projectId), item = project.cases[0]!, workflowId = item.workflows[0]!.id;
  const draft: RecordingDraft = { id: 'stopped-draft', projectId, caseId, workflowId, environmentId: project.environments[0]!.id, caseName: item.name, baseUrl: 'http://localhost:3000', revision: '', status: 'review', browserMode: 'isolated', events: [], createdAt: new Date().toISOString() };
  writeFileSync(path.join(dataDir, 'recording-draft.json'), JSON.stringify(draft));
  const server = createServer((_request, response) => response.end('<h1>Deletion guard fixture</h1>'));
  let app: ElectronApplication | undefined;
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    store.saveEnvironment({ projectId, id: project.environments[0]!.id, name: 'Local', baseUrl: `http://127.0.0.1:${address.port}` });
    store.saveWorkflow({ projectId, caseId, workflowId, ...store.workflow(projectId, caseId, workflowId), text: readFileSync('tests/fixtures/cancelled.yaml', 'utf8') });
    app = await electron.launch({ args: [process.cwd()], env: {
      ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined && entry[0] !== 'ELECTRON_RUN_AS_NODE')),
      WORKSPACE_DATA_DIR: dataDir, WORKSPACE_PROJECTS_DIR: projectsDir,
    } });
    const page = await app.firstWindow();
    await page.getByRole('button', { name: '新建项目', exact: true }).waitFor();
    async function checkBlocked(message: RegExp) {
      await expect(page.getByRole('button', { name: '移除项目', exact: true })).toBeDisabled();
      await page.getByRole('button', { name: /^Protected project/ }).click();
      await page.getByRole('button', { name: /Protected case/ }).click();
      await expect(page.getByRole('button', { name: '删除用例', exact: true })).toBeDisabled();
      const errors = await page.evaluate(async () => {
        const p = (await window.workspace.state()).projects[0]!, c = p.cases[0]!;
        const errors: string[] = [];
        try { await window.workspace.removeProject({ projectId: p.id }); } catch (error) { errors.push(String(error)); }
        try { await window.workspace.bulkCases({ projectId: p.id, cases: [{ id: c.id, revision: c.revision }], operation: { kind: 'delete' } }); } catch (error) { errors.push(String(error)); }
        return errors;
      });
      assert.equal(errors.length, 2);
      for (const error of errors) assert.match(error, message);
      assert.equal((await page.evaluate(() => window.workspace.state())).projects[0]!.cases.length, 1);
      await page.getByRole('button', { name: /^Projects/ }).click();
    }
    await checkBlocked(/未保存的录制/);
    await page.evaluate(() => window.workspace.discardRecording({ id: 'stopped-draft' }));
    await expect(page.getByRole('button', { name: '移除项目', exact: true })).toBeEnabled();
    await page.evaluate(async () => {
      const p = (await window.workspace.state()).projects[0]!, c = p.cases[0]!;
      await window.workspace.run({ projectId: p.id, caseId: c.id, workflowId: c.workflows[0]!.id, environmentId: p.environments[0]!.id });
    });
    await checkBlocked(/当前运行或浏览器连接/);
    await page.evaluate(() => window.workspace.cancelRun());
    await expect.poll(async () => (await page.evaluate(() => window.workspace.state())).activeRunId, { timeout: 30000 }).toBeUndefined();
    await expect(page.getByRole('button', { name: '移除项目', exact: true })).toBeEnabled();
  } finally {
    await app?.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
