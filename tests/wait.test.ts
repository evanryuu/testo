import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createWaitNodes, waitInputSchema } from '../src/runner/wait-nodes.js';
import { describeRunStep } from '../src/shared/run-steps.js';

function execution(aiAssert: any, input: Record<string, unknown> = {}, signal = new AbortController().signal) {
  return Promise.resolve(createWaitNodes(() => ({ aiAssert }))[0]!.execute({
    input: waitInputSchema.parse({ prompt: 'new answer complete', timeoutMs: 1000, checkIntervalMs: 100, ...input }), signal,
  } as any));
}
test('wait observes again until a delayed condition becomes true', async () => {
  let calls = 0;
  await execution(async () => ({ pass: ++calls === 3, thought: 'still generating' }));
  assert.equal(calls, 3);
});
test('wait timeout includes condition and last observed reason', async () => {
  await assert.rejects(execution(async () => ({ pass: false, thought: 'still generating' })), /等待条件超时.*new answer complete.*still generating/);
});
test('cancel interrupts a pending observation and never checks again or accepts its late result', async () => {
  const controller = new AbortController();
  let calls = 0, observedSignal: AbortSignal | undefined;
  let release!: (value: any) => void, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const pending = execution(async (_prompt: string, _message: unknown, options: any) => {
    calls++; observedSignal = options.abortSignal; entered();
    return new Promise(resolve => { release = resolve; });
  }, {}, controller.signal);
  const rejected = assert.rejects(pending, /cancel wait/);
  await started; controller.abort(new Error('cancel wait'));
  await rejected;
  assert.equal(observedSignal?.aborted, true);
  release({ pass: true });
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.equal(calls, 1);
});
test('a hanging model request is bounded by the wait deadline', async () => {
  await assert.rejects(execution(() => new Promise(() => {})), /等待条件超时/);
});
test('cancel during the interval prevents subsequent checks', async () => {
  const controller = new AbortController();
  let calls = 0;
  const pending = execution(async () => { calls++; setTimeout(() => controller.abort(new Error('cancel interval')), 20); return { pass: false }; }, {}, controller.signal);
  await assert.rejects(pending, /cancel interval/);
  assert.equal(calls, 1);
});
test('wait schema rejects invalid limits and timeline exposes condition and time limit', () => {
  for (const timeoutMs of [0, 999, 300001, NaN]) assert.equal(waitInputSchema.safeParse({ prompt: 'x', timeoutMs }).success, false);
  const step = describeRunStep('aiWaitFor', { prompt: 'latest answer', timeoutMs: 120000 }, 'steps', 3);
  assert.match(step.detail!, /latest answer/);
  assert.match(step.detail!, /120/);
});

import { defaultRunTimeout } from '../src/runner/run.js';
test('default run duration includes both waiting windows instead of truncating them at two minutes', () => {
  assert.equal(defaultRunTimeout('cases:\n  - steps:\n      - aiWaitFor: {prompt: first, timeoutMs: 60000}\n      - aiWaitFor: {prompt: complete, timeoutMs: 120000}\n'), 300000);
  assert.equal(defaultRunTimeout('cases: []'), 120000);
});
