import { attachOverlayScrollbars } from '@/lib/scrollbars';
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ArrowLeft, ArrowRight, Box, Check, ChevronRight, Circle, Clock3, Code2, FileCode2, Folder, FolderOpen, Globe2, Layers3, LayoutGrid, LoaderCircle, Monitor, Play, Plus, RefreshCw, Search, Settings2, ShieldCheck, Smartphone, Square, X } from 'lucide-react';
import { RecordingView } from './RecordingView.js';
import { BatchStatus, BatchView } from './BatchView.js';
import { HistoryView } from './HistoryView.js';
import { GitPanel } from './GitPanel.js';
import { WorkflowEditor } from './WorkflowEditor.js';
import { VariableEditor } from './VariableEditor.js';
import { AppUpdatePanel } from './AppUpdatePanel.js';
import { ProjectAssetsView } from './ProjectAssetsView.js';
import { ChromeTabPicker } from './ChromeTabPicker.js';
import { parseWorkflow } from '../shared/workflow-document.js';
import type { Variables, DebugSelection } from '../shared/workflow-document.js';
import type { PreflightResult } from '../shared/workspace.js';
import { GroupsView } from './GroupsView.js';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Checkbox } from '@/components/ui/checkbox';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Separator } from '@/components/ui/separator';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import type { RunStepInfo } from '../shared/run-steps.js';
import type { WorkerEvent } from '../runner/messages.js';
import type { HistoryRun, Project, TestCase, WorkspaceState } from '../shared/workspace.js';

type View = 'projects' | 'cases' | 'detail' | 'runs' | 'run' | 'environments' | 'settings' | 'recorder' | 'batch' | 'groups' | 'assets';
type Modal = { kind: 'project' | 'suite' | 'case' | 'edit' | 'environment' | 'workflow'; id?: string; text?: string; revision?: string };
const initial: WorkspaceState = { projects: [], runs: [], model: { name: '', baseUrl: '', family: '', hasApiKey: false }, errors: [] };
const platformNames: Record<string, string> = { web: 'Web', android: 'Android', ios: 'iOS' };
const statusNames: Record<string, string> = { passed: 'Passed', failed: 'Failed', error: 'Error', running: 'Running', cancelled: 'Cancelled', interrupted: 'Interrupted' };
const date = (value: string) => new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
const duration = (ms?: number) => ms === undefined ? '—' : `${(ms / 1000).toFixed(1)}s`;

function Status({ status }: { status?: string }) {
  return <Badge variant="secondary" data-status={status || 'none'} className={cn('gap-1.5 font-medium', {
    'bg-emerald-50 text-emerald-700': status === 'passed',
    'bg-red-50 text-red-700': status === 'failed' || status === 'error',
    'bg-primary/10 text-primary': status === 'running',
  })}>{status === 'running' ? <LoaderCircle className="size-3 animate-spin" /> : <span className="size-1.5 rounded-full bg-current opacity-70" />}{status ? statusNames[status] : '未运行'}</Badge>;
}
function Platform({ name }: { name: string }) {
  return <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">{name === 'web' ? <Globe2 className="size-3.5" /> : <Smartphone className="size-3.5" />}{platformNames[name]}</span>;
}
function Empty({ icon, title, children, action }: { icon: ReactNode; title: string; children: ReactNode; action?: ReactNode }) {
  return <div className="flex min-h-60 flex-col items-center justify-center gap-3 px-6 py-10 text-center"><div className="mb-1 flex size-14 items-center justify-center rounded-2xl bg-primary/5 text-primary/60">{icon}</div><h3 className="text-base font-medium">{title}</h3><p className="max-w-md text-sm leading-6 text-muted-foreground">{children}</p>{action}</div>;
}
function Field({ label, id, children }: { label: string; id: string; children: ReactNode }) {
  return <div className="grid gap-2 [&_[data-slot=native-select-wrapper]]:w-full"><Label htmlFor={id}>{label}</Label>{children}</div>;
}
function FormDialog({ title, children, close, submit, busy, error, wide, valid = true }: { valid?: boolean; wide?: boolean; title: string; children: ReactNode; close(): void; submit(form: FormData): void; busy: boolean; error: string }) {
  return <Dialog open onOpenChange={(open) => { if (!open && !busy) close(); }}>
    <DialogContent showCloseButton={false} className={cn("gap-0 overflow-hidden p-0 sm:max-w-xl", wide && "sm:max-w-[min(1100px,94vw)]")} onEscapeKeyDown={(e) => { if (busy) e.preventDefault(); }} onInteractOutside={(e) => e.preventDefault()}>
      <DialogHeader className="relative border-b p-6 pr-16"><DialogTitle>{title}</DialogTitle><DialogDescription className="sr-only">填写内容后保存到当前 Workspace。</DialogDescription><Button type="button" variant="ghost" size="icon-sm" aria-label="关闭弹窗" disabled={busy} onClick={close} className="absolute top-4 right-4"><X /></Button></DialogHeader>
      <form onSubmit={(e: FormEvent<HTMLFormElement>) => { e.preventDefault(); if (!busy && valid) submit(new FormData(e.currentTarget)); }}>
        <div ref={attachOverlayScrollbars} className="grid max-h-[65vh] gap-5 overflow-y-auto p-6">{children}{error ? <Alert variant="destructive"><AlertDescription className="whitespace-pre-wrap break-words">{error}</AlertDescription></Alert> : null}</div>
        <DialogFooter className="border-t bg-muted/30 p-4 px-6"><Button type="button" variant="outline" disabled={busy} onClick={close}>取消</Button><Button type="submit" disabled={busy || !valid}>{busy ? <LoaderCircle className="animate-spin" /> : <Check />}保存</Button></DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}
