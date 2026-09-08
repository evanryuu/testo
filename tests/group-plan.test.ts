import assert from 'node:assert/strict';
import { test } from 'node:test';
import { expandGroups } from '../src/main/group-plan.js';
import type { Project, TestGroup } from '../src/shared/workspace.js';
const group = (id: string, caseIds: string[]): TestGroup => ({ id, name: id, description: '', revision: 'version', caseIds });
function project(count = 4): Project {
  return { id: 'p', name: 'p', description: '', root: '', suites: [], environments: [], errors: [],
    cases: Array.from({ length: count }, (_, i) => ({ id: String(i), name: `Case ${i}`, description: '', suiteId: 'suite', priority: 'P1', tags: [], revision: 'r', workflows: [{ id: 'w', platform: 'web', definitionPath: 'web.yaml', ready: true }] })),
    groups: [group('A', ['2', '0']), group('B', ['0', '1']), group('C', ['3'])] };
}
test('multiple saved groups keep selection/member order and run shared cases once', () => {
  const p = project(); const result = expandGroups(p, ['B', 'A']);
  assert.deepEqual(result.caseIds, ['0', '1', '2']);
  assert.deepEqual(result.groupNames.get('0'), ['B', 'A']);
  assert.deepEqual(result.groups, [{ id: 'B', name: 'B' }, { id: 'A', name: 'A' }]);
  p.groups![1]!.name = 'renamed'; p.groups![1]!.caseIds.reverse();
  assert.deepEqual(result.caseIds, ['0', '1', '2']);
  assert.deepEqual(result.groupNames.get('0'), ['B', 'A']);
  assert.equal(result.groups[0]!.name, 'B');
});
test('group planning rejects invalid, empty, missing or unsupported members before any execution', () => {
  const p = project();
  assert.throws(() => expandGroups(p, []), /请选择/);
  assert.throws(() => expandGroups(p, ['A', 'A']), /不同/);
  assert.throws(() => expandGroups(p, ['absent']), /不存在/);
  p.groups!.push(group('empty', []), group('missing', ['gone']));
  assert.throws(() => expandGroups(p, ['A', 'empty']), /没有用例/);
  assert.throws(() => expandGroups(p, ['missing']), /修复/);
  p.cases[2]!.workflows[0]!.ready = false;
  assert.throws(() => expandGroups(p, ['A']), /没有可运行/);
});
test('thousands of reusable cases expand with deterministic deduplication', () => {
  const p = project(3000);
  p.groups = [group('first', p.cases.slice(0, 2000).map(item => item.id)), group('second', p.cases.slice(1000).map(item => item.id))];
  const plan = expandGroups(p, ['first', 'second']);
  assert.equal(plan.caseIds.length, 3000);
  assert.deepEqual(plan.caseIds, p.cases.map(item => item.id));
  assert.deepEqual(plan.groupNames.get('1500'), ['first', 'second']);
});
