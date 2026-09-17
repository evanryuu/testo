import type { BatchRun, RetryMode } from '../shared/workspace.js';

/** Dependent scenarios always restart as a whole; Groups remain membership only. */
export function retryItems(batch: BatchRun, mode: RetryMode): BatchRun['items'] {
  return structuredClone(retryItemIndexes(batch, mode).map(index => batch.items[index]!));
}

export function retryItemIndexes(batch: BatchRun, mode: RetryMode): number[] {
  if (batch.status === 'running') throw new Error('请等待当前批次结束');
  if (!['all', 'failed', 'unfinished'].includes(mode)) throw new Error('重跑方式无效');
  const indexes = batch.items.map((_, index) => index);
  const wanted = mode === 'all' ? indexes : indexes.filter(index => mode === 'failed'
    ? ['failed', 'error'].includes(batch.items[index]!.status)
    : ['queued', 'running', 'skipped', 'interrupted', 'cancelled'].includes(batch.items[index]!.status));
  if (!wanted.length) throw new Error(mode === 'failed' ? '没有失败用例' : '没有未完成用例');
  return batch.dependent ? indexes : wanted;
}
