import { useEffect, useMemo, useRef, useState } from 'react';
import { isMap, isSeq, parseDocument, stringify, type YAMLSeq } from 'yaml';
import { ArrowDown, ArrowUp, Copy, Plus, Redo2, Trash2, Undo2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { checkTemplates } from '../shared/check-templates.js';
import { VariableEditor, type JsonValue } from './VariableEditor';

export type SharedFlows = Record<string, { name: string; steps: Record<string, unknown>[] }>;
export interface WorkflowDebug { mode: 'to-step' | 'single-step'; stepIndex: number; precondition?: string }
interface Props {
  text: string; onChange(text: string): void; onDebug?(debug: WorkflowDebug): void;
  onRecord?(position: number, deleteCount?: number): void; flows?: SharedFlows; disabled?: boolean; scope?: 'workflow' | 'shared-flow'; onValidityChange?(valid: boolean): void;
}
type Phase = 'steps' | 'beforeAll' | 'beforeEach' | 'afterEach' | 'afterAll';
type YamlDocument = ReturnType<typeof parseDocument>;
const phases: [Phase, string][] = [['steps', '用例步骤'], ['beforeAll', '运行前'], ['beforeEach', '每例前'], ['afterEach', '每例后'], ['afterAll', '运行后']];
const phasePath = (phase: Phase): (string | number)[] => phase === 'steps' ? ['cases', 0, 'steps'] : [phase];
const objectValue = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const operation = (step: Record<string, unknown>) => Object.keys(step).find(key => key !== '$' && key !== 'testo') ?? '';
const rawNames: Record<string, string> = { Tap: '点击', Input: '输入文字', KeyboardPress: '按键', Scroll: '滚动', DragAndDrop: '拖拽' };
const nodeNames: Record<string, string> = { gotoUrl: '打开页面', aiAct: 'AI 操作', aiTap: 'AI 点击', aiInput: 'AI 输入', aiKeyboardPress: 'AI 按键', aiScroll: 'AI 滚动', aiWaitFor: '等待条件', aiAssert: 'AI 断言', assertText: '检查可见文本', recordToReport: '保存报告截图', waitForElement: '等待元素', requireViewport: '准备视口', setViewportSize: '设置视口', useFlow: '共享步骤', wait: '固定等待' };
const titleFor = (step: Record<string, unknown>) => String(objectValue(step.testo).name || (operation(step) === 'recordedAction' ? rawNames[String(objectValue(step.recordedAction).actionType)] : nodeNames[operation(step)]) || operation(step) || '未知步骤');
const defaults: Record<string, Record<string, unknown>> = {
  Tap: { recordedAction: { actionType: 'Tap', payload: { x: 0, y: 0 } } },
  Input: { recordedAction: { actionType: 'Input', payload: { value: '', mode: 'typeOnly' } } },
  KeyboardPress: { recordedAction: { actionType: 'KeyboardPress', payload: { keyName: 'Enter' } } },
  Scroll: { recordedAction: { actionType: 'Scroll', payload: { direction: 'down', distance: 500 } } },
  DragAndDrop: { recordedAction: { actionType: 'DragAndDrop', payload: { x: 0, y: 0, endX: 100, endY: 100 } } },
  gotoUrl: { gotoUrl: { url: '${baseUrl}' } }, aiAct: { aiAct: '' }, aiTap: { aiTap: '' },
  aiWaitFor: { aiWaitFor: { prompt: '', timeoutMs: 60000 } }, aiAssert: { aiAssert: '' },
  assertText: { assertText: { text: '', timeoutMs: 5000 } }, recordToReport: { recordToReport: '当前页面' },
  waitForElement: { waitForElement: { selector: '', state: 'visible', timeoutMs: 30000 } },
  wait: { wait: { duration: 1000, unit: 'ms' } },
};

export function WorkflowEditor({ text, onChange, onDebug, onRecord, flows = {}, disabled = false, scope = 'workflow', onValidityChange }: Props) {
  const [phase, setPhase] = useState<Phase>('steps');
  const [view, setView] = useState('visual');
  const [newNode, setNewNode] = useState('aiWaitFor');
  const [selectedTemplate, setSelectedTemplate] = useState(checkTemplates[0]!.id);
  const [error, setError] = useState('');
  const [invalidVariables, setInvalidVariables] = useState<Record<string, boolean>>({});
  const [precondition, setPrecondition] = useState('');
  const history = useRef<{ past: string[]; future: string[]; current: string }>({ past: [], future: [], current: text });
  const [, renderHistory] = useState(0);
  useEffect(() => {
    if (history.current.current !== text) history.current = { past: [], future: [], current: text };
  }, [text]);
  const parsed = useMemo(() => {
    try {
      const doc = parseDocument(text, { uniqueKeys: true });
      if (doc.errors.length) throw doc.errors[0];
      const data = objectValue(doc.toJS({ maxAliasCount: 50 }));
      if (!Array.isArray(data.cases) || data.cases.length !== 1) throw new Error('可视化编辑需要且仅支持一个用例。请在 YAML 中检查 cases。');
      return { doc, data, error: '' };
    } catch (cause) { return { doc: undefined, data: {} as Record<string, unknown>, error: (cause as Error).message }; }
  }, [text]);
  const caseData = objectValue((parsed.data.cases as unknown[] | undefined)?.[0]);
  const rawSteps = phase === 'steps' ? caseData.steps : parsed.data[phase];
  const steps: Record<string, unknown>[] = Array.isArray(rawSteps) ? rawSteps.map(objectValue) : [];
  const meta = objectValue(parsed.data.testo);
  const variables = objectValue(meta.variables) as Record<string, JsonValue>;
  const datasets = (Array.isArray(meta.datasets) ? meta.datasets : []).map(objectValue);
  useEffect(() => { onValidityChange?.(!parsed.error && !error && !Object.values(invalidVariables).some(Boolean)); }, [parsed.error, error, invalidVariables, onValidityChange]);
  const variableValidity = (id: string, valid: boolean) => setInvalidVariables(current => current[id] === !valid ? current : { ...current, [id]: !valid });
  function publish(next: string) {
    if (next === text) return;
    history.current.past.push(text); history.current.future = []; history.current.current = next;
    if (history.current.past.length > 100) history.current.past.shift();
    onChange(next); setError('');
  }
  function edit(change: (doc: YamlDocument) => void) {
    if (!parsed.doc || disabled) return;
    try { const next = parsed.doc.clone(); change(next); publish(next.toString()); } catch (cause) { setError((cause as Error).message); }
  }
  function stepSequence(doc: YamlDocument): YAMLSeq {
    const path = phasePath(phase);
    if (!doc.hasIn(path)) doc.setIn(path, doc.createNode([]));
    const node = doc.getIn(path, true);
    if (!isSeq(node)) throw new Error('当前阶段的步骤不是列表，请先检查 YAML。');
    return node;
  }
  function add(items: Record<string, unknown>[], position = steps.length) {
    edit(doc => { const list = stepSequence(doc); list.items.splice(position, 0, ...items.map(item => doc.createNode(item))); });
  }
  function changeField(index: number, path: (string | number)[], value: unknown) {
    edit(doc => {
      const inputPath = [...phasePath(phase), index, path[0]!];
      const input = doc.getIn(inputPath);
      if (path.length > 1 && typeof input === 'string') {
        const shorthand: Record<string, string> = { aiWaitFor: 'prompt', aiAssert: 'prompt', aiAct: 'prompt', aiTap: 'prompt', assertText: 'text', gotoUrl: 'url', recordToReport: 'title' };
        const key = shorthand[String(path[0])];
        if (key) doc.setIn(inputPath, doc.createNode({ [key]: input }));
      }
      doc.setIn([...phasePath(phase), index, ...path], value);
    });
  }
  function undo(redo = false) {
    const state = history.current, from = redo ? state.future : state.past, to = redo ? state.past : state.future;
    const next = from.pop(); if (next === undefined) return;
    to.push(text); state.current = next; onChange(next); renderHistory(value => value + 1);
  }
  return <div className="space-y-4" data-testid="workflow-editor">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <Tabs value={view} onValueChange={setView}><TabsList><TabsTrigger value="visual">可视化编辑</TabsTrigger><TabsTrigger value="yaml">YAML</TabsTrigger></TabsList></Tabs>
      <div className="flex gap-2"><Button type="button" size="sm" variant="outline" disabled={disabled || !history.current.past.length} onClick={() => undo()}><Undo2 />撤销</Button><Button type="button" size="sm" variant="outline" disabled={disabled || !history.current.future.length} onClick={() => undo(true)}><Redo2 />重做</Button></div>
    </div>
    {(parsed.error || error) && <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">{parsed.error || error}</p>}
    {view === 'yaml' || !parsed.doc ? <Textarea aria-label="Workflow YAML" className="min-h-96 font-mono text-xs" value={text} disabled={disabled} onChange={event => publish(event.target.value)} /> : <>
      <Tabs defaultValue="steps">
        <TabsList><TabsTrigger value="steps">步骤</TabsTrigger>{scope === 'workflow' && <TabsTrigger value="variables">变量与数据集</TabsTrigger>}</TabsList>
        <TabsContent value="steps" className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            {scope === 'workflow' && <NativeSelect aria-label="编辑阶段" value={phase} disabled={disabled} onChange={event => setPhase(event.target.value as Phase)}>{phases.map(([id, name]) => <NativeSelectOption key={id} value={id}>{name}</NativeSelectOption>)}</NativeSelect>}
            <p className="text-xs text-muted-foreground">{steps.length} 个步骤 · 步骤修改会同步到 YAML</p>
          </div>
          {phase !== 'steps' && <p className="text-xs text-muted-foreground">{phase === 'beforeAll' || phase === 'afterAll' ? '这些步骤在当前 Workflow 开始或结束时运行。' : '这些步骤在当前用例执行前或执行后运行。'}共享步骤可以在多个用例中复用。</p>}
          <div className="space-y-3">
            {steps.map((step, index) => <details key={`${phase}-${index}`} className="rounded-lg border bg-card" open={steps.length < 8 ? true : undefined} data-testid="workflow-step">
              <summary className="flex cursor-pointer list-none flex-wrap items-center justify-between gap-2 px-4 py-3">
                <span className="flex items-center gap-3"><span className="text-xs text-muted-foreground">{index + 1}</span><span className="text-sm font-medium">{titleFor(step)}</span>{objectValue(step.testo).disabled === true && <Badge variant="secondary">已停用</Badge>}</span>
                <span className="text-xs text-muted-foreground">{operation(step)}</span>
              </summary>
              <div className="space-y-4 border-t p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <label className="mr-auto flex items-center gap-2 text-sm"><Checkbox checked={objectValue(step.testo).disabled !== true} disabled={disabled} onCheckedChange={checked => changeField(index, ['testo', 'disabled'], checked !== true)} />启用步骤 {index + 1}</label>
                  <Button type="button" size="icon-sm" variant="ghost" aria-label={`上移步骤 ${index + 1}`} disabled={disabled || index === 0} onClick={() => edit(doc => { const list = stepSequence(doc); [list.items[index - 1], list.items[index]] = [list.items[index]!, list.items[index - 1]!]; })}><ArrowUp /></Button>
                  <Button type="button" size="icon-sm" variant="ghost" aria-label={`下移步骤 ${index + 1}`} disabled={disabled || index === steps.length - 1} onClick={() => edit(doc => { const list = stepSequence(doc); [list.items[index + 1], list.items[index]] = [list.items[index]!, list.items[index + 1]!]; })}><ArrowDown /></Button>
                  <Button type="button" size="icon-sm" variant="ghost" aria-label={`复制步骤 ${index + 1}`} disabled={disabled} onClick={() => edit(doc => { const list = stepSequence(doc), source = list.items[index]; const copy = isMap(source) ? source.clone() : doc.createNode(step); if (isMap(copy) && copy.hasIn(['testo', 'id'])) copy.setIn(['testo', 'id'], crypto.randomUUID()); list.items.splice(index + 1, 0, copy); })}><Copy /></Button>
                  <Button type="button" size="icon-sm" variant="ghost" aria-label={`删除步骤 ${index + 1}`} disabled={disabled} onClick={() => edit(doc => { stepSequence(doc).items.splice(index, 1); })}><Trash2 /></Button>
                </div>
                <label className="block space-y-1 text-sm"><span>步骤名称</span><Input aria-label={`步骤名称 ${index + 1}`} value={String(objectValue(step.testo).name ?? '')} disabled={disabled} placeholder={titleFor(step)} onChange={event => changeField(index, ['testo', 'name'], event.target.value)} /></label>
                <StepFields step={step} index={index} flows={flows} disabled={disabled} change={(path, value) => changeField(index, path, value)} />
                <details><summary className="cursor-pointer text-xs text-muted-foreground">高级步骤 YAML（保留原生参数和 $ 设置）</summary><StepYaml value={stringify(step)} disabled={disabled} apply={value => edit(doc => { const replacement = parseDocument(value); if (replacement.errors.length || !isMap(replacement.contents)) throw new Error('请填写有效的单个步骤 YAML。'); stepSequence(doc).items[index] = replacement.contents.clone(); })} /></details>
                {phase === 'steps' && (onDebug || onRecord) && <div className="flex flex-wrap gap-2 border-t pt-3">
                  {onDebug && <><Button type="button" size="sm" variant="outline" disabled={disabled || objectValue(step.testo).disabled === true} onClick={() => onDebug({ mode: 'to-step', stepIndex: index })}>运行到步骤 {index + 1}</Button><Button type="button" size="sm" variant="outline" disabled={disabled || !precondition.trim() || objectValue(step.testo).disabled === true} onClick={() => onDebug({ mode: 'single-step', stepIndex: index, precondition: precondition.trim() })}>只运行步骤 {index + 1}</Button></>}
                  {onRecord && <><Button type="button" size="sm" variant="outline" disabled={disabled} onClick={() => onRecord(index, 1)}>重录步骤 {index + 1}</Button><Button type="button" size="sm" variant="outline" disabled={disabled} onClick={() => onRecord(index + 1, 0)}>在步骤 {index + 1} 后录制</Button></>}
                </div>}
              </div>
            </details>)}
            {!steps.length && <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">此阶段还没有步骤，可以在下方添加。</p>}
          </div>
          <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/30 p-3">
            <NativeSelect aria-label="新增步骤类型" value={newNode} disabled={disabled} onChange={event => setNewNode(event.target.value)}>{Object.keys(defaults).map(name => <NativeSelectOption key={name} value={name}>{rawNames[name] ?? nodeNames[name]}</NativeSelectOption>)}{Object.keys(flows).map(id => <NativeSelectOption key={id} value={`flow:${id}`}>共享步骤：{flows[id]!.name}</NativeSelectOption>)}</NativeSelect>
            <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={() => add([newNode.startsWith('flow:') ? { useFlow: { id: newNode.slice(5) } } : structuredClone(defaults[newNode]!)])}><Plus />添加步骤</Button>
            {phase === 'steps' && onRecord && <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={() => onRecord(steps.length, 0)}>在末尾录制</Button>}
          </div>
          <div className="space-y-3 rounded-md border p-4">
            <h4 className="text-sm font-medium">AI 检查模板</h4>
            <div className="flex flex-wrap gap-2"><NativeSelect aria-label="AI 检查模板" value={selectedTemplate} disabled={disabled} onChange={event => setSelectedTemplate(event.target.value)}>{checkTemplates.map(template => <NativeSelectOption key={template.id} value={template.id}>{template.name}</NativeSelectOption>)}</NativeSelect><Button type="button" size="sm" variant="outline" disabled={disabled} onClick={() => add(structuredClone(checkTemplates.find(template => template.id === selectedTemplate)!.steps))}><Plus />添加模板</Button></div>
            <p className="text-xs text-muted-foreground">{checkTemplates.find(template => template.id === selectedTemplate)?.description} 添加后请修改步骤中的检查条件。</p>
          </div>
          {onDebug && <label className="block space-y-2 text-sm"><span>单步调试的前置条件</span><Textarea aria-label="单步调试的前置条件" placeholder="例如：页面已打开新建知识库弹窗，名称输入框为空。执行前会先检查这个条件。" value={precondition} disabled={disabled} onChange={event => setPrecondition(event.target.value)} /><span className="block text-xs text-muted-foreground">运行到某一步会从用例开头执行；单步执行需要先验证当前页面状态。</span></label>}
        </TabsContent>
        <TabsContent value="variables" forceMount className="space-y-6 data-[state=inactive]:hidden">
          <VariableEditor label="用例默认变量" onValidityChange={valid => variableValidity('defaults', valid)} value={variables} disabled={disabled} onChange={value => edit(doc => doc.setIn(['testo', 'variables'], value))} />
          <section className="space-y-3"><div className="flex items-center justify-between"><h4 className="text-sm font-medium">数据集</h4><Button type="button" size="sm" variant="outline" disabled={disabled} onClick={() => edit(doc => { const values = [...datasets, { id: crypto.randomUUID(), name: `数据集 ${datasets.length + 1}`, variables: {} }]; doc.setIn(['testo', 'datasets'], values); })}><Plus />添加数据集</Button></div><p className="text-xs text-muted-foreground">同一个用例可以使用不同输入值。选择数据集后，其变量覆盖用例默认值；运行前指定的值优先。</p>{datasets.map((dataset, index) => <div key={String(dataset.id ?? index)} className="space-y-4 rounded-md border p-4"><div className="flex gap-2"><Input aria-label={`数据集名称 ${index + 1}`} value={String(dataset.name ?? '')} disabled={disabled} onChange={event => edit(doc => doc.setIn(['testo', 'datasets', index, 'name'], event.target.value))} /><Button type="button" variant="ghost" size="icon" aria-label={`删除数据集 ${index + 1}`} disabled={disabled} onClick={() => edit(doc => { const node = doc.getIn(['testo', 'datasets'], true); if (isSeq(node)) node.items.splice(index, 1); setInvalidVariables(current => { const next = { ...current }; delete next[String(dataset.id)]; return next; }); })}><Trash2 /></Button></div><VariableEditor label={`数据集 ${index + 1} 变量`} onValidityChange={valid => variableValidity(String(dataset.id), valid)} value={objectValue(dataset.variables) as Record<string, JsonValue>} disabled={disabled} onChange={value => edit(doc => doc.setIn(['testo', 'datasets', index, 'variables'], value))} /></div>)}</section>
        </TabsContent>
      </Tabs>
    </>}
  </div>;
}

function StepYaml({ value, apply, disabled }: { value: string; apply(value: string): void; disabled: boolean }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return <div className="mt-2 space-y-2"><Textarea aria-label="高级步骤 YAML" className="min-h-32 font-mono text-xs" value={draft} disabled={disabled} onChange={event => setDraft(event.target.value)} /><Button type="button" size="sm" variant="outline" disabled={disabled || draft === value} onClick={() => apply(draft)}>应用步骤 YAML</Button></div>;
}

function StepFields({ step, index, change, flows, disabled }: { step: Record<string, unknown>; index: number; change(path: (string | number)[], value: unknown): void; flows: SharedFlows; disabled: boolean }) {
  const node = operation(step), input = step[node], data = objectValue(input);
  const scalar = typeof input === 'string';
  const field = (label: string, path: (string | number)[], value: unknown, options: { multiline?: boolean; number?: boolean; placeholder?: string } = {}) => {
    const props = { 'aria-label': `${label} ${index + 1}`, value: value === undefined ? '' : String(value), disabled, placeholder: options.placeholder, onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      const text = event.target.value;
      change(path, options.number && text !== '' && Number.isFinite(Number(text)) ? Number(text) : text);
    } };
    return <label key={path.join('.')} className="block space-y-1 text-sm"><span>{label}</span>{options.multiline ? <Textarea {...props} /> : <Input {...props} inputMode={options.number ? 'numeric' : undefined} />}</label>;
  };
  const select = (label: string, path: (string | number)[], value: unknown, options: [string, string][]) => <label key={path.join('.')} className="block space-y-1 text-sm"><span>{label}</span><NativeSelect aria-label={`${label} ${index + 1}`} disabled={disabled} value={String(value ?? options[0]?.[0] ?? '')} onChange={event => change(path, event.target.value)}>{options.map(([id, name]) => <NativeSelectOption key={id} value={id}>{name}</NativeSelectOption>)}</NativeSelect></label>;
  if (node === 'recordedAction') {
    const payload = objectValue(data.payload), action = String(data.actionType);
    return <div className="space-y-3">
      {['Tap', 'Input', 'Scroll', 'DragAndDrop'].includes(action) && <div className="grid grid-cols-2 gap-3">{field('横坐标 X', [node, 'payload', 'x'], payload.x, { number: true })}{field('纵坐标 Y', [node, 'payload', 'y'], payload.y, { number: true })}</div>}
      {action === 'Input' && <>{field('输入内容', [node, 'payload', 'value'], payload.value, { multiline: true, placeholder: '支持 ${变量名}' })}{select('输入方式', [node, 'payload', 'mode'], payload.mode, [['typeOnly', '继续输入'], ['replace', '替换内容'], ['clear', '清空内容']])}</>}
      {action === 'KeyboardPress' && field('按键', [node, 'payload', 'keyName'], payload.keyName, { placeholder: 'Enter / Control+A' })}
      {action === 'Scroll' && <div className="grid grid-cols-2 gap-3">{select('滚动方向', [node, 'payload', 'direction'], payload.direction, [['down', '向下'], ['up', '向上'], ['left', '向左'], ['right', '向右']])}{field('滚动距离', [node, 'payload', 'distance'], payload.distance, { number: true })}</div>}
      {action === 'DragAndDrop' && <div className="grid grid-cols-2 gap-3">{field('终点 X', [node, 'payload', 'endX'], payload.endX, { number: true })}{field('终点 Y', [node, 'payload', 'endY'], payload.endY, { number: true })}</div>}
      {data.viewport !== undefined && <details><summary className="text-xs text-muted-foreground">录制视口</summary><div className="mt-2 grid grid-cols-2 gap-3">{field('视口宽度', [node, 'viewport', 'width'], objectValue(data.viewport).width, { number: true })}{field('视口高度', [node, 'viewport', 'height'], objectValue(data.viewport).height, { number: true })}</div></details>}
    </div>;
  }
  if (['aiAct', 'aiTap', 'aiAssert', 'aiWaitFor', 'aiInput', 'aiKeyboardPress', 'aiScroll'].includes(node)) return <div className="space-y-3">
    {field(node === 'aiWaitFor' ? '等待条件' : node === 'aiAssert' ? '检查条件' : '目标或操作描述', scalar ? [node] : [node, 'prompt'], scalar ? input : data.prompt, { multiline: true, placeholder: '使用页面可见的名称、位置和状态描述目标。支持 ${变量名}。' })}
    {node === 'aiInput' && field('输入内容', [node, 'value'], data.value, { multiline: true })}
    {node === 'aiKeyboardPress' && field('按键', [node, 'keyName'], data.keyName)}
    {node === 'aiScroll' && select('滚动方向', [node, 'direction'], data.direction, [['down', '向下'], ['up', '向上'], ['left', '向左'], ['right', '向右']])}
    {node === 'aiWaitFor' && <div className="grid grid-cols-2 gap-3">{field('最长等待（毫秒）', [node, 'timeoutMs'], data.timeoutMs, { number: true })}{field('检查间隔（毫秒）', [node, 'checkIntervalMs'], data.checkIntervalMs, { number: true, placeholder: '默认 3000' })}</div>}
  </div>;
  if (node === 'gotoUrl') return field('页面地址', scalar ? [node] : [node, 'url'], scalar ? input : data.url, { placeholder: '${baseUrl}' });
  if (node === 'assertText') return <div className="space-y-3">{field('预期文本', scalar ? [node] : [node, 'text'], scalar ? input : data.text, { multiline: true })}{field('最长等待（毫秒）', [node, 'timeoutMs'], data.timeoutMs, { number: true })}</div>;
  if (node === 'recordToReport') return field('截图说明', scalar ? [node] : [node, 'title'], scalar ? input : data.title);
  if (node === 'waitForElement') return <div className="space-y-3">{field('元素选择器', [node, 'selector'], data.selector, { placeholder: '[data-testid="reply"]' })}{select('等待元素状态', [node, 'state'], data.state, [['visible', '可见'], ['hidden', '隐藏'], ['attached', '出现在页面结构中'], ['detached', '从页面结构中移除']])}{field('最长等待（毫秒）', [node, 'timeoutMs'], data.timeoutMs, { number: true })}</div>;
  if (node === 'setViewportSize' || node === 'requireViewport') return <div className="grid grid-cols-2 gap-3">{field('视口宽度', [node, 'width'], data.width, { number: true })}{field('视口高度', [node, 'height'], data.height, { number: true })}</div>;
  if (node === 'useFlow') return <div className="space-y-2">{select('共享步骤', [node, 'id'], data.id, Object.entries(flows).map(([id, flow]) => [id, flow.name]))}{!flows[String(data.id)] && <p role="alert" className="text-sm text-destructive">找不到该共享步骤，请重新选择或检查项目步骤库。</p>}<p className="text-xs text-muted-foreground">运行时会展开共享步骤的当前版本，并保存到运行快照。</p></div>;
  if (node === 'wait') return <div className="grid grid-cols-2 gap-3">{field('等待时长', [node, 'duration'], data.duration, { number: true })}{select('时长单位', [node, 'unit'], data.unit, [['ms', '毫秒'], ['s', '秒'], ['min', '分钟']])}</div>;
  return <p className="text-sm text-muted-foreground">此节点使用高级 YAML 编辑。原有参数会完整保留。</p>;
}
