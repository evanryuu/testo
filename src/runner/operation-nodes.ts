import { defineNode, type NodeExecutionContext, type NodeInputSchema } from '@midscene/test';
import { aiTapInputSchema, insightOptionsInputSchema, locateOptionsInputSchema, userPromptInputSchema } from '@midscene/test/midscene';
import type { PlaywrightAgent } from '@midscene/web/playwright';
import type { Page } from 'playwright';
import { z } from 'zod/v4';

const text = z.string().trim().min(1);
const timeoutMs = z.number().int().positive().max(25000).default(10000);
const locatorInput = z.object({ selector: text, timeoutMs }).strict();
const navigationInput = z.object({ timeoutMs }).strict();
const role = z.enum(['alert', 'alertdialog', 'application', 'article', 'banner', 'blockquote', 'button', 'caption', 'cell', 'checkbox', 'code', 'columnheader', 'combobox', 'complementary', 'contentinfo', 'definition', 'deletion', 'dialog', 'directory', 'document', 'emphasis', 'feed', 'figure', 'form', 'generic', 'grid', 'gridcell', 'group', 'heading', 'img', 'insertion', 'link', 'list', 'listbox', 'listitem', 'log', 'main', 'marquee', 'math', 'meter', 'menu', 'menubar', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'navigation', 'none', 'note', 'option', 'paragraph', 'presentation', 'progressbar', 'radio', 'radiogroup', 'region', 'row', 'rowgroup', 'rowheader', 'scrollbar', 'search', 'searchbox', 'separator', 'slider', 'spinbutton', 'status', 'strong', 'subscript', 'superscript', 'switch', 'tab', 'table', 'tablist', 'tabpanel', 'term', 'textbox', 'time', 'timer', 'toolbar', 'tooltip', 'tree', 'treegrid', 'treeitem']);

export const playwrightOperationNames = new Set(['click_by_text', 'click_by_role', 'click_by_test_id', 'click', 'fill', 'press', 'hover', 'double_click', 'right_click', 'check', 'uncheck', 'select_option', 'drag_and_drop', 'reload', 'goBack', 'goForward']);
export const midsceneOperationNames = new Set(['aiHover', 'aiDoubleClick', 'aiRightClick', 'aiInput', 'aiKeyboardPress', 'aiScroll', 'aiClearInput', 'aiQuery', 'aiLocate']);

export function operationStepTimeoutMs(node: string, input: Record<string, unknown>): number | undefined {
  if (playwrightOperationNames.has(node)) return (typeof input.timeoutMs === 'number' ? input.timeoutMs : 10000) + 1000;
  return undefined;
}

export function createPlaywrightOperationNodes(getPage: () => Page) {
  function operation<S extends NodeInputSchema>(name: string, inputSchema: S, run: (page: Page, input: z.output<S>) => Promise<unknown>, stringInputKey: string | false = 'selector') {
    return defineNode({ name, inputSchema, stringInputKey, async execute(ctx) {
      ctx.signal.throwIfAborted();
      await run(getPage(), ctx.input);
      ctx.signal.throwIfAborted();
    } });
  }
  return [
    operation('click_by_text', z.object({ text, exact: z.boolean().default(true), timeoutMs }).strict(), (page, input) => page.getByText(input.text, { exact: input.exact }).click({ timeout: input.timeoutMs }), 'text'),
    operation('click_by_role', z.object({ role, name: text, exact: z.boolean().default(true), timeoutMs }).strict(), (page, input) => page.getByRole(input.role, { name: input.name, exact: input.exact }).click({ timeout: input.timeoutMs }), false),
    operation('click_by_test_id', z.object({ testId: text, timeoutMs }).strict(), (page, input) => page.getByTestId(input.testId).click({ timeout: input.timeoutMs }), 'testId'),
    ...(['click', 'hover', 'check', 'uncheck'] as const).map(name => operation(name, locatorInput, (page, input) => page.locator(input.selector)[name]({ timeout: input.timeoutMs }))),
    operation('double_click', locatorInput, (page, input) => page.locator(input.selector).dblclick({ timeout: input.timeoutMs })),
    operation('right_click', locatorInput, (page, input) => page.locator(input.selector).click({ button: 'right', timeout: input.timeoutMs })),
    operation('fill', locatorInput.extend({ value: z.string() }), (page, input) => page.locator(input.selector).fill(input.value, { timeout: input.timeoutMs }), false),
    operation('press', locatorInput.extend({ key: text }), (page, input) => page.locator(input.selector).press(input.key, { timeout: input.timeoutMs }), false),
    operation('select_option', locatorInput.extend({ value: z.union([z.string(), z.array(z.string())]) }), (page, input) => page.locator(input.selector).selectOption(input.value, { timeout: input.timeoutMs }), false),
    operation('drag_and_drop', locatorInput.extend({ targetSelector: text }), (page, input) => page.locator(input.selector).dragTo(page.locator(input.targetSelector), { timeout: input.timeoutMs }), false),
    ...(['reload', 'goBack', 'goForward'] as const).map(name => operation(name, navigationInput, (page, input) => page[name]({ timeout: input.timeoutMs }), false)),
  ];
}

