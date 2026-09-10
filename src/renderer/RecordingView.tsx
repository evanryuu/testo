import { attachOverlayScrollbars } from '@/lib/scrollbars';
import { useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Check, Code2, Globe2, ImageIcon, LoaderCircle, Plus, RotateCw, Square, X } from 'lucide-react';
import { getMidsceneRecorderEventDescription } from '@midscene/shared/recorder';
import { isRecordingDescriptionVerified, type RecordedEvent, type RecordingDraft, type RecordingFrame, type RecordingInteraction } from '../shared/recording.js';
import type { RecordingAssertion, RecordingReviewStep, RecordingStepChoice } from '../recording/workflow.js';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Separator } from '@/components/ui/separator';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';

const isNavigationState = (event: RecordedEvent) => event.actionType === 'InitialNavigation' || (event.type === 'navigation' && event.rawPayload?.implicitNavigationState === true);
const eventNames = { click: '点击', drag: '拖动', scroll: '滚动', input: '输入', navigation: '导航', setViewport: '视口', keydown: '按键' };
function label(event: RecordedEvent) {
  if (event.actionType === 'InitialNavigation') return `进入页面 ${event.url ?? ''}`;
  if (event.rawPayload?.implicitNavigationState) return `地址变化 ${event.rawPayload.afterUrl ?? event.url ?? ''}`;
  if (event.actionType === 'Navigate') return `打开页面 ${event.rawPayload?.url ?? event.url ?? ''}`;
  return getMidsceneRecorderEventDescription(isRecordingDescriptionVerified(event) ? event : { ...event, semantic: undefined, elementDescription: undefined });
}
function EventDetails({ event, recordingId, close }: { event?: RecordedEvent; recordingId: string; close(): void }) {
  const [screenshot, setScreenshot] = useState(''), [error, setError] = useState('');
  useEffect(() => {
    let disposed = false;
    setScreenshot(''); setError('');
    if (event) void window.workspace.recordingScreenshot({ id: recordingId, hashId: event.hashId }).then((value) => { if (!disposed) setScreenshot(value); }).catch((error) => { if (!disposed) setError(String(error)); });
    return () => { disposed = true; };
  }, [event?.hashId, recordingId]);
  return <Dialog open={!!event} onOpenChange={(open) => { if (!open) close(); }}>
    <DialogContent ref={attachOverlayScrollbars} className="max-h-[90vh] overflow-y-auto sm:max-w-5xl">
      <DialogHeader><DialogTitle>录制事件截图</DialogTitle><DialogDescription className="break-all">{event ? label(event) : ''}</DialogDescription></DialogHeader>
      {screenshot ? <div className="relative overflow-hidden rounded-lg border">
        <img src={screenshot} alt="录制事件截图" className="block w-full" />
        {event?.elementRect?.x !== undefined && event.elementRect.y !== undefined ? <svg className="pointer-events-none absolute inset-0 h-full w-full" viewBox={`0 0 ${event.pageInfo.width} ${event.pageInfo.height}`} aria-label="录制目标位置"><circle cx={event.elementRect.x} cy={event.elementRect.y} r="12" fill="#2563eb33" stroke="#2563eb" strokeWidth="3" /></svg> : null}
      </div> : <p className="py-12 text-center text-sm text-muted-foreground">{error || '正在读取本地截图…'}</p>}
    </DialogContent>
  </Dialog>;
}
export function RecordingView({ draft, refresh, done }: { draft: RecordingDraft; refresh(): Promise<void>; done(): void }) {
  const [frame, setFrame] = useState<RecordingFrame>(), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const preview = useRef<HTMLIFrameElement>(null);
  const savedReview = useRef<{ choices?: RecordingStepChoice[]; assertions?: RecordingAssertion[]; steps?: RecordingReviewStep[] }>((() => { try { return JSON.parse(localStorage.getItem(`recording-review:${draft.id}`) || '{}'); } catch { return {}; } })());

  const [url, setUrl] = useState(draft.baseUrl), [choices, setChoices] = useState<RecordingStepChoice[]>(savedReview.current.choices ?? []);
  const [steps, setSteps] = useState<RecordingReviewStep[]>(() => savedReview.current.steps ?? [
    ...draft.events.map(event => ({ kind: 'event' as const, hashId: event.hashId })),
    ...(savedReview.current.assertions ?? []).map(assertion => ({ kind: 'check' as const, id: crypto.randomUUID(), assertion })),
  ]);
  const [yaml, setYaml] = useState(''), [confirmDiscard, setConfirmDiscard] = useState(false);
  const [insertAt, setInsertAt] = useState('end');
  const pendingCheckFocus = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!pendingCheckFocus.current) return;
    const field = document.querySelector<HTMLTextAreaElement>(`[data-review-check="${CSS.escape(pendingCheckFocus.current)}"] textarea`);
    if (!field) return;
    field.scrollIntoView({ block: 'nearest' });
    field.focus({ preventScroll: true });
    pendingCheckFocus.current = undefined;
  }, [steps]);
  useEffect(() => { localStorage.setItem(`recording-review:${draft.id}`, JSON.stringify({ choices, steps })); }, [draft.id, choices, steps]);
  const preparing = draft.status === 'ready';
  const active = draft.status === 'recording', starting = draft.status === 'starting';
  const working = useRef(false);
  const events = draft.events;
  const actions = events.filter((event) => !isNavigationState(event));
  const reviewing = !active && !starting && !preparing;
  const settledReview = useRef(reviewing);
  const checks = steps.filter((step): step is Extract<RecordingReviewStep, { kind: 'check' }> => step.kind === 'check');
  const eventIds = events.map(event => event.hashId);
  const storedEventIds = steps.filter((step): step is Extract<RecordingReviewStep, { kind: 'event' }> => step.kind === 'event').map(step => step.hashId);
  const staleSteps = reviewing && (
    storedEventIds.length !== eventIds.length || storedEventIds.some(id => !eventIds.includes(id)) || new Set(storedEventIds).size !== storedEventIds.length ||
    new Set(checks.map(step => step.id)).size !== checks.length ||
    storedEventIds.some((id, index) => index > 0 && eventIds.indexOf(id) < eventIds.indexOf(storedEventIds[index - 1]!))
  );
  useEffect(() => {
    if (!active && (!reviewing || settledReview.current)) return;
    settledReview.current = reviewing;
    setSteps(current => {
      const next = current.filter(step => step.kind === 'check' || eventIds.includes(step.hashId));
      for (let index = 0; index < eventIds.length; index++) {
        const hashId = eventIds[index]!;
        if (next.some(step => step.kind === 'event' && step.hashId === hashId)) continue;
        const following = next.findIndex(step => step.kind === 'event' && eventIds.indexOf(step.hashId) > index);
        const lastEvent = next.map(step => step.kind).lastIndexOf('event');
        next.splice(following >= 0 ? following : lastEvent + 1, 0, { kind: 'event', hashId });
      }
      return next.length === current.length && next.every((step, index) => step === current[index]) ? current : next;
    });
  }, [events, active, reviewing]);
  const timelineSteps: RecordingReviewStep[] = reviewing ? steps : events.map(event => ({ kind: 'event', hashId: event.hashId }));
  function addCheck(kind: RecordingAssertion['kind'], position = 'end') {
    if (busy || staleSteps) return;
    const check: RecordingReviewStep = { kind: 'check', id: crypto.randomUUID(), assertion: { kind, text: '', ...(kind === 'wait' ? { timeoutMs: 60000 } : {}) } };
    pendingCheckFocus.current = check.id;
    setSteps(current => {
      const next = [...current], index = position === 'end' ? next.length : Number(position);
      next.splice(Math.max(0, Math.min(index, next.length)), 0, check);
      return next;
    });
    setYaml('');
  }
  function editCheck(id: string, patch: Partial<RecordingAssertion>) {
    setSteps(current => current.map(step => step.kind === 'check' && step.id === id ? { ...step, assertion: { ...step.assertion, ...patch } } : step)); setYaml('');
  }
  function moveCheck(index: number, offset: number) {
    setSteps(current => {
      const next = [...current], target = index + offset;
      if (target < 0 || target >= next.length || next[index]?.kind !== 'check') return current;
      [next[index], next[target]] = [next[target]!, next[index]!];
      return next;
    }); setYaml('');
  }
  const canRetry = draft.browserMode === 'bridge' && events.length === 0 && (draft.status === 'interrupted' || (preparing && !!error));
  const disconnected = draft.status === 'interrupted' && events.length === 0;
  const hasReplayActions = actions.some((event) => (choices.find((item) => item.hashId === event.hashId)?.mode ?? 'recorded') !== 'skip');
  const [selectedEvent, setSelectedEvent] = useState<RecordedEvent>();
  useEffect(() => {
    let disposed = false, timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        if (!working.current && !starting && !preparing) {
          const next = await window.workspace.recordingFrame({ id: draft.id });
          if (!disposed) setFrame(next);
        }
      } catch (e) { if (!disposed && active) setError(String(e)); }
      if (!disposed && active) timer = setTimeout(tick, 2000);
    };
    void tick();
    return () => { disposed = true; clearTimeout(timer); };
  }, [draft.id, active, starting, preparing]);
  async function act(work: () => Promise<void>) {
    if (working.current) return;
    working.current = true; setBusy(true); setError('');
    try { await work(); await refresh(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); await refresh(); }
    finally { working.current = false; setBusy(false); }
  }
  async function interact(action: RecordingInteraction) {
    if (!active) return;
    await act(async () => {
      await window.workspace.recordingInteract({ id: draft.id, action });
      setFrame(await window.workspace.recordingFrame({ id: draft.id }));
    });
  }
  async function flushPreview() {
    const target = preview.current?.contentWindow;
    if (!target || !frame?.previewUrl) throw new Error('官方预览尚未就绪，请等待页面加载');
    const origin = new URL(frame.previewUrl).origin, requestId = crypto.randomUUID();
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: string) => { clearTimeout(timer); window.removeEventListener('message', onMessage); error ? reject(new Error(error)) : resolve(); };
      const onMessage = (event: MessageEvent) => {
        if (event.source === target && event.origin === origin && event.data?.type === 'workspace-preview:flushed' && event.data.requestId === requestId) finish(event.data.error);
      };
      const timer = setTimeout(() => finish('等待录制输入完成超时，请重试停止录制'), 15000);
      window.addEventListener('message', onMessage);
      target.postMessage({ type: 'workspace-preview:flush', requestId }, origin);
    });
  }
  function choice(hashId: string): RecordingStepChoice { return choices.find((c) => c.hashId === hashId) ?? { hashId, mode: 'recorded' }; }
  function changeChoice(hashId: string, patch: Partial<RecordingStepChoice>) {
    setChoices((items) => [...items.filter((i) => i.hashId !== hashId), { ...choice(hashId), ...patch, ...('prompt' in patch ? { confirmedPrompt: undefined } : {}) }]); setYaml('');
  }
  return <div className="flex flex-col gap-6">
    <div className="recording-heading flex flex-wrap items-start justify-between gap-4">
      <div className="space-y-2">
        <span className="text-xs font-semibold tracking-widest text-muted-foreground">WEB RECORDER · MIDSCENE</span>
        <h2 className="text-2xl font-semibold tracking-tight">{draft.caseName}</h2>
        <p className="text-sm text-muted-foreground">{preparing ? '已连接 Chrome。请在已连接的标签页手动完成登录，回到目标页面后点击「已准备好，开始录制」。准备阶段不采集截图或步骤。' : active ? '直接点击网页后输入文字、粘贴或滚动，操作由 Midscene 官方组件处理。' : starting ? '正在打开目标网页…' : '检查录制步骤，补充预期结果，然后保存到当前用例。'}</p>
      </div>
      <Badge variant="secondary" className={active ? 'border-red-200 bg-red-50 text-red-600' : ''}>{disconnected ? '连接失败' : preparing ? '等待手动登录' : active ? '● 录制中' : starting ? '准备中' : draft.status === 'saved' ? '已保存' : '待检查'}</Badge>
    </div>
    {staleSteps ? <Alert variant="destructive"><AlertDescription className="space-y-3"><p>保存的步骤与当前录制事件不一致。恢复后会保留检查内容，并将检查放到末尾，请重新确认执行位置。</p><Button variant="outline" disabled={busy} onClick={() => { const usedIds = new Set<string>();
      const restoredChecks = checks.map(check => {
        const id = check.id && !usedIds.has(check.id) ? check.id : crypto.randomUUID();
        usedIds.add(id); return { ...check, id };
      });
      setSteps([...events.map(event => ({ kind: 'event' as const, hashId: event.hashId })), ...restoredChecks]);
      setChoices(current => current.filter(item => eventIds.includes(item.hashId)));
      setInsertAt('end'); setYaml(''); }}>恢复事件顺序并将检查移至末尾</Button></AlertDescription></Alert> : null}
    {error || draft.error ? <Alert variant="destructive"><AlertDescription>{error || draft.error}</AlertDescription></Alert> : null}
    {canRetry ? <Card><CardContent className="space-y-3"><p className="text-sm leading-6">请在 Chrome 当前标签页打开所选环境的网站，并允许 Midscene 扩展连接。重试会保留当前用例信息。</p><Button disabled={busy || starting} onClick={() => void act(async () => { setFrame(undefined); await window.workspace.retryRecording({ id: draft.id }); })}><RotateCw className={`size-4 ${busy ? 'animate-spin' : ''}`} />{busy ? '正在重新连接…' : '重新连接 Chrome'}</Button></CardContent></Card> : null}
    {preparing ? <Card><CardContent className="space-y-4"><p className="text-sm leading-7">登录完成后，请返回 Workspace 的预览区域录制业务操作。直接在 Chrome 中操作不会加入 Timeline。平台会固定网页内容尺寸，结束后恢复。</p><Button disabled={busy} onClick={() => void act(() => window.workspace.beginRecording({ id: draft.id }))}>已准备好，开始录制</Button>{draft.existingWorkflow ? <Button variant="outline" className="ml-3" disabled={busy} onClick={() => void act(async () => { await window.workspace.confirmChromeSession({ id: draft.id }); done(); })}>登录完成，返回用例运行</Button> : null}</CardContent></Card> : null}
    {!preparing ? <div className="grid min-w-0 items-start gap-5 xl:grid-cols-[minmax(0,1fr)_320px]">
      <Card className="min-w-0 gap-0 overflow-hidden py-0">
        <form className="flex items-center gap-2 border-b p-3" onSubmit={(e) => { e.preventDefault(); void interact({ actionType: 'Navigate', url }); }}>
          <Globe2 className="size-4 shrink-0 text-muted-foreground" />
          <Input aria-label="录制网页地址" className="min-w-0 flex-1" type="url" required value={url} onChange={(e) => setUrl(e.target.value)} disabled={!active || busy} />
          <Button type="submit" variant="outline" disabled={!active || busy}>打开</Button>
        </form>
        <div className="relative w-full overflow-hidden bg-muted" style={{ aspectRatio: `${frame?.width ?? 1280}/${frame?.height ?? 800}` }}>
          {active && frame?.previewUrl ? <iframe ref={preview} title="Midscene 官方录制预览" src={frame.previewUrl} className="h-full w-full border-0" sandbox="allow-scripts allow-same-origin" /> : frame ? <img className="block h-full w-full object-contain" src={frame.screenshot.startsWith('data:') ? frame.screenshot : `data:image/png;base64,${frame.screenshot}`} alt="录制网页预览" /> : <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-muted-foreground">{starting || active ? <><LoaderCircle className="size-7 animate-spin" /><p>{starting && draft.browserMode === 'bridge' ? '正在连接 Chrome…' : '正在准备官方录制界面'}</p></> : <p>{disconnected ? 'Chrome 连接未完成，请重新连接后开始录制。' : '暂无录制画面，请查看已保留的事件。'}</p>}</div>}
        </div>
        <Separator />
        <p className="flex flex-wrap justify-between gap-2 px-3 py-3 text-xs text-muted-foreground"><span className="min-w-0 break-all">{frame?.url || draft.baseUrl}</span><span className="shrink-0">{frame?.width ?? 1280} × {frame?.height ?? 800} · {draft.browserMode === 'bridge' ? 'Chrome 现有会话' : '独立会话'} · 单页面录制</span></p>
      </Card>
      <Card className="min-w-0 gap-0 overflow-hidden py-0">
        <CardHeader className="flex flex-row items-center justify-between border-b px-5 py-4"><CardTitle className="text-base">Timeline</CardTitle><Badge variant="secondary">{events.length} 条事件{reviewing && checks.length ? ` · ${checks.length} 条检查` : ''}</Badge></CardHeader>
        {reviewing && actions.length > 0 ? <div className="space-y-3 border-b px-5 py-4">
          <label className="block space-y-2 text-xs text-muted-foreground"><span>插入位置</span><NativeSelect className="w-full" aria-label="检查步骤插入位置" value={insertAt} disabled={busy || staleSteps} onChange={event => setInsertAt(event.target.value)}>
            <NativeSelectOption value="0">Timeline 开头</NativeSelectOption>
            {steps.map((step, index) => <NativeSelectOption key={step.kind === 'event' ? step.hashId : step.id} value={String(index + 1)}>第 {index + 1} 项之后 · {step.kind === 'event' ? (events.some(event => event.hashId === step.hashId) ? label(events.find(event => event.hashId === step.hashId)!).slice(0, 32) : '原录制事件已不存在') : step.assertion.kind === 'wait' ? '等待条件' : '断言'}</NativeSelectOption>)}
            <NativeSelectOption value="end">Timeline 末尾</NativeSelectOption>
          </NativeSelect></label>
          <div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" disabled={busy || staleSteps} onClick={() => addCheck('wait', insertAt)}>插入等待条件</Button><Button size="sm" variant="outline" disabled={busy || staleSteps} onClick={() => addCheck('text', insertAt)}>插入断言</Button></div>
          <p className="text-xs leading-5 text-muted-foreground">按 Timeline 顺序执行。等待只重新检查当前页面，不会重复前面的操作。</p>
        </div> : null}
        <CardContent ref={attachOverlayScrollbars} className="max-h-[640px] overflow-y-auto p-0">{timelineSteps.length ? timelineSteps.map((step, index) => {
          if (step.kind === 'check') {
            const assertion = step.assertion, number = checks.findIndex(check => check.id === step.id) + 1;
            return <div key={step.id} data-review-step={step.id} data-review-check={step.id} className="space-y-3 border-b bg-muted/30 px-5 py-4 last:border-b-0">
              <div className="flex items-center justify-between gap-2"><span className="text-sm font-medium">{String(index + 1).padStart(2, '0')} · {assertion.kind === 'wait' ? '等待条件' : '检查预期结果'}</span><div className="flex gap-1">
                <Button type="button" size="icon" variant="ghost" className="size-7" aria-label={`上移检查 ${number}`} disabled={busy || staleSteps || index === 0} onClick={() => moveCheck(index, -1)}><ArrowUp className="size-3.5" /></Button>
                <Button type="button" size="icon" variant="ghost" className="size-7" aria-label={`下移检查 ${number}`} disabled={busy || staleSteps || index === steps.length - 1} onClick={() => moveCheck(index, 1)}><ArrowDown className="size-3.5" /></Button>
                <Button type="button" size="icon" variant="ghost" className="size-7" aria-label={`移除断言 ${number}`} disabled={busy || staleSteps} onClick={() => { setSteps(current => current.filter(item => item.kind !== 'check' || item.id !== step.id)); setYaml(''); }}><X className="size-3.5" /></Button>
              </div></div>
              <NativeSelect className="w-full" aria-label={`断言 ${number} 类型`} value={assertion.kind} disabled={busy || staleSteps} onChange={event => editCheck(step.id, { kind: event.target.value as RecordingAssertion['kind'] })}>
                <NativeSelectOption value="wait">等待页面满足条件</NativeSelectOption><NativeSelectOption value="text">页面包含可见文本</NativeSelectOption><NativeSelectOption value="ai">AI 判断预期结果</NativeSelectOption>
              </NativeSelect>
              <Textarea rows={2} aria-label={`断言 ${number} 内容`} disabled={busy || staleSteps} placeholder={assertion.kind === 'wait' ? '例如：最新消息下方出现非空的 AI 回复' : assertion.kind === 'text' ? '例如：发送成功' : '例如：回答与本次问题相关'} value={assertion.text} onChange={event => editCheck(step.id, { text: event.target.value })} />
              {assertion.kind === 'wait' ? <><label className="flex items-center gap-2 text-xs text-muted-foreground">最多等待<Input className="w-20" type="number" min={1} max={300} step={1} aria-label={`等待条件 ${number} 最长等待秒数`} disabled={busy || staleSteps} value={assertion.timeoutMs === 0 ? '' : String((assertion.timeoutMs ?? 60000) / 1000)} onChange={event => editCheck(step.id, { timeoutMs: Number(event.target.value) * 1000 })} />秒</label><p className="text-xs leading-5 text-muted-foreground">条件满足后继续，超过时限才失败。</p></> : <p className="text-xs leading-5 text-muted-foreground">{assertion.kind === 'ai' ? '检查此时的页面；异步结果请先插入等待条件。' : '检查页面中的可见文本。'}</p>}
            </div>;
          }
          const event = events.find(event => event.hashId === step.hashId);
          if (!event) return <div key={step.hashId} data-review-step={step.hashId} className="p-5 text-sm text-destructive">原录制事件已不存在，请重置步骤。</div>;
          const selected = choice(event.hashId), navigation = isNavigationState(event);
          const stepNumber = actions.findIndex((action) => action.hashId === event.hashId) + 1;
          const semantic = event.semantic;
          const screenshot = event.screenshotAsset || event.screenshotBefore || event.screenshotAfter || event.screenshotWithBox;
          const pending = semantic?.status === 'pending';
          const verified = isRecordingDescriptionVerified(event);
          const needsConfirmation = !verified || selected.prompt?.trim() !== semantic?.replayInstruction?.trim();
          return <div data-review-step={event.hashId} data-recorder-event={event.hashId} data-action-type={event.actionType} className={`space-y-3 border-b px-5 py-4 last:border-b-0 ${!navigation && selected.mode === 'skip' ? 'opacity-45' : ''}`} key={event.hashId}>
            <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground"><span>{event.actionType === 'Navigate' ? '导航' : eventNames[event.type]}</span><time>{Math.max(0, (event.timestamp - Date.parse(draft.createdAt)) / 1000).toFixed(1)}s</time></div>
            <div className="flex items-start gap-3"><span className="pt-0.5 font-mono text-xs text-muted-foreground">{String(index + 1).padStart(2, '0')}</span><strong className="min-w-0 break-words text-sm font-medium">{label(event)}</strong></div>
            {event.type === 'input' ? <p className="whitespace-pre-wrap break-all rounded bg-muted p-2 font-mono text-xs">{event.rawPayload?.mode === 'clear' ? '清空输入框' : String(event.rawPayload?.value ?? event.value ?? '')}</p> : null}
            {event.rawPayload?.implicitNavigationState ? <p className="break-all text-xs leading-5 text-muted-foreground">{String(event.rawPayload.beforeUrl ?? '')} → {String(event.rawPayload.afterUrl ?? event.url ?? '')}</p> : null}
            <div className="flex flex-wrap items-center gap-2">
              {pending ? <Badge variant="secondary"><LoaderCircle className="size-3 animate-spin" />正在生成并校验描述</Badge> : verified ? <Badge variant="secondary">AI 描述 · 已校验</Badge> : !navigation && event.actionType !== 'Navigate' ? <Badge variant="outline" title={semantic?.error}>描述待确认</Badge> : null}
              {screenshot ? <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs" aria-label={`查看第 ${index + 1} 条事件截图`} onClick={() => setSelectedEvent(event)}><ImageIcon className="size-3.5" />截图</Button> : null}
            </div>
            {navigation ? <p className="text-xs text-muted-foreground">{event.actionType === 'InitialNavigation' ? '回放时使用所选环境的地址。' : '由页面产生的导航记录，不重复执行跳转。'}</p> : null}
            {!active && !starting && !navigation ? <>
              <NativeSelect className="w-full" aria-label={`第 ${stepNumber} 步执行方式`} value={selected.mode} disabled={busy || staleSteps} onChange={(e) => changeChoice(event.hashId, { mode: e.target.value as RecordingStepChoice['mode'], ...(e.target.value === 'ai' && !selected.prompt ? { prompt: verified ? semantic?.replayInstruction ?? '' : '' } : {}) })}>
                <NativeSelectOption value="recorded">按录制操作回放</NativeSelectOption><NativeSelectOption value="ai">AI 描述执行</NativeSelectOption><NativeSelectOption value="skip">排除此步骤</NativeSelectOption>
              </NativeSelect>
              {selected.mode === 'ai' ? <><Textarea aria-label={`第 ${stepNumber} 步 AI 描述`} disabled={busy || staleSteps} rows={2} placeholder="例如：点击聊天输入框" value={selected.prompt ?? ''} onChange={(e) => changeChoice(event.hashId, { prompt: e.target.value })} />
                {needsConfirmation ? <label className="flex items-start gap-2 text-xs leading-5"><input type="checkbox" className="mt-1" disabled={busy || staleSteps || !selected.prompt?.trim()} checked={!!selected.prompt?.trim() && selected.confirmedPrompt === selected.prompt.trim()} onChange={(e) => changeChoice(event.hashId, { confirmedPrompt: e.target.checked ? selected.prompt?.trim() : undefined })} />我已对照截图确认此描述对应录制操作</label> : null}
              </> : null}
            </> : null}
            <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">事件详情</summary><div className="space-y-2 pt-2">
              {semantic?.error ? <p className="break-words">{semantic.error}</p> : null}
              {event.screenshotError ? <p>{event.screenshotError}</p> : null}
              {semantic?.elementDescription ? <p>目标：{semantic.elementDescription}</p> : null}
              {semantic?.replayInstruction ? <p>回放描述：{semantic.replayInstruction}</p> : null}
              {event.mergedHashIds?.length ? <p>已合并 {event.mergedHashIds.length} 个输入片段</p> : null}
              <pre ref={attachOverlayScrollbars} className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-2"><code>{JSON.stringify({ actionType: event.actionType, source: event.source, rawPayload: event.rawPayload, pageInfo: event.pageInfo, elementRect: event.elementRect }, null, 2)}</code></pre>
            </div></details>
          </div>;
        }) : <p className="px-5 py-8 text-sm leading-6 text-muted-foreground">{active ? '点击网页、输入文字或滚动后，步骤会显示在这里。' : '尚未采集操作。至少录制一个操作后才能保存。'}</p>}</CardContent>
      </Card>
    </div> : null}
    {!active && !starting && !preparing && actions.length > 0 ? <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3"><CardTitle className="text-base">等待条件与预期结果</CardTitle><div className="flex flex-wrap gap-2"><Button type="button" variant="outline" size="sm" disabled={busy || staleSteps} onClick={() => addCheck('wait')}><Plus className="size-3.5" />添加等待条件</Button><Button type="button" variant="outline" size="sm" disabled={busy || staleSteps} onClick={() => addCheck('text')}><Plus className="size-3.5" />添加断言</Button></div></CardHeader>
      <CardContent className="space-y-2 text-xs leading-6 text-muted-foreground"><p>快捷添加会放在 Timeline 末尾。你也可以在 Timeline 选择任意位置插入，并用上下按钮调整检查的位置。</p><p>等待条件和 AI 断言使用 Model Settings 中的配置；等待条件满足后立即继续，AI 断言只检查当时的页面。</p></CardContent>
    </Card> : null}
    <EventDetails event={selectedEvent} recordingId={draft.id} close={() => setSelectedEvent(undefined)} />
    {yaml ? <Card className="min-w-0"><CardHeader><CardTitle className="text-base">Workflow 预览</CardTitle></CardHeader><CardContent><pre ref={attachOverlayScrollbars} className="max-h-96 overflow-auto rounded-lg bg-muted p-4 font-mono text-xs leading-6" aria-label="生成的 Workflow YAML"><code>{yaml}</code></pre></CardContent></Card> : null}
    <div className="sticky bottom-0 z-10 flex flex-wrap items-center justify-between gap-3 border-t bg-background/95 py-4 backdrop-blur-sm">
      <div className="flex flex-wrap items-center gap-2">{confirmDiscard ? <>
        <span className="text-sm text-muted-foreground">放弃当前草稿，已保存的 Workflow 保持不变。</span>
        <Button type="button" variant="destructive" disabled={busy || starting} onClick={() => void act(async () => { await window.workspace.discardRecording({ id: draft.id }); done(); })}>确认放弃</Button>
        <Button type="button" variant="outline" onClick={() => setConfirmDiscard(false)}>保留草稿</Button>
      </> : <Button type="button" variant="outline" disabled={busy || starting} onClick={() => setConfirmDiscard(true)}>放弃本次录制</Button>}</div>
      <div className="flex flex-wrap items-center gap-2">{active ? <Button type="button" variant="destructive" disabled={busy} onClick={() => void act(async () => { await flushPreview(); await window.workspace.stopRecording({ id: draft.id }); })}><Square className="size-3.5" />停止录制并检查</Button> : !starting && !preparing ? <>
        <Button type="button" variant="outline" disabled={busy || staleSteps || !hasReplayActions} onClick={() => void act(async () => { setYaml(await window.workspace.buildRecording({ id: draft.id, choices, steps })); })}><Code2 className="size-4" />预览 YAML</Button>
        <Button type="button" disabled={busy || staleSteps || !hasReplayActions} onClick={() => void act(async () => { await window.workspace.saveRecording({ id: draft.id, choices, steps }); done(); })}><Check className="size-4" />保存到当前用例</Button>
      </> : null}</div>
    </div>
  </div>;
}
