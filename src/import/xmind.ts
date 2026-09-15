import { Inflate } from 'fflate';
import type { SourceNode, SourceRef } from '../shared/case-spec.js';
import { contentHash, parseMarkdown, type ParsedImport } from './markdown.js';

const MAX_FILE = 5 * 1024 * 1024, MAX_EXPANDED = 20 * 1024 * 1024;
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); }
  return (crc ^ 0xffffffff) >>> 0;
}
function readArchive(bytes: Uint8Array): { content: string; names: string[] } {
  if (bytes.length > MAX_FILE) throw new Error('XMind 压缩文件不能超过 5 MB');
  if (bytes.length < 22) throw new Error('XMind 压缩包已损坏');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (offset: number) => view.getUint16(offset, true), u32 = (offset: number) => view.getUint32(offset, true);
  let end = -1;
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65557); offset--) if (u32(offset) === 0x06054b50 && offset + 22 + u16(offset + 20) === bytes.length) { end = offset; break; }
  if (end < 0) throw new Error('XMind ZIP 目录损坏或缺失');
  const count = u16(end + 10), directorySize = u32(end + 12), start = u32(end + 16);
  if (u16(end + 4) || u16(end + 6) || u16(end + 8) !== count || count === 65535 || start === 0xffffffff) throw new Error('不支持分卷或 ZIP64 XMind 文件');
  if (count > 200) throw new Error('XMind 压缩包条目不能超过 200 个');
  if (start + directorySize !== end) throw new Error('XMind ZIP 目录大小无效');
  const entries: { name: string; packed: number; size: number; method: number; offset: number; crc: number; flags: number }[] = [];
  const names = new Set<string>();
  let total = 0, cursor = start;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > end || u32(cursor) !== 0x02014b50) throw new Error('XMind ZIP 条目损坏');
    const length = u16(cursor + 28), extra = u16(cursor + 30), comment = u16(cursor + 32);
    if (cursor + 46 + length + extra + comment > end) throw new Error('XMind ZIP 文件名损坏');
    const name = decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + length));
    if (!name || name.includes('\\') || name.includes('\0') || name.startsWith('/') || /^[A-Za-z]:/.test(name) || name.split('/').some(part => part === '..' || part === '.') || name.split('/').length > 30) throw new Error(`XMind 压缩包包含不安全的路径：${name.slice(0, 100)}`);
    if (names.has(name)) throw new Error(`XMind 压缩包包含重复条目：${name}`);
    names.add(name);
    const entry = { name, packed: u32(cursor + 20), size: u32(cursor + 24), method: u16(cursor + 10), offset: u32(cursor + 42), crc: u32(cursor + 16), flags: u16(cursor + 8) };
    total += entry.size;
    if (total > MAX_EXPANDED) throw new Error('XMind 解压后总大小不能超过 20 MB');
    if (entry.flags & 1 || ![0, 8].includes(entry.method)) throw new Error(`XMind 条目使用了不支持的加密或压缩方式：${name}`);
    if (entry.offset + 30 > start || u32(entry.offset) !== 0x04034b50) throw new Error('XMind ZIP 本地条目损坏');
    const localNameLength = u16(entry.offset + 26), localExtra = u16(entry.offset + 28);
    const dataStart = entry.offset + 30 + localNameLength + localExtra;
    if (dataStart + entry.packed > start || u16(entry.offset + 8) !== entry.method || decoder.decode(bytes.subarray(entry.offset + 30, entry.offset + 30 + localNameLength)) !== name) throw new Error('XMind ZIP 条目信息不一致');
    entries.push({ ...entry, offset: dataStart });
    cursor += 46 + length + extra + comment;
  }
  if (cursor !== end) throw new Error('XMind ZIP 目录条目数量不一致');
  const content = entries.find(entry => entry.name === 'content.json');
  if (!content) throw new Error(names.has('content.xml') ? '暂不支持 XMind 8 / XML 格式，请用新版 XMind 另存为包含 content.json 的 .xmind 文件' : 'XMind 文件缺少 content.json，仅支持现代 JSON 格式');
  const packed = bytes.subarray(content.offset, content.offset + content.packed);
  let data: Uint8Array = packed;
  if (content.method === 8) {
    // Feed small compressed chunks and check actual output, including dishonest size declarations.
    // This bounds both memory growth and how much a decompression bomb can expand before rejection.
    const parts: Uint8Array[] = [];
    let expanded = 0;
    const stream = new Inflate(chunk => {
      expanded += chunk.length;
      if (expanded > content.size || expanded > MAX_EXPANDED) throw new Error('XMind 实际解压大小超过声明或 20 MB 限制');
      parts.push(chunk);
    });
    for (let index = 0; index < packed.length; index += 1024) stream.push(packed.subarray(index, index + 1024), index + 1024 >= packed.length);
    data = new Uint8Array(expanded);
    let offset = 0;
    for (const part of parts) { data.set(part, offset); offset += part.length; }
  }
  if (data.length !== content.size || crc32(data) !== content.crc) throw new Error('XMind content.json 大小或校验和不一致，文件可能已损坏');
  return { content: decoder.decode(data), names: [...names] };
}
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
export function parseXmind(bytes: Uint8Array, name: string): ParsedImport {
  let archive: ReturnType<typeof readArchive>;
  try { archive = readArchive(bytes); } catch (error) { throw new Error(error instanceof Error ? error.message : 'XMind 压缩包已损坏'); }
  let input: unknown;
  try { input = JSON.parse(archive.content); } catch { throw new Error('XMind content.json 不是有效的 JSON'); }
  if (!Array.isArray(input) || !input.length) throw new Error('XMind content.json 必须包含画布列表');
  const warnings: string[] = [], tree: SourceNode[] = [], ids = new Set<string>();
  let count = 0;
  const walk = (value: unknown, depth: number): SourceNode => {
    if (depth > 30 || ++count > 5000) throw new Error('XMind 不能超过 30 层或 5000 个节点');
    if (!record(value) || typeof value.title !== 'string') throw new Error('XMind 节点缺少文字标题，暂不支持此节点结构');
    if (typeof value.id !== 'string' || !value.id || value.id.length > 200) throw new Error('XMind 节点缺少有效的节点 ID');
    if (ids.has(value.id)) throw new Error(`XMind 节点 ID 重复：${value.id}`);
    ids.add(value.id);
    const supported = new Set(['id', 'title', 'children', 'class', 'style', 'structureClass', 'titleUnedited', 'position', 'width', 'height', 'extensions', 'attributedTitle']);
    for (const key of Object.keys(value)) if (!supported.has(key)) warnings.push(`节点 ${value.id}（${value.title.slice(0, 60)}）的 ${key} 内容尚未转换，请核对原文件。`);
    if (value.attributedTitle || value.extensions) warnings.push(`节点 ${value.id} 包含富文本或扩展信息，仅使用纯文字标题，请核对原文件。`);
    const node: SourceNode = { id: value.id, title: value.title, children: [] };
    if (value.children !== undefined && !record(value.children)) throw new Error(`节点 ${value.id} 的 children 结构不支持`);
    for (const [kind, children] of Object.entries(value.children ?? {})) {
      if (!Array.isArray(children)) throw new Error(`节点 ${value.id} 的 ${kind} 子节点不是列表`);
      if (kind !== 'attached') warnings.push(`节点 ${value.id} 的 ${kind} 子节点已保留在树中，需人工确认用例边界。`);
      node.children.push(...children.map(child => walk(child, depth + 1)));
    }
    return node;
  };
  for (const sheet of input) {
    if (!record(sheet) || !sheet.rootTopic) throw new Error('XMind 画布缺少 rootTopic');
    for (const key of Object.keys(sheet)) if (!['id', 'title', 'rootTopic', 'class', 'theme', 'topicPositioning', 'style', 'extensions'].includes(key)) warnings.push(`画布 ${String(sheet.title ?? sheet.id)} 的 ${key} 内容尚未转换，请核对原文件。`);
    tree.push(walk(sheet.rootTopic, 1));
  }
  for (const file of archive.names) if (!['content.json', 'metadata.json', 'manifest.json', 'Thumbnails/thumbnail.png', 'thumbnail.png'].includes(file) && !file.endsWith('/')) warnings.push(`附件 ${file} 未转换为用例内容，请核对原文件。`);
  const lines: string[] = [], nodeByLine = new Map<number, string>(), casePaths = new Map<string, string[]>();
  const ambiguousNodes = new Map<string, string[]>();
  const emit = (text: string, node: SourceNode) => { lines.push(text); nodeByLine.set(lines.length, node.id); };
  const isSection = (title: string) => /^(?:前置条件|测试数据|步骤|测试步骤|预期结果)[：:]?$/.test(title.trim());
  const render = (node: SourceNode, path: string[]) => {
    const candidate = /^\[[^\]]+\]/.test(node.title) || node.children.some(child => /^(?:步骤|测试步骤)[：:]?$/.test(child.title.trim()));
    if (candidate) {
      casePaths.set(node.id, path);
      const ambiguities: string[] = [];
      ambiguousNodes.set(node.id, ambiguities);
      if (path.length) emit(`# ${path.join(' / ')}`, node);
      emit(`## ${node.title.replace(/\n/g, ' ')}`, node);
      for (const child of node.children) {
        if (!isSection(child.title)) { emit(`- ${child.title}`, child); warnings.push(`节点 ${child.id} 不属于模板字段，请补充到用例对应位置。`); ambiguities.push(child.id); }
        else emit(`- ${child.title.replace(/[：:]$/, '')}：`, child);
        const flatten = (current: SourceNode, depth: number, order: number) => {
          emit(`${'  '.repeat(depth)}${/^(?:步骤|测试步骤)/.test(child.title) && depth === 1 ? `${order}.` : '-'} ${current.title.replace(/\n/g, '\n    ')}`, current);
          if (current.children.length) { warnings.push(`节点 ${current.id} 的嵌套内容已按顺序保留，请确认步骤或断言边界。`); ambiguities.push(current.id); }
          current.children.forEach((nested, index) => flatten(nested, depth + 1, index + 1));
        };
        child.children.forEach((nested, index) => flatten(nested, 1, index + 1));
      }
      emit('', node);
    } else {
      // Free maps are retained as trees; only nodes with explicit case boundaries enter the deterministic parser.
      for (const child of node.children) render(child, [...path, node.title]);
    }
  };
  for (const root of tree) render(root, []);
  const parsed = parseMarkdown(lines.join('\n'), name);
  const id = contentHash(bytes);
  const source = (ref: SourceRef) => { const nodeId = ref.line ? nodeByLine.get(ref.line) : undefined; ref.documentId = id; delete ref.line; delete ref.endLine; if (nodeId) ref.nodeId = nodeId; };
  for (const spec of parsed.cases) {
    source(spec.ref);
    if (spec.ref.nodeId) {
      spec.path = casePaths.get(spec.ref.nodeId) ?? spec.path;
      for (const nodeId of ambiguousNodes.get(spec.ref.nodeId) ?? []) spec.questions.push({ code: `xmind-boundary-${nodeId}`, message: `节点 ${nodeId} 包含嵌套内容或非模板字段，请对照左侧树确认用例与步骤边界`, blocks: 'generation' });
    }
    for (const item of [...spec.preconditions, ...spec.data, ...spec.steps, ...spec.expectations]) source(item.ref);
  }
  if (!parsed.cases.length) warnings.push('未识别明确的用例边界，请使用 AI 辅助识别并审查；系统没有把所有叶子节点自动当作用例。');
  return { document: { id, name, format: 'xmind', text: archive.content, tree, warnings: [...parsed.document.warnings, ...warnings] }, cases: parsed.cases, needsAI: parsed.needsAI || warnings.some(warning => /边界|嵌套|不属于模板/.test(warning)) };
}
