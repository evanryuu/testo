import { stringify } from 'yaml';
import { z } from 'zod/v4';

export const RECORDING_VIEWPORT = { width: 1280, height: 800 } as const;

export interface RecorderEvent {
  hashId: string;
  actionType?: string;
  type?: string;
  rawPayload?: Record<string, unknown>;
  pageInfo: { width: number; height: number };
  url?: string;
  value?: string;
}
export interface RecordingStepChoice { hashId: string; mode: 'recorded' | 'ai' | 'skip'; prompt?: string }
export interface RecordingAssertion { kind: 'text' | 'ai'; text: string }

const point = { x: z.number().finite().min(0).max(1279).optional(), y: z.number().finite().min(0).max(799).optional() };
export const recordedActionSchema = z.object({
  actionType: z.enum(['Tap', 'Input', 'KeyboardPress', 'Scroll', 'DragAndDrop']),
  payload: z.object({
    ...point,
    endX: z.number().finite().min(0).max(1279).optional(),
    endY: z.number().finite().min(0).max(799).optional(),
    value: z.string().optional(),
    mode: z.enum(['replace', 'clear', 'typeOnly']).optional(),
    keyName: z.string().min(1).optional(),
    scrollType: z.enum(['singleAction', 'scrollToTop', 'scrollToBottom', 'scrollToLeft', 'scrollToRight']).optional(),
    direction: z.enum(['up', 'down', 'left', 'right']).optional(),
    distance: z.number().finite().nonnegative().optional(),
    autoDismissKeyboard: z.boolean().optional(),
  }).strict(),
}).strict().superRefine(({ actionType, payload }, ctx) => {
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
}): string {
  if (!input.name.trim()) throw new Error('用例名称不能为空');
  const choices = new Map((input.choices ?? []).map((choice) => [choice.hashId, choice]));
  if (choices.size !== (input.choices ?? []).length) throw new Error('录制步骤设置重复');
  const ids = new Set(input.events.map((event) => event.hashId));
  for (const id of choices.keys()) if (!ids.has(id)) throw new Error(`找不到录制步骤：${id}`);
  const steps: Record<string, unknown>[] = [{ setViewportSize: RECORDING_VIEWPORT }, { gotoUrl: { url: '${baseUrl}' } }];
  for (const event of input.events) {
    const payload = event.rawPayload ?? {};
    if (event.actionType === 'InitialNavigation' || (payload.implicitNavigationState === true && event.type === 'navigation')) continue;
    const choice = choices.get(event.hashId);
    if (choice?.mode === 'skip') continue;
    const actionType = event.actionType;
    if (!['Tap', 'Input', 'KeyboardPress', 'Scroll', 'Navigate', 'DragAndDrop'].includes(actionType ?? '')) throw new Error(`暂不支持录制操作：${actionType ?? event.type ?? '未知'}，请删除该步骤后重新录制`);
    if (event.pageInfo.width !== 1280 || event.pageInfo.height !== 800) throw new Error('录制视口必须为 1280 × 800，请重新录制');
    if (choice?.mode === 'ai') {
      if (!choice.prompt?.trim()) throw new Error('AI 步骤需要填写操作描述');
      steps.push({ aiAct: choice.prompt.trim() });
    } else if (actionType === 'Navigate') {
      const url = payload.url;
      if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) throw new Error('录制导航缺少有效的 HTTP 地址');
      steps.push({ gotoUrl: { url } });
    } else {
      // The official recorder already coalesces typeOnly input. Preserve its value and mode exactly.
      const { actionType: _actionType, ...parameters } = payload;
      const action = recordedActionSchema.parse({ actionType, payload: parameters });
      steps.push({ recordedAction: action });
    }
  }
  if (steps.length < 3) throw new Error('请至少录制一个操作');
  for (const assertion of input.assertions ?? []) {
    if (!assertion.text.trim()) throw new Error('断言内容不能为空');
    if (assertion.kind === 'text') steps.push({ assertText: { text: assertion.text.trim() } });
    else if (assertion.kind === 'ai') steps.push({ aiAssert: assertion.text.trim() });
    else throw new Error('不支持的断言类型');
  }
  return stringify({ cases: [{ name: input.name.trim(), steps }], afterEach: [{ recordToReport: '录制回放结束时的页面' }] });
}
