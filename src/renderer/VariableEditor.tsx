import { useEffect, useRef, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { validateVariables } from '../shared/workflow-document.js';

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
interface VariableRow { id: string; key: string; text: string; type: 'text' | 'number' | 'boolean' | 'json' }
const rowsFor = (value: Record<string, JsonValue>): VariableRow[] => Object.entries(value).map(([key, item]) => ({
  id: crypto.randomUUID(), key, text: typeof item === 'string' ? item : JSON.stringify(item),
  type: typeof item === 'string' ? 'text' : typeof item === 'number' ? 'number' : typeof item === 'boolean' ? 'boolean' : 'json',
}));
export function VariableEditor({ value, onChange, disabled, label = '变量', onValidityChange }: {
  value: Record<string, JsonValue>; onChange(value: Record<string, JsonValue>): void; disabled?: boolean; label?: string; onValidityChange?(valid: boolean): void;
}) {
  const [rows, setRows] = useState(() => rowsFor(value));
  const previous = useRef(JSON.stringify(value));
  useEffect(() => {
    const incoming = JSON.stringify(value);
    if (incoming !== previous.current) { previous.current = incoming; setRows(rowsFor(value)); }
  }, [value]);
  const validate = (items: VariableRow[]) => {
    const result: Record<string, JsonValue> = Object.create(null);
    for (const row of items) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(row.key)) throw new Error('变量名只能包含字母、数字和下划线，且不能以数字开头。');
      if (Object.hasOwn(result, row.key)) throw new Error(`变量名重复：${row.key}`);
      let parsed: JsonValue = row.text;
      if (row.type !== 'text') {
        try { parsed = JSON.parse(row.text); } catch { throw new Error(`${row.key} 的值不是有效的 ${row.type === 'json' ? 'JSON' : row.type === 'number' ? '数字' : '布尔值'}。`); }
        if (row.type === 'number' && (typeof parsed !== 'number' || !Number.isFinite(parsed))) throw new Error(`${row.key} 需要填写有限数字。`);
        if (row.type === 'boolean' && typeof parsed !== 'boolean') throw new Error(`${row.key} 需要填写 true 或 false。`);
      }
      result[row.key] = parsed;
    }
    return validateVariables(result);
  };
  let error = '';
  try { validate(rows); } catch (cause) { error = String((cause as Error).message); }
  useEffect(() => { onValidityChange?.(!error); }, [error, onValidityChange]);
  function update(next: VariableRow[]) {
    setRows(next);
    try { const result = validate(next); previous.current = JSON.stringify(result); onChange(result); } catch { /* Keep the user's incomplete input until it is valid. */ }
  }
  function patch(id: string, patch: Partial<VariableRow>) { update(rows.map(row => row.id === id ? { ...row, ...patch } : row)); }
  return <section className="space-y-3" aria-label={label}>
    <div className="flex flex-wrap items-center justify-between gap-2"><h4 className="text-sm font-medium">{label}</h4><Button type="button" size="sm" variant="outline" disabled={disabled} onClick={() => {
      let index = rows.length + 1; while (rows.some(row => row.key === `variable${index}`)) index++;
      update([...rows, { id: crypto.randomUUID(), key: `variable${index}`, text: '', type: 'text' }]);
    }}><Plus />添加变量</Button></div>
    <p className="text-xs text-muted-foreground">在步骤的文字中使用 {'${变量名}'}。运行前可以覆盖变量值。</p>
    {rows.map((row, index) => <div key={row.id} className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)_auto] items-start gap-2 rounded-md border p-3 sm:grid-cols-[minmax(0,1fr)_110px_minmax(0,2fr)_auto]">
      <Input aria-label={`${label}名称 ${index + 1}`} placeholder="例如 knowledgeBaseName" value={row.key} disabled={disabled} onChange={event => patch(row.id, { key: event.target.value })} />
      <NativeSelect aria-label={`${label}类型 ${index + 1}`} value={row.type} disabled={disabled} onChange={event => patch(row.id, { type: event.target.value as VariableRow['type'] })}><NativeSelectOption value="text">文本</NativeSelectOption><NativeSelectOption value="number">数字</NativeSelectOption><NativeSelectOption value="boolean">布尔值</NativeSelectOption><NativeSelectOption value="json">JSON</NativeSelectOption></NativeSelect>
      <Input aria-label={`${label}值 ${index + 1}`} className="col-span-2 sm:col-span-1" value={row.text} disabled={disabled} onChange={event => patch(row.id, { text: event.target.value })} />
      <Button type="button" size="icon-sm" variant="ghost" aria-label={`删除变量 ${row.key}`} disabled={disabled} onClick={() => update(rows.filter(item => item.id !== row.id))}><Trash2 /></Button>
    </div>)}
    {!rows.length && <p className="text-sm text-muted-foreground">尚未设置变量。</p>}
    {error && <p role="alert" className="text-sm text-destructive">{error} 当前输入尚未应用。</p>}
  </section>;
}
