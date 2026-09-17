import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { BatchQueue } from '../src/main/batch.js';
import { HistoryStore } from '../src/main/history.js';
import { retryItems } from '../src/main/batch-retry.js';
import type { BatchRun } from '../src/shared/workspace.js';
import type { RunResult } from '../src/runner/messages.js';

const input = (failurePolicy: 'stop' | 'continue' = 'stop') => ({ projectId: 'p', environment: 'local', failurePolicy,
  items: ['first', 'second', 'third'].map(caseId => ({ caseId, caseName: caseId, workflowId: 'web', sessionName: '已登录窗口', status: 'queued' as const })) });
const result = (status: RunResult['status'] = 'passed'): RunResult => ({ runId: 'r', status, startedAt: '', finishedAt: '', durationMs: 0, artifactDirectory: '', reportPaths: [], runnerVersion: '1.12.4' });
function deferred() { let resolve!: (value: RunResult) => void; const promise = new Promise<RunResult>(r => { resolve = r; }); return { promise, resolve }; }
const tick = () => new Promise(resolve => setImmediate(resolve));

test('batch holds one connection until worker cleanup resolves; keeps ordered independent run IDs', async () => {
  let saved!: BatchRun;
  const queue = new BatchQueue(batch => { saved = structuredClone(batch); });
  const jobs = [deferred(), deferred(), deferred()];
  const started: number[] = [];
  queue.start(input(), index => { started.push(index); return { runId: `run-${index}`, result: jobs[index]!.promise, cancel() {} }; });
  assert.equal(queue.active?.status, 'running');
  assert.throws(() => queue.start(input(), () => { throw new Error(); }), /已有批次/);
  await tick(); assert.deepEqual(started, [0]);
  assert.equal(saved.items[1]!.status, 'queued');
  jobs[0]!.resolve(result()); await tick(); assert.deepEqual(started, [0, 1]);
  jobs[1]!.resolve(result()); await tick(); assert.deepEqual(started, [0, 1, 2]);
  jobs[2]!.resolve(result()); await queue.result;
  assert.equal(saved.status, 'passed'); assert.equal(queue.active, undefined);
  assert.deepEqual(saved.items.map(i => i.runId), ['run-0', 'run-1', 'run-2']);
});

for (const policy of ['stop', 'continue'] as const) test(`batch failure policy ${policy} retains failure and controls following cases`, async () => {
  let saved!: BatchRun; const started: number[] = [];
  const queue = new BatchQueue(batch => { saved = structuredClone(batch); });
  queue.start(input(policy), index => { started.push(index); return { runId: String(index), result: Promise.resolve(result(index === 0 ? 'failed' : 'passed')), cancel() {} }; });
  await queue.result;
  assert.deepEqual(started, policy === 'stop' ? [0] : [0, 1, 2]);
  assert.equal(saved.status, 'failed');
  assert.deepEqual(saved.items.map(i => i.status), policy === 'stop' ? ['failed', 'skipped', 'skipped'] : ['failed', 'passed', 'passed']);
});

test('cancel stops current worker and never starts queued cases, even if current finishes successfully', async () => {
  let saved!: BatchRun; let cancelCount = 0; const started: number[] = []; const job = deferred();
  const queue = new BatchQueue(batch => { saved = structuredClone(batch); });
  const id = queue.start(input('continue'), index => { started.push(index); return { runId: 'one', result: job.promise, cancel() { cancelCount++; } }; });
  await tick(); queue.cancel('different-batch'); assert.equal(cancelCount, 0);
  queue.cancel(id); assert.equal(cancelCount, 1); assert.ok(queue.active);
  job.resolve(result()); await queue.result;
  assert.deepEqual(started, [0]); assert.equal(saved.status, 'cancelled');
  assert.deepEqual(saved.items.map(i => i.status), ['passed', 'skipped', 'skipped']);
});

