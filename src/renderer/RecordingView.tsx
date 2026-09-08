import { useEffect, useRef, useState } from 'react';
import { Check, Code2, Globe2, ImageIcon, LoaderCircle, Plus, Square, X } from 'lucide-react';
import { getMidsceneRecorderEventDescription } from '@midscene/shared/recorder';
import type { RecordedEvent, RecordingDraft, RecordingFrame, RecordingInteraction } from '../shared/recording.js';
import type { RecordingAssertion, RecordingStepChoice } from '../recording/workflow.js';
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
  return getMidsceneRecorderEventDescription(event);
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
    <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-5xl">
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
  const savedReview = useRef<{ choices?: RecordingStepChoice[]; assertions?: RecordingAssertion[] }>((() => { try { return JSON.parse(localStorage.getItem(`recording-review:${draft.id}`) || '{}'); } catch { return {}; } })());

  const [url, setUrl] = useState(draft.baseUrl), [choices, setChoices] = useState<RecordingStepChoice[]>(savedReview.current.choices ?? []);
  const [assertions, setAssertions] = useState<RecordingAssertion[]>(savedReview.current.assertions ?? []), [yaml, setYaml] = useState(''), [confirmDiscard, setConfirmDiscard] = useState(false);
  useEffect(() => { localStorage.setItem(`recording-review:${draft.id}`, JSON.stringify({ choices, assertions })); }, [draft.id, choices, assertions]);
  const active = draft.status === 'recording', starting = draft.status === 'starting';
  const working = useRef(false);
  const events = draft.events;
  const actions = events.filter((event) => !isNavigationState(event));
  const [selectedEvent, setSelectedEvent] = useState<RecordedEvent>();
  useEffect(() => {
    let disposed = false, timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        if (!working.current && !starting) {
          const next = await window.workspace.recordingFrame({ id: draft.id });
          if (!disposed) setFrame(next);
        }
      } catch (e) { if (!disposed && active) setError(String(e)); }
      if (!disposed && active) timer = setTimeout(tick, 2000);
    };
    void tick();
    return () => { disposed = true; clearTimeout(timer); };
  }, [draft.id, active, starting]);
  async function act(work: () => Promise<void>) {
    if (working.current) return;
    working.current = true; setBusy(true); setError('');
    try { await work(); await refresh(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
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
    setChoices((items) => [...items.filter((i) => i.hashId !== hashId), { ...choice(hashId), ...patch }]); setYaml('');
  }
  return <div className="flex flex-col gap-6">
    <div className="recording-heading flex flex-wrap items-start justify-between gap-4">
      <div className="space-y-2">
        <span className="text-xs font-semibold tracking-widest text-muted-foreground">WEB RECORDER · MIDSCENE</span>
        <h2 className="text-2xl font-semibold tracking-tight">{draft.caseName}</h2>
        <p className="text-sm text-muted-foreground">{active ? '直接点击网页后输入文字、粘贴或滚动，操作由 Midscene 官方组件处理。' : starting ? '正在打开目标网页…' : '检查录制步骤，补充预期结果，然后保存到当前用例。'}</p>
      </div>
      <Badge variant="secondary" className={active ? 'border-red-200 bg-red-50 text-red-600' : ''}>{active ? '● 录制中' : starting ? '准备中' : draft.status === 'saved' ? '已保存' : '待检查'}</Badge>
    </div>
    {error || draft.error ? <Alert variant="destructive"><AlertDescription>{error || draft.error}</AlertDescription></Alert> : null}
    <div className="grid min-w-0 items-start gap-5 xl:grid-cols-[minmax(0,1fr)_320px]">
      <Card className="min-w-0 gap-0 overflow-hidden py-0">
        <form className="flex items-center gap-2 border-b p-3" onSubmit={(e) => { e.preventDefault(); void interact({ actionType: 'Navigate', url }); }}>
          <Globe2 className="size-4 shrink-0 text-muted-foreground" />
          <Input aria-label="录制网页地址" className="min-w-0 flex-1" type="url" required value={url} onChange={(e) => setUrl(e.target.value)} disabled={!active || busy} />
          <Button type="submit" variant="outline" disabled={!active || busy}>打开</Button>
        </form>
        <div className="relative aspect-[1280/800] w-full overflow-hidden bg-muted">
          {active && frame?.previewUrl ? <iframe ref={preview} title="Midscene 官方录制预览" src={frame.previewUrl} className="h-full w-full border-0" sandbox="allow-scripts allow-same-origin" /> : frame ? <img className="block h-full w-full object-contain" src={frame.screenshot.startsWith('data:') ? frame.screenshot : `data:image/png;base64,${frame.screenshot}`} alt="录制网页预览" /> : <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-muted-foreground"><LoaderCircle className="size-7 animate-spin" /><p>正在准备官方录制界面</p></div>}
        </div>
        <Separator />
        <p className="flex flex-wrap justify-between gap-2 px-3 py-3 text-xs text-muted-foreground"><span className="min-w-0 break-all">{frame?.url || draft.baseUrl}</span><span className="shrink-0">1280 × 800 · 单页面录制</span></p>
      </Card>
      <Card className="min-w-0 gap-0 overflow-hidden py-0">
        <CardHeader className="flex flex-row items-center justify-between border-b px-5 py-4"><CardTitle className="text-base">Timeline</CardTitle><Badge variant="secondary">{events.length} 条事件</Badge></CardHeader>
        <CardContent className="max-h-[640px] overflow-y-auto p-0">{events.length ? events.map((event, index) => {
          const selected = choice(event.hashId), navigation = isNavigationState(event);
          const stepNumber = actions.findIndex((action) => action.hashId === event.hashId) + 1;
          const semantic = event.semantic;
          const screenshot = event.screenshotAsset || event.screenshotBefore || event.screenshotAfter || event.screenshotWithBox;
          const pending = semantic?.status === 'pending';
          return <div data-recorder-event={event.hashId} data-action-type={event.actionType} className={`space-y-3 border-b px-5 py-4 last:border-b-0 ${!navigation && selected.mode === 'skip' ? 'opacity-45' : ''}`} key={event.hashId}>
            <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground"><span>{event.actionType === 'Navigate' ? '导航' : eventNames[event.type]}</span><time>{Math.max(0, (event.timestamp - Date.parse(draft.createdAt)) / 1000).toFixed(1)}s</time></div>
            <div className="flex items-start gap-3"><span className="pt-0.5 font-mono text-xs text-muted-foreground">{String(index + 1).padStart(2, '0')}</span><strong className="min-w-0 break-words text-sm font-medium">{label(event)}</strong></div>
            {event.type === 'input' ? <p className="whitespace-pre-wrap break-all rounded bg-muted p-2 font-mono text-xs">{event.rawPayload?.mode === 'clear' ? '清空输入框' : String(event.rawPayload?.value ?? event.value ?? '')}</p> : null}
            {event.rawPayload?.implicitNavigationState ? <p className="break-all text-xs leading-5 text-muted-foreground">{String(event.rawPayload.beforeUrl ?? '')} → {String(event.rawPayload.afterUrl ?? event.url ?? '')}</p> : null}
            <div className="flex flex-wrap items-center gap-2">
              {pending ? <Badge variant="secondary"><LoaderCircle className="size-3 animate-spin" />正在生成描述</Badge> : semantic?.status === 'ready' && semantic.source !== 'heuristic' ? <Badge variant="secondary">{semantic.confidence === 'low' || semantic.aiDescribe?.verifyPassed === false ? 'AI 描述 · 请确认' : 'AI 描述'}</Badge> : !navigation && event.actionType !== 'Navigate' && semantic?.status === 'failed' ? <Badge variant="outline" title={semantic.error}>描述不可用</Badge> : null}
              {screenshot ? <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs" aria-label={`查看第 ${index + 1} 条事件截图`} onClick={() => setSelectedEvent(event)}><ImageIcon className="size-3.5" />截图</Button> : null}
            </div>
            {navigation ? <p className="text-xs text-muted-foreground">{event.actionType === 'InitialNavigation' ? '回放时使用所选环境的地址。' : '由页面产生的导航记录，不重复执行跳转。'}</p> : null}
            {!active && !starting && !navigation ? <>
              <NativeSelect className="w-full" aria-label={`第 ${stepNumber} 步执行方式`} value={selected.mode} onChange={(e) => changeChoice(event.hashId, { mode: e.target.value as RecordingStepChoice['mode'], ...(e.target.value === 'ai' && !selected.prompt ? { prompt: semantic?.replayInstruction ?? '' } : {}) })}>
                <NativeSelectOption value="recorded">按录制操作回放</NativeSelectOption><NativeSelectOption value="ai">AI 描述执行</NativeSelectOption><NativeSelectOption value="skip">排除此步骤</NativeSelectOption>
              </NativeSelect>
              {selected.mode === 'ai' ? <Textarea aria-label={`第 ${stepNumber} 步 AI 描述`} rows={2} placeholder="例如：点击聊天输入框" value={selected.prompt ?? ''} onChange={(e) => changeChoice(event.hashId, { prompt: e.target.value })} /> : null}
            </> : null}
            <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">事件详情</summary><div className="space-y-2 pt-2">
              {semantic?.error ? <p className="break-words">{semantic.error}</p> : null}
              {event.screenshotError ? <p>{event.screenshotError}</p> : null}
              {semantic?.elementDescription ? <p>目标：{semantic.elementDescription}</p> : null}
              {semantic?.replayInstruction ? <p>回放描述：{semantic.replayInstruction}</p> : null}
              {event.mergedHashIds?.length ? <p>已合并 {event.mergedHashIds.length} 个输入片段</p> : null}
              <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-2">{JSON.stringify({ actionType: event.actionType, source: event.source, rawPayload: event.rawPayload, pageInfo: event.pageInfo, elementRect: event.elementRect }, null, 2)}</pre>
            </div></details>
          </div>;
        }) : <p className="px-5 py-8 text-sm leading-6 text-muted-foreground">{active ? '点击网页、输入文字或滚动后，步骤会显示在这里。' : '尚未采集操作。至少录制一个操作后才能保存。'}</p>}</CardContent>
      </Card>
    </div>
    {!active && !starting ? <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-3"><CardTitle className="text-base">预期结果</CardTitle><Button type="button" variant="outline" size="sm" onClick={() => { setAssertions([...assertions, { kind: 'text', text: '' }]); setYaml(''); }}><Plus className="size-3.5" />添加断言</Button></CardHeader>
      <CardContent className="space-y-3">
        {assertions.length ? assertions.map((assertion, index) => <div className="flex flex-wrap items-center gap-3" key={index}>
          <NativeSelect aria-label={`断言 ${index + 1} 类型`} value={assertion.kind} onChange={(e) => { setAssertions(assertions.map((a, n) => n === index ? { ...a, kind: e.target.value as 'text' | 'ai' } : a)); setYaml(''); }}>
            <NativeSelectOption value="text">页面包含可见文本</NativeSelectOption><NativeSelectOption value="ai">AI 判断预期结果</NativeSelectOption>
          </NativeSelect>
          <Input className="min-w-48 flex-1" aria-label={`断言 ${index + 1} 内容`} placeholder={assertion.kind === 'text' ? '例如：发送成功' : '例如：页面展示了回答，并提示用户登录'} value={assertion.text} onChange={(e) => { setAssertions(assertions.map((a, n) => n === index ? { ...a, text: e.target.value } : a)); setYaml(''); }} />
          <Button type="button" variant="ghost" size="icon" aria-label={`移除断言 ${index + 1}`} onClick={() => { setAssertions(assertions.filter((_, n) => n !== index)); setYaml(''); }}><X className="size-4" /></Button>
        </div>) : <p className="text-sm leading-6 text-muted-foreground">添加断言后，测试才能检查业务结果。没有断言时，仅验证操作是否完成。</p>}
        <p className="pt-2 text-xs leading-6 text-muted-foreground">按录制操作回放不调用模型，页面布局变化后可能需要重录。AI 步骤和 AI 断言使用 Model Settings 中的配置。</p>
      </CardContent>
    </Card> : null}
    <EventDetails event={selectedEvent} recordingId={draft.id} close={() => setSelectedEvent(undefined)} />
    {yaml ? <Card className="min-w-0"><CardHeader><CardTitle className="text-base">Workflow 预览</CardTitle></CardHeader><CardContent><pre className="max-h-96 overflow-auto rounded-lg bg-muted p-4 font-mono text-xs leading-6" aria-label="生成的 Workflow YAML">{yaml}</pre></CardContent></Card> : null}
    <div className="sticky bottom-0 z-10 flex flex-wrap items-center justify-between gap-3 border-t bg-background/95 py-4 backdrop-blur-sm">
      <div className="flex flex-wrap items-center gap-2">{confirmDiscard ? <>
        <span className="text-sm text-muted-foreground">放弃当前草稿，已保存的 Workflow 保持不变。</span>
        <Button type="button" variant="destructive" disabled={busy || starting} onClick={() => void act(async () => { await window.workspace.discardRecording({ id: draft.id }); done(); })}>确认放弃</Button>
        <Button type="button" variant="outline" onClick={() => setConfirmDiscard(false)}>保留草稿</Button>
      </> : <Button type="button" variant="outline" disabled={busy || starting} onClick={() => setConfirmDiscard(true)}>放弃本次录制</Button>}</div>
      <div className="flex flex-wrap items-center gap-2">{active ? <Button type="button" variant="destructive" disabled={busy} onClick={() => void act(async () => { await flushPreview(); await window.workspace.stopRecording({ id: draft.id }); })}><Square className="size-3.5" />停止录制并检查</Button> : !starting ? <>
        <Button type="button" variant="outline" disabled={busy} onClick={() => void act(async () => { setYaml(await window.workspace.buildRecording({ id: draft.id, choices, assertions })); })}><Code2 className="size-4" />预览 YAML</Button>
        <Button type="button" disabled={busy} onClick={() => void act(async () => { await window.workspace.saveRecording({ id: draft.id, choices, assertions }); done(); })}><Check className="size-4" />保存到当前用例</Button>
      </> : null}</div>
    </div>
  </div>;
}
