import { randomUUID } from 'node:crypto';
import type { BatchRun } from '../shared/workspace.js';
import type { RunHandle } from '../runner/run.js';

/** Wait for worker cleanup before opening the next Bridge connection. */
export class BatchQueue {
  active?: BatchRun;
  result?: Promise<void>;
  private current?: Pick<RunHandle, 'runId' | 'result' | 'cancel'>;
  private cancelled = false;
  constructor(private save: (batch: BatchRun) => void) {}

  start(input: Omit<BatchRun, 'id' | 'startedAt' | 'status'>,
    launch: (index: number, batchId: string) => Pick<RunHandle, 'runId' | 'result' | 'cancel'>): string {
    if (this.active) throw new Error('已有批次正在运行');
    if (!input.items.length) throw new Error('请选择至少一个用例');
    const batch: BatchRun = { ...input, id: randomUUID(), startedAt: new Date().toISOString(), status: 'running' };
    this.cancelled = false;
    this.active = batch;
    this.save(batch);
    this.result = this.execute(batch, launch);
    return batch.id;
  }

  cancel(id: string): void {
    if (this.active?.id !== id) return;
    this.cancelled = true;
    this.current?.cancel();
  }

  private async execute(batch: BatchRun, launch: (index: number, batchId: string) => Pick<RunHandle, 'runId' | 'result' | 'cancel'>): Promise<void> {
    // Publish the batch and reserve it before starting any worker.
    await Promise.resolve();
    try {
      for (let index = 0; index < batch.items.length; index++) {
        if (this.cancelled) break;
        const item = batch.items[index]!;
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
      batch.status = this.cancelled ? 'cancelled' : batch.items.every(item => item.status === 'passed') ? 'passed' : 'failed';
      for (const item of batch.items) {
        if (item.status === 'queued') {
          item.status = 'skipped';
          item.error = this.cancelled ? '批次已取消，未执行' : '前面的用例失败，已停止后续执行';
        }
      }
    } finally {
      batch.finishedAt = new Date().toISOString();
      this.active = undefined;
      this.save(batch);
    }
  }
}
