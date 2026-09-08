import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { waitForStableViewport } from '../src/recording/viewport.js';
import { createRecordedNodes } from '../src/runner/recorded-nodes.js';

const expected = { width: 1280, height: 800 };
const options = { timeoutMs: 150, stableForMs: 25, pollMs: 5 };

test('accepts a consistently stable positive viewport', async () => {
  let reads = 0;
  const actual = await waitForStableViewport(async () => { reads++; return expected; }, options);
  assert.deepEqual(actual, expected);
  assert.ok(reads > 1);
});

test('a brief match followed by a resize must stabilize again', async () => {
  let reads = 0;
  const actual = await waitForStableViewport(async () => {
    reads++;
    return reads === 2 ? { width: 1280, height: 760 } : expected;
  }, { ...options, expected });
  assert.deepEqual(actual, expected);
  assert.ok(reads >= 4);
});

test('a persistent mismatch reports expected and actual dimensions and the limit', async () => {
  await assert.rejects(waitForStableViewport(async () => ({ width: 1280, height: 760 }), {
    ...options, expected, timeoutMs: 50,
  }), /预期 1280 × 800.*实际 1280 × 760.*50ms/);
});

test('continuous resizing cannot count as a stable viewport', async () => {
  let reads = 0;
  await assert.rejects(waitForStableViewport(async () => ({ width: 1280, height: reads++ % 2 ? 800 : 760 }), {
    ...options, timeoutMs: 50,
  }), /视口.*稳定.*50ms/);
});

test('a hanging size read is bounded by the total timeout', async () => {
  await assert.rejects(waitForStableViewport(() => new Promise(() => {}), {
    ...options, timeoutMs: 40,
  }), /实际 未获取.*40ms/);
});

test('cancel interrupts a hanging read and removes its listener', async () => {
  const controller = new AbortController();
  const reason = new Error('cancelled by user');
  const waiting = waitForStableViewport(() => new Promise(() => {}), { ...options, signal: controller.signal });
  controller.abort(reason);
  await assert.rejects(waiting, error => error === reason);
  assert.equal(EventEmitter.getEventListeners(controller.signal, 'abort').length, 0);
});

test('transient read errors reset the stable interval and may recover', async () => {
  let reads = 0;
  const actual = await waitForStableViewport(async () => {
    if (++reads === 2) throw new Error('execution context changed');
    return expected;
  }, options);
  assert.deepEqual(actual, expected);
  assert.ok(reads >= 4);
});

test('invalid sizes and repeated read failures never pass', async () => {
  await assert.rejects(waitForStableViewport(async () => ({ width: NaN, height: 0 }), { ...options, timeoutMs: 40 }), /视口/);
  await assert.rejects(waitForStableViewport(async () => { throw new Error('disconnected'); }, { ...options, timeoutMs: 40 }), /视口/);
});

test('completion stops polling and releases cancellation listeners', async () => {
  const controller = new AbortController();
  let reads = 0;
  await waitForStableViewport(async () => { reads++; return expected; }, { ...options, signal: controller.signal });
  const finishedReads = reads;
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(reads, finishedReads);
  assert.equal(EventEmitter.getEventListeners(controller.signal, 'abort').length, 0);
});


function recordedTap(readSize: () => Promise<{ width: number; height: number }>, before?: () => void) {
  const calls: unknown[] = [];
  const agent = {
    interface: {
      size: readSize,
      actionSpace: () => [{ name: 'Tap', call: async (parameters: unknown) => { calls.push(parameters); } }],
    },
    recordToReport: async () => {},
  };
  const node = createRecordedNodes({
    getAgent: () => agent as any,
    onAction: async (_ctx, _agent, stage) => { if (stage === 'before') before?.(); },
  }).find(entry => entry.name === 'recordedAction')!;
  return {
    calls,
    execute: (signal = new AbortController().signal) => node.execute({
      input: { actionType: 'Tap', payload: { x: 742, y: 340 }, viewport: { width: 1920, height: 902 } },
      signal,
    } as any),
  };
}

test('recorded Tap waits for a transient viewport mismatch to recover and executes once', async () => {
  let reads = 0;
  const tap = recordedTap(async () => ({ width: 1920, height: ++reads === 1 ? 850 : 902 }));
  await tap.execute();
  assert.equal(tap.calls.length, 1);
  assert.ok(reads > 2, 'the real node must check stability before dispatching the click');
});

test('recorded Tap refuses a persistent mismatch and reports both dimensions', { timeout: 8000 }, async () => {
  const tap = recordedTap(async () => ({ width: 1920, height: 850 }));
  await assert.rejects(async () => tap.execute(), /预期 1920 × 902.*实际 1920 × 850.*5000ms/);
  assert.equal(tap.calls.length, 0);
});

test('cancelling viewport stabilization prevents the recorded Tap', async () => {
  const controller = new AbortController();
  let notifyRead!: () => void;
  const readStarted = new Promise<void>(resolve => { notifyRead = resolve; });
  const tap = recordedTap(async () => { notifyRead(); return { width: 1920, height: 850 }; });
  const execution = tap.execute(controller.signal);
  await readStarted;
  const reason = new Error('cancel recorded Tap');
  controller.abort(reason);
  await assert.rejects(async () => execution, error => error === reason);
  assert.equal(tap.calls.length, 0);
});

test('a resize during the before-action screenshot is blocked before the recorded Tap', async () => {
  let height = 902;
  let capturedBefore = false;
  const tap = recordedTap(async () => ({ width: 1920, height }), () => { capturedBefore = true; height = 850; });
  await assert.rejects(async () => tap.execute(), /操作前视口发生变化.*预期 1920 × 902.*实际 1920 × 850.*未执行操作/);
  assert.equal(capturedBefore, true);
  assert.equal(tap.calls.length, 0);
});

test('cancelling during the final size read never dispatches a click', async () => {
  const controller = new AbortController();
  let finalRead = false, clicked = false;
  let release!: () => void, entered!: () => void;
  const enteredRead = new Promise<void>(resolve => { entered = resolve; });
  const pendingRead = new Promise<void>(resolve => { release = resolve; });
  const agent = { interface: {
    size: async () => { if (finalRead) { entered(); await pendingRead; } return expected; },
    actionSpace: () => [{ name: 'Tap', call: async () => { clicked = true; } }],
  }, recordToReport: async () => {} } as any;
  const node = createRecordedNodes({ getAgent: () => agent, onAction: async () => { finalRead = true; } }).find(node => node.name === 'recordedAction')!;
  const pending = node.execute({ input: { actionType: 'Tap', viewport: expected, payload: { x: 50, y: 50 } }, signal: controller.signal } as any);
  const rejection = assert.rejects(Promise.resolve(pending), /stop during last read/);
  await enteredRead; controller.abort(new Error('stop during last read')); release();
  await rejection;
  assert.equal(clicked, false);
});
