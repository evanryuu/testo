import { defineNode, type NodeExecutionContext } from '@midscene/test';
import { bridgeValue } from '../recording/chrome-bridge.js';
import type { AgentOverChromeBridge } from '@midscene/web/bridge-mode';
import type { Page } from 'playwright';
import type { WorkerEvent } from './messages.js';
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
export type WaitProgress = Extract<WorkerEvent, { type: 'wait-progress' }>;
export function createWaitNodes(getAgent: (ctx: NodeExecutionContext<unknown>) => Pick<PlaywrightAgent, 'aiAssert'> | Promise<Pick<PlaywrightAgent, 'aiAssert'>>, options: {
  getPage?: () => Page;
  onProgress?: (event: WaitProgress) => void;
} = {}) {
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
      const waitStarted = Date.now();
      let attempt = 0;
      const step = ctx.scope === 'case' ? ctx.case : ctx.document;
      const progress = (status: WaitProgress['status'], reason?: string) => options.onProgress?.({ type: 'wait-progress', phase: step?.phase ?? 'steps', index: step?.stepIndex ?? 0, prompt, attempt, modelCalls: attempt, elapsedMs: Date.now() - waitStarted, timeoutMs, status, ...(reason ? { reason } : {}) });
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
          attempt++;
          progress('checking');
          const result = await Promise.race([
            agent.aiAssert(prompt, undefined, { keepRawResponse: true, abortSignal: signal }),
            stopped,
          ]);
          if (Date.now() >= deadline) expire();
          signal.throwIfAborted();
          if (result?.pass) { progress('passed'); return; }
          lastReason = result?.thought || result?.message || '条件尚未满足';
          progress('waiting', lastReason);
          await delay(Math.max(0, Math.min(checkIntervalMs, timeoutMs) - (Date.now() - started)), undefined, { signal });
        }
      } catch (error) {
        progress('failed', signal.aborted ? String(signal.reason) : String(error));
        if (signal.aborted) throw signal.reason;
        throw error;
      } finally {
        clearTimeout(timer);
        ctx.signal.removeEventListener('abort', onAbort);
        signal.removeEventListener('abort', stop);
      }
    },
  }), defineNode({
    name: 'waitForElement',
    stringInputKey: 'selector',
    inputSchema: elementWaitInputSchema,
    async execute(ctx) {
      const { selector, state, timeoutMs } = ctx.input;
      const started = Date.now();
      const step = ctx.scope === 'case' ? ctx.case : ctx.document;
      let attempt = 0;
      const prompt = `${selector} · ${state}`;
      const progress = (status: WaitProgress['status'], reason?: string) => options.onProgress?.({ type: 'wait-progress', phase: step?.phase ?? 'steps', index: step?.stepIndex ?? 0, prompt, attempt, modelCalls: 0, elapsedMs: Date.now() - started, timeoutMs, status, ...(reason ? { reason } : {}) });
      const check = (input: { selector: string; state: string }) => {
        const elements = [...document.querySelectorAll(input.selector)];
        const visible = elements.some(el => el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) && el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0);
        return input.state === 'attached' ? elements.length > 0 : input.state === 'detached' ? elements.length === 0 : input.state === 'visible' ? visible : !visible;
      };
      const agent = options.getPage ? undefined : await getAgent(ctx) as AgentOverChromeBridge;
      const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(timeoutMs)]);
      let stop!: () => void;
      const stopped = new Promise<never>((_, reject) => { stop = () => reject(signal.reason); signal.addEventListener('abort', stop, { once: true }); });
      try {
        while (true) {
          signal.throwIfAborted();
          attempt++;
          progress('checking');
          const passed = await Promise.race([options.getPage ? options.getPage().evaluate(check, { selector, state }) : bridgeValue(agent!.interface, `(${check.toString()})(${JSON.stringify({ selector, state })})`), stopped]);
          signal.throwIfAborted();
          if (passed) { progress('passed'); return; }
          progress('waiting', '元素尚未满足条件');
          await delay(100, undefined, { signal });
        }
      } catch (error) {
        const reason = ctx.signal.aborted ? ctx.signal.reason : signal.aborted ? new Error(`等待元素超时（${timeoutMs / 1000} 秒）：${prompt}`) : error;
        progress('failed', String(reason));
        throw reason;
      } finally { signal.removeEventListener('abort', stop); }
    },
  })];
}

export const elementWaitInputSchema = z.object({
  selector: z.string().trim().min(1),
  state: z.enum(['visible', 'hidden', 'attached', 'detached']).default('visible'),
  timeoutMs: z.number().int().min(1000).max(300000).default(30000),
}).strict();
