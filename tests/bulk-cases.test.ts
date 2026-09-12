import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync, symlinkSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { parse, stringify } from 'yaml';
import { WorkspaceStore } from '../src/main/workspace.js';
import { HistoryStore } from '../src/main/history.js';
import type { BulkCaseOperation } from '../src/shared/workspace.js';
function setup() {
  mkdirSync('artifacts', { recursive: true });
  const directory = mkdtempSync(path.resolve('artifacts/bulk-cases-'));
  const store = new WorkspaceStore(path.join(directory, 'data'), path.join(directory, 'projects'));
  const projectId = store.create('Bulk cases', '');
  const suiteId = store.project(projectId).suites[0]!.id, target = store.createSuite(projectId, 'Knowledge');
  const ids = ['Create', 'Delete', 'Other'].map(name => store.createCase(projectId, name, suiteId, ['web']));
  const apply = (operation: BulkCaseOperation, chosen = ids.slice(0, 2)) => store.bulkCases({ projectId, cases: store.project(projectId).cases.filter(item => chosen.includes(item.id)), operation });
  return { directory, store, projectId, suiteId, target, ids, apply };
}
test('bulk Suite move preserves custom directories, workflow identities, shared external files, group membership and history', () => {
  const { directory, store, projectId, target, ids, apply } = setup();
  const location = store.caseLocation(projectId, ids[0]!);
  const workflowId = location.item.workflows[0]!.id;
  const originalDirectory = path.dirname(location.file), custom = path.join(path.dirname(originalDirectory), 'custom-case');
  writeFileSync(path.join(originalDirectory, 'web.yaml'), 'cases: [{name: Create, steps: [{sleep: 10}]}]');
  writeFileSync(path.join(originalDirectory, 'fixture.txt'), 'fixture');
  renameSync(originalDirectory, custom);
  const external = path.join(location.project.root, 'shared.yaml');
  writeFileSync(external, 'cases: [{name: Shared, steps: [{sleep: 20}]}]');
  const other = store.caseLocation(projectId, ids[1]!);
  const data = parse(readFileSync(other.file, 'utf8')); data.workflows[0].definitionPath = path.relative(path.dirname(other.file), external); writeFileSync(other.file, stringify(data));
  const groupId = store.saveGroup({ projectId, name: 'Smoke', description: '', caseIds: ids });
  const history = new HistoryStore(path.join(directory, 'history.db'));
  history.save({ projectId, caseId: ids[0]!, caseName: 'Create', runId: 'old-run', environment: 'Local', status: 'passed', startedAt: new Date().toISOString(), events: [] });
  apply({ kind: 'moveSuite', suiteId: target });
  const reloaded = new WorkspaceStore(path.join(directory, 'data'), path.join(directory, 'projects'));
  const moved = reloaded.caseLocation(projectId, ids[0]!);
  assert.equal(moved.item.suiteId, target); assert.equal(path.basename(path.dirname(moved.file)), 'custom-case');
  assert.equal(moved.item.workflows[0]!.id, workflowId);
  assert.equal(readFileSync(path.join(path.dirname(moved.file), 'fixture.txt'), 'utf8'), 'fixture');
  assert.match(reloaded.workflow(projectId, ids[0]!, workflowId).text, /Create/);
  assert.equal(reloaded.workflowLocation(projectId, ids[1]!, other.item.workflows[0]!.id).file, external);
  assert.deepEqual(reloaded.project(projectId).groups!.find(group => group.id === groupId)!.caseIds, ids);
  assert.equal(history.list()[0]!.caseId, ids[0]);
  assert.deepEqual(reloaded.project(projectId).errors, []);
});
test('Group add is ordered and idempotent; removal keeps cases; delete clears all references and preserves history', () => {
  const { directory, store, projectId, ids, apply } = setup();
  const first = store.saveGroup({ projectId, name: 'First', description: '', caseIds: [ids[1]!] });
  const second = store.saveGroup({ projectId, name: 'Second', description: '', caseIds: ids });
  const group = () => store.project(projectId).groups!.find(group => group.id === first)!;
  apply({ kind: 'addGroup', groupId: first, revision: group().revision });
  apply({ kind: 'addGroup', groupId: first, revision: group().revision });
  assert.deepEqual(group().caseIds, [ids[1], ids[0]]);
  apply({ kind: 'removeGroup', groupId: first, revision: group().revision }, [ids[0]!]);
  assert.equal(store.project(projectId).cases.length, 3); assert.deepEqual(group().caseIds, [ids[1]]);
  const history = new HistoryStore(path.join(directory, 'history.db'));
  history.save({ projectId, caseId: ids[0]!, caseName: 'Create', runId: 'before-delete', environment: 'Local', status: 'passed', startedAt: new Date().toISOString(), events: [] });
  const directories = ids.slice(0, 2).map(id => path.dirname(store.caseLocation(projectId, id).file));
  apply({ kind: 'delete' });
  assert.equal(store.project(projectId).cases.length, 1);
  assert.ok(directories.every(directory => !existsSync(directory)));
  assert.deepEqual(group().caseIds, []);
  assert.deepEqual(store.project(projectId).groups!.find(group => group.id === second)!.caseIds, [ids[2]]);
  assert.equal(history.list()[0]!.caseName, 'Create');
  assert.deepEqual(store.project(projectId).errors, []);
});
test('stale case or Group revision rejects the entire batch', () => {
  const { store, projectId, ids, target } = setup();
  const snapshot = store.project(projectId).cases;
  const file = store.caseLocation(projectId, ids[1]!).file;
  writeFileSync(file, readFileSync(file, 'utf8').replace('Delete', 'Externally edited'));
  for (const operation of [{ kind: 'delete' }, { kind: 'moveSuite', suiteId: target }] as BulkCaseOperation[]) {
    assert.throws(() => store.bulkCases({ projectId, cases: snapshot, operation }), /修改或删除/);
  }
  const groupId = store.saveGroup({ projectId, name: 'Group', description: '', caseIds: [] });
  assert.throws(() => store.bulkCases({ projectId, cases: store.project(projectId).cases, operation: { kind: 'addGroup', groupId, revision: 'stale' } }), /Group 已被修改/);
  assert.equal(store.project(projectId).cases.length, 3);
  assert.equal(store.project(projectId).cases.filter(item => item.suiteId === target).length, 0);
});
test('shared inbound workflows and target collisions prevent destructive changes', () => {
  const { store, projectId, ids, target, apply } = setup();
  const selected = store.caseLocation(projectId, ids[0]!), other = store.caseLocation(projectId, ids[2]!);
  const data = parse(readFileSync(other.file, 'utf8'));
  data.workflows[0].definitionPath = path.relative(path.dirname(other.file), path.join(path.dirname(selected.file), 'web.yaml'));
  writeFileSync(other.file, stringify(data));
  assert.throws(() => apply({ kind: 'delete' }), /仍引用/);
  assert.throws(() => apply({ kind: 'moveSuite', suiteId: target }), /仍引用/);
  data.workflows[0].definitionPath = 'web.yaml'; writeFileSync(other.file, stringify(data));
  const destination = store.project(projectId).suites.find(suite => suite.id === target)!;
  const collision = path.join(selected.project.root, destination.directory, path.basename(path.dirname(selected.file)));
  mkdirSync(collision, { recursive: true });
  writeFileSync(path.join(collision, 'case.yaml'), stringify({ ...parse(readFileSync(selected.file, 'utf8')), id: 'collision', suiteId: target }));
  assert.throws(() => apply({ kind: 'moveSuite', suiteId: target }), /同名/);
  assert.ok(existsSync(selected.file));
});
test('invalid selections, symlinks and incomplete projects cannot partially delete cases', () => {
  const { store, projectId, ids, apply } = setup();
  const original = store.project(projectId).cases;
  assert.throws(() => store.bulkCases({ projectId, cases: [], operation: { kind: 'delete' } }), /请选择/);
  assert.throws(() => store.bulkCases({ projectId, cases: [original[0]!, original[0]!], operation: { kind: 'delete' } }), /重复/);
  const file = store.caseLocation(projectId, ids[0]!).file;
  symlinkSync(file, path.join(path.dirname(file), 'linked.yaml'));
  assert.throws(() => apply({ kind: 'delete' }), /符号链接/);
  writeFileSync(store.caseLocation(projectId, ids[2]!).file, 'invalid');
  assert.throws(() => apply({ kind: 'delete' }), /项目文件存在错误/);
  assert.ok(existsSync(file));
});

