import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { stringify } from 'yaml';
import { WorkspaceStore } from '../src/main/workspace.js';

function setup() {
  mkdirSync('artifacts', { recursive: true });
  const dir = mkdtempSync(path.resolve('artifacts/groups-'));
  const store = new WorkspaceStore(path.join(dir, 'data'), path.join(dir, 'projects'));
  const projectId = store.create('Grouped tests', '');
  const suiteId = store.project(projectId).suites[0]!.id;
  const first = store.createCase(projectId, 'First', suiteId, ['web']);
  const second = store.createCase(projectId, 'Second', suiteId, ['web']);
  return { dir, store, projectId, suiteId, first, second };
}

test('groups persist ordered shared references and deleting a group leaves cases and workflows intact', () => {
  const { dir, store, projectId, first, second } = setup();
  assert.deepEqual(store.project(projectId).groups, []);
  const id = store.saveGroup({ projectId, name: 'Smoke', description: 'Ordered checks', caseIds: [second, first] });
  const shared = store.saveGroup({ projectId, name: 'Auth', description: '', caseIds: [first] });
  const restored = new WorkspaceStore(path.join(dir, 'data'), path.join(dir, 'projects'));
  const project = restored.project(projectId), group = project.groups!.find(g => g.id === id)!;
  assert.deepEqual(group.caseIds, [second, first]);
  assert.equal(group.description, 'Ordered checks');
  const firstCase = restored.caseLocation(projectId, first);
  const before = readFileSync(firstCase.file, 'utf8');
  restored.deleteGroup(projectId, id, group.revision);
  assert.equal(readFileSync(firstCase.file, 'utf8'), before);
  assert.deepEqual(restored.project(projectId).groups!.map(g => g.id), [shared]);
  assert.equal(restored.project(projectId).cases.length, 2);
});

test('group edits preserve order and reject stale save and delete revisions', () => {
  const { store, projectId, first, second } = setup();
  const id = store.saveGroup({ projectId, name: 'Smoke', description: '', caseIds: [first, second] });
  const project = store.project(projectId), initial = project.groups![0]!;
  store.saveGroup({ projectId, ...initial, caseIds: [second, first] });
  const edited = store.project(projectId).groups![0]!;
  assert.deepEqual(edited.caseIds, [second, first]);
  assert.notEqual(initial.revision, edited.revision);
  assert.throws(() => store.saveGroup({ projectId, ...initial }), /外部修改/);
  writeFileSync(path.join(project.root, 'groups', `${id}.yaml`), readFileSync(path.join(project.root, 'groups', `${id}.yaml`), 'utf8') + '\n# external change\n');
  assert.throws(() => store.deleteGroup(projectId, id, edited.revision), /外部修改/);
  assert.equal(store.project(projectId).groups!.length, 1);
});

test('invalid groups stay local and externally missing case references remain repairable', () => {
  const { store, projectId, first, second } = setup();
  assert.throws(() => store.saveGroup({ projectId, name: 'Duplicate', description: '', caseIds: [first, first] }), /重复/);
  assert.throws(() => store.saveGroup({ projectId, name: 'Missing', description: '', caseIds: ['missing'] }), /不存在/);
  const id = store.saveGroup({ projectId, name: 'Keep references', description: '', caseIds: [first, second] });
  const project = store.project(projectId);
  writeFileSync(path.join(project.root, 'groups/broken.yaml'), 'caseIds: [unclosed');
  writeFileSync(path.join(project.root, 'groups/duplicate.yaml'), stringify({ schemaVersion: 1, id: 'duplicate', name: 'Duplicate', description: '', caseIds: [second, second] }));
  const firstFile = store.caseLocation(projectId, first).file;
  // Simulate a case removed in Git outside the application.
  rmSync(path.dirname(firstFile), { recursive: true });
  const loaded = store.project(projectId), group = loaded.groups!.find(g => g.id === id)!;
  assert.deepEqual(group.caseIds, [first, second]);
  assert.equal(loaded.cases.length, 1);
  assert.equal(loaded.groups!.length, 1);
  assert.ok(loaded.errors.some(error => error.includes('broken.yaml')));
  assert.ok(loaded.errors.some(error => error.includes('重复')));
  assert.ok(loaded.errors.some(error => error.includes('不存在')));
  assert.throws(() => store.saveGroup({ projectId, ...group }), /不存在/);
  store.saveGroup({ projectId, ...group, caseIds: [second] });
  assert.deepEqual(store.project(projectId).groups![0]!.caseIds, [second]);
});

