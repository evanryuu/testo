import type { BatchRun, RetryMode } from '../shared/workspace.js';

/** Dependent scenarios always restart as a whole; Groups remain membership only. */
export function retryItems(batch: BatchRun, mode: RetryMode): BatchRun['items'] {
  if (batch.status === 'running') throw new Error('请等待当前批次结束');
  if (!['all', 'failed', 'unfinished'].includes(mode)) throw new Error('重跑方式无效');
  const wanted = mode === 'all' ? batch.items : batch.items.filter(item => mode === 'failed'
    ? ['failed', 'error'].includes(item.status)
    : ['queued', 'running', 'skipped', 'interrupted', 'cancelled'].includes(item.status));
  if (!wanted.length) throw new Error(mode === 'failed' ? '没有失败用例' : '没有未完成用例');
  return structuredClone(batch.dependent ? batch.items : wanted);
}