test('an I/O failure while moving a batch restores earlier directories and case metadata', () => {
  const { store, projectId, ids, target, apply } = setup();
  const otherSource = store.createSuite(projectId, 'Other source');
  apply({ kind: 'moveSuite', suiteId: otherSource }, [ids[0]!]);
  const project = store.project(projectId);
  const targetDirectory = path.join(project.root, project.suites.find(suite => suite.id === target)!.directory);
  mkdirSync(targetDirectory, { recursive: true });
  // The first directory can move; the second source's parent cannot be written.
  const parent = path.dirname(path.dirname(store.caseLocation(projectId, ids[1]!).file));
  const before = ids.map(id => store.caseLocation(projectId, id)).map(({ file }) => ({ file, text: readFileSync(file, 'utf8') }));
  const cases = ids.slice(0, 2).map(id => project.cases.find(item => item.id === id)!);
  chmodSync(parent, 0o500);
  try { assert.throws(() => store.bulkCases({ projectId, cases, operation: { kind: 'moveSuite', suiteId: target } }), /EACCES|EPERM/); }
  finally { chmodSync(parent, 0o700); }
  for (const item of before) assert.equal(readFileSync(item.file, 'utf8'), item.text);
  assert.deepEqual(store.project(projectId).errors, []);
  assert.equal(store.project(projectId).cases.filter(item => item.suiteId === target).length, 0);
});

test('moving selected cases preserves shared workflows even when one case already belongs to the target Suite', () => {
  const { store, projectId, ids, target, apply } = setup();
  apply({ kind: 'moveSuite', suiteId: target }, [ids[1]!]);
  const owner = store.caseLocation(projectId, ids[0]!), reference = store.caseLocation(projectId, ids[1]!);
  writeFileSync(path.join(path.dirname(owner.file), 'web.yaml'), 'shared workflow content');
  const data = parse(readFileSync(reference.file, 'utf8'));
  data.workflows[0].definitionPath = path.relative(path.dirname(reference.file), path.join(path.dirname(owner.file), 'web.yaml'));
  writeFileSync(reference.file, stringify(data));
  apply({ kind: 'moveSuite', suiteId: target });
  for (const id of ids.slice(0, 2)) {
    const item = store.caseLocation(projectId, id).item;
    assert.equal(item.suiteId, target);
    assert.equal(store.workflow(projectId, id, item.workflows[0]!.id).text, 'shared workflow content');
  }
});
