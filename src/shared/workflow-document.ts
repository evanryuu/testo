import { parse, stringify } from 'yaml';

export type JSONValue = string | number | boolean | null | JSONValue[] | { [key: string]: JSONValue };
export type Variables = Record<string, JSONValue>;
export interface StepMetadata { id?: string; name?: string; metric?: 'first-response' | 'response-complete' }
export type WorkflowStep = Record<string, unknown>;
export interface WorkflowSettings {
  variables?: Variables;
  datasets?: { id: string; name: string; variables: Variables }[];
}
export type WorkflowDocument = Record<string, unknown> & {
  cases: (Record<string, unknown> & { name?: string; steps: WorkflowStep[] })[];
  testo?: WorkflowSettings;
};
export interface SharedFlow { name: string; steps: WorkflowStep[] }
export interface DebugSelection { mode: 'to-step' | 'single-step'; stepIndex: number; precondition?: string }
export interface CompileOptions { defaults?: Variables; variables?: Variables; datasetId?: string; flows?: Record<string, SharedFlow>; debug?: DebugSelection }
const phases = ['beforeAll', 'beforeEach', 'afterEach', 'afterAll'] as const;
const reserved = new Set(['baseUrl', 'baseOrigin', '__proto__', 'constructor', 'prototype']);
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function json(value: unknown, seen = new Set<object>()): value is JSONValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (!object(value) && !Array.isArray(value)) return false;
  if (seen.has(value)) return false;
  seen.add(value);
  const valid = Object.entries(value).every(([key, item]) => !['__proto__', 'constructor', 'prototype'].includes(key) && json(item, seen));
  seen.delete(value);
  return valid;
}
export function validateVariables(value: unknown, label = '变量'): Variables {
  if (!object(value) || !json(value)) throw new Error(`${label}必须是 JSON 对象`);
  for (const key of Object.keys(value)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || reserved.has(key)) throw new Error(`${label}名称无效或占用了内置变量：${key}`);
  }
  return structuredClone(value) as Variables;
}
function validateSteps(value: unknown, label: string): WorkflowStep[] {
  if (!Array.isArray(value)) throw new Error(`${label}必须是步骤列表`);
  for (const [index, step] of value.entries()) {
    if (!object(step) || Object.keys(step).filter(key => key !== 'testo').length !== 1) throw new Error(`${label}第 ${index + 1} 步必须包含一个操作`);
    if (step.testo !== undefined) {
      if (!object(step.testo) || Object.keys(step.testo).some(key => !['id', 'name', 'disabled', 'metric'].includes(key))) throw new Error('步骤 testo 元信息无效');
      if (step.testo.metric !== undefined && !['first-response', 'response-complete'].includes(String(step.testo.metric))) throw new Error('步骤 metric 无效');
      if (step.testo.disabled !== undefined && typeof step.testo.disabled !== 'boolean') throw new Error('步骤 disabled 必须是布尔值');
      for (const key of ['id', 'name']) if (step.testo[key] !== undefined && typeof step.testo[key] !== 'string') throw new Error(`步骤 ${key} 必须是文字`);
    }
  }
  return value;
}
export function parseWorkflow(text: string): WorkflowDocument {
  const value: unknown = parse(text, { uniqueKeys: true, maxAliasCount: 50 });
  if (!object(value) || !Array.isArray(value.cases) || value.cases.length !== 1) throw new Error('每个平台 Workflow 必须包含一个用例');
  for (const entry of value.cases) {
    if (!object(entry)) throw new Error('用例定义必须是对象');
    validateSteps(entry.steps, '用例');
  }
  for (const phase of phases) if (value[phase] !== undefined) validateSteps(value[phase], phase);
  if (value.testo !== undefined) {
    if (!object(value.testo) || Object.keys(value.testo).some(key => !['variables', 'datasets'].includes(key))) throw new Error('Workflow testo 设置无效');
    if (value.testo.variables !== undefined) validateVariables(value.testo.variables);
    if (value.testo.datasets !== undefined) {
      if (!Array.isArray(value.testo.datasets)) throw new Error('datasets 必须是列表');
      const ids = new Set<string>();
      for (const dataset of value.testo.datasets) {
        if (!object(dataset) || typeof dataset.id !== 'string' || !dataset.id.trim() || typeof dataset.name !== 'string' || ids.has(dataset.id)) throw new Error('数据集必须具有唯一 id 和名称');
        validateVariables(dataset.variables, '数据集变量');
        ids.add(dataset.id);
      }
    }
  }
  return value as WorkflowDocument;
}
export function compileWorkflow(text: string, options: CompileOptions = {}): { text: string; variables: Variables; stepMetadata: Record<string, StepMetadata> } {
  const document = parseWorkflow(text);
  const dataset = options.datasetId === undefined ? undefined : document.testo?.datasets?.find(item => item.id === options.datasetId);
  if (options.datasetId !== undefined && !dataset) throw new Error(`找不到数据集：${options.datasetId}`);
  const variables = { ...validateVariables(options.defaults ?? {}), ...validateVariables(document.testo?.variables ?? {}), ...validateVariables(dataset?.variables ?? {}), ...validateVariables(options.variables ?? {}) };
  let count = 0;
  const expand = (steps: WorkflowStep[], ancestors: string[] = []): WorkflowStep[] => steps.flatMap(step => {
    if (object(step.testo) && step.testo.disabled === true) return [];
    if (++count > 10000) throw new Error('展开后的 Workflow 超过 10000 个步骤');
    const { testo: _testo, ...native } = structuredClone(step);
    if (!Object.hasOwn(native, 'useFlow')) return [structuredClone(step)];
    const ref = native.useFlow;
    if (!object(ref) || typeof ref.id !== 'string' || !ref.id || Object.keys(ref).some(key => key !== 'id')) throw new Error('useFlow 必须包含共享步骤 id');
    if (native.$ !== undefined) throw new Error('共享步骤的超时等设置请配置在共享步骤内部');
    if (ancestors.includes(ref.id)) throw new Error(`共享步骤存在循环引用：${[...ancestors, ref.id].join(' → ')}`);
    if (ancestors.length >= 20) throw new Error('共享步骤引用超过 20 层');
    const flow = Object.hasOwn(options.flows ?? {}, ref.id) ? options.flows![ref.id] : undefined;
    if (!flow) throw new Error(`找不到共享步骤：${ref.id}`);
    return expand(validateSteps(flow.steps, `共享步骤 ${flow.name}`), [...ancestors, ref.id]);
  });
  const entry = document.cases[0]!;
  if (options.debug) {
    const { mode, stepIndex, precondition } = options.debug;
    if (!['single-step', 'to-step'].includes(mode) || !Number.isInteger(stepIndex) || stepIndex < 0 || stepIndex >= entry.steps.length) throw new Error('调试步骤不存在');
    if (object(entry.steps[stepIndex]!.testo) && entry.steps[stepIndex]!.testo.disabled === true) throw new Error('不能运行已停用的步骤');
    if (mode === 'single-step') {
      if (!precondition?.trim()) throw new Error('单步调试前需要填写页面前置条件');
      delete document.beforeAll;
      delete document.beforeEach;
      entry.steps = [{ aiWaitFor: { prompt: precondition.trim(), timeoutMs: 30000 } }, entry.steps[stepIndex]!];
    } else entry.steps = entry.steps.slice(0, stepIndex + 1);
  }
  entry.steps = expand(entry.steps);
  if (!entry.steps.length) throw new Error('Workflow 至少需要一个启用的步骤');
  for (const phase of phases) if (document[phase] !== undefined) document[phase] = expand(document[phase] as WorkflowStep[]);
  const stepMetadata: Record<string, StepMetadata> = {};
  const strip = (steps: WorkflowStep[], phase: string) => steps.map((step, index) => {
    const { testo, ...native } = step;
    if (object(testo)) {
      const { disabled: _disabled, ...metadata } = testo;
      stepMetadata[`${phase}:${index}`] = metadata as StepMetadata;
    }
    return native;
  });
  entry.steps = strip(entry.steps, 'steps');
  for (const phase of phases) if (document[phase] !== undefined) document[phase] = strip(document[phase] as WorkflowStep[], phase);
  delete document.testo;
  return { text: stringify(document), variables, stepMetadata };
}
