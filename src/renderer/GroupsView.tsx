import { attachOverlayScrollbars } from '@/lib/scrollbars';
import { lazy, Suspense, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Pencil, Play, Plus, Trash2, X } from 'lucide-react';
import type { Project, SaveGroupInput, TestGroup } from '../shared/workspace.js';
const GroupGraph = lazy(() => import('./GroupGraph.js').then(module => ({ default: module.GroupGraph })));
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';

const PAGE = 50;
function Pager({ label, page, count, change }: { label: string; page: number; count: number; change(value: number): void }) {
  const pages = Math.max(1, Math.ceil(count / PAGE));
  return <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground"><span>{count} 项 · 第 {page + 1} / {pages} 页</span><div className="flex gap-2"><Button type="button" size="sm" variant="outline" aria-label={label + '上一页'} disabled={page === 0} onClick={() => change(page - 1)}>上一页</Button><Button type="button" size="sm" variant="outline" aria-label={label + '下一页'} disabled={page + 1 >= pages} onClick={() => change(page + 1)}>下一页</Button></div></div>;
}
function GroupEditor({ project, initial, close, refresh, saved }: { project: Project; initial: SaveGroupInput; close(): void; refresh(): Promise<void>; saved(id: string): void }) {
  const [draft, setDraft] = useState(initial), [query, setQuery] = useState(''), [suite, setSuite] = useState('all'), [tag, setTag] = useState('');
  const [onlySelected, setOnlySelected] = useState(false), [page, setPage] = useState(0), [selectedPage, setSelectedPage] = useState(0);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''); const working = useRef(false);
  const cases = useMemo(() => new Map(project.cases.map(item => [item.id, item])), [project.cases]);
  const filtered = project.cases.filter(item => (suite === 'all' || item.suiteId === suite) && (!tag || item.tags.some(value => value.toLowerCase().includes(tag.toLowerCase()))) && (!onlySelected || draft.caseIds.includes(item.id)) && (item.name + ' ' + item.description).toLowerCase().includes(query.toLowerCase()));
  const currentPage = Math.min(page, Math.max(0, Math.ceil(filtered.length / PAGE) - 1)), currentSelectedPage = Math.min(selectedPage, Math.max(0, Math.ceil(draft.caseIds.length / PAGE) - 1));
  function move(index: number, offset: number) {
    setDraft(current => {
      const caseIds = [...current.caseIds], target = index + offset;
      if (target < 0 || target >= caseIds.length) return current;
      [caseIds[index], caseIds[target]] = [caseIds[target]!, caseIds[index]!]; return { ...current, caseIds };
    });
  }
  async function save() {
    if (working.current) return;
    working.current = true; setBusy(true); setError('');
    try { const id = await window.workspace.saveGroup({ ...draft, name: draft.name.trim() }); await refresh(); saved(id); close(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { working.current = false; setBusy(false); }
  }
  return <Dialog open onOpenChange={open => { if (!open && !busy) close(); }}><DialogContent showCloseButton={false} className="flex max-h-[92dvh] flex-col overflow-hidden sm:max-w-5xl" onInteractOutside={event => event.preventDefault()}>
    <DialogHeader className="shrink-0"><DialogTitle>{draft.id ? '编辑分组' : '新建分组'}</DialogTitle><DialogDescription>一个用例可以加入多个分组。成员顺序决定该分组的执行顺序。</DialogDescription></DialogHeader>
    <div ref={attachOverlayScrollbars} className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain pr-1">
      <div className="grid gap-3 sm:grid-cols-2"><label className="space-y-2 text-sm"><span>分组名称</span><Input aria-label="分组名称" value={draft.name} disabled={busy} onChange={event => setDraft({ ...draft, name: event.target.value })} /></label><label className="space-y-2 text-sm"><span>分组说明</span><Textarea rows={2} aria-label="分组说明" value={draft.description} disabled={busy} onChange={event => setDraft({ ...draft, description: event.target.value })} /></label></div>
      {error ? <Alert variant="destructive"><AlertDescription>{error} 输入内容已保留。</AlertDescription></Alert> : null}
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-3 rounded-lg border p-4"><h3 className="text-sm font-medium">选择成员</h3><Input aria-label="搜索分组成员用例" placeholder="搜索用例名称或说明" value={query} disabled={busy} onChange={event => { setQuery(event.target.value); setPage(0); }} />
          <div className="flex flex-wrap gap-2"><NativeSelect aria-label="分组成员 Suite" value={suite} disabled={busy} onChange={event => { setSuite(event.target.value); setPage(0); }}><NativeSelectOption value="all">全部 Suite</NativeSelectOption>{project.suites.map(item => <NativeSelectOption key={item.id} value={item.id}>{item.name}</NativeSelectOption>)}</NativeSelect><Input className="min-w-28 flex-1" aria-label="分组成员标签" placeholder="筛选标签" value={tag} disabled={busy} onChange={event => { setTag(event.target.value); setPage(0); }} /></div>
          <Button type="button" size="sm" variant="outline" disabled={busy || !filtered.length || filtered.every(item => draft.caseIds.includes(item.id))} onClick={() => setDraft(current => ({ ...current, caseIds: [...new Set([...current.caseIds, ...filtered.map(item => item.id)])] }))}>添加全部筛选结果</Button>
          <label className="flex items-center gap-2 text-xs"><Checkbox aria-label="仅显示已选成员" checked={onlySelected} disabled={busy} onCheckedChange={value => { setOnlySelected(!!value); setPage(0); }} />仅显示已选成员</label>
          <div ref={attachOverlayScrollbars} className="max-h-64 divide-y overflow-y-auto rounded border">{filtered.slice(currentPage * PAGE, (currentPage + 1) * PAGE).map(item => <label data-testid="group-candidate-row" key={item.id} className="flex cursor-pointer items-start gap-2 p-2.5 text-xs"><Checkbox aria-label={`选择成员 ${item.name}`} checked={draft.caseIds.includes(item.id)} disabled={busy} onCheckedChange={checked => setDraft(current => ({ ...current, caseIds: checked ? [...current.caseIds.filter(id => id !== item.id), item.id] : current.caseIds.filter(id => id !== item.id) }))} /><span className="min-w-0 flex-1 break-words">{item.name}<small className="mt-1 block text-muted-foreground">{project.suites.find(value => value.id === item.suiteId)?.name}{item.tags.length ? ' · ' + item.tags.join(', ') : ''}</small></span></label>)}{!filtered.length ? <p className="p-4 text-xs text-muted-foreground">没有匹配的用例。</p> : null}</div>
          <Pager label="候选用例" page={currentPage} count={filtered.length} change={setPage} />
        </div>
        <div className="space-y-3 rounded-lg border p-4"><div className="flex items-center justify-between gap-2"><h3 className="text-sm font-medium">已选成员与顺序 · {draft.caseIds.length}</h3><Button type="button" size="sm" variant="ghost" disabled={busy || !draft.caseIds.length} onClick={() => setDraft(current => ({ ...current, caseIds: [] }))}>清空已选成员</Button></div><div ref={attachOverlayScrollbars} className="max-h-96 divide-y overflow-y-auto rounded border">{draft.caseIds.slice(currentSelectedPage * PAGE, (currentSelectedPage + 1) * PAGE).map((id, localIndex) => {
          const index = currentSelectedPage * PAGE + localIndex;
          return <div data-testid="group-member-row" data-case-id={id} key={id} className="flex items-center gap-2 p-2 text-xs"><span className="text-muted-foreground">{index + 1}</span><span className="min-w-0 flex-1 break-words">{cases.get(id)?.name ?? '缺失用例：' + id}</span><Button type="button" size="icon-xs" variant="ghost" aria-label={`上移成员 ${cases.get(id)?.name ?? id}`} disabled={busy || index === 0} onClick={() => move(index, -1)}><ArrowUp /></Button><Button type="button" size="icon-xs" variant="ghost" aria-label={`下移成员 ${cases.get(id)?.name ?? id}`} disabled={busy || index === draft.caseIds.length - 1} onClick={() => move(index, 1)}><ArrowDown /></Button><Button type="button" size="icon-xs" variant="ghost" aria-label={`移除成员 ${cases.get(id)?.name ?? id}`} disabled={busy} onClick={() => setDraft(current => ({ ...current, caseIds: current.caseIds.filter(value => value !== id) }))}><X /></Button></div>;
        })}{!draft.caseIds.length ? <p className="p-4 text-xs text-muted-foreground">从左侧选择用例。空分组可以保存，但不能运行。</p> : null}</div><Pager label="已选成员" page={currentSelectedPage} count={draft.caseIds.length} change={setSelectedPage} /></div>
      </div>
    </div>
    <DialogFooter className="shrink-0 border-t bg-background pt-4"><Button variant="outline" disabled={busy} onClick={close}>取消编辑</Button><Button disabled={busy || !draft.name.trim()} onClick={() => void save()}>保存分组</Button></DialogFooter>
  </DialogContent></Dialog>;
}

export function GroupsView({ project, refresh, openCase, run, runLocked }: { project: Project; refresh(): Promise<void>; openCase(id: string): void; run(ids: string[]): void; runLocked: boolean }) {
  const groups = project.groups ?? [], caseMap = useMemo(() => new Map(project.cases.map(item => [item.id, item])), [project.cases]);
  const [revealGroupId, setRevealGroupId] = useState('');
  const [mode, setMode] = useState('list'), [query, setQuery] = useState(''), [page, setPage] = useState(0), [selectionPage, setSelectionPage] = useState(0);
  const [selected, setSelected] = useState<string[]>([]), [edit, setEdit] = useState<SaveGroupInput>(), [deleting, setDeleting] = useState<TestGroup>();
  const [error, setError] = useState(''), [busy, setBusy] = useState(false); const working = useRef(false);
  const filtered = groups.filter(group => (group.name + ' ' + group.description).toLowerCase().includes(query.toLowerCase()) || group.caseIds.some(id => { const item = caseMap.get(id); return item && (item.name + ' ' + item.tags.join(' ')).toLowerCase().includes(query.toLowerCase()); }));
  const currentPage = Math.min(page, Math.max(0, Math.ceil(filtered.length / PAGE) - 1)), currentSelectionPage = Math.min(selectionPage, Math.max(0, Math.ceil(selected.length / PAGE) - 1));
  const visible = filtered.slice(currentPage * PAGE, (currentPage + 1) * PAGE);
  function createGroup() { setError(''); setEdit({ projectId: project.id, name: '', description: '', caseIds: [] }); }
  function toggle(id: string) { setSelected(current => current.includes(id) ? current.filter(value => value !== id) : [...current, id]); }
  function move(index: number, offset: number) { setSelected(current => { const next = [...current], target = index + offset; if (target < 0 || target >= next.length) return current; [next[index], next[target]] = [next[target]!, next[index]!]; return next; }); }
  const issues = selected.flatMap(id => {
    const group = groups.find(item => item.id === id);
    if (!group) return ['所选分组已不存在'];
    if (!group.caseIds.length) return [group.name + ' 是空分组'];
    const missing = group.caseIds.filter(caseId => !caseMap.has(caseId));
    const unavailable = group.caseIds.filter(caseId => caseMap.has(caseId) && !caseMap.get(caseId)!.workflows.some(workflow => workflow.platform === 'web' && workflow.ready));
    return [...(missing.length ? [group.name + ' 有 ' + missing.length + ' 个缺失用例'] : []), ...(unavailable.length ? [group.name + ' 有 ' + unavailable.length + ' 个用例尚无可运行的 Web Workflow'] : [])];
  });
  async function remove() {
    if (!deleting || working.current) return;
    working.current = true; setBusy(true); setError('');
    try { await window.workspace.deleteGroup({ projectId: project.id, id: deleting.id, revision: deleting.revision }); setSelected(current => current.filter(id => id !== deleting.id)); await refresh(); setDeleting(undefined); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { working.current = false; setBusy(false); }
  }
  return <div className="space-y-5" data-testid="groups-view">
    <div className="flex flex-wrap items-center justify-between gap-3"><Tabs value={mode} onValueChange={setMode}><TabsList><TabsTrigger value="list">分组列表</TabsTrigger><TabsTrigger value="graph">关系图</TabsTrigger></TabsList></Tabs><Input className="w-72" aria-label="搜索分组或用例" placeholder="搜索分组、用例或标签" value={query} onChange={event => { setQuery(event.target.value); setPage(0); setRevealGroupId(''); }} /><Button onClick={createGroup}><Plus />新建分组</Button></div>
    {error && !deleting ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
    {mode === 'graph' ? <Suspense fallback={<Card><CardContent className="py-10 text-center text-sm text-muted-foreground">正在加载关系图…</CardContent></Card>}><GroupGraph key={query} search={query} project={project} groups={filtered} selected={selected} toggle={toggle} openCase={openCase} createGroup={createGroup} revealGroupId={revealGroupId} disabled={busy} /></Suspense> : <Card className="gap-0 overflow-hidden py-0">
      <CardHeader className="flex flex-row items-center justify-between border-b py-4"><CardTitle className="text-base">{filtered.length} 个分组</CardTitle><label className="flex items-center gap-2 text-xs"><Checkbox aria-label="全选本页分组" checked={visible.length > 0 && visible.every(group => selected.includes(group.id))} disabled={!visible.length || busy} onCheckedChange={value => setSelected(current => value ? [...current, ...visible.map(group => group.id).filter(id => !current.includes(id))] : current.filter(id => !visible.some(group => group.id === id)))} />全选本页</label></CardHeader>
      <CardContent className="p-0">{visible.map(group => <div data-testid="group-list-row" data-group-id={group.id} key={group.id} className="flex flex-wrap items-center gap-3 border-b px-5 py-4 last:border-b-0"><Checkbox aria-label={`选择分组 ${group.name}`} checked={selected.includes(group.id)} disabled={busy} onCheckedChange={() => toggle(group.id)} /><div className="min-w-40 flex-1"><strong className="text-sm">{group.name}</strong>{group.description ? <p className="mt-1 break-words text-xs text-muted-foreground">{group.description}</p> : null}</div><Badge variant="outline">{group.caseIds.length} 个用例</Badge><Button size="sm" variant="outline" aria-label={`编辑分组 ${group.name}`} disabled={busy} onClick={() => { setError(''); setEdit({ projectId: project.id, id: group.id, revision: group.revision, name: group.name, description: group.description, caseIds: [...group.caseIds] }); }}><Pencil />编辑</Button><Button size="icon-sm" variant="ghost" aria-label={`删除分组 ${group.name}`} disabled={busy} onClick={() => { setError(''); setDeleting(group); }}><Trash2 /></Button></div>)}{!visible.length ? <p className="p-6 text-sm text-muted-foreground">没有匹配的分组。你可以新建分组，将不同 Suite 的用例组合起来。</p> : null}</CardContent><div className="border-t px-5 py-3"><Pager label="分组列表" page={currentPage} count={filtered.length} change={setPage} /></div>
    </Card>}
    {selected.length ? <Card><CardHeader className="flex flex-row items-center justify-between"><CardTitle className="text-base">已选分组与运行顺序 · {selected.length}</CardTitle><Button variant="ghost" size="sm" onClick={() => setSelected([])}>清空已选分组</Button></CardHeader><CardContent className="space-y-3">
      {selected.slice(currentSelectionPage * PAGE, (currentSelectionPage + 1) * PAGE).map((id, localIndex) => { const index = currentSelectionPage * PAGE + localIndex, name = groups.find(group => group.id === id)?.name ?? '已删除的分组'; return <div data-testid="selected-group-row" data-group-id={id} key={id} className="flex items-center gap-3 rounded border p-3 text-sm"><span className="text-xs text-muted-foreground">{index + 1}</span><span className="flex-1">{name}</span><Button size="icon-xs" variant="ghost" aria-label={`上移已选分组 ${name}`} disabled={index === 0 || busy} onClick={() => move(index, -1)}><ArrowUp /></Button><Button size="icon-xs" variant="ghost" aria-label={`下移已选分组 ${name}`} disabled={index === selected.length - 1 || busy} onClick={() => move(index, 1)}><ArrowDown /></Button><Button size="icon-xs" variant="ghost" aria-label={`移除已选分组 ${name}`} onClick={() => toggle(id)}><X /></Button></div>; })}
      <Pager label="已选分组" page={currentSelectionPage} count={selected.length} change={setSelectionPage} />
      {issues.length ? <Alert variant="destructive"><AlertDescription>{issues.slice(0, 3).join('；')}{issues.length > 3 ? `；另有 ${issues.length - 3} 项问题` : ''}。请先编辑分组。</AlertDescription></Alert> : null}
    </CardContent></Card> : null}
    <div className="sticky bottom-0 z-10 flex flex-wrap items-center justify-between gap-3 border-t bg-background/95 py-4"><p className="max-w-xl text-xs leading-5 text-muted-foreground">分组是用例的组合，不会复制用例文件。多个分组按这里的顺序执行，组内按成员顺序执行，重复用例只运行一次。</p><Button disabled={busy || runLocked || !selected.length || !!issues.length} onClick={() => run(selected)}><Play />运行所选分组</Button></div>
    {edit ? <GroupEditor key={edit.id ?? 'new'} project={project} initial={edit} close={() => setEdit(undefined)} refresh={refresh} saved={id => { if (!edit.id && mode === 'graph') { setQuery(''); setRevealGroupId(id); } }} /> : null}
    {deleting ? <Dialog open onOpenChange={open => { if (!open && !busy) setDeleting(undefined); }}><DialogContent showCloseButton={false}><DialogHeader><DialogTitle>删除分组 {deleting.name}？</DialogTitle><DialogDescription>只删除这个分组，用例及其 Workflow 保持不变。</DialogDescription></DialogHeader>{error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}<DialogFooter><Button variant="outline" disabled={busy} onClick={() => setDeleting(undefined)}>保留分组</Button><Button variant="destructive" disabled={busy} onClick={() => void remove()}>确认删除分组</Button></DialogFooter></DialogContent></Dialog> : null}
  </div>;
}
