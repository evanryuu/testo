import { useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Check, Clock3, LoaderCircle, Play, Plus, Square } from 'lucide-react';
import type { BatchRun, Project, TestCase, WorkspaceState } from '../shared/workspace.js';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Checkbox } from '@/components/ui/checkbox';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';

const names: Record<string, string> = { queued: '排队中', running: '运行中', passed: '通过', failed: '失败', error: '错误', skipped: '已跳过', cancelled: '已取消', interrupted: '已中断' };
export function BatchStatus({ status }: { status: string }) {
  return <Badge data-status={status} variant="secondary" className={status === 'passed' ? 'bg-emerald-50 text-emerald-700' : status === 'failed' || status === 'error' ? 'bg-red-50 text-red-700' : ''}>{status === 'running' ? <LoaderCircle className="size-3 animate-spin" /> : status === 'passed' ? <Check className="size-3" /> : <Clock3 className="size-3" />}{names[status] ?? status}</Badge>;
}

export function BatchView({ project, cases, state, batch, refresh, started, openRun, configure }: {
  project?: Project; cases: TestCase[]; state: WorkspaceState; batch?: BatchRun; refresh(): Promise<void>;
  started(id: string): void; openRun(id: string): void; configure(): void;
}) {
  const available = cases.filter(item => item.workflows.some(workflow => workflow.platform === 'web' && workflow.ready));
  const [order, setOrder] = useState(() => available.map(item => item.id));
  const [selected, setSelected] = useState(() => available.map(item => item.id));
  const [environmentId, setEnvironmentId] = useState(project?.environments[0]?.id ?? '');
  const [assigned, setAssigned] = useState<Record<string, string>>({});
  const [policy, setPolicy] = useState<'stop' | 'continue'>('stop');
  const [sessionName, setSessionName] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const working = useRef(false);
  const environment = project?.environments.find(item => item.id === environmentId);
  const sessions = (state.sessions ?? []).filter(session => session.projectId === project?.id && session.environmentId === environmentId);
  const locked = busy || !!state.activeBatchId || !!state.activeRunId || !!state.connectingSession || !!state.recording && state.recording.status !== 'saved';
  const sessionFor = (id: string) => assigned[id] ?? sessions[0]?.id ?? '';
  const allSelected = available.length > 0 && available.every(item => selected.includes(item.id));
  const chosen = order.filter(id => selected.includes(id) && available.some(item => item.id === id));
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
  if (batch) return <div data-testid="batch-results" className="space-y-5">
    {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
    <Card><CardHeader className="flex flex-row items-center justify-between gap-4"><div className="space-y-2"><CardTitle>批次运行结果</CardTitle><p className="text-sm text-muted-foreground">{batch.environment} · {batch.items.length} 个用例 · {batch.failurePolicy === 'stop' ? '失败后停止' : '失败后继续'}</p></div><BatchStatus status={batch.status} /></CardHeader><CardContent><p className="text-xs text-muted-foreground">{new Date(batch.startedAt).toLocaleString('zh-CN')} · 各用例按列表顺序逐个执行</p></CardContent></Card>
    <Card className="gap-0 overflow-hidden py-0">{batch.items.map((item, index) => <div key={index} data-testid="batch-result-item" className="flex flex-wrap items-center gap-4 border-b px-5 py-4 last:border-b-0">
      <span className="text-xs text-muted-foreground">{String(index + 1).padStart(2, '0')}</span><div className="min-w-0 flex-1"><strong className="text-sm">{item.caseName}</strong><p className="mt-1 text-xs text-muted-foreground">登录窗口：{item.sessionName}</p>{item.error ? <p className="mt-2 whitespace-pre-wrap break-words text-xs text-destructive">{item.error}</p> : null}</div><BatchStatus status={item.status} /><Button size="sm" variant="outline" disabled={!item.runId} onClick={() => item.runId && openRun(item.runId)}>查看单例详情</Button>
    </div>)}</Card>
    <div className="flex justify-end">{batch.status === 'running' ? <Button variant="destructive" disabled={busy} onClick={() => void act(() => window.workspace.cancelBatch({ id: batch.id }))}><Square />取消批次</Button> : project ? <Button variant="outline" onClick={configure}>配置新批次</Button> : null}</div>
  </div>;
  if (!project) return <Alert><AlertDescription>项目当前不可用，请返回项目列表打开项目。</AlertDescription></Alert>;
  return <div data-testid="batch-config" className="space-y-5">
    {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
    {locked && !busy ? <Alert><AlertDescription>{state.connectingSession ? '正在确认登录窗口，请稍候。' : '请先结束当前运行或处理录制草稿，再启动批次。'}</AlertDescription></Alert> : null}
    <Card><CardHeader><CardTitle>运行设置</CardTitle></CardHeader><CardContent className="grid gap-5 sm:grid-cols-2">
      <label className="space-y-2 text-sm"><span>运行环境</span><NativeSelect className="w-full" aria-label="批量运行环境" disabled={locked} value={environmentId} onChange={event => { setEnvironmentId(event.target.value); setAssigned({}); }}>{project.environments.map(item => <NativeSelectOption key={item.id} value={item.id}>{item.name}</NativeSelectOption>)}</NativeSelect><p className="break-all text-xs text-muted-foreground">{environment?.web.baseUrl ?? '请先添加运行环境'}</p></label>
      <label className="space-y-2 text-sm"><span>失败处理</span><NativeSelect className="w-full" aria-label="批量失败处理" value={policy} disabled={locked} onChange={event => setPolicy(event.target.value as 'stop' | 'continue')}><NativeSelectOption value="stop">失败后停止（默认）</NativeSelectOption><NativeSelectOption value="continue">失败后继续下一用例</NativeSelectOption></NativeSelect></label>
    </CardContent></Card>
    <Card><CardHeader><CardTitle>已确认的登录窗口</CardTitle></CardHeader><CardContent className="space-y-4">
      <p className="text-sm leading-6 text-muted-foreground">请先在 Chrome 当前标签页打开此环境的网站，手动登录并允许 Midscene 扩展连接，然后确认当前窗口。平台只绑定当前标签页，不会打开其他网址；登录状态由你确认。</p>
      <div className="flex flex-wrap gap-3"><Input className="min-w-48 flex-1" aria-label="登录窗口名称" placeholder="例如：窗口 A、窗口 B" value={sessionName} disabled={locked} onChange={event => setSessionName(event.target.value)} /><Button variant="outline" disabled={locked || !environment || !sessionName.trim()} onClick={() => void act(async () => { await window.workspace.captureSession({ projectId: project.id, environmentId, name: sessionName.trim() }); setSessionName(''); })}><Plus />{state.connectingSession ? '正在确认登录窗口…' : '确认当前登录窗口'}</Button></div>
      <p className="text-xs leading-6 text-muted-foreground">若要连续运行而不逐次确认连接，可在 Midscene 扩展的连接提示中选择「Always Allow」。平台会在每个用例结束后释放连接，再连接下一个目标。</p>
      {sessions.length ? <div className="flex flex-wrap gap-2">{sessions.map(session => <Badge key={session.id} variant="outline" data-testid="confirmed-session">{session.name} · {session.origin}</Badge>)}</div> : <p className="text-xs text-muted-foreground">当前环境还没有已确认的登录窗口。</p>}
      <p className="text-xs leading-6 text-muted-foreground">同一 Chrome 用户配置的窗口共享登录状态；本版支持同一配置中的多个窗口，不支持跨配置批量执行。所有用例仍按全局顺序逐个执行。</p>
    </CardContent></Card>
    <Card className="gap-0 overflow-hidden py-0"><CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3 border-b py-4"><CardTitle>选择用例与执行顺序</CardTitle><label className="flex items-center gap-2 text-sm"><Checkbox aria-label="全选当前筛选用例" checked={allSelected} disabled={locked || !available.length} onCheckedChange={checked => setSelected(checked ? available.map(item => item.id) : [])} />全选当前筛选用例</label></CardHeader>
      <CardContent className="p-0">{order.map((id, index) => {
        const item = available.find(candidate => candidate.id === id); if (!item) return null;
        return <div data-testid="batch-case-row" data-case-id={id} key={id} className="flex flex-wrap items-center gap-3 border-b px-5 py-4 last:border-b-0">
          <Checkbox aria-label={`选择用例 ${item.name}`} checked={selected.includes(id)} disabled={locked} onCheckedChange={checked => setSelected(current => checked ? [...current.filter(value => value !== id), id] : current.filter(value => value !== id))} />
          <span className="text-xs text-muted-foreground">{index + 1}</span><span className="min-w-36 flex-1 text-sm font-medium">{item.name}</span>
          <NativeSelect aria-label={`用例 ${item.name} 登录窗口`} className="w-44" value={sessionFor(id)} disabled={locked || !selected.includes(id)} onChange={event => setAssigned(current => ({ ...current, [id]: event.target.value }))}><NativeSelectOption value="">请选择登录窗口</NativeSelectOption>{sessions.map(session => <NativeSelectOption key={session.id} value={session.id}>{session.name}</NativeSelectOption>)}</NativeSelect>
          <Button size="icon-sm" variant="ghost" aria-label={`上移用例 ${item.name}`} disabled={locked || index === 0} onClick={() => move(index, -1)}><ArrowUp /></Button><Button size="icon-sm" variant="ghost" aria-label={`下移用例 ${item.name}`} disabled={locked || index === order.length - 1} onClick={() => move(index, 1)}><ArrowDown /></Button>
        </div>;
      })}{!available.length ? <p className="p-6 text-sm text-muted-foreground">当前筛选中没有已保存 Web Workflow 的用例。</p> : null}</CardContent>
    </Card>
    <div className="sticky bottom-0 z-10 flex flex-wrap items-center justify-between gap-3 border-t bg-background/95 py-4"><p className="text-xs text-muted-foreground">已选择 {chosen.length} 个用例{cases.length !== available.length ? ` · ${cases.length - available.length} 个用例尚不能运行 Web` : ''}</p><Button disabled={locked || !environment || !chosen.length || chosen.some(id => !sessions.some(session => session.id === sessionFor(id)))} onClick={() => void act(async () => {
      const id = await window.workspace.runBatch({ projectId: project.id, environmentId, failurePolicy: policy, items: chosen.map(caseId => ({ caseId, workflowId: available.find(item => item.id === caseId)!.workflows.find(workflow => workflow.platform === 'web' && workflow.ready)!.id, sessionId: sessionFor(caseId) })) }); started(id);
    })}><Play />开始批量运行</Button></div>
  </div>;
}
