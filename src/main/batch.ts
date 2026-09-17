import { randomUUID } from 'node:crypto';
import type { BatchAttempt, BatchRun } from '../shared/workspace.js';
import type { RunHandle } from '../runner/run.js';
import { retryItemIndexes } from './batch-retry.js';

/** Wait for worker cleanup before opening the next Bridge connection. */
export class BatchQueue {
  active?: BatchRun;
  result?: Promise<void>;
  private current?: Pick<RunHandle, 'runId' | 'result' | 'cancel'>;
  private cancelled = false;
  constructor(private save: (batch: BatchRun) => void) {}

  start(input: Omit<BatchRun, 'id' | 'startedAt' | 'status'>,
    launch: (index: number, batchId: string) => Pick<RunHandle, 'runId' | 'result' | 'cancel'>, source?: BatchRun): string {
    if (this.active) throw new Error('已有批次正在运行');
    if (!input.items.length) throw new Error('请选择至少一个用例');
    const startedAt = new Date().toISOString();
    const indexes = source ? retryItemIndexes(source, input.retryMode!) : input.items.map((_, index) => index);
    if (indexes.length !== input.items.length) throw new Error('重跑用例与原批次不一致');
    const batch: BatchRun = source ? structuredClone(source) : { ...structuredClone(input), id: randomUUID(), startedAt, status: 'running' };
    // Legacy batches acquire their first immutable attempt when retried.
    const attempts = batch.attempts ?? (source ? [{ number: 0, startedAt: batch.startedAt, finishedAt: batch.finishedAt,
      status: batch.status, snapshot: structuredClone(batch.snapshot), items: structuredClone(batch.items) }] : []);
    const attempt: BatchAttempt = { number: attempts.length, mode: input.retryMode, startedAt, status: 'running',
      snapshot: structuredClone(input.snapshot), items: structuredClone(input.items) };
    indexes.forEach((index, position) => { batch.items[index] = attempt.items[position]!; });
    batch.snapshot = structuredClone(input.snapshot);
    batch.retryMode = input.retryMode;
    batch.status = 'running'; batch.finishedAt = undefined;
    batch.attempts = [...attempts, attempt];
    this.cancelled = false;
    this.active = batch;
    this.save(batch);
    this.result = this.execute(batch, attempt, launch);
    return batch.id;
  }

  cancel(id: string): void {
    if (this.active?.id !== id) return;
    this.cancelled = true;
    this.current?.cancel();
  }

  private async execute(batch: BatchRun, attempt: BatchAttempt, launch: (index: number, batchId: string) => Pick<RunHandle, 'runId' | 'result' | 'cancel'>): Promise<void> {
    // Publish the batch and reserve it before starting any worker.
    await Promise.resolve();
    try {
      for (let index = 0; index < attempt.items.length; index++) {
        if (this.cancelled) break;
        const item = attempt.items[index]!;
        item.status = 'running';
        this.save(batch);
        try {
          this.current = launch(index, batch.id);
          item.runId = this.current.runId;
          this.save(batch);
          const result = await this.current.result;
          item.status = result.status;
          item.error = result.error;
        } catch (error) {
          item.status = 'error';
          item.error = error instanceof Error ? error.message : String(error);
        } finally {
          this.current = undefined;
          this.save(batch);
        }
        if (item.status === 'cancelled') this.cancelled = true;
        if (item.status !== 'passed' && batch.failurePolicy === 'stop') break;
      }
      attempt.status = this.cancelled ? 'cancelled' : attempt.items.every(item => item.status === 'passed') ? 'passed' : 'failed';
      batch.status = this.cancelled ? 'cancelled' : batch.items.every(item => item.status === 'passed') ? 'passed' : 'failed';
      for (const item of attempt.items) {
        if (item.status === 'queued') {
          item.status = 'skipped';
          item.error = this.cancelled ? '批次已取消，未执行' : '前面的用例失败，已停止后续执行';
        }
      }
    } finally {
      batch.finishedAt = new Date().toISOString();
      attempt.finishedAt = batch.finishedAt;
      this.active = undefined;
      this.save(batch);
    }
  }
}
