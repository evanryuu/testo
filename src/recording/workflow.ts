import { isRecordingDescriptionVerified, type RecordedEvent } from '../shared/recording.js';
import { stringify, parseDocument, isSeq } from 'yaml';
import { z } from 'zod/v4';

export const RECORDING_VIEWPORT = { width: 1280, height: 800 } as const;

export interface RecorderEvent {
  semantic?: RecordedEvent['semantic'];
  target?: { tag?: string; role?: string; name?: string; testId?: string };
  hashId: string;
  actionType?: string;
  type?: string;
  rawPayload?: Record<string, unknown>;
  pageInfo: { width: number; height: number };
  url?: string;
  value?: string;
}
export interface RecordingStepChoice { hashId: string; mode: 'recorded' | 'ai' | 'skip'; prompt?: string; confirmedPrompt?: string }
export interface RecordingAssertion { kind: 'text' | 'ai' | 'wait'; text: string; timeoutMs?: number }
export type RecordingReviewStep =
  | { kind: 'event'; hashId: string }
  | { kind: 'check'; id: string; assertion: RecordingAssertion };

const reviewStepsSchema = z.array(z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('event'), hashId: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('check'), id: z.string().min(1), assertion: z.object({
    kind: z.enum(['text', 'ai', 'wait']), text: z.string(), timeoutMs: z.number().optional(),
  }).strict() }).strict(),
]));

const point = { x: z.number().finite().min(0).max(16383).optional(), y: z.number().finite().min(0).max(16383).optional() };
export const recordedActionSchema = z.object({
  actionType: z.enum(['Tap', 'Input', 'KeyboardPress', 'Scroll', 'DragAndDrop']),
  viewport: z.object({ width: z.number().int().positive().max(16384), height: z.number().int().positive().max(16384) }).strict().optional(),
  target: z.object({ tag: z.string().min(1).optional(), role: z.string().min(1).optional(), name: z.string().min(1).optional(), testId: z.string().min(1).optional() }).strict().optional(),
  payload: z.object({
    ...point,
    endX: z.number().finite().min(0).max(16383).optional(),
    endY: z.number().finite().min(0).max(16383).optional(),
    value: z.string().optional(),
    mode: z.enum(['replace', 'clear', 'typeOnly']).optional(),
    keyName: z.string().min(1).optional(),
    scrollType: z.enum(['singleAction', 'scrollToTop', 'scrollToBottom', 'scrollToLeft', 'scrollToRight']).optional(),
    direction: z.enum(['up', 'down', 'left', 'right']).optional(),
    distance: z.number().finite().nonnegative().optional(),
    autoDismissKeyboard: z.boolean().optional(),
  }).strict(),
}).strict().superRefine(({ actionType, payload, viewport = RECORDING_VIEWPORT }, ctx) => {
  for (const key of ['x', 'endX', 'y', 'endY'] as const) {
    const value = payload[key];
    if (value !== undefined && value >= (key.endsWith('X') || key === 'x' ? viewport.width : viewport.height)) ctx.addIssue({ code: 'custom', message: '操作坐标超出录制视口' });
  }
  if ((payload.x === undefined) !== (payload.y === undefined)) ctx.addIssue({ code: 'custom', message: 'x 和 y 必须一起提供' });
  if (actionType === 'Tap' && payload.x === undefined) ctx.addIssue({ code: 'custom', message: 'Tap 缺少录制坐标' });
  if (actionType === 'DragAndDrop' && (payload.x === undefined || payload.endX === undefined || payload.endY === undefined)) ctx.addIssue({ code: 'custom', message: '拖动需要完整的起点和终点坐标' });
  if (actionType === 'Input' && payload.value === undefined) ctx.addIssue({ code: 'custom', message: 'Input 缺少输入内容' });
  if (actionType === 'KeyboardPress' && !payload.keyName) ctx.addIssue({ code: 'custom', message: 'KeyboardPress 缺少按键' });
  if (actionType === 'Input' && payload.mode === 'clear' && payload.x === undefined) ctx.addIssue({ code: 'custom', message: '清空输入框需要录制坐标' });
});
export type RecordedAction = z.infer<typeof recordedActionSchema>;

