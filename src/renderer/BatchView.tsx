import { useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Check, Clock3, LoaderCircle, Play, Square } from 'lucide-react';
import type { BatchAttempt, BatchRun, Project, TestCase, WorkspaceState } from '../shared/workspace.js';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ChromeTabPicker } from './ChromeTabPicker.js';
import { VariableEditor } from './VariableEditor.js';
import { Input } from '@/components/ui/input';
import { parseWorkflow, type Variables } from '../shared/workflow-document.js';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Checkbox } from '@/components/ui/checkbox';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';

const names: Record<string, string> = { queued: '排队中', running: '运行中', passed: '通过', failed: '失败', error: '错误', skipped: '已跳过', cancelled: '已取消', interrupted: '已中断' };
export function BatchStatus({ status }: { status: string }) {
  return <Badge data-status={status} variant="secondary" className={status === 'passed' ? 'bg-emerald-50 text-emerald-700' : status === 'failed' || status === 'error' ? 'bg-red-50 text-red-700' : ''}>{status === 'running' ? <LoaderCircle className="size-3 animate-spin" /> : status === 'passed' ? <Check className="size-3" /> : <Clock3 className="size-3" />}{names[status] ?? status}</Badge>;
}

function AttemptHistory({ attempts, openRun }: { attempts: BatchAttempt[]; openRun(id: string): void }) {
  const [selected, setSelected] = useState<number>();
  const [page, setPage] = useState(0);
  const attempt = attempts.find(item => item.number === selected) ?? attempts[attempts.length - 1];
  if (!attempt) return null;
  return <Card data-testid="batch-attempt-history"><CardHeader><CardTitle>运行记录</CardTitle></CardHeader><CardContent className="space-y-4">
    <NativeSelect aria-label="查看运行轮次" value={attempt.number} onChange={event => { setSelected(Number(event.target.value)); setPage(0); }}>
      {[...attempts].reverse().map(item => <NativeSelectOption key={item.number} value={item.number}>{item.number === 0 ? '首次运行' : `第 ${item.number} 次重跑`} · {item.items.length} 个用例 · {names[item.status]}</NativeSelectOption>)}
    </NativeSelect>
    <p className="text-xs text-muted-foreground">{new Date(attempt.startedAt).toLocaleString('zh-CN')} · {attempt.mode === 'failed' ? '重跑失败用例' : attempt.mode === 'unfinished' ? '运行未完成用例' : attempt.mode === 'all' ? '重跑整个批次' : '首次运行'}</p>
    {attempt.snapshot ? <p data-testid="batch-attempt-environment" className="break-all text-xs text-muted-foreground">本轮运行地址：{attempt.snapshot.baseUrl}</p> : null}
    <div className="divide-y">{attempt.items.slice(page * 50, (page + 1) * 50).map((item, index) => <div key={index} data-testid="batch-attempt-item" className="flex flex-wrap items-center gap-3 py-3">
      <div className="min-w-0 flex-1"><p className="text-sm">{item.caseName}</p>{item.error ? <p className="mt-1 whitespace-pre-wrap break-words text-xs text-destructive">{item.error}</p> : null}</div>
      <BatchStatus status={item.status} /><Button size="sm" variant="outline" disabled={!item.runId} onClick={() => item.runId && openRun(item.runId)}>查看本次详情</Button>
    </div>)}</div>
    {attempt.items.length > 50 ? <div className="flex justify-end gap-3"><Button variant="outline" disabled={page === 0} onClick={() => setPage(value => value - 1)}>上一页记录</Button><span>{page + 1} / {Math.ceil(attempt.items.length / 50)}</span><Button variant="outline" disabled={(page + 1) * 50 >= attempt.items.length} onClick={() => setPage(value => value + 1)}>下一页记录</Button></div> : null}
  </CardContent></Card>;
}

