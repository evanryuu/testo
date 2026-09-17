import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { WorkspaceStore } from '../src/main/workspace.js';
import { HistoryStore } from '../src/main/history.js';

function setup() {
  mkdirSync('artifacts', { recursive: true });
  const dir = mkdtempSync(path.resolve('artifacts/workspace-'));
  return { dir, store: new WorkspaceStore(path.join(dir, 'data'), path.join(dir, 'projects')) };
}
test('project, suite, business case and environment survive a store reload', () => {
  const { dir, store } = setup();
  const id = store.create('LongbridgeAI', 'Local verification');
  const suiteId = store.createSuite(id, 'Chat');
  const caseId = store.createCase(id, 'Send message', suiteId, ['web', 'android']);
  store.saveEnvironment({ projectId: id, name: 'Staging', baseUrl: 'https://staging.example.com' });
  const restored = new WorkspaceStore(path.join(dir, 'data'), path.join(dir, 'projects')).project(id);
  assert.equal(restored.cases[0]?.id, caseId);
  assert.equal(restored.cases[0]?.workflows.length, 2);
  assert.equal(restored.environments.length, 2);
  assert.equal(restored.errors.length, 0);
});
test('external edits are preserved when an outdated editor tries to save', () => {
  const { store } = setup();
  const id = store.create('Test', '');
  const caseId = store.createCase(id, 'Original', store.project(id).suites[0]!.id, ['web']);
  const location = store.caseLocation(id, caseId);
  writeFileSync(location.file, readFileSync(location.file, 'utf8').replace('Original', 'Externally changed'));
  assert.throws(() => store.saveCase({ projectId: id, caseId, revision: location.item.revision, name: 'Overwrite', description: '', priority: 'P0', tags: [] }), /外部修改/);
  assert.equal(store.project(id).cases[0]?.name, 'Externally changed');
});
test('removing a project persists without changing its files, other projects or history and allows reopening', () => {
  const { dir, store } = setup();
  const id = store.create('Remove me', 'Keep my files');
  const otherId = store.create('Keep me', '');
  const caseId = store.createCase(id, 'Preserved case', store.project(id).suites[0]!.id, ['web']);
  const original = store.project(id), other = store.project(otherId);
  const file = store.caseLocation(id, caseId).file;
  const text = readFileSync(file, 'utf8');
  const history = new HistoryStore(path.join(dir, 'runs.db'));
  history.save({ projectId: id, caseId, caseName: 'Preserved case', runId: 'preserved-run', environment: 'Local', status: 'passed', startedAt: new Date().toISOString(), events: [] });
  assert.throws(() => store.removeProject('unknown'), /项目不存在/);
  assert.equal(store.list().projects.length, 2);
  store.removeProject(id);
  assert.deepEqual(store.list().projects, [other]);
  assert.equal(readFileSync(file, 'utf8'), text);
  assert.equal(history.list()[0]?.runId, 'preserved-run');
  const reloaded = new WorkspaceStore(path.join(dir, 'data'), path.join(dir, 'projects'));
  assert.deepEqual(reloaded.list().projects, [other]);
  assert.equal(reloaded.open(original.root), id);
  assert.deepEqual(reloaded.project(id), original);
});
test('workflow import preserves identity and rejects stale writes', () => {
  const { store } = setup();
  const projectId = store.create('Test', '');
  const caseId = store.createCase(projectId, 'Case', store.project(projectId).suites[0]!.id, ['web']);
  const workflowId = store.project(projectId).cases[0]!.workflows[0]!.id;
  const input = { projectId, caseId, workflowId, ...store.workflow(projectId, caseId, workflowId) };
  store.saveWorkflow({ ...input, text: 'cases:\n  - name: Open\n    steps:\n      - gotoUrl: {url: "${baseUrl}"}\n' });
  assert.equal(store.project(projectId).cases[0]!.workflows[0]!.ready, true);
  assert.equal(store.project(projectId).cases[0]!.workflows[0]!.id, workflowId);
  assert.throws(() => store.saveWorkflow({ ...input, text: '# overwriting' }), /外部修改/);
});
test('workspace paths cannot escape the project root', () => {
  const { store } = setup();
  const id = store.create('Test', '');
  const p = store.project(id), file = path.join(p.root, 'workspace.yaml');
  writeFileSync(file, readFileSync(file, 'utf8').replace('cases/general', '../outside'));
  assert.ok(store.list().errors.some((e) => e.includes('超出项目目录')));
});
test('SQLite restores running records as interrupted after restart', () => {
  const { dir } = setup();
  const first = new HistoryStore(path.join(dir, 'runs.db'));
  first.save({ runId: 'run-1', caseId: 'case-1', projectId: 'project-1', caseName: 'Send message', environment: 'Local', status: 'running', startedAt: new Date().toISOString(), events: [] });
  const second = new HistoryStore(path.join(dir, 'runs.db'));
  assert.equal(second.list()[0]?.status, 'interrupted');
});
