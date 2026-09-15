import assert from 'node:assert/strict';
import { test } from 'node:test';
import { caseSpecSchema, type CaseSpec } from '../src/shared/case-spec.js';
import { mergeCaseSpecs, splitCaseSpec } from '../src/shared/case-spec-edit.js';

function sample(id = 'case-a'): CaseSpec {
  const ref = { documentId: 'source-document', line: 3 };
  return { id, sourceId: id.toUpperCase(), title: `用例 ${id}`, description: `原文 ${id}`, path: ['模块', id], priority: 'P1', tags: ['Web'], origin: 'source', ref,
    preconditions: [{ id: 'pre-1', text: '人工准备测试账号', kind: 'manual', acknowledged: true, origin: 'source', ref }],
    data: [{ name: 'account', value: '${testUser}', origin: 'source', ref }],
    steps: [1, 2, 3, 4].map(index => ({ id: `step-${index}`, text: `操作 ${index}`, kind: 'action', origin: 'source', ref: { ...ref, line: index + 4 } })),
    expectations: [{ id: 'expected-first', text: '第一个操作完成', kind: 'semantic', afterStepId: 'step-1', origin: 'source', ref }, { id: 'expected-third', text: '第三个操作完成', kind: 'semantic', afterStepId: 'step-3', origin: 'source', ref }, { id: 'expected-final', text: '业务结果正确', kind: 'semantic', origin: 'source', ref }],
    questions: [],
  };
}
function assertReferences(spec: CaseSpec) {
  caseSpecSchema.parse(spec);
  const allIds = [...spec.steps, ...spec.preconditions, ...spec.expectations].map(item => item.id);
  assert.equal(new Set(allIds).size, allIds.length);
  const stepIds = new Set(spec.steps.map(step => step.id));
  for (const expectation of spec.expectations) if (expectation.afterStepId) assert.ok(stepIds.has(expectation.afterStepId));
}
test('split assigns step-specific assertions to their segment and final assertions to the second segment', () => {
  const original = sample(), before = structuredClone(original);
  const [first, second] = splitCaseSpec(original, 2, 'case-b');
  assert.deepEqual(original, before, 'input is immutable');
  assert.deepEqual(first.steps.map(step => step.id), ['step-1', 'step-2']);
  assert.deepEqual(second.steps.map(step => step.id), ['step-3', 'step-4']);
  assert.deepEqual(first.expectations.map(item => item.id), ['expected-first']);
  assert.deepEqual(second.expectations.map(item => item.id), ['expected-third', 'expected-final']);
  assert.equal(second.expectations[0]!.afterStepId, 'step-3');
  assert.equal(second.expectations[1]!.afterStepId, undefined);
  for (const part of [first, second]) {
    assertReferences(part); assert.equal(part.origin, 'manual');
    assert.deepEqual(part.data, original.data); assert.deepEqual(part.ref, original.ref);
    assert.equal(part.preconditions[0]!.acknowledged, false);
    assert.equal(part.questions.filter(question => question.blocks === 'generation').length, 2);
    assert.ok(part.questions.every(question => !question.resolved));
  }
  assert.deepEqual(second.steps[0]!.ref, original.steps[2]!.ref);
  const allIds = [first, second].flatMap(part => [...part.steps, ...part.preconditions, ...part.expectations].map(item => item.id));
  assert.equal(new Set(allIds).size, allIds.length);
  assert.equal(first.id, original.id); assert.equal(second.id, 'case-b');
  second.data[0]!.value = 'changed'; assert.notEqual(first.data[0]!.value, second.data[0]!.value);
});
test('split cannot silently create complete tests from fragments with no expectations', () => {
  const original = sample(); original.expectations = original.expectations.slice(2);
  const [first, second] = splitCaseSpec(original, 1, 'next');
  assert.equal(first.expectations.length, 0); assert.equal(second.expectations.length, 1);
  assert.match(first.questions.map(question => question.message).join('\n'), /没有预期结果/);
  for (const at of [0, 4, -1, 1.5]) assert.throws(() => splitCaseSpec(original, at, 'next'), /拆分位置/);
  assert.throws(() => splitCaseSpec(original, 1, original.id), /不同的有效 ID/);
});
test('merge keeps case order, unique IDs, per-case final assertion timing, data values and source references', () => {
  const first = sample(), second = sample('case-b');
  second.data[0]!.value = '${otherUser}'; second.data[0]!.ref = { documentId: 'second-source', nodeId: 'data-node' };
  second.priority = 'P0'; second.tags = ['Web', '登录'];
  const before = structuredClone([first, second]);
  const merged = mergeCaseSpecs([first, second]);
  assert.deepEqual([first, second], before);
  assertReferences(merged);
  assert.equal(merged.id, first.id); assert.equal(merged.sourceId, undefined);
  assert.deepEqual(merged.path, ['模块']); assert.equal(merged.priority, 'P0'); assert.deepEqual(merged.tags, ['Web', '登录']);
  assert.deepEqual(merged.steps.map(step => step.text), [...first.steps, ...second.steps].map(step => step.text));
  assert.equal(merged.expectations[2]!.afterStepId, merged.steps[3]!.id);
  assert.equal(merged.expectations[5]!.afterStepId, merged.steps[7]!.id);
  assert.equal(merged.expectations[3]!.afterStepId, merged.steps[4]!.id);
  assert.deepEqual(merged.data, [...first.data, ...second.data]);
  assert.deepEqual(merged.data[1]!.ref, second.data[0]!.ref);
  assert.match(merged.questions.find(question => question.code.startsWith('merge-data-conflict'))!.message, /2 个不同值/);
  assert.ok(merged.questions.some(question => question.code === 'merge-preconditions-review'));
  assert.ok(merged.preconditions.every(pre => pre.acknowledged === false));
  assert.match(merged.description, /CASE-A/); assert.match(merged.description, /CASE-B/);
});
test('merge preserves equal data with separate provenance and reports missing assertions and ambiguous empty cases', () => {
  const first = sample(), second = sample('case-b');
  second.steps = []; second.expectations = second.expectations.slice(2);
  first.expectations = [];
  const merged = mergeCaseSpecs([first, second]);
  assertReferences(merged); assert.equal(merged.data.length, 2);
  assert.ok(!merged.questions.some(question => question.code.startsWith('merge-data-conflict')));
  assert.ok(merged.questions.some(question => question.code.startsWith('merge-empty-case')));
  assert.ok(merged.questions.some(question => question.code.startsWith('merge-missing-expectation')));
  assert.throws(() => mergeCaseSpecs([first]), /至少两个/);
});
test('editing rejects ambiguous source references and schema overflow instead of dropping information', () => {
  const invalid = sample(); invalid.expectations[0]!.afterStepId = 'missing';
  assert.throws(() => splitCaseSpec(invalid, 2, 'new'), /不存在的步骤/);
  assert.throws(() => mergeCaseSpecs([sample(), invalid]), /不存在的步骤/);
  const duplicate = sample(); duplicate.steps[1]!.id = duplicate.steps[0]!.id;
  assert.throws(() => mergeCaseSpecs([sample(), duplicate]), /重复的步骤 ID/);
  const large = sample(); large.description = 'a'.repeat(10000);
  assert.throws(() => mergeCaseSpecs([large, sample('case-b')]));
});
