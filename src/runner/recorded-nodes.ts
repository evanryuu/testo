import { waitForStableViewport, type ViewportSize } from '../recording/viewport.js';
import { bridgeValue } from '../recording/chrome-bridge.js';
import { defineNode, type NodeExecutionContext } from '@midscene/test';
import { generateElementByPoint } from '@midscene/shared/extractor';
import type { AgentOverChromeBridge } from '@midscene/web/bridge-mode';
import type { PlaywrightAgent } from '@midscene/web/playwright';
import type { Page } from 'playwright';
import { z } from 'zod/v4';
import { recordedActionSchema, type RecordedAction } from '../recording/workflow.js';

export function recordedActionParameters({ actionType, payload }: RecordedAction): Record<string, unknown> {
  const { x, y, endX, endY, ...parameters } = payload;
  // Match Midscene Playground /interact: raw preview pixels become an official located element.
  const locate = x !== undefined && y !== undefined
    ? generateElementByPoint([Math.round(x), Math.round(y)], `recorded ${actionType}`) : undefined;
  if (actionType === 'DragAndDrop') return { from: locate, to: generateElementByPoint([Math.round(endX!), Math.round(endY!)], 'recorded drag end') };
  return { ...parameters, ...(locate ? { locate } : {}), ...(actionType === 'Scroll' && !parameters.scrollType ? { scrollType: 'singleAction' } : {}) };
}

export function createRecordedNodes(options: {
  getPage?: () => Page;
  prepareViewport?(size: ViewportSize, signal: AbortSignal): Promise<unknown>;
  onAction?(ctx: NodeExecutionContext<RecordedAction>, agent: PlaywrightAgent | AgentOverChromeBridge, stage: 'before' | 'after' | 'failed'): Promise<void>;
  getAgent(ctx: NodeExecutionContext<unknown>): PlaywrightAgent | AgentOverChromeBridge | Promise<PlaywrightAgent | AgentOverChromeBridge>;
}) {
  return [
    defineNode({
      name: 'requireViewport',
      inputSchema: z.object({ width: z.number().int().positive().max(16384), height: z.number().int().positive().max(16384) }).strict(),
      async execute(ctx) {
        if (options.getPage) {
          await options.getPage().setViewportSize(ctx.input);
          await waitForStableViewport(() => options.getPage!().evaluate(() => ({ width: innerWidth, height: innerHeight })), { expected: ctx.input, signal: ctx.signal });
          return;
        }
        if (options.prepareViewport) await options.prepareViewport(ctx.input, ctx.signal);
        else {
          const agent = await options.getAgent(ctx);
          await waitForStableViewport(() => agent.interface.size(), { expected: ctx.input, signal: ctx.signal });
        }
      },
    }),
    defineNode({
      name: 'recordedAction',
      inputSchema: recordedActionSchema,
      async execute(ctx) {
        ctx.signal.throwIfAborted();
        const agent = await options.getAgent(ctx);
        const expected = ctx.input.viewport ?? { width: 1280, height: 800 };
        if (options.prepareViewport) await options.prepareViewport(expected, ctx.signal);
        else await waitForStableViewport(() => agent.interface.size(), { expected, signal: ctx.signal });
        // Playground's manual /interact path invokes the official action directly.
        // callActionInActionSpace always requires model settings, even for resolved pixels.
        const action = agent.interface.actionSpace().find((entry) => entry.name === ctx.input.actionType);
        if (!action) throw new Error(`Midscene 不支持操作：${ctx.input.actionType}`);
        await options.onAction?.(ctx, agent, 'before');
        ctx.signal.throwIfAborted();
        const beforeClick = await waitForStableViewport(() => agent.interface.size(), { signal: ctx.signal, stableForMs: 0, timeoutMs: 1000 });
        if (beforeClick.width !== expected.width || beforeClick.height !== expected.height) throw new Error(`操作前视口发生变化：预期 ${expected.width} × ${expected.height}，实际 ${beforeClick.width} × ${beforeClick.height}；未执行操作`);
        ctx.signal.throwIfAborted();
        try {
          await action.call(recordedActionParameters(ctx.input));
        } catch (error) {
          await options.onAction?.(ctx, agent, 'failed');
          throw error;
        }
        await options.onAction?.(ctx, agent, 'after');
        await agent.recordToReport(`录制操作：${ctx.input.actionType}`);
        ctx.signal.throwIfAborted();
      },
    }),
    defineNode({
      name: 'assertText',
      stringInputKey: 'text',
      inputSchema: z.object({ text: z.string().trim().min(1), timeoutMs: z.number().int().positive().max(30000).optional() }).strict(),
      async execute(ctx) {
        ctx.signal.throwIfAborted();
        // Match a visible exact text node, never a hidden element with the same label.
        if (options.getPage) {
          await options.getPage().getByText(ctx.input.text, { exact: true }).filter({ visible: true }).first().waitFor({ state: 'visible', timeout: ctx.input.timeoutMs ?? 5000 });
        } else {
          const agent = await options.getAgent(ctx);
          const deadline = Date.now() + (ctx.input.timeoutMs ?? 5000);
          while (true) {
            ctx.signal.throwIfAborted();
            const visible = await bridgeValue((agent as AgentOverChromeBridge).interface, `(() => { const expected = ${JSON.stringify(ctx.input.text)}.replace(/\\s+/g, ' ').trim(); return [...document.querySelectorAll('body *')].some(el => el instanceof HTMLElement && el.innerText.replace(/\\s+/g, ' ').trim() === expected && el.checkVisibility({checkOpacity: true, checkVisibilityCSS: true})); })()`);
            if (visible) break;
            if (Date.now() >= deadline) throw new Error('未找到可见文本：' + ctx.input.text);
            await new Promise(resolve => setTimeout(resolve, 100));
          }
        }
        ctx.signal.throwIfAborted();
      },
    }),
  ];
}
