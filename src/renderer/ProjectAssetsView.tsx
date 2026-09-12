import { useState } from 'react';
import { parse, stringify } from 'yaml';
import { Plus, Save, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { VariableEditor, type JsonValue } from './VariableEditor';
import { WorkflowEditor, type SharedFlows } from './WorkflowEditor';

export function ProjectAssetsView({ variables, flows, revision, onSave, busy = false }: {
  variables: Record<string, JsonValue>; flows: SharedFlows; revision?: string;
  onSave(value: { variables: Record<string, JsonValue>; flows: SharedFlows; revision?: string }): void | { revision: string } | Promise<void | { revision: string }>; busy?: boolean;
}) {
  const [values, setValues] = useState(variables), [library, setLibrary] = useState(flows);
  const [baseRevision, setBaseRevision] = useState(revision);
  const [selected, setSelected] = useState<string>(), [text, setText] = useState('');
  const [error, setError] = useState(''), [saving, setSaving] = useState(false);
  const [variablesValid, setVariablesValid] = useState(true), [flowValid, setFlowValid] = useState(true);
  const blocked = busy || saving;
  const changedElsewhere = revision !== undefined && baseRevision !== revision;
  function choose(id: string) {
    setSelected(id); setText(stringify({ cases: [{ name: library[id]!.name, steps: library[id]!.steps }] })); setError('');
  }
  function applyFlow(): SharedFlows {
    if (!selected) return library;
    const document = parse(text, { maxAliasCount: 50 });
    if (!document?.cases?.[0] || !Array.isArray(document.cases[0].steps)) throw new Error('共享步骤需要一个有效的步骤列表。');
    for (const key of ['beforeAll', 'beforeEach', 'afterEach', 'afterAll']) if (document[key]?.length) throw new Error('共享步骤本身只保存步骤列表。请将运行前后的共享步骤引用放在用例的相应阶段。');
    return { ...library, [selected]: { name: library[selected]!.name, steps: document.cases[0].steps } };
  }
  function leaveSelection(next?: string) {
    try { const value = applyFlow(); setLibrary(value); setSelected(next); setText(next ? stringify({ cases: [{ name: value[next]!.name, steps: value[next]!.steps }] }) : ''); setError(''); } catch (cause) { setError((cause as Error).message); }
  }
  return <div className="space-y-6">
    <div><h2 className="text-2xl font-semibold">变量与共享步骤</h2><p className="mt-2 text-sm text-muted-foreground">项目默认变量用于所有用例。共享步骤集中维护，运行记录会保存当时使用的完整内容。</p></div>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {changedElsewhere && !saving && <div role="alert" className="space-y-2 rounded-md border p-4 text-sm"><p>项目资产已在其他位置修改。当前草稿仍保留；载入最新内容会替换此草稿。</p><Button type="button" variant="outline" disabled={blocked} onClick={() => { setValues(variables); setLibrary(flows); setBaseRevision(revision); setSelected(undefined); setText(''); setError(''); setFlowValid(true); }}>载入最新项目资产</Button></div>}
    <Card><CardContent className="pt-6"><VariableEditor label="项目默认变量" value={values} onChange={setValues} onValidityChange={setVariablesValid} disabled={blocked} /></CardContent></Card>
    <Card><CardHeader className="flex-row items-center justify-between gap-3"><CardTitle>共享步骤</CardTitle><Button type="button" size="sm" variant="outline" disabled={blocked} onClick={() => {
      try { const value = applyFlow(), id = crypto.randomUUID(); const next = { ...value, [id]: { name: `共享步骤 ${Object.keys(value).length + 1}`, steps: [] } }; setLibrary(next); setSelected(id); setText(stringify({ cases: [{ name: next[id]!.name, steps: [] }] })); setError(''); } catch (cause) { setError((cause as Error).message); }
    }}><Plus />新建共享步骤</Button></CardHeader><CardContent className="space-y-4">
      <div className="flex flex-wrap gap-2">{Object.entries(library).map(([id, flow]) => <Button key={id} type="button" size="sm" variant={selected === id ? 'secondary' : 'outline'} disabled={blocked} onClick={() => selected ? leaveSelection(id) : choose(id)}>{flow.name}</Button>)}</div>
      {!Object.keys(library).length && <p className="text-sm text-muted-foreground">例如，把进入知识库页面的操作保存为共享步骤。</p>}
      {selected && library[selected] && <div className="space-y-4 rounded-md border p-4"><div className="flex gap-2"><Input aria-label="共享步骤名称" disabled={blocked} value={library[selected]!.name} onChange={event => setLibrary(value => ({ ...value, [selected]: { ...value[selected]!, name: event.target.value } }))} /><Button type="button" size="icon" variant="ghost" disabled={blocked} aria-label="删除当前共享步骤" onClick={() => { setLibrary(value => Object.fromEntries(Object.entries(value).filter(([id]) => id !== selected))); setSelected(undefined); setText(''); setFlowValid(true); }}><Trash2 /></Button></div><WorkflowEditor key={selected} scope="shared-flow" onValidityChange={setFlowValid} text={text} onChange={setText} disabled={blocked} flows={Object.fromEntries(Object.entries(library).filter(([id]) => id !== selected))} /></div>}
    </CardContent></Card>
    <div className="sticky bottom-0 flex justify-end border-t bg-background/95 py-4"><Button type="button" disabled={blocked || !variablesValid || !flowValid || changedElsewhere} onClick={async () => { setError(''); setSaving(true); try { const result = applyFlow(); const saved = await onSave({ variables: values, flows: result, revision: baseRevision }); if (saved) setBaseRevision(saved.revision); setLibrary(result); } catch (cause) { setError((cause as Error).message); } finally { setSaving(false); } }}><Save />{saving ? '正在保存…' : '保存项目资产'}</Button></div>
  </div>;
}
