import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import type { HistoryPage, HistoryRun } from '../shared/workspace.js';
export function HistoryView({ projectId, openRun }: { projectId?: string; openRun(run: HistoryRun): void }) {
  const [status, setStatus] = useState(''), [environment, setEnvironment] = useState(''), [after, setAfter] = useState(''), [before, setBefore] = useState('');
  const [page, setPage] = useState(0), [data, setData] = useState<HistoryPage>({ runs: [], total: 0 }), [error, setError] = useState('');
  const [revision, refresh] = useState(0);
  useEffect(() => window.workspace.onChange(() => refresh(n => n + 1)), []);
  useEffect(() => { setPage(0); }, [projectId, status, environment, after, before]);
  useEffect(() => {
    let live = true;
    void window.workspace.history({ projectId, status, environment, after: after ? new Date(after).toISOString() : undefined, before: before ? new Date(before + 'T23:59:59.999').toISOString() : undefined, offset: page * 50, limit: 50 }).then(result => { if (live) { setData(result); setError(''); } }).catch(e => { if (live) setError(String(e)); });
    return () => { live = false; };
  }, [projectId, status, environment, after, before, page, revision]);
  return <Card><CardContent className="space-y-4 pt-6">
    <div className="flex flex-wrap gap-3"><NativeSelect aria-label="历史状态" value={status} onChange={e => setStatus(e.target.value)}><NativeSelectOption value="">全部状态</NativeSelectOption>{['passed','failed','error','cancelled','interrupted'].map(value => <NativeSelectOption key={value} value={value}>{value}</NativeSelectOption>)}</NativeSelect><Input className="w-40" aria-label="历史环境" placeholder="环境名称" value={environment} onChange={e => setEnvironment(e.target.value)} /><Input className="w-40" type="date" aria-label="开始日期" value={after} onChange={e => setAfter(e.target.value)} /><Input className="w-40" type="date" aria-label="结束日期" value={before} onChange={e => setBefore(e.target.value)} /></div>
    {error && <p role="alert" className="text-destructive">{error}</p>}
    <div className="divide-y">{data.runs.map(run => <Button data-testid="run-row" variant="ghost" className="h-auto w-full justify-between rounded-none py-4 text-left" key={run.runId} onClick={() => openRun(run)}><span><strong className="block">{run.caseName}</strong><small className="text-muted-foreground">{run.environment} · {new Date(run.startedAt).toLocaleString('zh-CN')}</small></span><span>{run.status}</span></Button>)}</div>
    {!data.total && <p className="py-5 text-center text-muted-foreground">没有符合筛选条件的运行记录。</p>}
    <div className="flex items-center justify-between"><span className="text-xs text-muted-foreground">{data.total} 条记录 · 第 {page + 1} / {Math.max(1, Math.ceil(data.total / 50))} 页</span><div className="flex gap-2"><Button variant="outline" disabled={!page} onClick={() => setPage(p => p - 1)}>上一页</Button><Button variant="outline" disabled={(page + 1) * 50 >= data.total} onClick={() => setPage(p => p + 1)}>下一页</Button></div></div>
  </CardContent></Card>;
}