type OperationAgent = Pick<PlaywrightAgent, 'aiHover' | 'aiDoubleClick' | 'aiRightClick' | 'aiInput' | 'aiKeyboardPress' | 'aiScroll' | 'aiClearInput' | 'aiQuery' | 'aiLocate'>;
export function createMidsceneOperationNodes(getAgent: (ctx: NodeExecutionContext<unknown>) => OperationAgent | Promise<OperationAgent>) {
  function operation<S extends NodeInputSchema>(name: string, inputSchema: S, run: (agent: OperationAgent, input: z.output<S>) => Promise<unknown>, stringInputKey: string | false = 'prompt') {
    return defineNode({ name, inputSchema, stringInputKey, async execute(ctx) {
      ctx.signal.throwIfAborted();
      const agent = await getAgent(ctx);
      ctx.signal.throwIfAborted();
      const data = await run(agent, ctx.input);
      ctx.signal.throwIfAborted();
      return data === undefined ? undefined : { data };
    } });
  }
  return [
    ...(['aiHover', 'aiDoubleClick', 'aiRightClick', 'aiClearInput', 'aiLocate'] as const).map(name => operation(name, aiTapInputSchema, (agent, input) => agent[name](input.prompt, input.options))),
    operation('aiInput', aiTapInputSchema.extend({ value: z.union([z.string(), z.number()]), mode: z.enum(['replace', 'clear', 'typeOnly', 'append']).optional(), options: locateOptionsInputSchema.extend({ autoDismissKeyboard: z.boolean().optional(), keyboardTypeDelay: z.number().nonnegative().optional(), inputStrategy: z.enum(['legacy', 'sequential', 'bulk']).optional() }).optional() }), (agent, input) => agent.aiInput(input.prompt, { ...input.options, value: input.value, ...(input.mode ? { mode: input.mode } : {}) }), false),
    operation('aiKeyboardPress', z.object({ prompt: userPromptInputSchema.optional(), keyName: text, options: locateOptionsInputSchema.optional() }).strict(), (agent, input) => agent.aiKeyboardPress(input.prompt, { ...input.options, keyName: input.keyName }), 'keyName'),
    operation('aiScroll', z.object({ prompt: userPromptInputSchema.optional(), direction: z.enum(['down', 'up', 'left', 'right']), distance: z.number().nonnegative().optional(), scrollType: z.enum(['singleAction', 'scrollToBottom', 'scrollToTop', 'scrollToRight', 'scrollToLeft', 'once', 'untilBottom', 'untilTop', 'untilRight', 'untilLeft']).optional(), options: locateOptionsInputSchema.optional() }).strict(), (agent, { prompt, options, ...scroll }) => agent.aiScroll(prompt, { ...options, ...scroll }), false),
    operation('aiQuery', z.object({ dataDemand: z.union([text, z.record(z.string(), z.string())]), options: insightOptionsInputSchema.optional() }).strict(), (agent, input) => agent.aiQuery(input.dataDemand, input.options), 'dataDemand'),
  ];
}
