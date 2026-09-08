import { defineNode, type NodeExecutionContext } from '@midscene/test';
import type { PlaywrightAgent } from '@midscene/web/playwright';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod/v4';

export const waitInputSchema = z.object({
  prompt: z.string().trim().min(1),
  timeoutMs: z.number().int().min(1000).max(300000).default(60000),
  checkIntervalMs: z.number().int().min(100).max(30000).default(3000),
}).strict();

// The pinned SDK's aiWaitFor loop has no cancellation signal. Use its official
// assertion API for each observation; the Workspace owns only timing/cancellation.
export function createWaitNodes(getAgent: (ctx: NodeExecutionContext<unknown>) => Pick<PlaywrightAgent, 'aiAssert'> | Promise<Pick<PlaywrightAgent, 'aiAssert'>>) {
  return [defineNode({
    name: 'aiWaitFor',
    stringInputKey: 'prompt',
    inputSchema: waitInputSchema,
    async execute(ctx) {
      ctx.signal.throwIfAborted();
      const agent = await getAgent(ctx);
      ctx.signal.throwIfAborted();
      const { prompt, timeoutMs, checkIntervalMs } = ctx.input;
      const controller = new AbortController();
      const deadline = Date.now() + timeoutMs;
      let lastReason = '尚未完成检查';
      const onAbort = () => controller.abort(ctx.signal.reason);
      ctx.signal.addEventListener('abort', onAbort, { once: true });
      const expire = () => controller.abort(new Error(`等待条件超时（${timeoutMs / 1000} 秒）：${prompt}。最后检查：${lastReason}`));
      const timer = setTimeout(expire, timeoutMs);
      const { signal } = controller;
      let stop!: () => void;
      const stopped = new Promise<never>((_, reject) => {
        stop = () => reject(signal.reason);
        signal.addEventListener('abort', stop, { once: true });
      });
      try {
        while (true) {
          if (Date.now() >= deadline) expire();
          signal.throwIfAborted();
          const started = Date.now();
          const result = await Promise.race([
            agent.aiAssert(prompt, undefined, { keepRawResponse: true, abortSignal: signal }),
            stopped,
          ]);
          if (Date.now() >= deadline) expire();
          signal.throwIfAborted();
          if (result?.pass) return;
          lastReason = result?.thought || result?.message || '条件尚未满足';
          await delay(Math.max(0, Math.min(checkIntervalMs, timeoutMs) - (Date.now() - started)), undefined, { signal });
        }
      } catch (error) {
        if (signal.aborted) throw signal.reason;
        throw error;
      } finally {
        clearTimeout(timer);
        ctx.signal.removeEventListener('abort', onAbort);
        signal.removeEventListener('abort', stop);
      }
    },
  })];
}
