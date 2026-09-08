import { defineNode, type NodeExecutionContext } from '@midscene/test';
import { generateElementByPoint } from '@midscene/shared/extractor';
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
  getPage(): Page;
  getAgent(ctx: NodeExecutionContext<unknown>): PlaywrightAgent | Promise<PlaywrightAgent>;
}) {
  return [
    defineNode({
      name: 'recordedAction',
      inputSchema: recordedActionSchema,
      async execute(ctx) {
        ctx.signal.throwIfAborted();
        const page = options.getPage();
        if (page.viewportSize()?.width !== 1280 || page.viewportSize()?.height !== 800) throw new Error('录制回放需要 1280 × 800 视口');
        const agent = await options.getAgent(ctx);
        // Playground's manual /interact path invokes the official action directly.
        // callActionInActionSpace always requires model settings, even for resolved pixels.
        const action = agent.interface.actionSpace().find((entry) => entry.name === ctx.input.actionType);
        if (!action) throw new Error(`Midscene 不支持操作：${ctx.input.actionType}`);
        await action.call(recordedActionParameters(ctx.input));
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
        await options.getPage().getByText(ctx.input.text, { exact: true }).filter({ visible: true }).first().waitFor({ state: 'visible', timeout: ctx.input.timeoutMs ?? 5000 });
        ctx.signal.throwIfAborted();
      },
    }),
  ];
}
