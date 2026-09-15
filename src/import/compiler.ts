import { stringify } from 'yaml';
import { caseSpecSchema, type CaseIssue, type CaseSpec } from '../shared/case-spec.js';
import { type SharedFlow, type Variables, type WorkflowStep, validateVariables } from '../shared/workflow-document.js';
import { contentHash } from './markdown.js';
import { assertNoImportCredentials } from './privacy.js';

interface Options { variables?: Variables; flows?: Record<string, SharedFlow> }
function flowId(step: CaseSpec['steps'][number], flows: Options['flows']): string | undefined {
  if (step.flowId && Object.hasOwn(flows ?? {}, step.flowId)) return step.flowId;
  const name = step.flowId ?? step.text.trim();
  const matches = Object.entries(flows ?? {}).filter(([, flow]) => flow.name === name);
  return matches.length === 1 ? matches[0]![0] : undefined;
}
export function caseIssues(spec: CaseSpec, options: Options = {}): CaseIssue[] {
  caseSpecSchema.parse(spec);
  const issues = spec.questions.filter(issue => !issue.resolved).map(issue => ({ ...issue }));
  const add = (code: string, message: string, blocks: CaseIssue['blocks']) => { if (!issues.some(issue => issue.code === code)) issues.push({ code, message, blocks }); };
  if (!spec.title.trim()) add('missing-title', '缺少用例标题', 'generation');
  if (!spec.steps.length || spec.steps.some(step => !step.text.trim())) add('missing-steps', '缺少操作步骤，或存在空步骤', 'generation');
  if (!spec.expectations.length || spec.expectations.some(item => !item.text.trim())) add('missing-expectation', '没有预期结果，请补充业务断言', 'generation');
  if (spec.preconditions.some(item => !item.text.trim())) add('empty-precondition', '前置条件文字不能为空，请补充前置条件', 'generation');
  if (spec.data.some(item => !item.name.trim())) add('empty-data-name', '测试数据名称不能为空，请补充名称', 'generation');
  if (spec.data.some(item => !item.value.trim())) add('empty-data-value', '测试数据值不能为空，请填写测试值或变量引用', 'generation');
  const text = [...spec.preconditions, ...spec.steps, ...spec.expectations].map(item => item.text).join('\n');
  if (/跨标签页|切换标签页|新标签页|新窗口|文件上传|上传文件|任意脚本|执行\s*(?:JavaScript|javascript|JS)|\b(?:eval|executeScript)\s*\(/.test(text)) add('unsupported-operation', '包含当前不支持的跨标签页、文件上传或脚本操作，请修改对应步骤', 'generation');
  for (const pre of spec.preconditions) if (pre.kind === 'manual') {
    if (/(?:打开|进入|访问|切换到|停留在|位于|处于).*(?:页|网址|网站|界面)|已登录|未登录/.test(pre.text)) add(`precondition-navigation-${pre.id}`, `运行会导航至目标环境；请将页面或登录状态准备改为可执行或可检查条件：${pre.text}`, 'execution');
    else if (!pre.acknowledged) add(`precondition-${pre.id}`, `需要人工完成并确认前置条件：${pre.text}`, 'execution');
  }
  const ids = new Set(spec.steps.map(step => step.id));
  const itemIds = [...spec.preconditions, ...spec.steps, ...spec.expectations].map(item => item.id);
  if (itemIds.some(id => !id.trim())) add('empty-item-id', '前置条件、操作和预期结果的 ID 不能为空', 'generation');
  if (new Set(itemIds).size !== itemIds.length) add('duplicate-item-id', '前置条件、操作和预期结果的 ID 不能重复，请重新识别或修正', 'generation');
  for (const item of spec.expectations) if (item.afterStepId && !ids.has(item.afterStepId)) add(`expectation-step-${item.id}`, `预期结果引用了不存在的步骤：${item.afterStepId}`, 'generation');
  for (const step of spec.steps) if (step.kind === 'flow' && !flowId(step, options.flows)) add(`missing-flow-${step.id}`, `找不到唯一匹配的共享流程：${step.flowId ?? step.text}`, 'generation');
  const variables = validateVariables(options.variables ?? {});
  const variableText = `${text}\n${spec.data.map(item => item.value).join('\n')}`;
  for (const match of variableText.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) {
    const key = match[1]!;
    if (!['baseUrl', 'baseOrigin'].includes(key) && !Object.hasOwn(variables, key)) add(`missing-variable-${key}`, `缺少 ${key} 变量，请在运行参数或环境中补充`, 'execution');
  }
  return issues;
}
function exactText(text: string): string | undefined { return /^(?:页面显示|页面包含|显示文本|可见文本|等待文本)\s*[“"「]([\s\S]+)[”"」]$/.exec(text.trim())?.[1]; }
function action(text: string, kind: 'action' | 'wait' = 'action'): WorkflowStep {
  const prompt = text.trim();
  const url = /^(?:打开|访问|导航至)\s+((?:https?:\/\/|\$\{(?:baseUrl|baseOrigin)\})\S*)$/.exec(prompt)?.[1];
  if (url) return { gotoUrl: { url } };
  const click = /^点击文本\s*[“"「]([\s\S]+)[”"」]$/.exec(prompt)?.[1];
  if (click) return { click_by_text: { text: click, exact: true } };
  if (kind === 'wait') { const value = exactText(prompt); return value ? { assertText: { text: value, timeoutMs: 10000 } } : { aiWaitFor: { prompt, timeoutMs: 30000 } }; }
  return { aiAct: prompt };
}
export function compileCaseSpec(input: CaseSpec, options: Options = {}): { text: string; specHash: string; issues: CaseIssue[] } {
  const spec = caseSpecSchema.parse(input);
  assertNoImportCredentials(spec.data.map(item => `${item.name}: ${item.value}`).join('\n'));
  const issues = caseIssues(spec, options);
  const blocking = issues.filter(issue => issue.blocks === 'generation');
  if (blocking.length) throw new Error(blocking.map(issue => issue.message).join('；'));
  const steps: WorkflowStep[] = [];
  const append = (step: WorkflowStep, item: { id: string; text: string }) => steps.push({ ...step, testo: { id: item.id, name: item.text } });
  for (const pre of spec.preconditions) {
    if (pre.kind === 'action') append(action(pre.text), pre);
    else if (pre.kind === 'check') append({ aiAssert: pre.text }, pre);
  }
  // Navigation runs before preparation checks so the selected environment is actually loaded.
  if (steps.length ? !('gotoUrl' in steps[0]!) : !('gotoUrl' in action(spec.steps[0]!.text))) steps.unshift({ gotoUrl: { url: '${baseUrl}' } });
  const assertion = (item: CaseSpec['expectations'][number]) => {
    const exact = exactText(item.text);
    append(item.kind === 'text' ? { assertText: { text: exact ?? item.text } } : { aiAssert: item.text }, item);
  };
  for (const step of spec.steps) {
    const matched = flowId(step, options.flows);
    const native = step.kind === 'flow' || (step.kind === 'action' && matched) ? { useFlow: { id: matched! } } : action(step.text, step.kind);
    if ('aiAct' in native && spec.data.length) native.aiAct += `\n测试数据（只用于本步骤）：${spec.data.map(item => `${item.name}：${item.value}`).join('；')}`;
    append(native, step);
    for (const expected of spec.expectations.filter(item => item.afterStepId === step.id)) assertion(expected);
  }
  for (const expected of spec.expectations.filter(item => !item.afterStepId)) assertion(expected);
  return { text: stringify({ cases: [{ name: spec.title, steps }] }), specHash: contentHash(JSON.stringify(spec)), issues };
}
