import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parse, stringify } from 'yaml';
import { compileWorkflow, parseWorkflow, validateVariables } from '../src/shared/workflow-document.js';
import { recordingNavigationUrl } from '../src/recording/workflow.js';
import { targetMismatch } from '../src/shared/recorded-target.js';
import { defaultRunTimeout } from '../src/runner/run.js';

const text = stringify({ testo: { variables: { libraryName: 'default', workflowOnly: 1 }, datasets: [{ id: 'asia', name: 'Asia', variables: { libraryName: 'dataset' } }] }, beforeEach: [{ gotoUrl: '${baseUrl}' }], cases: [{ name: 'knowledge base', steps: [{ useFlow: { id: 'create' } }, { aiAct: 'disabled', testo: { disabled: true } }, { aiAssert: { prompt: '${libraryName}', $: { timeout: 10000 } }, testo: { name: 'Verify name', metric: 'first-response' } }] }], afterEach: [{ recordToReport: 'final' }] });
test('compiler expands shared steps and freezes one variable value across all operations', () => {
  const compiled = compileWorkflow(text, { defaults: { libraryName: 'project', inherited: true }, datasetId: 'asia', variables: { libraryName: 'release-123' }, flows: { create: { name: 'Create', steps: [{ aiAct: 'create ${libraryName}' }, { useFlow: { id: 'delete' } }] }, delete: { name: 'Delete', steps: [{ aiAct: 'delete ${libraryName}' }] } } });
  assert.deepEqual(compiled.variables, { inherited: true, libraryName: 'release-123', workflowOnly: 1 });
  const result = parse(compiled.text);
  assert.deepEqual(result.cases[0].steps, [{ aiAct: 'create ${libraryName}' }, { aiAct: 'delete ${libraryName}' }, { aiAssert: { prompt: '${libraryName}', $: { timeout: 10000 } } }]);
  assert.equal(result.testo, undefined);
  assert.deepEqual(compiled.stepMetadata['steps:2'], { name: 'Verify name', metric: 'first-response' });
  assert.equal(parseWorkflow(text).cases[0]!.steps.length, 3, 'editor source is unchanged');
});
test('compiler rejects missing shared steps, cycles, datasets and reserved variable overrides', () => {
  assert.throws(() => compileWorkflow(text), /找不到共享步骤/);
  assert.throws(() => compileWorkflow(text, { datasetId: 'missing' }), /找不到数据集/);
  assert.throws(() => compileWorkflow(text, { flows: { create: { name: 'Create', steps: [{ useFlow: { id: 'create' } }] } } }), /循环引用/);
  for (const name of ['baseUrl', 'baseOrigin', '__proto__']) assert.throws(() => validateVariables(JSON.parse(`{"${name}":"wrong"}`)), /变量|JSON/);
});
test('single-step requires a page condition and retains cleanup without replaying setup', () => {
  const compiled = compileWorkflow(text, { debug: { mode: 'single-step', stepIndex: 2, precondition: 'the knowledge base exists' } });
  const result = parse(compiled.text);
  assert.equal(result.beforeEach, undefined);
  assert.deepEqual(result.cases[0].steps[0], { aiWaitFor: { prompt: 'the knowledge base exists', timeoutMs: 30000 } });
  assert.equal(result.cases[0].steps.length, 2);
  assert.deepEqual(result.afterEach, [{ recordToReport: 'final' }]);
  assert.throws(() => compileWorkflow(text, { debug: { mode: 'single-step', stepIndex: 2 } }), /前置条件/);
  assert.throws(() => compileWorkflow(text, { debug: { mode: 'to-step', stepIndex: 1 } }), /停用/);
});
test('unknown native nodes and native metadata survive visual editing and compilation', () => {
  const source = 'cases:\n  - name: Custom\n    custom: preserved\n    steps:\n      - thirdPartyNode: {custom: true, $: {timeout: 2000}}\n';
  assert.deepEqual(parse(compileWorkflow(source).text), parse(source));
});
test('new recordings follow selected environment while preserving an explicit cross-origin URL', () => {
  assert.equal(recordingNavigationUrl('https://staging.example/chat', 'https://staging.example/chat'), '${baseUrl}');
  assert.equal(recordingNavigationUrl('https://staging.example/chat/new?lang=zh', 'https://staging.example/chat'), '${baseOrigin}/chat/new?lang=zh');
  assert.equal(recordingNavigationUrl('https://login.example/auth', 'https://staging.example/chat'), 'https://login.example/auth');
  assert.equal(recordingNavigationUrl('https://staging.example/chat'), 'https://staging.example/chat', 'legacy URL is preserved when recording environment is unavailable');
});
test('target checks reject an unrelated control rather than executing a coordinate click', () => {
  assert.equal(targetMismatch({ tag: 'button', role: 'button', name: 'Send' }, { tag: 'button', role: 'button', name: 'Send' }), undefined);
  assert.match(targetMismatch({ testId: 'send' }, { testId: 'delete' })!, /未执行操作/);
  assert.match(targetMismatch({ tag: 'button' }, null)!, /没有目标/);
});
test('long workflows receive time for every operation as well as explicit waits', () => {
  const steps = Array.from({ length: 250 }, () => ({ recordedAction: { actionType: 'Tap', payload: { x: 1, y: 1 } } }));
  assert.ok(defaultRunTimeout(stringify({ cases: [{ steps }] })) >= 250 * 30000);
  assert.equal(defaultRunTimeout('cases: [{steps: [{aiWaitFor: {prompt: answer, timeoutMs: 120000}}]}]'), 240000);
});

test('run timeout honors native nested dollar timeout and fixed wait units', () => {
  assert.equal(defaultRunTimeout('cases: [{steps: [{aiAct: {prompt: work, $: {timeout: 300000}}}]}]'), 420000);
  assert.equal(defaultRunTimeout('cases: [{steps: [{wait: {duration: 5, unit: min}}]}]'), 420000);
});