export function BatchView({ project, cases, state, batch, refresh, started, openRun, configure, groupIds }: {
  groupIds?: string[]; project?: Project; cases: TestCase[]; state: WorkspaceState; batch?: BatchRun; refresh(): Promise<void>;
  started(id: string): void; openRun(id: string): void; configure(): void;
}) {
  const available = cases.filter(item => item.workflows.some(workflow => workflow.platform === 'web' && workflow.ready));
  const groupMode = !!groupIds?.length;
  const groupById = new Map((project?.groups ?? []).map(group => [group.id, group]));
  const selectedGroups = (groupIds ?? []).flatMap(id => groupById.has(id) ? [groupById.get(id)!] : []);
  const groupCaseIds = [...new Set(selectedGroups.flatMap(group => group.caseIds))];
  const availableById = new Map(available.map(item => [item.id, item]));
  const invalidGroups = groupMode && (selectedGroups.length !== groupIds!.length || selectedGroups.some(group => !group.caseIds.length) || groupCaseIds.some(id => !availableById.has(id)));
  const [listPage, setListPage] = useState(0), [resultPage, setResultPage] = useState(0);
  const [groupSession, setGroupSession] = useState('');
  const [order, setOrder] = useState(() => available.map(item => item.id));
  const [selected, setSelected] = useState(() => available.map(item => item.id));
  const [environmentId, setEnvironmentId] = useState(batch?.environmentId ?? project?.environments[0]?.id ?? '');
  const [assigned, setAssigned] = useState<Record<string, string>>({});
  const [variables, setVariables] = useState<Variables>(batch?.snapshot?.variables ?? {});
  const [variablesValid, setVariablesValid] = useState(true);
  const [loginCondition, setLoginCondition] = useState(batch?.snapshot?.loginCondition ?? '');
  const [timeoutSeconds, setTimeoutSeconds] = useState(batch?.snapshot?.timeoutMs ? String(batch.snapshot.timeoutMs / 1000) : '');
  const [allowUnverifiedGenerated, setAllowUnverifiedGenerated] = useState(false);
  const [dependent, setDependent] = useState(batch?.dependent ?? false);
  const [datasetIds, setDatasetIds] = useState<Record<string, string>>({});
  const [datasets, setDatasets] = useState<Record<string, {id:string;name:string}[]>>({});
  useEffect(() => {
    if (!project || batch) return;
    let live = true;
    const page = (groupMode ? groupCaseIds : order).slice(listPage * 50, (listPage + 1) * 50);
    void Promise.all(page.map(async id => {
      const workflow = availableById.get(id)?.workflows.find(w => w.platform === 'web' && w.ready); if (!workflow) return;
      try { const file = await window.workspace.workflow({ projectId: project.id, caseId: id, workflowId: workflow.id }); const values = parseWorkflow(file.text).testo?.datasets ?? []; if (live) setDatasets(current => ({ ...current, [id]: values })); } catch { /* The run preflight reports invalid workflows. */ }
    }));
    return () => { live = false; };
  }, [project?.id, batch?.id, listPage, order.join('|'), groupCaseIds.join('|')]);
  const [policy, setPolicy] = useState<'stop' | 'continue'>(batch?.failurePolicy ?? 'stop');
  const [pickerBusy, setPickerBusy] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const working = useRef(false);
  const environment = project?.environments.find(item => item.id === environmentId);
  const sessions = (state.sessions ?? []).filter(session => session.projectId === project?.id && session.environmentId === environmentId);
  const locked = busy || pickerBusy || !!state.activeBatchId || !!state.activeRunId || !!state.connectingSession || !!state.recording && state.recording.status !== 'saved';
  const sessionFor = (id: string) => assigned[id] ?? (groupSession || sessions[0]?.id || '');
  const allSelected = available.length > 0 && available.every(item => selected.includes(item.id));
  const selectedSet = new Set(selected);
  const chosen = groupMode ? groupCaseIds : order.filter(id => selectedSet.has(id) && availableById.has(id));
  const targetSession = groupSession || sessions[0]?.id || '';
  const validRetrySession = !!environment && sessions.some(session => session.id === targetSession);
  const pageSize = 50;
  async function act(work: () => Promise<void>) {
    if (working.current) return;
    working.current = true; setBusy(true); setError('');
    try { await work(); await refresh(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { working.current = false; setBusy(false); }
  }
  function move(index: number, offset: number) {
    setOrder(current => {
      const next = [...current], target = index + offset;
      if (target < 0 || target >= next.length) return current;
      [next[index], next[target]] = [next[target]!, next[index]!]; return next;
    });
  }
  const trialChoice = <label className="flex items-start gap-2 text-sm"><Checkbox checked={allowUnverifiedGenerated} onCheckedChange={value => setAllowUnverifiedGenerated(value === true)} disabled={locked} />允许试跑当前版本尚未验证的生成用例（会真实操作所选页面）</label>;
  if (batch) return <div data-testid="batch-results" className="space-y-5">
    {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
    <p data-testid="batch-aggregate-summary" className="text-sm">已通过 {batch.items.filter(item => item.status === 'passed').length} / {batch.items.length} 个用例 · 已重跑 {Math.max(0, (batch.attempts?.length ?? 1) - 1)} 次。汇总显示各用例的最新结果，结果可能来自不同轮次和环境。</p>
    <Card><CardHeader className="flex flex-row items-center justify-between gap-4"><div className="space-y-2"><CardTitle>批次运行结果</CardTitle><p className="text-sm text-muted-foreground">最近一次运行环境：{batch.environment} · {batch.items.length} 个用例 · {batch.failurePolicy === 'stop' ? '失败后停止' : '失败后继续'}</p></div><BatchStatus status={batch.status} /></CardHeader><CardContent>{batch.groups?.length ? <p className="mb-2 text-sm" data-testid="batch-source-groups">Group：{batch.groups.slice(0, 10).map(group => group.name).join("、")}{batch.groups.length > 10 ? ` 等 ${batch.groups.length} 组` : ""}</p> : null}<p className="mb-2 text-sm">已完成 {batch.items.filter(item => !["running", "queued"].includes(item.status)).length} / {batch.items.length} 个用例</p><p className="text-xs text-muted-foreground">{new Date(batch.startedAt).toLocaleString('zh-CN')} · 各用例按列表顺序逐个执行</p></CardContent></Card>
    <Card className="gap-0 overflow-hidden py-0">{batch.items.slice(resultPage * pageSize, (resultPage + 1) * pageSize).map((item, index) => <div key={index} data-testid="batch-result-item" className="flex flex-wrap items-center gap-4 border-b px-5 py-4 last:border-b-0">
      <span className="text-xs text-muted-foreground">{String(resultPage * pageSize + index + 1).padStart(2, '0')}</span><div className="min-w-0 flex-1"><strong className="text-sm">{item.caseName}</strong><p className="mt-1 text-xs text-muted-foreground">运行标签页：{item.sessionName}</p>{item.groupNames?.length ? <p className="mt-1 text-xs text-muted-foreground">Group：{item.groupNames.slice(0, 3).join("、")}{item.groupNames.length > 3 ? ` 等 ${item.groupNames.length} 组` : ""}</p> : null}{item.error ? <p className="mt-2 whitespace-pre-wrap break-words text-xs text-destructive">{item.error}</p> : null}</div><BatchStatus status={item.status} /><Button size="sm" variant="outline" disabled={!item.runId} onClick={() => item.runId && openRun(item.runId)}>查看单例详情</Button>
    </div>)}</Card>
    {batch.items.length > pageSize ? <div className="flex items-center justify-end gap-3"><Button variant="outline" disabled={resultPage === 0} onClick={() => setResultPage(page => page - 1)}>上一页结果</Button><span className="text-sm">{resultPage + 1} / {Math.ceil(batch.items.length / pageSize)}</span><Button variant="outline" disabled={(resultPage + 1) * pageSize >= batch.items.length} onClick={() => setResultPage(page => page + 1)}>下一页结果</Button>{batch.status === 'running' ? <Button variant="outline" onClick={() => setResultPage(Math.floor(Math.max(0, batch.items.findIndex(item => item.status === 'running')) / pageSize))}>定位正在运行</Button> : null}</div> : null}
    {batch.attempts?.length ? <AttemptHistory key={batch.attempts.length} attempts={batch.attempts} openRun={openRun} /> : null}
    {batch.status !== 'running' && project && batch.snapshot ? <Card><CardHeader><CardTitle>在当前批次重跑</CardTitle></CardHeader><CardContent className="space-y-4">
      <p className="text-sm text-muted-foreground">重跑前会读取最新保存的 YAML 和共享步骤，保留原批次的用例顺序。继续使用同一环境时保留上次运行配置；选择其他环境时更新运行地址和环境默认变量。结果会聚合到当前批次，历次记录仍可查看。请重新选择运行标签页。{batch.dependent ? '此批次包含前后依赖，重跑时会从第一条用例完整执行。' : ''}</p>
      {batch.sourceBatchId && <p className="text-xs">来源批次：{batch.sourceBatchId}</p>}
      <label className="space-y-2 text-sm"><span>重跑环境</span><NativeSelect className="w-full" aria-label="重跑环境" disabled={locked} value={environmentId} onChange={event => { setEnvironmentId(event.target.value); setGroupSession(''); }}>{project.environments.map(item => <NativeSelectOption key={item.id} value={item.id}>{item.name}</NativeSelectOption>)}</NativeSelect><p data-testid="batch-retry-base-url" className="break-all text-xs text-muted-foreground">{environmentId === batch.snapshot.environmentId ? batch.snapshot.baseUrl : environment?.web.baseUrl ?? '请先添加运行环境'}</p></label>
      <ChromeTabPicker projectId={project.id} environmentId={environmentId} disabled={locked} onBusy={setPickerBusy} selected={async id => { setGroupSession(id); await refresh(); }} />
      <NativeSelect aria-label="重跑标签页" value={targetSession} onChange={event => setGroupSession(event.target.value)} disabled={locked}><NativeSelectOption value="">请选择运行标签页</NativeSelectOption>{sessions.map(session => <NativeSelectOption key={session.id} value={session.id}>{session.name}</NativeSelectOption>)}</NativeSelect>
      <VariableEditor label="重跑共享变量" value={variables} onChange={setVariables} onValidityChange={setVariablesValid} disabled={locked} />
      {trialChoice}<div className="flex flex-wrap gap-3">{(['failed','unfinished','all'] as const).map(mode => <Button key={mode} variant="outline" disabled={locked || !validRetrySession || !variablesValid || (mode === 'failed' && !batch.items.some(item => ['failed','error'].includes(item.status))) || (mode === 'unfinished' && !batch.items.some(item => ['skipped','queued','running','interrupted','cancelled'].includes(item.status)))} onClick={() => void act(async () => { const id = await window.workspace.retryBatch({ id: batch.id, mode, environmentId, sessionId: targetSession, variables, allowUnverifiedGenerated }); started(id); })}>{mode === 'failed' ? '重跑失败用例' : mode === 'unfinished' ? '运行未完成用例' : '重跑整个批次'}</Button>)}</div>
    </CardContent></Card> : null}
    <div className="flex justify-end">{batch.status === 'running' ? <Button variant="destructive" disabled={busy} onClick={() => void act(() => window.workspace.cancelBatch({ id: batch.id }))}><Square />取消批次</Button> : project ? <Button variant="outline" onClick={configure}>配置新批次</Button> : null}</div>
  </div>;
  if (!project) return <Alert><AlertDescription>项目当前不可用，请返回项目列表打开项目。</AlertDescription></Alert>;
  return <div data-testid="batch-config" className="space-y-5">
    {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
    {locked && !busy && !pickerBusy ? <Alert><AlertDescription>{state.connectingSession ? '正在连接所选标签页，请稍候。' : '请先结束当前运行或处理录制草稿，再启动批次。'}</AlertDescription></Alert> : null}
    {trialChoice}<Card><CardHeader><CardTitle>运行设置</CardTitle></CardHeader><CardContent className="grid gap-5 sm:grid-cols-2">
      <label className="space-y-2 text-sm"><span>运行环境</span><NativeSelect className="w-full" aria-label="批量运行环境" disabled={locked} value={environmentId} onChange={event => { setEnvironmentId(event.target.value); setAssigned({}); setGroupSession(''); }}>{project.environments.map(item => <NativeSelectOption key={item.id} value={item.id}>{item.name}</NativeSelectOption>)}</NativeSelect><p className="break-all text-xs text-muted-foreground">{environment?.web.baseUrl ?? '请先添加运行环境'}</p></label>
      <label className="space-y-2 text-sm"><span>失败处理</span><NativeSelect className="w-full" aria-label="批量失败处理" value={policy} disabled={locked} onChange={event => setPolicy(event.target.value as 'stop' | 'continue')}><NativeSelectOption value="stop">失败后停止（默认）</NativeSelectOption><NativeSelectOption value="continue">失败后继续下一用例</NativeSelectOption></NativeSelect></label>
    </CardContent></Card>
    <Card><CardHeader><CardTitle>批次共享设置</CardTitle></CardHeader><CardContent className="space-y-5">
      <VariableEditor label="批次共享变量" value={variables} onChange={setVariables} onValidityChange={setVariablesValid} disabled={locked} />
      <p className="text-xs text-muted-foreground">这里的值会覆盖每条用例的默认值和数据集。例如，给 knowledgeBaseName 设置一个名称，新建和删除知识库都会使用同一名称。</p>
      <label className="flex items-start gap-2 text-sm"><Checkbox checked={dependent} onCheckedChange={value => setDependent(value === true)} disabled={locked} />用例有前后依赖，重跑时必须从第一条开始</label>
      <div className="grid gap-4 sm:grid-cols-2"><label className="space-y-2 text-sm">登录状态检查（可选）<Input aria-label="批次登录检查" value={loginCondition} onChange={event => setLoginCondition(event.target.value)} disabled={locked} placeholder="每条用例开始前检查页面状态" /></label><label className="space-y-2 text-sm">每条用例总时限（秒，可选）<Input aria-label="批次用例时限" type="number" min="1" max="86400" value={timeoutSeconds} onChange={event => setTimeoutSeconds(event.target.value)} disabled={locked} placeholder="按各用例步骤自动计算" /></label></div>
    </CardContent></Card>
    <ChromeTabPicker projectId={project.id} environmentId={environmentId} disabled={locked} onBusy={setPickerBusy} selected={async id => { setGroupSession(id); await refresh(); }} />
    {sessions.length ? <div className="flex flex-wrap gap-2">{sessions.map(session => <Badge key={session.id} variant="outline" data-testid="confirmed-session">{session.name} · {session.url || session.origin}</Badge>)}</div> : null}
    <p className="text-xs leading-6 text-muted-foreground">批次中的用例按全局顺序逐个执行。每个用例使用下方指定的 Profile 和标签页。</p>
    {groupMode ? <Card data-testid="group-run-summary"><CardHeader><CardTitle>运行已保存的 Group</CardTitle></CardHeader><CardContent className="space-y-4"><p className="text-sm">{selectedGroups.slice(0, 10).map(group => group.name).join(' → ')}{selectedGroups.length > 10 ? ` 等 ${selectedGroups.length} 组` : ''}</p><p className="text-xs text-muted-foreground">按所选 Group 和组内顺序执行，共 {groupCaseIds.length} 个不同用例，重复用例只运行一次。</p>{invalidGroups ? <Alert variant="destructive"><AlertDescription>所选 Group 为空、已不存在，或包含缺失用例及未保存的 Web Workflow。请返回 Groups 修复后再运行。</AlertDescription></Alert> : null}<label className="flex items-center gap-3 text-sm">本次运行标签页<NativeSelect aria-label="Group 运行标签页" value={targetSession} disabled={locked} onChange={event => setGroupSession(event.target.value)}><NativeSelectOption value="">请选择运行标签页</NativeSelectOption>{sessions.map(session => <NativeSelectOption key={session.id} value={session.id}>{session.name}</NativeSelectOption>)}</NativeSelect></label><p className="break-all text-xs text-muted-foreground">{sessions.find(session => session.id === targetSession)?.name} · {sessions.find(session => session.id === targetSession)?.url || sessions.find(session => session.id === targetSession)?.origin}</p><div className="divide-y rounded-md border">{groupCaseIds.slice(listPage * pageSize, (listPage + 1) * pageSize).map((id, index) => <div data-testid="group-run-case" key={id} className="flex gap-3 px-4 py-3 text-sm"><span className="text-muted-foreground">{listPage * pageSize + index + 1}</span><span className="flex-1">{availableById.get(id)?.name ?? `不可运行：${id}`}</span>{datasets[id]?.length ? <NativeSelect aria-label={`数据集 ${availableById.get(id)?.name}`} value={datasetIds[id] ?? ''} onChange={event => setDatasetIds(current => ({ ...current, [id]: event.target.value }))}><NativeSelectOption value="">默认数据</NativeSelectOption>{datasets[id]!.map(dataset => <NativeSelectOption key={dataset.id} value={dataset.id}>{dataset.name}</NativeSelectOption>)}</NativeSelect> : null}</div>)}</div></CardContent></Card> : <Card className="gap-0 overflow-hidden py-0"><CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3 border-b py-4"><CardTitle>选择用例与执行顺序</CardTitle><label className="flex items-center gap-2 text-sm"><Checkbox aria-label="全选当前筛选用例" checked={allSelected} disabled={locked || !available.length} onCheckedChange={checked => setSelected(checked ? available.map(item => item.id) : [])} />全选当前筛选用例</label></CardHeader>
      <CardContent className="p-0">{order.slice(listPage * pageSize, (listPage + 1) * pageSize).map((id, pageIndex) => {
        const index = listPage * pageSize + pageIndex;
        const item = availableById.get(id); if (!item) return null;
        return <div data-testid="batch-case-row" data-case-id={id} key={id} className="flex flex-wrap items-center gap-3 border-b px-5 py-4 last:border-b-0">
          <Checkbox aria-label={`选择用例 ${item.name}`} checked={selected.includes(id)} disabled={locked} onCheckedChange={checked => setSelected(current => checked ? [...current.filter(value => value !== id), id] : current.filter(value => value !== id))} />
          <span className="text-xs text-muted-foreground">{index + 1}</span><span className="min-w-36 flex-1 text-sm font-medium">{item.name}</span>
          <div className="w-72 max-w-full space-y-1"><NativeSelect aria-label={`用例 ${item.name} 运行标签页`} className="w-full" value={sessionFor(id)} disabled={locked || !selected.includes(id)} onChange={event => setAssigned(current => ({ ...current, [id]: event.target.value }))}><NativeSelectOption value="">请选择运行标签页</NativeSelectOption>{sessions.map(session => <NativeSelectOption key={session.id} value={session.id}>{session.name}</NativeSelectOption>)}</NativeSelect><p className="break-all text-xs text-muted-foreground">{sessions.find(session => session.id === sessionFor(id))?.url || sessions.find(session => session.id === sessionFor(id))?.origin}</p></div>
          {datasets[id]?.length ? <NativeSelect aria-label={`数据集 ${item.name}`} value={datasetIds[id] ?? ''} disabled={locked} onChange={event => setDatasetIds(current => ({ ...current, [id]: event.target.value }))}><NativeSelectOption value="">默认数据</NativeSelectOption>{datasets[id]!.map(dataset => <NativeSelectOption key={dataset.id} value={dataset.id}>{dataset.name}</NativeSelectOption>)}</NativeSelect> : null}
          <Button size="icon-sm" variant="ghost" aria-label={`上移用例 ${item.name}`} disabled={locked || index === 0} onClick={() => move(index, -1)}><ArrowUp /></Button><Button size="icon-sm" variant="ghost" aria-label={`下移用例 ${item.name}`} disabled={locked || index === order.length - 1} onClick={() => move(index, 1)}><ArrowDown /></Button>
        </div>;
      })}{!available.length ? <p className="p-6 text-sm text-muted-foreground">当前筛选中没有已保存 Web Workflow 的用例。</p> : null}</CardContent>
    </Card>}
    {(groupMode ? groupCaseIds.length : order.length) > pageSize ? <div className="flex items-center justify-end gap-3"><Button variant="outline" disabled={listPage === 0} onClick={() => setListPage(page => page - 1)}>上一页用例</Button><span className="text-sm">{listPage + 1} / {Math.ceil((groupMode ? groupCaseIds.length : order.length) / pageSize)}</span><Button variant="outline" disabled={(listPage + 1) * pageSize >= (groupMode ? groupCaseIds.length : order.length)} onClick={() => setListPage(page => page + 1)}>下一页用例</Button></div> : null}
    <div className="sticky bottom-0 z-10 flex flex-wrap items-center justify-between gap-3 border-t bg-background/95 py-4"><p className="text-xs text-muted-foreground">已选择 {chosen.length} 个用例{!groupMode && cases.length !== available.length ? ` · ${cases.length - available.length} 个用例尚不能运行 Web` : ''}</p><Button disabled={locked || !variablesValid || !environment || !chosen.length || (groupMode ? invalidGroups || !sessions.some(session => session.id === targetSession) : chosen.some(id => !sessions.some(session => session.id === sessionFor(id))))} onClick={() => void act(async () => {
      const id = groupMode ? await window.workspace.runGroups({ projectId: project.id, environmentId, failurePolicy: policy, sessionId: targetSession, groupIds: groupIds!, variables, datasetIds, loginCondition, dependent, allowUnverifiedGenerated, timeoutMs: timeoutSeconds ? Number(timeoutSeconds) * 1000 : undefined }) : await window.workspace.runBatch({ projectId: project.id, environmentId, failurePolicy: policy, variables, loginCondition, dependent, allowUnverifiedGenerated, timeoutMs: timeoutSeconds ? Number(timeoutSeconds) * 1000 : undefined, items: chosen.map(caseId => ({ caseId, workflowId: availableById.get(caseId)!.workflows.find(workflow => workflow.platform === 'web' && workflow.ready)!.id, sessionId: sessionFor(caseId), datasetId: datasetIds[caseId] || undefined })) }); started(id);
    })}><Play />开始批量运行</Button></div>
  </div>;
}
