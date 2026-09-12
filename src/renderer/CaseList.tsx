import { useState, type ReactNode } from 'react';
import { FolderInput, Layers3, LoaderCircle, Play, Trash2 } from 'lucide-react';
import type { BulkCaseOperation, Project, TestCase } from '../shared/workspace.js';
import { attachOverlayScrollbars } from '@/lib/scrollbars';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';

type Kind = BulkCaseOperation['kind'];
const labels: Record<Kind, string> = { delete: '删除用例', moveSuite: '移动到 Suite', addGroup: '加入 Group', removeGroup: '从 Group 移除' };
const columns = 'grid grid-cols-[minmax(180px,1fr)_140px_60px_100px_16px] items-center gap-3';

export function CaseList({ project, cases, blocked, renderCase, empty, onOpen, onRun, onChanged }: {
  project: Project; cases: TestCase[]; blocked: boolean; renderCase: (item: TestCase) => ReactNode;
  empty: ReactNode; onOpen: (item: TestCase) => void; onRun: (ids: string[]) => void; onChanged: () => Promise<void>;
}) {
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [confirmation, setConfirmation] = useState<{ kind: Kind; cases: TestCase[]; groups: NonNullable<Project['groups']> }>();
  const [target, setTarget] = useState(''), [working, setWorking] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const selected = cases.filter(item => selection.has(item.id));
  const unavailable = working || blocked;
  function open(kind: Kind) {
    setConfirmation({ kind, cases: selected, groups: project.groups ?? [] });
    setTarget(''); setError(''); setNotice('');
  }
  async function submit() {
    if (!confirmation || unavailable) return;
    let operation: BulkCaseOperation;
    if (confirmation.kind === 'delete') operation = { kind: 'delete' };
    else if (confirmation.kind === 'moveSuite') operation = { kind: 'moveSuite', suiteId: target };
    else {
      const group = confirmation.groups.find(group => group.id === target);
      if (!group) return;
      operation = { kind: confirmation.kind, groupId: group.id, revision: group.revision };
    }
    setWorking(true); setError('');
    try {
      const result = await window.workspace.bulkCases({ projectId: project.id, cases: confirmation.cases.map(({ id, revision }) => ({ id, revision })), operation });
      setSelection(new Set()); setConfirmation(undefined);
      setNotice(result.warning ?? `已完成「${labels[operation.kind]}」，共 ${result.count} 个用例。`);
      await onChanged();
    } catch (failure) { setError(String(failure)); }
    finally { setWorking(false); }
  }
  const targetGroups = confirmation?.kind === 'removeGroup'
    ? confirmation.groups.filter(group => confirmation.cases.some(item => group.caseIds.includes(item.id)))
    : confirmation?.groups ?? [];
  const targetSuites = project.suites.filter(suite => confirmation?.cases.some(item => item.suiteId !== suite.id));
  return <div className="space-y-3">
    {notice && <p role="status" className="text-sm text-muted-foreground">{notice}</p>}
    <div className="sticky top-[72px] z-20 flex flex-wrap items-center gap-2 rounded-lg border bg-card p-3 shadow-sm" aria-label="用例批量操作">
      <span className="mr-2 text-sm" role="status">已选 {selected.length} 个用例</span>
      <Button size="sm" variant="ghost" disabled={!selected.length || working} onClick={() => setSelection(new Set())}>清空选择</Button>
      <Button size="sm" variant="outline" disabled={!selected.length || unavailable} onClick={() => onRun(selected.map(item => item.id))}><Play />运行所选</Button>
      <Button size="sm" variant="outline" disabled={!selected.length || unavailable} onClick={() => open('moveSuite')}><FolderInput />移动到 Suite</Button>
      <Button size="sm" variant="outline" disabled={!selected.length || unavailable} onClick={() => open('addGroup')}><Layers3 />加入 Group</Button>
      <Button size="sm" variant="outline" disabled={!selected.length || unavailable} onClick={() => open('removeGroup')}>从 Group 移除</Button>
      <Button size="sm" variant="outline" className="text-destructive" disabled={!selected.length || unavailable} onClick={() => open('delete')}><Trash2 />删除所选</Button>
      {blocked && <p className="w-full text-xs text-muted-foreground">请先结束运行、连接或保存 / 放弃录制，再批量操作。</p>}
    </div>
    <Card className="gap-0 overflow-hidden py-0">
      <div ref={attachOverlayScrollbars} className="overflow-x-auto">
        <div className="min-w-[680px]">
          <div className="flex items-center border-b bg-muted/40 text-xs text-muted-foreground">
            <div className="flex w-12 shrink-0 justify-center"><Checkbox aria-label="选择全部筛选结果" disabled={!cases.length || working} checked={selected.length > 0 && selected.length === cases.length ? true : selected.length ? 'indeterminate' : false} onCheckedChange={checked => setSelection(checked ? new Set(cases.map(item => item.id)) : new Set())} /></div>
            <div className={`${columns} flex-1 px-3 py-3`}><span>用例名称</span><span>平台</span><span>优先级</span><span>最近运行</span><span /></div>
          </div>
          {cases.map(item => <div key={item.id} data-testid="case-list-row" className={`flex items-center border-b last:border-b-0 ${selection.has(item.id) ? 'bg-primary/5' : ''}`}>
            <div className="flex w-12 shrink-0 justify-center"><Checkbox aria-label={`选择用例 ${item.name}`} disabled={working} checked={selection.has(item.id)} onCheckedChange={checked => setSelection(current => { const next = new Set(current); if (checked) next.add(item.id); else next.delete(item.id); return next; })} /></div>
            <Button variant="ghost" className={`${columns} h-auto min-w-0 flex-1 rounded-none px-3 py-4 text-left font-normal`} onClick={() => onOpen(item)}>{renderCase(item)}</Button>
          </div>)}
        </div>
      </div>
      {!cases.length && empty}
      <div className="flex flex-wrap justify-between gap-2 border-t px-5 py-3 text-xs text-muted-foreground"><span>{cases.length} 个用例</span><span>全选仅包含当前筛选结果；切换筛选会清空选择。</span></div>
    </Card>
    <Dialog open={!!confirmation} onOpenChange={open => { if (!open && !working) setConfirmation(undefined); }}>
      <DialogContent showCloseButton={!working} className="flex max-h-[calc(100dvh-2rem)] flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="shrink-0 border-b p-5"><DialogTitle>{confirmation && labels[confirmation.kind]}</DialogTitle><DialogDescription>本次操作包含 {confirmation?.cases.length ?? 0} 个用例，请核对后确认。</DialogDescription></DialogHeader>
        <div ref={attachOverlayScrollbars} className="min-h-0 space-y-4 overflow-y-auto p-5">
          {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
          {confirmation?.kind === 'delete' ? <p className="text-sm leading-6">用例目录及其中的 Workflow 文件将被删除，同时从所有 Group 中移除这些用例。运行历史和报告保留。此操作无法在应用内撤销。</p>
            : confirmation?.kind === 'moveSuite' ? <label className="block space-y-2 text-sm"><span>目标 Suite</span><NativeSelect aria-label="目标 Suite" value={target} disabled={working} onChange={event => setTarget(event.target.value)}><NativeSelectOption value="">请选择目标 Suite</NativeSelectOption>{targetSuites.map(suite => <NativeSelectOption key={suite.id} value={suite.id}>{suite.name}</NativeSelectOption>)}</NativeSelect><span className="block text-xs text-muted-foreground">用例将归入所选 Suite，Group 成员关系与运行历史保留。{!targetSuites.length && '请先创建其他 Suite。'}</span></label>
            : <label className="block space-y-2 text-sm"><span>目标 Group</span><NativeSelect aria-label="目标 Group" value={target} disabled={working} onChange={event => setTarget(event.target.value)}><NativeSelectOption value="">请选择目标 Group</NativeSelectOption>{targetGroups.map(group => <NativeSelectOption key={group.id} value={group.id}>{group.name}</NativeSelectOption>)}</NativeSelect><span className="block text-xs text-muted-foreground">{confirmation?.kind === 'addGroup' ? '未加入的用例按列表顺序追加，已有成员不会重复添加。' : '仅移除成员关系，用例及其 Workflow 文件保留。'}{!targetGroups.length && (confirmation?.kind === 'addGroup' ? '请先在 Groups 中创建分组。' : '所选用例尚未加入任何 Group。')}</span></label>}
          <ul className="divide-y rounded-md border text-sm">{confirmation?.cases.map(item => <li className="break-words px-3 py-2" key={item.id}>{item.name}<span className="ml-2 text-xs text-muted-foreground">{project.suites.find(suite => suite.id === item.suiteId)?.name}</span></li>)}</ul>
        </div>
        <DialogFooter className="shrink-0 border-t bg-background p-4"><Button variant="outline" disabled={working} onClick={() => setConfirmation(undefined)}>取消</Button><Button variant={confirmation?.kind === 'delete' ? 'destructive' : 'default'} disabled={unavailable || confirmation?.kind !== 'delete' && !target} onClick={() => void submit()}>{working && <LoaderCircle className="animate-spin" />}{confirmation?.kind === 'delete' ? '确认删除用例' : '确认操作'}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </div>;
}