test('group IDs and symlinks cannot overwrite or delete files outside the project', () => {
  const { dir, store, projectId, first } = setup();
  const project = store.project(projectId);
  assert.throws(() => store.saveGroup({ projectId, id: '../workspace', revision: '', name: 'Escape', description: '', caseIds: [first] }), /ID 格式/);
  assert.throws(() => store.deleteGroup(projectId, '../workspace', ''), /ID 格式/);
  const outside = path.join(dir, 'outside'); mkdirSync(outside);
  const sentinel = path.join(outside, 'sentinel.yaml'); writeFileSync(sentinel, 'unchanged');
  symlinkSync(outside, path.join(project.root, 'groups'));
  const loaded = store.project(projectId);
  assert.equal(loaded.cases.length, 2);
  assert.ok(loaded.errors.some(error => error.includes('超出项目目录')));
  assert.throws(() => store.saveGroup({ projectId, name: 'Escape', description: '', caseIds: [first] }), /超出项目目录/);
  assert.throws(() => store.deleteGroup(projectId, 'sentinel', ''), /超出项目目录/);
  assert.equal(readFileSync(sentinel, 'utf8'), 'unchanged');
});

test('one snapshot locates 1000 workflows without rescanning the project or reading workflow contents', () => {
  const { store, projectId, suiteId } = setup();
  const original = store.project(projectId), suite = original.suites.find(s => s.id === suiteId)!;
  const ids: string[] = [];
  for (let index = 0; index < 1000; index++) {
    const id = `bulk-${index}`; ids.push(id);
    const directory = path.join(original.root, suite.directory, `directory-${index}`); mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, 'case.yaml'), stringify({ schemaVersion: 1, id, name: id, suiteId, tags: [], workflows: [{ id: 'web', platform: 'web', definitionPath: 'web.yaml' }] }));
    writeFileSync(path.join(directory, 'web.yaml'), 'not parsed by the location index');
  }
  const project = store.project(projectId);
  assert.equal(project.cases.length, 1002);
  assert.equal(project.errors.length, 0);
  const originalProject = store.project;
  store.project = () => { throw new Error('unexpected project rescan'); };
  try {
    for (let index = 0; index < ids.length; index++) {
      const location = store.workflowLocationFromProject(project, ids[index]!, 'web');
      assert.equal(location.file, path.join(project.root, suite.directory, `directory-${index}`, 'web.yaml'));
      assert.equal(location.platform, 'web');
    }
  } finally { store.project = originalProject; }
  const groupId = store.saveGroup({ projectId, name: 'All 1000', description: '', caseIds: ids });
  assert.deepEqual(store.project(projectId).groups!.find(g => g.id === groupId)!.caseIds, ids);
});

test('snapshot workflow lookup rechecks symlinks changed after the snapshot was read', () => {
  const { dir, store, projectId, first } = setup();
  const project = store.project(projectId), item = project.cases.find(c => c.id === first)!;
  const location = store.workflowLocationFromProject(project, first, item.workflows[0]!.id);
  const outside = path.join(dir, 'outside.yaml'); writeFileSync(outside, 'outside');
  symlinkSync(outside, location.file);
  assert.throws(() => store.workflowLocationFromProject(project, first, item.workflows[0]!.id), /超出项目目录/);
});

test('queued snapshot refuses changed workflow mappings even when the old workflow file is unchanged', () => {
  for (const change of ['redirect', 'remove'] as const) {
    const { store, projectId, first } = setup();
    const project = store.project(projectId), item = project.cases.find(c => c.id === first)!;
    const workflowId = item.workflows[0]!.id;
    const location = store.workflowLocationFromProject(project, first, workflowId);
    writeFileSync(location.file, 'original workflow stays unchanged');
    const caseFile = store.caseLocation(projectId, first).file;
    const original = readFileSync(caseFile, 'utf8');
    writeFileSync(caseFile, change === 'redirect' ? original.replace('web.yaml', 'new.yaml') : stringify({ schemaVersion: 1, id: first, name: item.name, suiteId: item.suiteId, tags: [], workflows: [] }));
    assert.equal(readFileSync(location.file, 'utf8'), 'original workflow stays unchanged');
    assert.throws(() => store.workflowLocationFromProject(project, first, workflowId), /用例定义已修改.*重新加载/, change);
  }
});