export function buildRecordedWorkflow(input: {
  name: string;
  events: RecorderEvent[];
  choices?: RecordingStepChoice[];
  assertions?: RecordingAssertion[];
  steps?: RecordingReviewStep[];
  viewport?: { width: number; height: number };
  startUrl?: string;
  baseUrl?: string;
}): string {
  if (!input.name.trim()) throw new Error('用例名称不能为空');
  const choices = new Map((input.choices ?? []).map((choice) => [choice.hashId, choice]));
  if (choices.size !== (input.choices ?? []).length) throw new Error('录制步骤设置重复');
  const ids = new Set(input.events.map((event) => event.hashId));
  for (const id of choices.keys()) if (!ids.has(id)) throw new Error(`找不到录制步骤：${id}`);
  if (ids.size !== input.events.length) throw new Error('录制事件标识重复');
  if (input.steps !== undefined && input.assertions?.length) throw new Error('请使用 Timeline 中的检查步骤，不要重复传入末尾断言');
  const reviewSteps: RecordingReviewStep[] = input.steps === undefined
    ? [...input.events.map(event => ({ kind: 'event' as const, hashId: event.hashId })),
      ...(input.assertions ?? []).map((assertion, index) => ({ kind: 'check' as const, id: `legacy-${index}`, assertion }))]
    : reviewStepsSchema.parse(input.steps);
  const eventIds = reviewSteps.flatMap(step => step.kind === 'event' ? [step.hashId] : []);
  if (eventIds.length !== input.events.length || eventIds.some((id, index) => id !== input.events[index]?.hashId)) {
    throw new Error('Timeline 的录制事件缺失、重复或顺序发生变化，请重新检查草稿');
  }
  const checkIds = reviewSteps.flatMap(step => step.kind === 'check' ? [step.id] : []);
  if (new Set(checkIds).size !== checkIds.length) throw new Error('Timeline 的检查步骤标识重复');
  const events = new Map(input.events.map(event => [event.hashId, event]));
  const viewport = input.viewport ?? RECORDING_VIEWPORT;
  const steps: Record<string, unknown>[] = [];
  let replayActions = 0;
  for (const item of reviewSteps) {
    if (item.kind === 'check') {
      const assertion = item.assertion;
      if (!assertion.text.trim()) throw new Error(assertion.kind === 'wait' ? '等待条件不能为空' : '断言内容不能为空');
      if (assertion.kind === 'text') steps.push({ assertText: { text: assertion.text.trim() } });
      else if (assertion.kind === 'ai') steps.push({ aiAssert: assertion.text.trim() });
      else if (assertion.kind === 'wait') {
        const timeoutMs = assertion.timeoutMs ?? 60000;
        if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 300000) throw new Error('最长等待时间必须在 1 到 300 秒之间');
        steps.push({ aiWaitFor: { prompt: assertion.text.trim(), timeoutMs } });
      } else throw new Error('不支持的断言类型');
      continue;
    }
    const event = events.get(item.hashId)!;
    const payload = event.rawPayload ?? {};
    if (event.actionType === 'InitialNavigation' || (payload.implicitNavigationState === true && event.type === 'navigation')) continue;
    const choice = choices.get(event.hashId);
    if (choice?.mode === 'skip') continue;
    replayActions++;
    const actionType = event.actionType;
    if (!['Tap', 'Input', 'KeyboardPress', 'Scroll', 'Navigate', 'DragAndDrop'].includes(actionType ?? '')) throw new Error(`暂不支持录制操作：${actionType ?? event.type ?? '未知'}，请删除该步骤后重新录制`);
    if (choice?.mode === 'ai') {
      if (!choice.prompt?.trim()) throw new Error('AI 步骤需要填写操作描述');
      const prompt = choice.prompt.trim();
      if ((!isRecordingDescriptionVerified(event) || prompt !== event.semantic?.replayInstruction?.trim()) && choice.confirmedPrompt !== prompt) {
        throw new Error('请检查并确认 AI 描述后再保存，或选择按录制操作回放');
      }
      steps.push({ aiAct: prompt });
    } else if (actionType === 'Navigate') {
      const url = payload.url;
      if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) throw new Error('录制导航缺少有效的 HTTP 地址');
      steps.push({ gotoUrl: { url: recordingNavigationUrl(url, input.baseUrl) } });
    } else {
      if (event.pageInfo.width !== viewport.width || event.pageInfo.height !== viewport.height) throw new Error('坐标回放步骤的视口发生变化，请保持 Chrome 窗口尺寸后重新录制');
      // The official recorder already coalesces typeOnly input. Preserve its value and mode exactly.
      const { actionType: _actionType, ...parameters } = payload;
      const action = recordedActionSchema.parse({ actionType, payload: parameters, ...(event.target ? { target: event.target } : {}), ...(input.viewport ? { viewport } : {}) });
      steps.push({ recordedAction: action });
    }
  }
  if (!replayActions) throw new Error('请至少录制一个操作');
  const needsViewport = steps.some(step => 'recordedAction' in step);
  steps.unshift({ gotoUrl: { url: recordingNavigationUrl(input.startUrl, input.baseUrl) } });
  if (needsViewport) steps.unshift(input.viewport ? { requireViewport: viewport } : { setViewportSize: viewport });
  return stringify({ cases: [{ name: input.name.trim(), steps }], afterEach: [{ recordToReport: '录制回放结束时的页面' }] });
}

