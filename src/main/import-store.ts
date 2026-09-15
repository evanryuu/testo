import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parse, stringify } from 'yaml';
import { z } from 'zod/v4';
import { caseSpecsSchema } from '../shared/case-spec.js';
import type { CaseSpec, ImportDocument, ImportDraft, ImportDraftSnapshot, ImportedCaseSource, SourceNode } from '../shared/case-spec.js';
import { validateVariables } from '../shared/workflow-document.js';
import { validateWorkflow } from './workflow-validation.js';
import { WorkspaceStore } from './workspace.js';
import { assertNoImportCredentials } from '../import/privacy.js';
import { caseIssues } from '../import/compiler.js';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const idSchema = z.uuid();
const short = z.string().max(500);
const nodeSchema: z.ZodType<SourceNode> = z.lazy(() => z.strictObject({ id: z.string().max(200), title: z.string().max(10000), children: z.array(nodeSchema).max(2000) }));
const documentSchema = z.strictObject({ id: z.string().min(1).max(100), name: short, format: z.enum(['markdown', 'xmind']), text: z.string().max(2_000_000), tree: z.array(nodeSchema).max(2000).optional(), warnings: z.array(z.string().max(2000)).max(200) });
const draftSchema = z.strictObject({
  id: idSchema, document: documentSchema, mode: z.enum(['existing', 'design']), cases: caseSpecsSchema,
  selectedIds: z.array(z.string().min(1).max(100)).max(200),
  workflows: z.record(z.string().min(1).max(100), z.strictObject({ text: z.string().max(200000), specHash: z.string().regex(/^[a-f0-9]{64}$/), edited: z.boolean() })),
  variables: z.record(z.string(), z.unknown()), suiteId: short, newSuiteName: z.string().max(200).optional(),
  saved: z.record(z.string().min(1).max(100), z.strictObject({ caseId: idSchema, workflowId: idSchema, fingerprint: z.string().regex(/^[a-f0-9]{64}$/) })),
});

