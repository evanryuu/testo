import { createHash } from 'node:crypto';
import { caseSpecsSchema, type CaseSpec, type ImportDocument, type SourceRef, type ParsedImport } from '../shared/case-spec.js';
import { assertNoImportCredentials } from './privacy.js';

export type { ParsedImport } from '../shared/case-spec.js';
export function contentHash(text: string | Uint8Array): string { return createHash('sha256').update(text).digest('hex'); }
type Section = 'preconditions' | 'data' | 'steps' | 'expectations';
function preconditionKind(text: string): CaseSpec['preconditions'][number]['kind'] {
  if (/^(打开|访问|导航至|退出登录)/.test(text)) return 'action';
  if (/^(确认|检查|验证|等待)/.test(text) || /^(?:(?:当前)?(?:用户|账号)?(?:仍)?(?:处于)?)?(?:已登录|未登录)(?:状态)?$/.test(text)) return 'check';
  return 'manual';
}
const sections: Record<string, Section> = { 前置条件: 'preconditions', 测试数据: 'data', 步骤: 'steps', 测试步骤: 'steps', 预期结果: 'expectations', Preconditions: 'preconditions', Data: 'data', Steps: 'steps', Expected: 'expectations' };
function section(text: string): { kind: Section; rest: string } | undefined {
  const normalized = text.replace(/^#{1,6}\s+/, '').replace(/^[-*+]\s+/, '').replace(/\*\*/g, '').trim();
  const match = /^([^：:]+)[：:]?\s*(.*)$/.exec(normalized);
  const kind = match && sections[match[1]!.trim()];
  return kind ? { kind, rest: match![2]!.trim() } : undefined;
}
export function parseMarkdown(text: string, name = 'document.md'): ParsedImport {
  if (Buffer.byteLength(text, 'utf8') > 5 * 1024 * 1024) throw new Error('Markdown 文件不能超过 5 MB');
  assertNoImportCredentials(text);
  const document: ImportDocument = { id: contentHash(text), name, format: 'markdown', text, warnings: [] };
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const headings: { line: number; depth: number; text: string }[] = [];
  const ignored = new Set<number>();
  let fence: string | undefined;
  for (const [index, line] of lines.entries()) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (marker) { if (!fence) fence = marker[1]![0]; else if (fence === marker[1]![0]) fence = undefined; ignored.add(index); continue; }
    if (fence) { ignored.add(index); continue; }
    const heading = /^\s{0,3}(#{1,6})\s+(.+?)(?:\s+#+\s*)?$/.exec(line);
    if (heading) headings.push({ line: index, depth: heading[1]!.length, text: heading[2]! });
  }
  if (ignored.size) document.warnings.push('代码块仅保留在原文中，不会作为操作执行；请审查代码块中的测试信息。');
  if (/<\/?[A-Za-z][^>]*>/.test(text)) document.warnings.push('原文包含 HTML，仅按文字展示，不执行 HTML 或脚本。');
  const candidates = headings.filter((heading, index) => {
    if (section(heading.text)) return false;
    if (/^\[[^\]]+\]/.test(heading.text)) return true;
    const next = headings.slice(index + 1).find(item => item.depth <= heading.depth || !section(item.text));
    const end = next?.line ?? lines.length;
    return lines.slice(heading.line + 1, end).some(line => section(line)?.kind === 'steps');
  });
  const cases: CaseSpec[] = [];
  for (const [caseIndex, heading] of candidates.entries()) {
    const boundary = headings.find(item => item.line > heading.line && item.depth <= heading.depth);
    const end = Math.min(boundary?.line ?? lines.length, candidates[caseIndex + 1]?.line ?? lines.length);
    const titleMatch = /^\[([^\]]+)\]\s*(.*)$/.exec(heading.text);
    const sourceId = titleMatch?.[1];
    const title = titleMatch ? titleMatch[2]! : heading.text;
    const ref = (line: number): SourceRef => ({ documentId: document.id, line: line + 1, endLine: line + 1 });
    const ancestors: typeof headings = [];
    for (const previous of headings.filter(item => item.line < heading.line)) {
      while (ancestors.length && ancestors.at(-1)!.depth >= previous.depth) ancestors.pop();
      ancestors.push(previous);
    }
    const spec: CaseSpec = { id: `case-${contentHash(`${sourceId ?? ''}\n${lines.slice(heading.line, end).join('\n')}`).slice(0, 24)}`, ...(sourceId ? { sourceId } : {}), title, description: '', path: ancestors.filter(item => item.depth < heading.depth).map(item => item.text), priority: 'P1', tags: [], origin: 'source', ref: { ...ref(heading.line), endLine: end }, preconditions: [], data: [], steps: [], expectations: [], questions: [] };
    let current: Section | undefined;
    let last: { text?: string; value?: string; ref: SourceRef } | undefined;
    const add = (kind: Section, value: string, index: number) => {
      if (!value.trim()) return;
      const sourced = { text: value.trim(), origin: 'source' as const, ref: ref(index) };
      if (kind === 'preconditions') {
        const parts = value.split(/[，,；;]/).map(part => part.trim()).filter(Boolean);
        // Split only when every clause has a clear preparation meaning; ambiguous sentences stay intact.
        const unambiguous = parts.length > 1 && parts.every(part => preconditionKind(part) !== 'manual');
        for (const text of unambiguous ? parts : [value.trim()]) {
          const item: CaseSpec['preconditions'][number] = { id: `${spec.id}-pre-${spec.preconditions.length + 1}`, ...sourced, text, ref: ref(index), kind: !unambiguous && parts.length > 1 ? 'manual' : preconditionKind(text) };
          spec.preconditions.push(item); last = item;
        }
      } else if (kind === 'data') {
        const match = /^([^：:]+)[：:]\s*(.*)$/.exec(value);
        const item = { name: match?.[1]?.trim() ?? `数据 ${spec.data.length + 1}`, value: match?.[2] ?? value, origin: 'source' as const, ref: ref(index) };
        spec.data.push(item); last = item;
      } else if (kind === 'steps') {
        const flow = /^(?:共享流程|useFlow)[：:]\s*(.+)$/.exec(value);
        const item: CaseSpec['steps'][number] = { id: `${spec.id}-step-${spec.steps.length + 1}`, ...sourced, kind: flow ? 'flow' : /^等待/.test(value) ? 'wait' : 'action', ...(flow ? { flowId: flow[1]!.trim() } : {}) };
        spec.steps.push(item); last = item;
      } else {
        const item: CaseSpec['expectations'][number] = { id: `${spec.id}-expected-${spec.expectations.length + 1}`, ...sourced, kind: /^(?:页面显示|页面包含|显示文本|可见文本)\s*[“"「].+[”"」]$/.test(value) ? 'text' : 'semantic' };
        spec.expectations.push(item); last = item;
      }
    };
    for (let index = heading.line + 1; index < end; index++) {
      if (ignored.has(index)) continue;
      const line = lines[index]!;
      if (!line.trim()) continue;
      const label = section(line);
      if (label) { current = label.kind; last = undefined; add(current, label.rest, index); continue; }
      const list = /^\s*(?:[-*+]\s+|\d+[.)]\s+)(.*)$/.exec(line);
      if (current && list) { add(current, list[1]!, index); continue; }
      if (current && last && /^\s{2,}\S/.test(line)) {
        if (last.text !== undefined) last.text += `\n${line.trim()}`; else last.value += `\n${line.trim()}`;
        last.ref.endLine = index + 1; continue;
      }
      if (/^\s*#/.test(line)) { current = undefined; last = undefined; }
      spec.description += `${spec.description ? '\n' : ''}${line.trim()}`;
      if (current) spec.questions.push({ code: `unstructured-${index + 1}`, message: `第 ${index + 1} 行不是可识别的列表，请补充到对应字段：${line.trim().slice(0, 120)}`, blocks: 'generation' });
    }
    cases.push(spec);
  }
  const seen = new Set<string>();
  for (const spec of cases) {
    if (seen.has(spec.id)) spec.id += `-${cases.indexOf(spec) + 1}`;
    seen.add(spec.id);
  }
  return { document, cases: caseSpecsSchema.parse(cases), needsAI: cases.length === 0 || cases.some(spec => spec.questions.some(issue => issue.code.startsWith('unstructured-'))) };
}