// Only URLs produced by a new recording are parameterized; saved YAML is never migrated implicitly.
export function recordingNavigationUrl(url?: string, baseUrl?: string): string {
  if (!url) return '${baseUrl}';
  if (!baseUrl) return url;
  const target = new URL(url), base = new URL(baseUrl);
  if (target.origin !== base.origin) return url;
  if (target.href === base.href || (target.pathname.replace(/\/$/, '') === base.pathname.replace(/\/$/, '') && target.search === base.search && target.hash === base.hash)) return '${baseUrl}';
  return '${baseOrigin}' + target.pathname + target.search + target.hash;
}

/** Splice only recorded actions into the original YAML AST; preserve hooks, settings and comments. */
export function mergeRecordedWorkflow(originalText: string, recordedText: string, start: number, deleteCount: number): string {
  const original = parseDocument(originalText, { uniqueKeys: true }), recorded = parseDocument(recordedText, { uniqueKeys: true });
  if (original.errors.length || recorded.errors.length) throw new Error('局部录制的 YAML 无法读取');
  const steps = original.getIn(['cases', 0, 'steps']), incoming = recorded.getIn(['cases', 0, 'steps']);
  if (!isSeq(steps) || !isSeq(incoming)) throw new Error('局部录制需要有效的步骤列表');
  if (!Number.isInteger(start) || !Number.isInteger(deleteCount) || start < 0 || deleteCount < 0 || start + deleteCount > steps.items.length) throw new Error('局部录制位置无效');
  // buildRecordedWorkflow always prepends optional viewport setup and one initial navigation.
  let prefix = 0;
  if (recorded.hasIn(['cases', 0, 'steps', 0, 'requireViewport']) || recorded.hasIn(['cases', 0, 'steps', 0, 'setViewportSize'])) prefix++;
  if (!recorded.hasIn(['cases', 0, 'steps', prefix, 'gotoUrl'])) throw new Error('录制缺少初始导航');
  prefix++;
  steps.items.splice(start, deleteCount, ...incoming.items.slice(prefix));
  return original.toString();
}