/** All import paths are resolved from the real project root and reject symlinks, including dangling ones. */
export function importFile(root: string, relative: string): string {
  const realRoot = realpathSync(root), file = path.resolve(realRoot, relative), rel = path.relative(realRoot, file);
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new Error('导入文件路径不能超出项目目录');
  let candidate = realRoot;
  for (const part of rel.split(path.sep).filter(Boolean)) {
    candidate = path.join(candidate, part);
    try { if (lstatSync(candidate).isSymbolicLink()) throw new Error('导入文件路径不能包含符号链接'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  return file;
}
function readText(root: string, relative: string): string | undefined {
  const file = importFile(root, relative);
  try {
    if (lstatSync(file).size > 12 * 1024 * 1024) throw new Error('导入文件超过 12 MB');
    return readFileSync(file, 'utf8');
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}
function writeAtomic(root: string, relative: string, text: string): void {
  const file = importFile(root, relative);
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try { writeFileSync(temporary, text, { mode: 0o600, flag: 'wx' }); renameSync(temporary, file); }
  finally { try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } }
}
function json(value: unknown): string { return JSON.stringify(value, null, 2) + '\n'; }
function secretCheck(value: string): void {
  assertNoImportCredentials(value);
  // Only reject explicit assignments, not ordinary instructions such as "enter password".
  const assignment = /(?:password|passwd|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|token|cookie|authorization|密码)\s*["']?\s*[:=：]\s*["']?([^\s"',;\n]+)/gi;
  for (const match of value.matchAll(assignment)) {
    if (!/^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(match[1]!)) throw new Error('导入内容包含明文密码、Token 或 Cookie，请替换为 ${变量名} 后再保存');
  }
}
export function validateImportDraft(value: unknown): ImportDraft {
  // Cap serialized input before recursive schema validation, including tree depth.
  const serialized = JSON.stringify(value);
  if (!serialized || Buffer.byteLength(serialized) > 10_000_000) throw new Error('导入草稿超过大小上限');
  if (value && typeof value === 'object' && 'document' in value && value.document && typeof value.document === 'object' && 'tree' in value.document && Array.isArray(value.document.tree)) {
    const pending = value.document.tree.map(node => ({ node, depth: 1 }));
    let count = 0;
    while (pending.length) {
      const { node, depth } = pending.pop()!;
      if (++count > 10000 || depth > 50) throw new Error('导入文档树超过节点或层级上限');
      if (node && typeof node === 'object' && Array.isArray(node.children)) pending.push(...node.children.map((child: unknown) => ({ node: child, depth: depth + 1 })));
    }
  }
  const parsed = draftSchema.safeParse(value);
  if (!parsed.success) throw new Error(`导入草稿格式无效：${parsed.error.issues[0]?.message}`);
  const draft = parsed.data as ImportDraft;
  const ids = new Set(draft.cases.map(spec => spec.id));
  if (ids.size !== draft.cases.length || new Set(draft.selectedIds).size !== draft.selectedIds.length) throw new Error('导入用例 ID 不能重复');
  if ([...draft.selectedIds, ...Object.keys(draft.workflows), ...Object.keys(draft.saved)].some(id => !ids.has(id) || ['__proto__', 'constructor', 'prototype'].includes(id))) throw new Error('导入草稿引用了不存在的用例');
  for (const spec of draft.cases) {
    const refs = [spec.ref, ...[...spec.preconditions, ...spec.data, ...spec.steps, ...spec.expectations].map(item => item.ref)];
    if (refs.some(ref => ref.documentId !== draft.document.id)) throw new Error('用例来源不属于当前导入文档');
    const stepIds = new Set(spec.steps.map(step => step.id));
    if (stepIds.size !== spec.steps.length || spec.expectations.some(expectation => expectation.afterStepId && !stepIds.has(expectation.afterStepId))) throw new Error('用例步骤引用无效');
  }
  draft.variables = validateVariables(draft.variables);
  secretCheck(draft.document.text);
  for (const spec of draft.cases) {
    for (const text of [spec.title, spec.description, ...spec.preconditions.map(item => item.text), ...spec.steps.map(item => item.text), ...spec.expectations.map(item => item.text)]) secretCheck(text);
    for (const item of spec.data) if (/password|passwd|token|cookie|api.?key|密码/i.test(item.name) && !/^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(item.value)) throw new Error('敏感测试数据必须使用 ${变量名}');
  }
  for (const workflow of Object.values(draft.workflows)) secretCheck(workflow.text);
  for (const [name, value] of Object.entries(draft.variables)) if (/password|passwd|token|cookie|api.?key|密码/i.test(name) && (typeof value !== 'string' || !/^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(value))) throw new Error('敏感变量值请在运行环境配置，不能保存在导入草稿中');
  return draft;
}
export function importedCaseFingerprint(_document: ImportDocument, spec: CaseSpec): string {
  return hash(JSON.stringify({ title: spec.title, description: spec.description, path: spec.path, preconditions: spec.preconditions.map(item => [item.kind, item.text]), data: spec.data.map(item => [item.name, item.value]), steps: spec.steps.map(item => [item.kind, item.text, item.flowId]), expectations: spec.expectations.map(item => [item.kind, item.text]) }));
}
const sourceKey = (document: ImportDocument, spec: CaseSpec) => {
  const sourceId = spec.sourceId || spec.ref.nodeId;
  return sourceId ? JSON.stringify([document.format, document.name, sourceId]) : undefined;
};
interface Transaction {
  version: 1; state: 'applying' | 'committed'; draftId: string;
  directories: { path: string; files: Record<string, string> }[];
  writes: { path: string; before?: string; after: string }[];
}
const transactionSchema = z.strictObject({ version: z.literal(1), state: z.enum(['applying', 'committed']), draftId: idSchema,
  directories: z.array(z.strictObject({ path: z.string(), files: z.record(z.string(), z.string()) })).max(200),
  writes: z.array(z.strictObject({ path: z.string(), before: z.string().optional(), after: z.string() })).max(2),
});
export class ImportStore {
  constructor(private store: WorkspaceStore, private hooks: { checkpoint?: (phase: 'directory' | 'write', index: number) => void } = {}) {}
  private readAt(root: string, id: string): ImportDraftSnapshot {
    idSchema.parse(id);
    const text = readText(root, `imports/${id}.json`);
    if (text === undefined) throw new Error('导入草稿不存在');
    const draft = validateImportDraft(JSON.parse(text));
    if (draft.id !== id) throw new Error('导入草稿 ID 与文件名不一致');
    return { revision: hash(text), draft };
  }
  read(projectId: string, id: string): ImportDraftSnapshot {
    const root = this.store.project(projectId).root;
    this.recover(projectId);
    return this.readAt(root, id);
  }
  list(projectId: string): ImportDraftSnapshot[] {
    const root = this.store.project(projectId).root;
    const warnings = this.recover(projectId), directory = importFile(root, 'imports');
    if (!existsSync(directory)) return [];
    return readdirSync(directory).filter(name => name.endsWith('.json')).map(name => {
      const snapshot = this.readAt(root, name.slice(0, -5));
      snapshot.draft.document.warnings.push(...warnings);
      return snapshot;
    });
  }
  save(projectId: string, value: ImportDraft, revision: string): ImportDraftSnapshot {
    const root = this.store.project(projectId).root;
    this.recover(projectId);
    const draft = validateImportDraft(value), relative = `imports/${draft.id}.json`;
    const existing = readText(root, relative), current = existing === undefined ? undefined : this.readAt(root, draft.id);
    if ((current?.revision ?? '') !== revision) throw new Error('导入草稿已被修改，请重新加载后保存');
    if (JSON.stringify(draft.saved) !== JSON.stringify(current?.draft.saved ?? {})) throw new Error('已保存用例记录不能由编辑器修改');
    writeAtomic(root, relative, json(draft));
    return this.readAt(root, draft.id);
  }
  private rollback(root: string, transaction: Transaction): void {
    for (const write of transaction.writes) {
      const current = readText(root, write.path);
      if (current !== write.before && current !== write.after) throw new Error('中断导入的文件已被外部修改，请人工检查事务目录');
    }
    for (const directory of transaction.directories) {
      const absolute = importFile(root, directory.path);
      if (!existsSync(absolute)) continue;
      const names = readdirSync(absolute);
      if (names.length !== Object.keys(directory.files).length || names.some(name => !Object.hasOwn(directory.files, name) || readText(root, path.join(directory.path, name)) !== directory.files[name])) throw new Error('中断导入的用例已被外部修改，请人工检查事务目录');
    }
    for (const write of [...transaction.writes].reverse()) {
      if (readText(root, write.path) !== write.after) continue;
      if (write.before === undefined) unlinkSync(importFile(root, write.path));
      else writeAtomic(root, write.path, write.before);
    }
    for (const directory of [...transaction.directories].reverse()) rmSync(importFile(root, directory.path), { recursive: true, force: true });
  }
  recover(projectId: string): string[] {
    const root = this.store.project(projectId).root, directory = importFile(root, 'imports');
    if (!existsSync(directory)) return [];
    const warnings: string[] = [];
    for (const name of readdirSync(directory).filter(name => /^\.transaction-[a-f0-9-]{36}$/.test(name))) {
      const base = `imports/${name}`, text = readText(root, `${base}/manifest.json`);
      if (text === undefined) throw new Error(`导入事务缺少恢复清单，请检查 ${base}`);
      const tx = transactionSchema.parse(JSON.parse(text));
      for (const item of tx.directories) {
        if (!idSchema.safeParse(path.basename(item.path)).success || Object.keys(item.files).sort().join(',') !== 'case.yaml,source.json,web.yaml') throw new Error('导入事务目录格式无效');
        importFile(root, item.path);
      }
      if (tx.writes.some(item => !['workspace.yaml', `imports/${tx.draftId}.json`].includes(item.path))) throw new Error('导入事务文件格式无效');
      if (tx.state === 'applying') { this.rollback(root, tx); warnings.push('已恢复中断的文档导入，未完成的批量写入已撤销，请重新保存。'); }
      rmSync(importFile(root, base), { recursive: true, force: true });
    }
    return warnings;
  }
  commit(projectId: string, draftId: string, revision: string, duplicate: 'skip' | 'copy'): { snapshot: ImportDraftSnapshot; saved: { specId: string; caseId: string; workflowId: string }[]; skipped: string[] } {
    if (!['skip', 'copy'].includes(duplicate)) throw new Error('请选择跳过重复用例或创建副本');
    this.recover(projectId);
    const project = this.store.project(projectId), root = project.root, current = this.readAt(root, draftId);
    if (current.revision !== revision) throw new Error('导入草稿已被修改，请重新加载后保存');
    if (project.errors.length) throw new Error('项目文件存在错误，请先修复再导入');
    const draft = structuredClone(current.draft), skipped: string[] = [], saved: { specId: string; caseId: string; workflowId: string }[] = [];
    const existingFingerprints = new Set<string>(), existingSources = new Set<string>();
    for (const item of project.cases) {
      const location = this.store.caseLocation(projectId, item.id), text = readText(root, path.relative(root, path.join(path.dirname(location.file), 'source.json')));
      if (text === undefined) continue;
      const source = JSON.parse(text) as ImportedCaseSource;
      if (source.version !== 1 || typeof source.fingerprint !== 'string' || !source.document || !source.spec) throw new Error('已有用例来源文件格式无效');
      existingFingerprints.add(source.fingerprint);
      const key = sourceKey(source.document, source.spec); if (key) existingSources.add(key);
    }
    const suiteId = draft.newSuiteName?.trim() ? randomUUID() : draft.suiteId;
    const suite = draft.newSuiteName?.trim() ? { id: suiteId, name: draft.newSuiteName.trim(), directory: `cases/${suiteId}` } : project.suites.find(item => item.id === suiteId);
    if (!suite) throw new Error('请选择有效的 Suite');
    const directories: Transaction['directories'] = [];
    for (const spec of draft.cases.filter(item => draft.selectedIds.includes(item.id))) {
      if (draft.saved[spec.id]) { skipped.push(spec.id); continue; }
      const workflow = draft.workflows[spec.id];
      if (!workflow) { skipped.push(spec.id); continue; }
      if (caseIssues(spec, { variables: { ...project.assets?.variables, ...draft.variables }, flows: project.assets?.flows }).some(question => question.blocks === 'generation')) throw new Error(`用例「${spec.title}」仍有生成阻断问题`);
      if (workflow.specHash !== hash(JSON.stringify(spec))) throw new Error(`用例「${spec.title}」已修改，请重新生成脚本`);
      const fingerprint = importedCaseFingerprint(draft.document, spec), key = sourceKey(draft.document, spec);
      if (duplicate === 'skip' && (existingFingerprints.has(fingerprint) || !!key && existingSources.has(key))) { skipped.push(spec.id); continue; }
      const validation = validateWorkflow(workflow.text, { defaults: project.assets?.variables, variables: draft.variables, flows: project.assets?.flows }, true);
      if (!validation.steps) throw new Error(`用例「${spec.title}」没有可执行步骤`);
      const caseId = randomUUID(), workflowId = randomUUID(), relative = path.join(suite.directory, caseId);
      if (existsSync(importFile(root, relative))) throw new Error('目标用例目录已存在');
      const source: ImportedCaseSource = { version: 1, document: draft.document, spec, fingerprint, workflowHash: hash(workflow.text) };
      directories.push({ path: relative, files: { 'case.yaml': stringify({ schemaVersion: 1, id: caseId, name: spec.title, description: spec.description, suiteId, priority: spec.priority, tags: spec.tags, workflows: [{ id: workflowId, platform: 'web', definitionPath: 'web.yaml' }] }), 'web.yaml': workflow.text, 'source.json': json(source) } });
      draft.saved[spec.id] = { caseId, workflowId, fingerprint };
      saved.push({ specId: spec.id, caseId, workflowId });
      // Split fragments can share one source ID; within this batch only equivalent content is a duplicate.
      existingFingerprints.add(fingerprint);
    }
    if (!saved.length) return { snapshot: current, saved, skipped };
    const writes: Transaction['writes'] = [];
    if (draft.newSuiteName?.trim()) {
      const before = readText(root, 'workspace.yaml')!, config = parse(before, { uniqueKeys: true, maxAliasCount: 50 });
      config.suites.push(suite);
      writes.push({ path: 'workspace.yaml', before, after: stringify(config) });
      draft.suiteId = suite.id; delete draft.newSuiteName;
    }
    writes.push({ path: `imports/${draft.id}.json`, before: readText(root, `imports/${draft.id}.json`)!, after: json(draft) });
    const tx: Transaction = { version: 1, state: 'applying', draftId, directories, writes }, base = `imports/.transaction-${randomUUID()}`;
    if (Buffer.byteLength(json(tx)) > 12 * 1024 * 1024) throw new Error('本次导入超过 12 MB，请分批保存');
    // Persist the complete undo plan before publishing any case or configuration change.
    writeAtomic(root, `${base}/manifest.json`, json(tx));
    try {
      directories.forEach((directory, index) => {
        const staged = `${base}/staged/${index}`;
        for (const [name, text] of Object.entries(directory.files)) writeAtomic(root, `${staged}/${name}`, text);
      });
      directories.forEach((directory, index) => {
        const target = importFile(root, directory.path);
        mkdirSync(path.dirname(target), { recursive: true });
        renameSync(importFile(root, `${base}/staged/${index}`), target);
        this.hooks.checkpoint?.('directory', index);
      });
      writes.forEach((write, index) => {
        if (readText(root, write.path) !== write.before) throw new Error('项目文件已被外部修改，已撤销导入');
        writeAtomic(root, write.path, write.after);
        this.hooks.checkpoint?.('write', index);
      });
      tx.state = 'committed'; writeAtomic(root, `${base}/manifest.json`, json(tx));
    } catch (error) {
      try { this.rollback(root, tx); rmSync(importFile(root, base), { recursive: true, force: true }); }
      catch (failure) { throw new AggregateError([error, failure], `导入失败且恢复未完成，请保留并检查 ${base}`); }
      throw error;
    }
    rmSync(importFile(root, base), { recursive: true, force: true });
    return { snapshot: this.readAt(root, draftId), saved, skipped };
  }
}