export function App() {
  const [state, setState] = useState(initial), [loaded, setLoaded] = useState(false);
  const [view, setView] = useState<View>('projects'), [projectId, setProjectId] = useState(''), [caseId, setCaseId] = useState(''), [runId, setRunId] = useState('');
  const [batchId, setBatchId] = useState(''), [batchCaseIds, setBatchCaseIds] = useState<string[]>([]);
  const [batchGroupIds, setBatchGroupIds] = useState<string[] | undefined>();
  const [query, setQuery] = useState(''), [suite, setSuite] = useState('all'), [environmentId, setEnvironmentId] = useState('');
  const [workflowValid, setWorkflowValid] = useState(true);
  const [environmentVariables, setEnvironmentVariables] = useState<Variables>({}), [environmentValid, setEnvironmentValid] = useState(true);
  const [modal, setModal] = useState<Modal | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [browserMode, setBrowserMode] = useState<'isolated' | 'bridge'>('isolated');
  const [sessionId, setSessionId] = useState(''), [pickerBusy, setPickerBusy] = useState(false);
  const [variables, setVariables] = useState<Variables>({}), [variablesValid, setVariablesValid] = useState(true), [datasetId, setDatasetId] = useState('');
  const [loginCondition, setLoginCondition] = useState(''), [timeoutSeconds, setTimeoutSeconds] = useState('');
  const [preflight, setPreflight] = useState<PreflightResult>();
  const [datasets, setDatasets] = useState<{ id: string; name: string }[]>([]);
  const [detailRun, setDetailRun] = useState<HistoryRun>();
  const [caseHistory, setCaseHistory] = useState<{ runs: HistoryRun[]; total: number }>({ runs: [], total: 0 }), [caseHistoryPage, setCaseHistoryPage] = useState(0);
  const sequence = useRef(0);
  const refresh = useCallback(async () => {
    const n = ++sequence.current;
    try { const next = await window.workspace.state(); if (n === sequence.current) { setState(next); setLoaded(true); } }
    catch (e) { setError(String(e)); setLoaded(true); }
  }, []);
  useEffect(() => { void refresh(); return window.workspace.onChange(() => { void refresh(); }); }, [refresh]);
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(''), 3500); return () => clearTimeout(timer); }, [notice]);
  const project = state.projects.find((p) => p.id === projectId);
  const item = project?.cases.find((c) => c.id === caseId);
  const selectedRun = detailRun?.runId === runId ? detailRun : state.runs.find((r) => r.runId === runId);
  useEffect(() => { if (!runId) return; let live = true; void window.workspace.runDetail({ runId }).then(run => { if (live) setDetailRun(run); }).catch(() => {}); return () => { live = false; }; }, [runId]);
  useEffect(() => window.workspace.onRunChange(run => { setDetailRun(current => current?.runId === run.runId || runId === run.runId ? run : current); setState(current => ({ ...current, runs: [run, ...current.runs.filter(item => item.runId !== run.runId)].slice(0, 50) })); }), [runId]);
  useEffect(() => { setVariables({}); setDatasetId(''); setSessionId(''); setPreflight(undefined); }, [caseId, projectId, environmentId]);
  useEffect(() => { let live = true; const workflow = item?.workflows.find(w => w.platform === 'web' && w.ready); if (!project || !item || !workflow) { setDatasets([]); return; } void window.workspace.workflow({ projectId: project.id, caseId: item.id, workflowId: workflow.id }).then(file => { if (live) { const next = parseWorkflow(file.text).testo?.datasets ?? []; setDatasets(next); setDatasetId(current => next.some(dataset => dataset.id === current) ? current : ''); } }).catch(() => { if (live) setDatasets([]); }); return () => { live = false; }; }, [projectId, caseId, item?.revision, item?.workflows.find(workflow => workflow.platform === 'web')?.ready, modal?.kind === 'workflow']);
  useEffect(() => { setCaseHistoryPage(0); setCaseHistory({ runs: [], total: 0 }); }, [projectId, caseId]);
  useEffect(() => {
    if (view !== 'detail' || !projectId || !caseId) return;
    let live = true;
    const load = () => { void window.workspace.history({ projectId, caseId, offset: caseHistoryPage * 50, limit: 50 }).then(result => { if (live) setCaseHistory(result); }).catch(cause => { if (live) setError(String(cause)); }); };
    load(); const stop = window.workspace.onChange(load);
    return () => { live = false; stop(); };
  }, [view, projectId, caseId, caseHistoryPage]);
  const selectedBatch = state.batches?.find(batch => batch.id === batchId);
  function openBatch(id: string) {
    const batch = state.batches?.find(item => item.id === id);
    if (!batch) return;
    setBatchId(id); setProjectId(batch.projectId); go('batch');
  }
  const selectedEnv = project?.environments.find((e) => e.id === environmentId) ?? project?.environments[0];
  const selectedSession = (state.sessions ?? []).find(session => session.id === sessionId && session.projectId === projectId && session.environmentId === selectedEnv?.id);
  const bridgeMissingSession = browserMode === 'bridge' && !selectedSession;
  const runSettingsValid = variablesValid && (!timeoutSeconds || Number.isInteger(Number(timeoutSeconds)) && Number(timeoutSeconds) >= 1 && Number(timeoutSeconds) <= 86400);
  const latest = (id: string) => state.runs.find((r) => r.caseId === id && r.projectId === projectId);
  async function act(work: () => Promise<void>) {
    setError(''); setBusy(true);
    try { await work(); await refresh(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  function go(next: View) { setView(next); setQuery(''); setError(''); }
  function openProject(p: Project) { setProjectId(p.id); setSuite('all'); setEnvironmentId(''); go('cases'); }
  function openCase(c: TestCase) { setCaseId(c.id); go('detail'); }
  function openRun(r: HistoryRun) { setRunId(r.runId); setProjectId(r.projectId); setCaseId(r.caseId); go('run'); }
  function show(m: Modal) { setError(''); setWorkflowValid(true); if (m.kind === 'environment') setEnvironmentVariables(project?.environments.find(env => env.id === m.id)?.variables ?? {}); if (m.kind === 'workflow' && !m.text) m.text = 'cases:\n  - name: New workflow\n    steps:\n      - gotoUrl:\n          url: ${baseUrl}\n'; setModal(m); }
  async function executeStart(workflowId: string, debug?: DebugSelection) {
    if (!project || !item || !selectedEnv) throw new Error('请先配置运行环境');
    if (!runSettingsValid) throw new Error('请先修正运行变量或总运行时限');
    if (bridgeMissingSession) throw new Error('请先选择 Chrome 标签页');
    if (debug?.mode === 'single-step' && browserMode !== 'bridge') throw new Error('单步调试需要选择当前 Chrome 标签页');
    const input = { projectId: project.id, caseId: item.id, workflowId, environmentId: selectedEnv.id, browserMode, sessionId, variables, datasetId: datasetId || undefined, loginCondition, timeoutMs: timeoutSeconds ? Number(timeoutSeconds) * 1000 : undefined, debug };
    const checked = await window.workspace.preflight(input); setPreflight(checked);
    if (!checked.ready) throw new Error(checked.checks.filter(c => c.status === 'failed').map(c => c.message).join('；'));
    const id = await window.workspace.run(input);
    setRunId(id); setView('run');
  }
  async function start(workflowId: string, debug?: DebugSelection) {
    await act(() => executeStart(workflowId, debug));
  }
  function openRecording() {
    if (!state.recording) return;
    setProjectId(state.recording.projectId); setCaseId(state.recording.caseId); go('recorder');
  }
  async function record(workflowId: string) {
    if (!project || !item || !selectedEnv) return;
    await act(async () => {
      if (bridgeMissingSession) throw new Error('请先选择 Chrome 标签页');
      await window.workspace.startRecording({ projectId: project.id, caseId: item.id, workflowId, environmentId: selectedEnv.id, browserMode, sessionId });
      go('recorder');
    });
  }
  const heading = { projects: ['Projects', '在一个地方组织、维护和运行你的测试。'], cases: ['Test Cases', '按业务组织用例，为每个平台维护独立的 Workflow。'], detail: [item?.name ?? 'Test Case', ''], runs: ['Run History', '每次执行，都有记录可查。'], run: ['Run Results', '查看执行步骤和原始报告。'], environments: ['Environments', '为同一套测试切换运行环境。'], settings: ['Model Settings', '沿用 Midscene 的模型配置方式。'], recorder: ['Record Workflow', '录制、检查并保存到当前用例。'], batch: ['批量运行', '为多个用例分配登录窗口，并按顺序执行。'], groups: ['Groups', '将用例组合为分组，按成员顺序批量运行。'], assets: ['共享资源', '维护默认变量和可重复使用的步骤。'] }[view];
  const filteredCases = (project?.cases ?? []).filter((c) => (suite === 'all' || c.suiteId === suite) && `${c.name} ${c.description} ${c.tags.join(' ')}`.toLowerCase().includes(query.toLowerCase()));
  async function submit(form: FormData) {
    await act(async () => {
      const value = (key: string) => String(form.get(key) ?? '');
      if (modal?.kind === 'project') { const id = await window.workspace.createProject({ name: value('name'), description: value('description') }); setProjectId(id); setSuite('all'); setView('cases'); }
      if (modal?.kind === 'suite' && project) { const id = await window.workspace.createSuite({ projectId: project.id, name: value('name') }); setSuite(id); }
      if (modal?.kind === 'case' && project) { const id = await window.workspace.createCase({ projectId: project.id, name: value('name'), suiteId: value('suite'), platforms: form.getAll('platform').map(String) }); setCaseId(id); setView('detail'); }
      if (modal?.kind === 'edit' && project && item) await window.workspace.saveCase({ projectId: project.id, caseId: item.id, revision: modal.revision!, name: value('name'), description: value('description'), priority: value('priority'), tags: value('tags').split(',').map((v) => v.trim()).filter(Boolean) });
      if (modal?.kind === 'environment' && project) await window.workspace.saveEnvironment({ projectId: project.id, id: modal.id, name: value('name'), baseUrl: value('baseUrl'), variables: environmentVariables });
      if (modal?.kind === 'workflow' && project && item) await window.workspace.saveWorkflow({ projectId: project.id, caseId: item.id, workflowId: modal.id!, revision: modal.revision!, text: modal.text ?? '' });
      setModal(null); setNotice('已保存');
    });
  }
  function runRows(runs: HistoryRun[]) {
    return runs.length ? <div className="divide-y">{runs.map((r) => <Button variant="ghost" data-testid="run-row" className="h-auto w-full justify-start gap-4 rounded-none px-6 py-5 text-left" key={r.runId} onClick={() => openRun(r)}>
      <span className={cn('flex size-9 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground', r.status === 'passed' && 'bg-emerald-50 text-emerald-600')}>{r.status === 'passed' ? <Check /> : r.status === 'running' ? <LoaderCircle className="animate-spin" /> : <Clock3 />}</span>
      <span className="min-w-0 flex-1"><strong className="block truncate text-sm font-medium">{r.caseName}</strong><small className="mt-1 block text-xs font-normal text-muted-foreground">{r.environment} · Web · {date(r.startedAt)}</small></span><Status status={r.status} /><span className="w-12 text-right text-xs text-muted-foreground">{duration(r.result?.durationMs)}</span><ChevronRight className="text-muted-foreground" />
    </Button>)}</div> : <Empty icon={<Clock3 />} title="还没有运行记录">运行一个 Workflow，执行结果会保存在这里。</Empty>;
  }
  const nav = (selected: boolean) => cn('h-10 w-full justify-start px-3 font-normal text-muted-foreground', selected && 'bg-primary/10 font-medium text-primary hover:bg-primary/15 hover:text-primary');
  const pendingRecording = state.recording && state.recording.status !== 'saved';

  return <div className="min-h-screen">
    <aside className="fixed inset-y-0 left-0 z-20 flex w-56 flex-col border-r bg-muted/50 px-3 pb-5 pt-14 xl:w-60">
      <div className="mb-8 flex items-center gap-3 px-2"><span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-sm"><Layers3 className="size-5" /></span><div className="text-sm font-semibold tracking-tight">Testo<small className="mt-1 block text-[11px] font-normal text-muted-foreground">Powered by Midscene</small></div></div>
      <Button variant="ghost" className={nav(view === 'projects')} onClick={() => { setProjectId(''); go('projects'); }}><LayoutGrid />Projects<Badge variant="secondary" className="ml-auto">{state.projects.length}</Badge></Button>
      {project ? <><div className="my-5 flex items-center gap-2 rounded-lg border bg-card p-3 text-sm font-medium"><span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">{project.name.slice(0, 1).toUpperCase()}</span><span className="truncate">{project.name}</span><ChevronRight className="ml-auto size-3.5 text-muted-foreground" /></div><p className="mb-2 px-3 text-[10px] font-medium tracking-widest text-muted-foreground">WORKSPACE</p><Button variant="ghost" className={nav(view === 'cases' || view === 'detail')} onClick={() => go('cases')}><FileCode2 />Test Cases<Badge variant="secondary" className="ml-auto">{project.cases.length}</Badge></Button><Button variant="ghost" className={nav(view === 'groups')} onClick={() => go('groups')}><Layers3 />Groups</Button><Button variant="ghost" className={nav(view === 'environments')} onClick={() => go('environments')}><Box />Environments</Button><Button variant="ghost" className={nav(view === 'assets')} onClick={() => go('assets')}><Layers3 />共享资源</Button></> : null}
      <Button variant="ghost" className={nav(view === 'runs' || view === 'run' || view === 'batch')} onClick={() => go('runs')}><Clock3 />Run History</Button>
      {project ? <div ref={attachOverlayScrollbars} className="mt-7 min-h-0 overflow-auto"><div className="mb-2 flex items-center justify-between px-3 text-[10px] tracking-widest text-muted-foreground">SUITES<Button variant="ghost" size="icon-xs" aria-label="新建 Suite" onClick={() => show({ kind: 'suite' })}><Plus /></Button></div>{project.suites.map((s) => <Button variant="ghost" key={s.id} className={nav(view === 'cases' && suite === s.id)} onClick={() => { setSuite(s.id); go('cases'); }}><Folder /><span className="truncate">{s.name}</span><span className="ml-auto text-xs">{project.cases.filter((c) => c.suiteId === s.id).length}</span></Button>)}</div> : null}
      <div className="mt-auto pt-6"><Button variant="ghost" className={nav(view === 'settings')} onClick={() => go('settings')}><Settings2 />Model Settings</Button><Separator className="my-4" /><div className="flex items-center gap-3 px-3"><span className="flex size-8 items-center justify-center rounded-full bg-secondary text-muted-foreground"><Monitor className="size-4" /></span><div className="text-xs font-medium">Local workspace<small className="mt-1 flex items-center gap-1.5 text-[10px] font-normal text-muted-foreground"><span className="size-1.5 rounded-full bg-emerald-500" />保存在本机</small></div><ShieldCheck className="ml-auto size-4 text-muted-foreground" /></div></div>
    </aside>
    <main className="ml-56 min-w-0 xl:ml-60">
      <header className="sticky top-0 z-30 [-webkit-app-region:drag] [&_button]:[-webkit-app-region:no-drag] flex h-16 items-center justify-between gap-4 border-b bg-card px-6 xl:px-8">
        <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground"><span>Workspace</span><ChevronRight className="size-3" />{project ? <><Button variant="ghost" size="sm" className="h-7 max-w-48 truncate px-1 text-xs" onClick={() => go('cases')}>{project.name}</Button><ChevronRight className="size-3" /></> : null}<strong className="truncate font-medium">{view === 'detail' ? 'Case Detail' : heading[0]}</strong></div>
        <div className="flex shrink-0 items-center gap-3">{state.activeBatchId ? <Button variant="ghost" size="sm" className="text-primary" onClick={() => openBatch(state.activeBatchId!)}><LoaderCircle className="animate-spin" />批次运行中</Button> : state.activeRunId ? <Button variant="ghost" size="sm" className="text-primary" onClick={() => { setRunId(state.activeRunId!); go('run'); }}><LoaderCircle className="animate-spin" />测试运行中</Button> : <span className="flex items-center gap-1.5 text-xs text-muted-foreground"><span className="size-1.5 rounded-full bg-emerald-500" />本地运行</span>}<Button variant="ghost" size="icon-sm" aria-label="刷新" title="重新读取项目文件" onClick={() => void refresh()}><RefreshCw /></Button></div>
      </header>
      <div className="mx-auto max-w-7xl space-y-6 p-6 xl:p-8">
        {error && !modal && !(view === 'recorder' && state.recording?.error) ? <Alert variant="destructive"><AlertDescription className="flex items-start justify-between gap-3 whitespace-pre-wrap break-words">{error}<Button variant="ghost" size="icon-xs" aria-label="关闭错误提示" onClick={() => setError('')}><X /></Button></AlertDescription></Alert> : null}
        {[...state.errors, ...(project?.errors ?? [])].map((e) => <Alert key={e} variant="destructive"><AlertDescription>{e}</AlertDescription></Alert>)}
        {pendingRecording && view !== 'recorder' ? <Alert className="border-primary/20 bg-primary/5"><AlertDescription className="flex items-center justify-between gap-4"><span>{state.recording!.status === 'recording' ? '录制进行中' : '有一份录制草稿待检查'} · {state.recording!.caseName}</span><Button variant="outline" size="sm" onClick={openRecording}>打开录制</Button></AlertDescription></Alert> : null}
        {view !== 'recorder' ? <div className="flex items-center justify-between gap-5"><div className="min-w-0">{view === 'detail' || view === 'run' ? <Button variant="link" className="mb-3 h-auto p-0 text-xs text-muted-foreground" onClick={() => go(view === 'detail' ? 'cases' : 'runs')}><ArrowLeft />{view === 'detail' ? '返回用例列表' : '返回运行历史'}</Button> : null}<h1 className="flex items-center gap-3 text-2xl font-semibold tracking-tight xl:text-3xl">{heading[0]}{view === 'cases' ? <Badge variant="secondary">{project?.cases.length ?? 0}</Badge> : null}</h1>{heading[1] ? <p className="mt-2 text-sm text-muted-foreground">{heading[1]}</p> : null}</div><div className="flex shrink-0 gap-2">
          {view === 'projects' ? <><Button variant="outline" disabled={busy} onClick={() => void act(async () => { const id = await window.workspace.openProject(); if (id) { setProjectId(id); setView('cases'); } })}><FolderOpen />打开项目</Button><Button onClick={() => show({ kind: 'project' })}><Plus />新建项目</Button></> : null}
          {view === 'cases' && project ? <><Button variant="outline" disabled={busy} onClick={() => { setBatchCaseIds(filteredCases.map(item => item.id)); setBatchGroupIds(undefined); setBatchId(''); setView('batch'); }}><Play />批量运行</Button><Button onClick={() => show({ kind: 'case' })}><Plus />新建用例</Button></> : null}
          {view === 'detail' && item ? <Button variant="outline" onClick={() => show({ kind: 'edit', revision: item.revision })}><Settings2 />编辑用例</Button> : null}
          {view === 'environments' && project ? <Button onClick={() => show({ kind: 'environment' })}><Plus />添加环境</Button> : null}
        </div></div> : null}
        {!loaded ? <Empty icon={<LoaderCircle className="animate-spin" />} title="正在读取 Workspace">加载本地项目和运行记录。</Empty> : null}
        {view === 'projects' && loaded ? <>
          <div className="flex gap-6 border-b pb-5 text-xs text-muted-foreground"><span className="flex items-center gap-2"><Folder className="size-4" /><strong className="text-foreground">{state.projects.length}</strong>个项目</span><span className="flex items-center gap-2"><FileCode2 className="size-4" /><strong className="text-foreground">{state.projects.reduce((n, p) => n + p.cases.length, 0)}</strong>个测试用例</span><span className="flex items-center gap-2"><Clock3 className="size-4" /><strong className="text-foreground">{state.runs.length}</strong>条近期运行记录</span></div>
          <div className="flex items-center justify-between"><h2 className="text-base font-medium">你的项目</h2><div className="relative w-64"><Search className="absolute top-2.5 left-3 size-4 text-muted-foreground" /><Input aria-label="搜索项目" placeholder="搜索项目…" className="bg-card pl-9" value={query} onChange={(e) => setQuery(e.target.value)} /></div></div>
          <div className="grid grid-cols-2 gap-5 2xl:grid-cols-3">{state.projects.filter((p) => p.name.toLowerCase().includes(query.toLowerCase())).map((p) => <Button key={p.id} variant="ghost" className="block h-auto min-w-0 whitespace-normal p-0 text-left" onClick={() => openProject(p)}><Card className="h-full transition-colors hover:border-primary/40 hover:bg-accent/20"><CardHeader><div className="mb-3 flex items-center justify-between"><span className="flex size-11 items-center justify-center rounded-xl bg-primary/10 text-primary"><Layers3 className="size-6" /></span><ArrowRight className="text-muted-foreground" /></div><CardTitle className="text-lg">{p.name}</CardTitle><CardDescription className="min-h-10 font-normal leading-6">{p.description || '为这个项目建立可重复运行的业务测试。'}</CardDescription></CardHeader><CardContent><Separator className="mb-4" /><div className="flex gap-5 text-xs font-normal text-muted-foreground"><span className="flex items-center gap-1.5"><Folder className="size-3.5" />{p.suites.length} 个 Suite</span><span className="flex items-center gap-1.5"><FileCode2 className="size-3.5" />{p.cases.length} 个用例</span></div></CardContent></Card></Button>)}<Button variant="outline" className="h-auto min-h-60 flex-col gap-3 rounded-xl border-dashed bg-transparent font-normal text-muted-foreground" onClick={() => show({ kind: 'project' })}><span className="flex size-10 items-center justify-center rounded-full bg-muted"><Plus className="size-5" /></span><strong className="font-medium">创建一个项目</strong><small>从第一个业务测试开始</small></Button></div>
          <p className="flex items-center gap-2 text-xs text-muted-foreground"><ShieldCheck className="size-4" />测试定义保存在项目文件夹中，运行历史保存在本机。</p>
        </> : null}
        {view === 'cases' && project ? <><div className="flex items-center justify-between gap-4"><Tabs value={suite} onValueChange={setSuite} className="min-w-0"><div ref={attachOverlayScrollbars} className="overflow-x-auto overflow-y-hidden p-1"><TabsList><TabsTrigger value="all">全部 <span className="ml-1 text-xs opacity-60">{project.cases.length}</span></TabsTrigger>{project.suites.map((s) => <TabsTrigger key={s.id} value={s.id}>{s.name}<span className="ml-1 text-xs opacity-60">{project.cases.filter((c) => c.suiteId === s.id).length}</span></TabsTrigger>)}</TabsList></div></Tabs><div className="relative w-64 shrink-0"><Search className="absolute top-2.5 left-3 size-4 text-muted-foreground" /><Input aria-label="搜索用例" placeholder="搜索用例或标签…" className="bg-card pl-9" value={query} onChange={(e) => setQuery(e.target.value)} /></div></div>
          <Card className="gap-0 overflow-hidden py-0"><div className="grid grid-cols-[minmax(180px,1fr)_140px_60px_100px_16px] gap-3 border-b bg-muted/40 px-5 py-3 text-xs text-muted-foreground"><span>用例名称</span><span>平台</span><span>优先级</span><span>最近运行</span><span /></div>{filteredCases.length ? filteredCases.map((c) => <Button variant="ghost" className="grid h-auto w-full grid-cols-[minmax(180px,1fr)_140px_60px_100px_16px] items-center gap-3 rounded-none border-b px-5 py-4 text-left font-normal last:border-b-0" key={c.id} onClick={() => openCase(c)}><span className="flex min-w-0 items-center gap-3"><FileCode2 className="text-primary/60" /><span className="min-w-0"><strong className="block truncate text-sm font-medium">{c.name}</strong><small className="mt-1 block truncate text-xs text-muted-foreground">{project.suites.find((s) => s.id === c.suiteId)?.name}{c.tags.length ? ` · ${c.tags.join(' · ')}` : ''}</small></span></span><span className="flex flex-wrap gap-2">{c.workflows.map((w) => <Platform name={w.platform} key={w.id} />)}</span><Badge variant="outline" className="w-fit">{c.priority}</Badge><Status status={latest(c.id)?.status} /><ChevronRight className="text-muted-foreground" /></Button>) : <Empty icon={<FileCode2 />} title={query ? '没有找到匹配的用例' : '开始创建你的第一个测试用例'} action={!query ? <Button onClick={() => show({ kind: 'case' })}><Plus />新建用例</Button> : undefined}>{query ? '试试其他关键词，或切换 Suite。' : '先描述业务意图，再为 Web、Android 或 iOS 添加 Workflow。'}</Empty>}<div className="flex justify-between border-t px-5 py-3 text-xs text-muted-foreground"><span>{filteredCases.length} 个用例</span><span>一个业务用例，多个平台实现</span></div></Card></> : null}
        {view === 'detail' && project && item ? <>
          <div className="flex flex-wrap items-center gap-2"><Badge variant="secondary">{project.suites.find((s) => s.id === item.suiteId)?.name}</Badge><Badge variant="outline" className={item.priority === 'P0' ? 'border-rose-200 bg-rose-50 text-rose-600' : ''}>{item.priority}</Badge>{item.tags.map((tag) => <Badge variant="secondary" key={tag}>{tag}</Badge>)}<Status status={latest(item.id)?.status} /></div>
          <div className="grid grid-cols-[minmax(0,1fr)_220px] items-start gap-5 xl:grid-cols-[minmax(0,1fr)_250px]">
            <div className="space-y-5"><Card><CardHeader><CardTitle><h2>业务描述</h2></CardTitle></CardHeader><CardContent><p className="whitespace-pre-wrap text-sm leading-7 text-muted-foreground">{item.description || '添加业务描述，说明这个用例要验证什么，以及什么结果代表成功。'}</p></CardContent></Card><Card className="gap-0 overflow-hidden pb-0"><CardHeader className="mb-5 flex flex-row items-center justify-between"><CardTitle><h2>Platform Workflows</h2></CardTitle><span className="text-xs text-muted-foreground">{item.workflows.length} 个平台</span></CardHeader>{item.workflows.map((w) => <div data-testid="workflow-row" className="flex flex-wrap items-center gap-2 border-t p-5" key={w.id}><span className="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-muted/40 text-primary/60">{w.platform === 'web' ? <Globe2 className="size-5" /> : <Smartphone className="size-5" />}</span><div className="min-w-32 flex-1"><strong className="text-sm font-medium">{platformNames[w.platform]}</strong><small className="mt-1 block text-xs text-muted-foreground">{w.ready ? w.platform === 'web' ? 'Workflow 已保存，可以运行' : 'Workflow 已保存，移动端执行尚未接入' : '尚未添加 Workflow'}</small></div><div className="ml-auto flex gap-2"><Button variant="outline" size="sm" disabled={busy} onClick={() => void act(async () => { const file = await window.workspace.workflow({ projectId: project.id, caseId: item.id, workflowId: w.id }); show({ kind: 'workflow', id: w.id, ...file }); })}><Code2 />{w.ready ? '查看 / 编辑' : '导入 YAML'}</Button>{w.platform === 'web' ? <><Button variant="outline" size="sm" disabled={busy || pickerBusy || bridgeMissingSession || !!state.activeBatchId || !!state.connectingSession || !!state.activeRunId || !selectedEnv || (!!state.recording && state.recording.status !== 'saved')} onClick={() => void record(w.id)}><Circle />{browserMode === 'bridge' ? '连接 Chrome' : '开始录制'}</Button><Button size="sm" disabled={!w.ready || pickerBusy || bridgeMissingSession || !runSettingsValid || !!state.activeBatchId || !!state.connectingSession || !!state.activeRunId || state.recording?.status === 'recording' || state.recording?.status === 'starting' || state.recording?.status === 'ready' || busy || !selectedEnv} onClick={() => void start(w.id)}><Play />运行</Button></> : null}</div></div>)}</Card><Card className="gap-0 overflow-hidden pb-0"><CardHeader className="mb-5"><CardTitle><h2>运行历史</h2></CardTitle></CardHeader>{runRows(caseHistory.runs)}{caseHistory.total > 50 && <div className="flex flex-wrap items-center justify-between gap-3 border-t p-4"><span className="text-xs text-muted-foreground">共 {caseHistory.total} 条 · 第 {caseHistoryPage + 1} 页</span><div className="flex gap-2"><Button variant="outline" size="sm" aria-label="用例历史上一页" disabled={caseHistoryPage === 0} onClick={() => setCaseHistoryPage(page => page - 1)}>上一页</Button><Button variant="outline" size="sm" aria-label="用例历史下一页" disabled={(caseHistoryPage + 1) * 50 >= caseHistory.total} onClick={() => setCaseHistoryPage(page => page + 1)}>下一页</Button></div></div>}</Card></div>
            <aside className="space-y-5"><Card><CardHeader><CardTitle><h2>运行环境</h2></CardTitle></CardHeader><CardContent className="space-y-4"><Field label="Environment" id="case-environment"><NativeSelect id="case-environment" aria-label="运行环境" value={selectedEnv?.id ?? ''} onChange={(e) => setEnvironmentId(e.target.value)}>{project.environments.map((e) => <NativeSelectOption key={e.id} value={e.id}>{e.name}</NativeSelectOption>)}</NativeSelect></Field><Field label="浏览器会话" id="browser-mode"><NativeSelect id="browser-mode" value={browserMode} disabled={busy || !!state.activeBatchId || !!state.connectingSession || !!state.activeRunId || !!state.recording && ['starting', 'ready', 'recording'].includes(state.recording.status)} onChange={(e) => setBrowserMode(e.target.value as 'isolated' | 'bridge')}><NativeSelectOption value="isolated">独立会话（未登录）</NativeSelectOption><NativeSelectOption value="bridge">Chrome 现有会话</NativeSelectOption></NativeSelect></Field>{browserMode === 'bridge' ? <p className="text-xs leading-6 text-muted-foreground">使用下方选择器选择 Profile、窗口和标签页。录制与运行都使用你选中的页面，结束后保留 Chrome。</p> : null}<p className="break-all text-xs leading-6 text-muted-foreground">{selectedEnv?.web.baseUrl ?? '请先添加运行环境'}</p><Button variant="link" className="h-auto p-0 text-xs" onClick={() => go('environments')}>管理环境 <ArrowRight /></Button></CardContent></Card><Card className="border-primary/10 bg-primary/5 shadow-none"><CardContent className="space-y-3"><Layers3 className="size-6 text-primary/60" /><h3 className="text-sm font-medium text-primary/80">Powered by Midscene</h3><p className="text-xs leading-6 text-muted-foreground">点击「开始录制」，在 Workspace 的网页预览中操作，检查步骤后保存到当前用例。</p><p className="text-xs leading-6 text-muted-foreground">支持单个 Web 页面。弹出窗口、文件上传和移动端录制尚未接入。</p></CardContent></Card></aside>
          </div>
        </> : null}
        {view === 'detail' && project && item && selectedEnv ? <>
          {browserMode === 'bridge' ? <ChromeTabPicker projectId={project.id} environmentId={selectedEnv.id} disabled={busy || !!state.activeRunId || !!state.activeBatchId || !!pendingRecording} onBusy={setPickerBusy} selected={async id => { setSessionId(id); setPreflight(undefined); await refresh(); }} /> : null}
          {bridgeMissingSession && <p role="status" className="text-sm text-muted-foreground">请先在上方选择目标 Chrome 标签页，再开始录制或运行。</p>}
          {browserMode === 'bridge' && (state.sessions ?? []).some(session => session.projectId === project.id && session.environmentId === selectedEnv.id) ? <label className="space-y-2 text-sm">本次运行标签页<NativeSelect aria-label="单例运行标签页" value={sessionId} onChange={event => { setSessionId(event.target.value); setPreflight(undefined); }}><NativeSelectOption value="">请选择标签页</NativeSelectOption>{(state.sessions ?? []).filter(session => session.projectId === project.id && session.environmentId === selectedEnv.id).map(session => <NativeSelectOption key={session.id} value={session.id}>{session.name}</NativeSelectOption>)}</NativeSelect></label> : null}
          <Card><CardHeader><CardTitle>本次运行设置</CardTitle></CardHeader><CardContent className="space-y-5">
            <VariableEditor label="运行变量" value={variables} onChange={setVariables} onValidityChange={setVariablesValid} disabled={busy} />
            {datasets.length ? <label className="block space-y-2 text-sm">数据集<NativeSelect aria-label="运行数据集" value={datasetId} onChange={e => setDatasetId(e.target.value)}><NativeSelectOption value="">使用默认值</NativeSelectOption>{datasets.map(dataset => <NativeSelectOption key={dataset.id} value={dataset.id}>{dataset.name}</NativeSelectOption>)}</NativeSelect></label> : null}
            <div className="grid gap-4 sm:grid-cols-2"><Field label="登录状态检查（可选）" id="login-condition"><Input id="login-condition" value={loginCondition} onChange={e => setLoginCondition(e.target.value)} placeholder="例如：右下角显示已登录用户头像" /></Field><Field label="总运行时限（秒，可选）" id="run-timeout"><Input id="run-timeout" type="number" min="1" max="86400" value={timeoutSeconds} onChange={e => setTimeoutSeconds(e.target.value)} placeholder="根据步骤自动计算" /></Field></div>
            {preflight && <div className="space-y-2">{preflight.checks.map(check => <p key={check.name} className={cn('text-sm', check.status === 'failed' && 'text-destructive')}>{check.name}：{check.message}</p>)}</div>}
          </CardContent></Card>
        </> : null}
        {view === 'assets' && project ? <ProjectAssetsView key={project.id} variables={project.assets?.variables ?? {}} flows={project.assets?.flows ?? {}} revision={project.assets?.revision} busy={busy} onSave={async value => {
          const saved = await window.workspace.saveAssets({ projectId: project.id, variables: value.variables, flows: value.flows, revision: value.revision ?? '' });
          await refresh(); setNotice('项目资产已保存');
          return { revision: saved.revision };
        }} /> : null}
        {view === 'runs' ? <>
          {(state.batches ?? []).some(batch => !project || batch.projectId === project.id) ? <Card className="gap-0 overflow-hidden py-0"><CardHeader className="border-b py-4"><CardTitle>批次运行</CardTitle></CardHeader>{(state.batches ?? []).filter(batch => !project || batch.projectId === project.id).map(batch => <Button key={batch.id} data-testid="batch-history-row" variant="ghost" className="h-auto w-full justify-start gap-4 rounded-none border-b px-5 py-4 last:border-b-0" onClick={() => openBatch(batch.id)}><span className="min-w-0 flex-1 text-left"><strong className="block text-sm">{batch.items.length} 个用例 · {batch.environment}</strong><small className="mt-1 block text-xs text-muted-foreground">{date(batch.startedAt)}</small></span><BatchStatus status={batch.status} /><ChevronRight /></Button>)}</Card> : null}
          <HistoryView projectId={project?.id} openRun={openRun} />
        </> : null}
        {view === 'groups' && project ? <GroupsView key={project.id} project={project} refresh={refresh} openCase={id => { const item = project.cases.find(candidate => candidate.id === id); if (item) openCase(item); }} runLocked={busy || !!state.activeBatchId || !!state.activeRunId || !!state.connectingSession || !!pendingRecording} run={ids => { setBatchGroupIds(ids); setBatchCaseIds([...new Set(ids.flatMap(id => project.groups?.find(group => group.id === id)?.caseIds ?? []))]); setBatchId(''); go('batch'); }} /> : null}
        {view === 'batch' ? <BatchView key={`${projectId}:${batchId || 'config'}`} project={project} groupIds={batchGroupIds} cases={batchCaseIds.flatMap(id => { const item = project?.cases.find(candidate => candidate.id === id); return item ? [item] : []; })} state={state} batch={selectedBatch} refresh={refresh} started={setBatchId} openRun={id => { const run = state.runs.find(item => item.runId === id); if (run) openRun(run); }} configure={() => { const ids = selectedBatch?.groups?.map(group => group.id); setBatchGroupIds(ids); setBatchCaseIds(ids ? [...new Set(ids.flatMap(id => project?.groups?.find(group => group.id === id)?.caseIds ?? []))] : project?.cases.map(item => item.id) ?? []); setBatchId(''); }} /> : null}
        {view === 'run' && selectedRun?.result ? <Button variant="outline" className="w-fit" onClick={() => void act(async () => { const file = await window.workspace.exportRun({ runId: selectedRun.runId }); if (file) setNotice('运行包已导出'); })}>导出完整运行包</Button> : null}
        {view === 'run' && selectedRun?.batchId ? <Button variant="link" className="h-auto p-0" onClick={() => openBatch(selectedRun.batchId!)}><ArrowLeft />返回批次结果</Button> : null}
        {view === 'run' && selectedRun ? <RunDetail run={selectedRun} busy={busy} cancel={() => void act(async () => { if (selectedRun.batchId && state.activeBatchId === selectedRun.batchId) await window.workspace.cancelBatch({ id: selectedRun.batchId }); else await window.workspace.cancelRun(); setNotice('正在取消并清理资源'); })} report={() => void act(async () => { await window.workspace.openReport({ runId: selectedRun.runId }); })} rerun={() => { setCaseId(selectedRun.caseId); go('detail'); }} /> : null}
        {view === 'environments' && project ? <div className="grid grid-cols-2 gap-5">{project.environments.map((e) => <Card key={e.id}><CardHeader><div className="mb-4 flex items-center justify-between"><span className="flex size-10 items-center justify-center rounded-xl bg-primary/10 text-primary/70"><Box className="size-5" /></span><Button variant="outline" size="sm" onClick={() => show({ kind: 'environment', id: e.id })}>编辑</Button></div><CardTitle>{e.name}</CardTitle></CardHeader><CardContent className="space-y-3"><p className="flex items-center gap-2 break-all rounded-lg bg-muted p-3 text-sm text-muted-foreground"><Globe2 className="size-4 shrink-0" />{e.web.baseUrl}</p><p className="text-xs text-muted-foreground">运行时将使用这个 Web 地址。</p></CardContent></Card>)}</div> : null}
        {view === 'recorder' && state.recording ? <RecordingView key={state.recording.id} draft={state.recording} refresh={refresh} done={() => { setProjectId(state.recording!.projectId); setCaseId(state.recording!.caseId); go('detail'); }} /> : null}
        {view === 'settings' ? <Card className="max-w-2xl"><CardHeader><CardTitle>模型连接</CardTitle><CardDescription>沿用 Midscene 的模型配置。</CardDescription></CardHeader><CardContent><form key={JSON.stringify(state.model)} className="space-y-5" onSubmit={(e) => { e.preventDefault(); const form = new FormData(e.currentTarget); void act(async () => { await window.workspace.saveModel({ name: String(form.get('name')), baseUrl: String(form.get('baseUrl')), family: String(form.get('family')), apiKey: String(form.get('apiKey')) }); setNotice('模型配置已保存'); }); }}>
          <Field label="模型名称" id="model-name"><Input id="model-name" name="name" defaultValue={state.model.name} placeholder="填写 Midscene 支持的模型名称" /></Field><Field label="服务地址" id="model-base"><Input id="model-base" name="baseUrl" defaultValue={state.model.baseUrl} placeholder="https://…/v1" /></Field><Field label="模型系列" id="model-family"><Input id="model-family" name="family" defaultValue={state.model.family} placeholder="按 Midscene 的模型说明填写" /></Field><div className="grid gap-2"><div className="flex items-center gap-3"><Label htmlFor="model-key">API Key</Label>{state.model.hasApiKey ? <span data-testid="saved-key" className="flex items-center gap-1 text-xs text-emerald-600"><Check className="size-3" />已保存</span> : null}</div><Input id="model-key" type="password" name="apiKey" autoComplete="new-password" placeholder={state.model.hasApiKey ? '留空保留当前 Key' : '输入 API Key'} /></div><p className="text-xs leading-6 text-muted-foreground">API Key 由系统加密后保存在本机，不写入测试 YAML。配置保存后还需要一次真实测试验证连接。</p><Button type="submit" disabled={busy}><Check />保存模型配置</Button>
        </form></CardContent></Card> : null}
        {view === 'settings' && <AppUpdatePanel />}
      </div>
    </main>
    {notice ? <Alert role="status" className="fixed bottom-6 left-[calc(50%+7rem)] z-40 w-auto -translate-x-1/2 border-emerald-200 bg-card px-5 py-3 text-emerald-700 shadow-lg"><Check className="size-4" /><AlertDescription className="text-emerald-700">{notice}</AlertDescription></Alert> : null}
    {modal ? <FormDialog valid={modal.kind === 'workflow' ? workflowValid : modal.kind === 'environment' ? environmentValid : true} wide={modal.kind === 'workflow'} title={{ project: '新建项目', suite: '新建 Suite', case: '新建测试用例', edit: '编辑测试用例', environment: '运行环境', workflow: '编辑平台 Workflow' }[modal.kind]} busy={busy} error={error} close={() => { setModal(null); setError(''); }} submit={(form) => void submit(form)}>
      {modal.kind === 'project' ? <><Field label="项目名称" id="project-name"><Input id="project-name" name="name" autoFocus required placeholder="例如 LongbridgeAI" /></Field><Field label="项目描述" id="project-description"><Textarea id="project-description" name="description" rows={3} placeholder="这个项目要测试什么？" /></Field><p className="text-xs leading-6 text-muted-foreground">创建后会生成独立的项目文件夹，测试定义以 YAML 保存。</p></> : null}
      {modal.kind === 'suite' ? <Field label="Suite 名称" id="suite-name"><Input id="suite-name" name="name" autoFocus required placeholder="例如 Chat、Authentication" /></Field> : null}
      {modal.kind === 'case' && project ? <><Field label="用例名称" id="case-name"><Input id="case-name" name="name" autoFocus required placeholder="例如 未登录用户发送消息" /></Field><Field label="Suite" id="case-suite"><NativeSelect id="case-suite" name="suite" aria-label="Suite" defaultValue={suite !== 'all' ? suite : project.suites[0]?.id}>{project.suites.map((s) => <NativeSelectOption key={s.id} value={s.id}>{s.name}</NativeSelectOption>)}</NativeSelect></Field><fieldset><legend className="mb-3 text-sm font-medium">目标平台</legend><div className="flex gap-3">{['web', 'android', 'ios'].map((p) => <Label key={p} htmlFor={`platform-${p}`} className="flex flex-1 cursor-pointer items-center gap-2 rounded-lg border p-3"><Checkbox id={`platform-${p}`} name="platform" value={p} defaultChecked={p === 'web'} aria-label={platformNames[p]} /><Platform name={p} /></Label>)}</div></fieldset><p className="text-xs text-muted-foreground">当前版本可执行 Web；移动端可以先保存 Workflow。</p></> : null}
      {modal.kind === 'edit' && item ? <><Field label="用例名称" id="edit-name"><Input id="edit-name" name="name" defaultValue={item.name} required /></Field><Field label="业务描述" id="edit-description"><Textarea id="edit-description" name="description" aria-label="业务描述" rows={4} defaultValue={item.description} /></Field><div className="grid grid-cols-[100px_1fr] gap-5"><Field label="优先级" id="edit-priority"><NativeSelect id="edit-priority" name="priority" aria-label="优先级" defaultValue={item.priority}>{['P0', 'P1', 'P2'].map((p) => <NativeSelectOption key={p}>{p}</NativeSelectOption>)}</NativeSelect></Field><Field label="标签（用逗号分隔）" id="edit-tags"><Input id="edit-tags" name="tags" defaultValue={item.tags.join(', ')} /></Field></div></> : null}
      {modal.kind === 'environment' ? <><Field label="环境名称" id="env-name"><Input id="env-name" name="name" required defaultValue={project?.environments.find((e) => e.id === modal.id)?.name} placeholder="例如 Staging" /></Field><Field label="Web 地址" id="env-url"><Input id="env-url" name="baseUrl" type="url" required defaultValue={project?.environments.find((e) => e.id === modal.id)?.web.baseUrl} placeholder="https://staging.example.com" /></Field><VariableEditor label="环境变量" value={environmentVariables} onChange={setEnvironmentVariables} onValidityChange={setEnvironmentValid} /></> : null}
      {modal.kind === 'workflow' ? <><div className="flex flex-wrap items-center justify-between gap-3"><p className="text-xs text-muted-foreground">调试或局部录制会先保存当前修改。</p><Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void act(async () => { const text = await window.workspace.importFile(); if (text !== null) setModal(current => current ? { ...current, text } : current); })}><FolderOpen />从文件导入</Button></div><WorkflowEditor onValidityChange={setWorkflowValid} text={modal.text ?? ''} onChange={text => setModal({ ...modal, text })} flows={project?.assets?.flows} disabled={busy}
        onDebug={debug => void act(async () => {
          if (!project || !item || !modal.id) return;
          if (!workflowValid || !runSettingsValid) throw new Error('请先修正工作流或运行设置');
          if (bridgeMissingSession || debug.mode === 'single-step' && browserMode !== 'bridge') throw new Error('请先选择用于调试的 Chrome 标签页');
          await window.workspace.saveWorkflow({ projectId: project.id, caseId: item.id, workflowId: modal.id, revision: modal.revision!, text: modal.text ?? '' });
          const id = modal.id; setModal(null); await executeStart(id, debug);
        })}
        onRecord={(position, deleteCount = 0) => void act(async () => {
          if (!project || !item || !selectedEnv || !modal.id) return;
          if (!workflowValid) throw new Error('请先修正工作流');
          if (bridgeMissingSession) throw new Error('请先选择 Chrome 标签页');
          const text = modal.text ?? '';
          await window.workspace.saveWorkflow({ projectId: project.id, caseId: item.id, workflowId: modal.id, revision: modal.revision!, text });
          const saved = await window.workspace.workflow({ projectId: project.id, caseId: item.id, workflowId: modal.id });
          await window.workspace.startRecording({ projectId: project.id, caseId: item.id, workflowId: modal.id, environmentId: selectedEnv.id, browserMode, sessionId,
            replace: { revision: saved.revision, originalText: saved.text, start: position, deleteCount } });
          setModal(null); go('recorder');
        })} /></> : null}
    </FormDialog> : null}
  </div>;
}

function RunDetail({ run, busy, cancel, report, rerun }: { run: HistoryRun; busy: boolean; cancel(): void; report(): void; rerun(): void }) {
  const [tab, setTab] = useState('steps');
  const [savedPlan, setSavedPlan] = useState<RunStepInfo[]>([]);
  const [shot, setShot] = useState<{ image: string; step: RunStepInfo; title: string }>();
  const [shotUrl, setShotUrl] = useState(''), [shotError, setShotError] = useState('');
  useEffect(() => { let active = true; setSavedPlan([]); setShot(undefined); void window.workspace.runPlan({ runId: run.runId }).then(plan => { if (active) setSavedPlan(plan); }).catch(() => {}); return () => { active = false; }; }, [run.runId]);
  useEffect(() => {
    let active = true; setShotUrl(''); setShotError('');
    if (shot) void window.workspace.runScreenshot({ runId: run.runId, image: shot.image }).then(image => { if (active) setShotUrl(image); }).catch(error => { if (active) setShotError(String(error)); });
    return () => { active = false; };
  }, [shot, run.runId]);
  const planned = run.events.find(e => e.type === 'steps-planned');
  type Evidence = Extract<WorkerEvent, { type: 'step-evidence' }>;
  type WaitProgress = Extract<WorkerEvent, { type: 'wait-progress' }>;
  type DisplayStep = RunStepInfo & { status: string; durationMs?: number; error?: string; evidence: Evidence[]; wait?: WaitProgress };
  const steps = new Map<string, DisplayStep>((planned?.type === 'steps-planned' ? planned.steps : savedPlan).map(step => [`${step.phase}:${step.index}`, { ...step, status: 'pending', evidence: [] }]));
  for (const e of run.events) {
    if (e.type !== 'step-started' && e.type !== 'step-finished' && e.type !== 'step-evidence' && e.type !== 'wait-progress') continue;
    const key = `${e.phase}:${e.index}`;
    const step: DisplayStep = steps.get(key) ?? { node: 'node' in e ? e.node : 'recordedAction', title: 'node' in e ? e.node : '录制操作', phase: e.phase, index: e.index, status: 'pending', evidence: [] };
    if (e.type === 'step-evidence') step.evidence.push(e);
    else if (e.type === 'wait-progress') step.wait = e;
    else { step.status = e.type === 'step-started' ? 'running' : e.status; step.durationMs = e.type === 'step-finished' ? e.durationMs : undefined; step.error = e.type === 'step-finished' ? e.error : undefined; }
    steps.set(key, step);
  }
  const diagnostics = run.events.filter((event): event is Extract<WorkerEvent, { type: 'diagnostic' }> => event.type === 'diagnostic');
  const checks = run.result?.checks ?? [...steps.values()].flatMap(step => step.wait && ['passed', 'failed'].includes(step.wait.status) ? [{ ...step.wait }] : []);
  const checkCalls = [...steps.values()].reduce((total, step) => total + (step.wait?.modelCalls ?? 0), 0) || checks.reduce((total, check) => total + check.modelCalls, 0);
  return <>
    <Card data-testid="run-summary"><CardHeader className="flex flex-row items-center justify-between gap-4"><div><p className="mb-2 text-[10px] tracking-widest text-muted-foreground">WEB WORKFLOW</p><CardTitle className="text-xl">{run.caseName}</CardTitle></div><Status status={run.status} /></CardHeader><CardContent><Separator className="mb-5" /><div className="grid grid-cols-4 gap-4 text-sm">{[['运行环境', run.environment], ['平台', 'Web · Chrome'], ['开始时间', date(run.startedAt)], ['总耗时', duration(run.result?.durationMs)]].map(([label, value]) => <div key={label}><small className="mb-2 block text-xs text-muted-foreground">{label}</small><strong className="font-medium">{value}</strong></div>)}</div>{(checks.length > 0 || checkCalls > 0) && <div className="mt-5 grid gap-3 border-t pt-4 text-sm sm:grid-cols-3">{(['first-response', 'response-complete'] as const).map(metric => { const check = checks.find(value => value.metric === metric); return check ? <div key={metric}><p className="text-xs text-muted-foreground">{metric === 'first-response' ? '首条回复等待' : '回复完成等待'}</p><p className="mt-1">{duration(check.elapsedMs)} · {check.status === 'passed' ? '条件满足' : '条件未满足'}</p></div> : null; })}<div><p className="text-xs text-muted-foreground">等待条件的模型检查次数</p><p className="mt-1">{checkCalls} 次</p></div></div>}</CardContent></Card>
    <Card className="gap-0 overflow-hidden py-0"><Tabs value={tab} onValueChange={setTab} className="gap-0"><div className="border-b px-5 py-3"><TabsList><TabsTrigger value="steps">执行步骤 <Badge variant="secondary" className="ml-1">{steps.size}</Badge></TabsTrigger><TabsTrigger value="logs">运行事件</TabsTrigger><TabsTrigger value="diagnostics">诊断信息 <Badge variant="secondary" className="ml-1">{diagnostics.length}</Badge></TabsTrigger></TabsList></div><TabsContent value="steps" className="min-h-64 px-6 py-6">{steps.size ? [...steps].map(([key, step], index) => <div data-testid="run-step" className="relative flex min-h-14 items-start gap-3 pb-5 last:pb-0" key={key}><span className={cn('flex size-6 shrink-0 items-center justify-center rounded-full bg-emerald-50 text-emerald-600', step.status === 'failed' && 'bg-red-50 text-red-600', step.status === 'running' && 'bg-primary/10 text-primary', step.status === 'pending' && 'bg-muted text-muted-foreground')}>{step.status === 'success' ? <Check className="size-3.5" /> : step.status === 'running' ? <LoaderCircle className="size-3.5 animate-spin" /> : step.status === 'pending' ? <Clock3 className="size-3.5" /> : <X className="size-3.5" />}</span><span className="pt-1 text-xs text-muted-foreground/60">{String(index + 1).padStart(2, '0')}</span><div className="min-w-0 flex-1"><strong className="text-sm font-medium">{step.title}</strong>
              {step.wait && <div data-testid="wait-progress" role={step.wait.status === 'checking' || step.wait.status === 'waiting' ? 'status' : undefined} className="mt-2 space-y-1 rounded-md border bg-muted/30 p-3 text-xs"><p>{step.wait.status === 'checking' ? '正在检查条件' : step.wait.status === 'waiting' ? '条件尚未满足，继续等待' : step.wait.status === 'passed' ? '等待条件已满足' : '等待条件未满足'} · 已等待 {duration(step.wait.elapsedMs)} / {duration(step.wait.timeoutMs)}</p><p>第 {step.wait.attempt} 次检查 · 已调用模型 {step.wait.modelCalls} 次</p>{step.wait.reason && <p className="whitespace-pre-wrap break-words text-muted-foreground">{step.wait.reason}</p>}</div>}
              {step.detail ? <p className="mt-1 whitespace-pre-wrap break-all text-sm text-muted-foreground">{step.detail}</p> : null}
              {step.status === 'pending' ? <Badge variant="outline" className="mt-2">{run.status === 'running' ? '等待执行' : '未执行'}</Badge> : null}
              {step.node === 'recordedAction' ? <p className="mt-1 text-xs text-muted-foreground">{step.status === 'success' ? '操作调用完成；业务结果由后续断言确认' : step.status === 'running' ? '正在执行已录制的操作' : step.status === 'pending' ? '此操作已记录在用例中，尚未执行' : '操作步骤失败，请查看错误和执行证据'}</p> : null}
              {step.evidence.find(e => e.target)?.target ? <p className="mt-2 break-words text-xs">操作前坐标处元素：{step.evidence.find(e => e.target)!.target}</p> : null}
              <div className="mt-2 flex flex-wrap gap-2">{step.evidence.map(e => e.image ? <Button key={e.stage} variant="outline" size="sm" onClick={() => setShot({ image: e.image!, step, title: e.stage === 'before' ? '执行前' : e.stage === 'after' ? '执行后' : '失败时' })}>{e.stage === 'before' ? '执行前截图' : e.stage === 'after' ? '执行后截图' : '失败截图'}</Button> : e.warning ? <p key={e.stage} className="text-xs text-muted-foreground">{e.warning}</p> : null)}</div>
              {step.node === 'recordedAction' && step.status === 'success' && !step.evidence.length ? <p className="mt-1 text-xs text-muted-foreground">旧记录没有步骤截图，请打开 Midscene 报告查看。</p> : null}{step.phase !== 'steps' ? <small className="mt-1 block text-xs text-muted-foreground">{step.phase}</small> : null}{step.error ? <pre className="mt-2 whitespace-pre-wrap break-words rounded-md bg-destructive/5 p-3 text-xs text-destructive">{step.error}</pre> : null}</div><span className="pt-1 text-xs text-muted-foreground">{duration(step.durationMs)}</span></div>) : <Empty icon={run.status === 'running' ? <LoaderCircle className="animate-spin" /> : <Clock3 />} title={run.status === 'running' ? '正在准备浏览器' : '没有执行步骤'}>{run.status === 'interrupted' ? '上次应用意外退出，本次运行未完成。' : '执行器将依次回传每一步的结果。'}</Empty>}</TabsContent><TabsContent value="logs"><pre ref={attachOverlayScrollbars} className="max-h-[30rem] min-h-64 overflow-auto whitespace-pre-wrap break-words bg-muted/30 p-6 font-mono text-xs leading-6 text-muted-foreground"><code>{run.events.map((e) => JSON.stringify(e)).join('\n') || '暂无事件'}</code></pre></TabsContent><TabsContent value="diagnostics" className="min-h-64 space-y-3 p-6">{diagnostics.length ? diagnostics.map((entry, index) => <div key={index} className="space-y-1 rounded-md border p-3 text-sm"><div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground"><span>{{ network: '网络请求', console: '浏览器控制台', pageerror: '页面错误', capability: '采集能力' }[entry.kind]}</span><time>{new Date(entry.at).toLocaleTimeString('zh-CN')}</time></div><p className="whitespace-pre-wrap break-words">{entry.message}</p>{entry.url && <p className="break-all text-xs text-muted-foreground">{entry.url}</p>}</div>) : <p className="text-sm text-muted-foreground">本次运行没有记录到诊断信息。</p>}</TabsContent></Tabs>
      {run.result?.error ? <Alert variant="destructive" className="mx-6 mb-5 w-auto"><AlertDescription className="whitespace-pre-wrap break-words">{run.result.error}</AlertDescription></Alert> : null}<div className="flex flex-wrap items-center justify-between gap-4 border-t p-5"><span className="text-xs text-muted-foreground">{run.status === 'running' ? '浏览器正在本机执行测试' : '本次运行已保存到历史记录'}</span><div className="flex gap-2">{run.status === 'running' ? <Button variant="destructive" disabled={busy} onClick={cancel}><Square />取消运行</Button> : <><Button variant="outline" onClick={rerun}><RefreshCw />返回用例再运行</Button><Button disabled={busy || !run.result?.reportPaths.length} onClick={report}><FolderOpen />打开 Midscene 报告</Button></>}</div></div>
    </Card>
    <Dialog open={!!shot} onOpenChange={open => { if (!open) setShot(undefined); }}><DialogContent ref={attachOverlayScrollbars} className="max-h-[90vh] overflow-y-auto sm:max-w-5xl"><DialogHeader><DialogTitle>{shot?.title} · {shot?.step.title}</DialogTitle><DialogDescription>圆圈标记原录制坐标。请对比前后截图，确认按钮位置及页面变化；截图本身不代表业务操作成功。</DialogDescription></DialogHeader>{shotUrl ? <div className="relative"><img src={shotUrl} alt="运行步骤截图" className="block w-full" />{shot?.step.point && shot.step.viewport ? <svg className="pointer-events-none absolute inset-0 h-full w-full" viewBox={`0 0 ${shot.step.viewport.width} ${shot.step.viewport.height}`} aria-label="原录制坐标"><circle cx={shot.step.point.x} cy={shot.step.point.y} r="12" stroke="#ef4444" strokeWidth="3" fill="#ef444433" /></svg> : null}</div> : <p>{shotError || '正在读取截图…'}</p>}</DialogContent></Dialog>
  </>;
}
