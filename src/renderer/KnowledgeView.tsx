import { useEffect, useState } from 'react';
import { Plus, Save } from 'lucide-react';
import type { KnowledgeEntry, KnowledgeSnapshot } from '../shared/knowledge.js';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';

export function KnowledgeView({ projectId }: { projectId: string }) {
  const [base, setBase] = useState<KnowledgeSnapshot>(), [entries, setEntries] = useState<KnowledgeEntry[]>([]);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [saved, setSaved] = useState(false);
  const load = async () => { try { const result = await window.workspace.knowledge({ projectId }); setBase(result); setEntries(result.entries); setError(''); } catch (cause) { setError(String(cause)); } };
  useEffect(() => { void load(); }, [projectId]);
  const patch = (id: string, change: Partial<KnowledgeEntry>) => { setSaved(false); setEntries(current => current.map(entry => entry.id === id ? { ...entry, ...change, updatedAt: new Date().toISOString() } : entry)); };
  return <div className="space-y-5" data-testid="knowledge-view">
    <p className="text-sm text-muted-foreground">知识按项目保存。AI 先看名称和别名，只读取选中的已确认知识。自动生成的知识保留为草稿，请核实后确认。</p>
    {error && <div role="alert" className="space-y-2 text-destructive"><p>{error}</p><Button variant="outline" onClick={() => void load()}>重新加载知识库（替换当前草稿）</Button></div>}
    {entries.map(entry => <section key={entry.id} className="space-y-3 rounded-lg border bg-card p-5">
      <div className="flex flex-wrap items-center gap-3"><Input aria-label={`知识名称 ${entry.id}`} value={entry.title} onChange={event => patch(entry.id, { title: event.target.value })} disabled={busy} /><NativeSelect aria-label={`知识状态 ${entry.title}`} value={entry.status} onChange={event => patch(entry.id, { status: event.target.value as KnowledgeEntry['status'] })}><NativeSelectOption value="draft">待确认草稿</NativeSelectOption><NativeSelectOption value="confirmed">已确认，可供 AI 使用</NativeSelectOption></NativeSelect></div>
      <label className="block space-y-1 text-sm"><span>别名（逗号分隔）</span><Input aria-label={`知识别名 ${entry.title}`} value={entry.aliases.join(', ')} disabled={busy} onChange={event => patch(entry.id, { aliases: event.target.value.split(/[,，]/).map(value => value.trim()).filter(Boolean) })} /></label>
      <label className="block space-y-1 text-sm"><span>导航方法、前置条件或业务说明</span><Textarea aria-label={`知识内容 ${entry.title}`} value={entry.content} disabled={busy} className="min-h-28" onChange={event => patch(entry.id, { content: event.target.value })} /></label>
      <p className="text-xs text-muted-foreground">来源：{entry.source === 'ai' ? 'AI 提炼，尚不代表经过试跑验证' : '人工维护'} · {entry.updatedAt}</p>
    </section>)}
    {!entries.length && base && <p className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">例如：名称“Agent 列表”，说明“从首页点击我的 Agent，等待 Agent 列表标题出现”。</p>}
    <div className="flex flex-wrap gap-3"><Button variant="outline" disabled={!base || busy} onClick={() => setEntries(current => [...current, { id: crypto.randomUUID(), title: '', aliases: [], content: '', source: 'manual', status: 'draft', updatedAt: new Date().toISOString() }])}><Plus />添加知识</Button><Button disabled={!base || busy || entries.some(entry => !entry.title.trim() || !entry.content.trim())} onClick={async () => { setBusy(true); setError(''); try { const result = await window.workspace.saveKnowledge({ projectId, revision: base!.revision, entries }); setBase(result); setEntries(result.entries); setSaved(true); } catch (cause) { setError(String(cause)); } finally { setBusy(false); } }}><Save />保存知识库</Button>{saved && <span role="status" className="self-center text-sm">知识库已保存</span>}</div>
  </div>;
}