test('cancel before first worker starts performs no browser action', async () => {
  let saved!: BatchRun; const queue = new BatchQueue(batch => { saved = structuredClone(batch); });
  const id = queue.start(input(), () => { assert.fail('must not launch'); });
  queue.cancel(id); await queue.result;
  assert.equal(saved.status, 'cancelled'); assert.ok(saved.items.every(i => i.status === 'skipped'));
});

test('launch errors release reservation and mark items rather than stranding batch', async () => {
  let saved!: BatchRun; const queue = new BatchQueue(batch => { saved = structuredClone(batch); });
  queue.start(input(), () => { throw new Error('会话已关闭'); }); await queue.result;
  assert.equal(saved.status, 'failed'); assert.equal(saved.items[0]!.error, '会话已关闭'); assert.equal(queue.active, undefined);
});

test('history keeps batch items and independent reports across reopen; unfinished batch never resumes', () => {
  const store = new HistoryStore(':memory:');
  const batch: BatchRun = { ...input(), id: 'batch', status: 'passed', startedAt: new Date().toISOString() };
  store.saveBatch(batch); assert.deepEqual(store.batches(), [batch]);
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'testo-batch-')), 'runs.db');
  const disk = new HistoryStore(file);
  disk.saveBatch({ ...batch, status: 'running', items: batch.items.map((item, index) => ({ ...item, status: index === 0 ? 'passed' : index === 1 ? 'running' : 'queued', runId: index === 0 ? 'completed' : undefined })) });
  disk.save({ runId: 'completed', batchId: batch.id, projectId: 'p', caseId: 'first', caseName: 'first', environment: 'local', startedAt: batch.startedAt, status: 'passed', events: [], result: { ...result(), reportPaths: ['local-report.html'] } });
  const reopened = new HistoryStore(file);
  assert.equal(reopened.batches()[0]!.status, 'interrupted');
  assert.deepEqual(reopened.batches()[0]!.items.map(i => i.status), ['passed', 'interrupted', 'interrupted']);
  assert.deepEqual(reopened.list()[0]!.result!.reportPaths, ['local-report.html']);
});

test('retries aggregate in the same batch, preserve passed reports and keep every attempt', async () => {
  const store = new HistoryStore(':memory:');
  const queue = new BatchQueue(batch => store.saveBatch(batch));
  const id = queue.start(input('continue'), index => ({ runId: `initial-${index}`, result: Promise.resolve(result(index === 0 ? 'passed' : 'failed')), cancel() {} }));
  await queue.result;
  const original = store.batch(id)!;
  const retry = async (statuses: RunResult['status'][]) => {
    const source = store.batch(id)!;
    const items = retryItems(source, 'failed').map(item => ({ ...item, status: 'queued' as const, runId: undefined, error: undefined }));
    const retryId = queue.start({ ...source, retryMode: 'failed', items }, index => ({ runId: `retry-${source.attempts!.length}-${index}`, result: Promise.resolve(result(statuses[index]!)), cancel() {} }), source);
    assert.equal(retryId, id);
    assert.equal(queue.active!.items[0]!.runId, 'initial-0');
    await queue.result;
    return store.batch(id)!;
  };
  const first = await retry(['passed', 'failed']);
  assert.deepEqual(first.items.map(item => item.status), ['passed', 'passed', 'failed']);
  assert.equal(first.status, 'failed');
  const final = await retry(['passed']);
  assert.equal(final.status, 'passed');
  assert.equal(store.batches().length, 1);
  assert.equal(final.startedAt, original.startedAt);
  assert.deepEqual(final.items.map(item => item.runId), ['initial-0', 'retry-1-0', 'retry-2-0']);
  assert.deepEqual(final.attempts!.map(attempt => [attempt.number, attempt.items.length, attempt.status]), [[0, 3, 'failed'], [1, 2, 'failed'], [2, 1, 'passed']]);
  assert.deepEqual(final.attempts![0], original.attempts![0]);
  const freshId = queue.start(input(), index => ({ runId: `new-${index}`, result: Promise.resolve(result()), cancel() {} }));
  await queue.result;
  assert.notEqual(freshId, id);
  assert.equal(store.batches().length, 2);
  assert.deepEqual(store.batch(id), final);
  store.close();
});

test('passing failed items does not hide unfinished items; completing them makes the batch pass', async () => {
  let saved!: BatchRun;
  const queue = new BatchQueue(batch => { saved = structuredClone(batch); });
  queue.start(input(), () => ({ runId: 'initial', result: Promise.resolve(result('failed')), cancel() {} }));
  await queue.result;
  for (const mode of ['failed', 'unfinished'] as const) {
    const source = saved;
    queue.start({ ...source, retryMode: mode, items: retryItems(source, mode).map(item => ({ ...item, status: 'queued', runId: undefined, error: undefined })) },
      index => ({ runId: `${mode}-${index}`, result: Promise.resolve(result()), cancel() {} }), source);
    await queue.result;
    assert.equal(saved.status, mode === 'failed' ? 'failed' : 'passed');
    assert.equal(saved.attempts!.at(-1)!.status, 'passed');
  }
});

test('legacy batches gain attempt history and an all-items retry replaces old passed results', async () => {
  const source: BatchRun = { ...input('continue'), id: 'legacy', startedAt: '2026-09-01T00:00:00Z', status: 'passed',
    items: input().items.map((item, index) => ({ ...item, status: 'passed', runId: `old-${index}` })) };
  let saved!: BatchRun;
  const queue = new BatchQueue(batch => { saved = structuredClone(batch); });
  queue.start({ ...source, retryMode: 'all', items: input().items }, index => ({ runId: `new-${index}`, result: Promise.resolve(result(index === 1 ? 'failed' : 'passed')), cancel() {} }), source);
  await queue.result;
  assert.equal(saved.id, source.id); assert.equal(saved.status, 'failed');
  assert.deepEqual(saved.attempts![0]!.items, source.items);
  assert.equal(saved.attempts![1]!.number, 1);
  assert.deepEqual(saved.items.map(item => item.runId), ['new-0', 'new-1', 'new-2']);
  assert.equal(source.attempts, undefined);
});

test('cancelling and reopening a retry retain previous success and synchronize attempt status', async () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'testo-batch-retry-')), 'runs.db');
  const store = new HistoryStore(file);
  const queue = new BatchQueue(batch => store.saveBatch(batch));
  const id = queue.start(input('continue'), index => ({ runId: `initial-${index}`, result: Promise.resolve(result(index === 0 ? 'passed' : 'failed')), cancel() {} }));
  await queue.result;
  let source = store.batch(id)!;
  const job = deferred();
  queue.start({ ...source, retryMode: 'failed', items: retryItems(source, 'failed').map(item => ({ ...item, status: 'queued', runId: undefined })) },
    () => ({ runId: 'cancelled-retry', result: job.promise, cancel() { job.resolve(result('cancelled')); } }), source);
  await tick(); queue.cancel(id); await queue.result;
  source = store.batch(id)!;
  assert.equal(source.status, 'cancelled');
  assert.equal(source.attempts!.at(-1)!.status, 'cancelled');
  assert.equal(source.items[0]!.runId, 'initial-0');
  const blocked = deferred();
  queue.start({ ...source, retryMode: 'unfinished', items: retryItems(source, 'unfinished').map(item => ({ ...item, status: 'queued', runId: undefined })) },
    () => ({ runId: 'interrupted-retry', result: blocked.promise, cancel() {} }), source);
  await tick();
  const reopened = new HistoryStore(file);
  const recovered = reopened.batch(id)!;
  assert.equal(recovered.status, 'interrupted');
  assert.equal(recovered.attempts!.at(-1)!.status, 'interrupted');
  assert.deepEqual(recovered.items.map(item => item.status), ['passed', 'interrupted', 'interrupted']);
  assert.deepEqual(recovered.attempts!.at(-1)!.items.map(item => item.status), ['interrupted', 'interrupted']);
  assert.deepEqual(recovered.attempts!.slice(0, 2), source.attempts);
  queue.cancel(id); blocked.resolve(result('cancelled')); await queue.result;
  reopened.close(); store.close();
});
