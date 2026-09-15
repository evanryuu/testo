import { randomUUID } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod/v4';
import { parseMarkdown } from '../import/markdown.js';
import { parseXmind } from '../import/xmind.js';
import { caseIssues, compileCaseSpec } from '../import/compiler.js';
import { assertNoImportCredentials } from '../import/privacy.js';
import { caseSpecsSchema } from '../shared/case-spec.js';
import type { CaseSpec, ImportDocument, SourceNode } from '../shared/case-spec.js';
import { stringify } from 'yaml';
import { parseWorkflow, validateVariables } from '../shared/workflow-document.js';
import { planInWorker } from '../generation/worker.js';
import { ImportStore, validateImportDraft } from './import-store.js';
import { readKnowledge, saveKnowledge } from './knowledge.js';
import { knowledgeEntrySchema } from '../shared/knowledge.js';
import type { WorkspaceStore } from './workspace.js';

const textId = (limit: number) => z.string().max(limit).refine(value => value.trim().length > 0, '不能为空');
const id = textId(100);
const projectInput = z.object({ projectId: id }).strict();
const revision = z.string().regex(/^[a-f0-9]{64}$/);
const nodeSchema = z.object({ id: textId(200), title: z.string().max(10000), children: z.array(z.unknown()).max(5000) }).strict();
const documentSchema = z.object({
  id, name: textId(200), format: z.enum(['markdown', 'xmind']), text: textId(1024 * 1024),
  warnings: z.array(z.string().max(2000)).max(200), tree: z.array(z.unknown()).max(5000).optional(),
}).strict();
const uniqueCases = caseSpecsSchema.refine(cases => new Set(cases.map(spec => spec.id)).size === cases.length && cases.every(spec => !['__proto__', 'constructor', 'prototype'].includes(spec.id)), '用例 ID 不能重复或使用保留名称');
function planningDocument(input: unknown): ImportDocument {
  const value = documentSchema.parse(input);
  if (Buffer.byteLength(value.text) > 1024 * 1024) throw new Error('导入文档超过 1 MB');
  const result: ImportDocument = { id: value.id, name: value.name, format: value.format, text: value.text, warnings: value.warnings };
  let bytes = Buffer.byteLength(JSON.stringify(result));
  for (const text of [value.name, value.text, ...value.warnings]) assertNoImportCredentials(text);
  if (value.tree !== undefined) {
    result.tree = [];
    const pending = [...value.tree].reverse().map(node => ({ node, target: result.tree!, depth: 1 }));
    const ids = new Set<string>();
    while (pending.length) {
      const item = pending.pop()!;
      if (item.depth > 30 || ids.size >= 5000) throw new Error('导入文档树不能超过 30 层或 5000 个节点');
      const node = nodeSchema.parse(item.node);
      if (ids.has(node.id)) throw new Error('导入文档树节点 ID 不能重复');
      ids.add(node.id);
      bytes += Buffer.byteLength(node.id) + Buffer.byteLength(node.title);
      if (bytes > 2 * 1024 * 1024) throw new Error('导入文档及节点文字超过 2 MB');
      assertNoImportCredentials(node.title);
      const copy: SourceNode = { id: node.id, title: node.title, children: [] };
      item.target.push(copy);
      for (const child of [...node.children].reverse()) pending.push({ node: child, target: copy.children, depth: item.depth + 1 });
    }
  }
  // Match the planner's document limit before spawning its worker process.
  if (JSON.stringify(result).length > 350000) throw new Error('文档过大，请缩小文档后重试');
  return result;
}
function assertCaseCredentials(spec: CaseSpec): void {
  for (const text of [spec.title, spec.description, ...spec.path, ...spec.tags, ...spec.preconditions.map(item => item.text), ...spec.steps.map(item => item.text), ...spec.expectations.map(item => item.text), ...spec.questions.map(item => item.message), ...spec.data.map(item => `${item.name}: ${item.value}`)]) assertNoImportCredentials(text);
}
export function createImportHandlers(store: WorkspaceStore, environment: () => NodeJS.ProcessEnv, pickFile: () => Promise<string | undefined>) {
  const imports = new ImportStore(store);
  const jobs = new Map<string, AbortController>();
  const handlers: Record<string, (input: unknown) => unknown> = {
    parseImportDocument(input) {
      const value = z.object({ text: z.string().max(1024 * 1024), name: textId(200) }).strict().parse(input);
      if (Buffer.byteLength(value.text) > 1024 * 1024) throw new Error('Markdown 文件超过 1 MB');
      assertNoImportCredentials(value.text);
      return parseMarkdown(value.text, value.name);
    },
    async pickImportDocument(input) {
      z.undefined().parse(input);
      const file = await pickFile(); if (!file) return null;
      const extension = path.extname(file).toLowerCase();
      if (!['.md', '.xmind'].includes(extension)) throw new Error('请选择 .md 或 .xmind 文件');
      if (statSync(file).size > (extension === '.md' ? 1024 * 1024 : 5 * 1024 * 1024)) throw new Error('文件超过导入大小上限（Markdown 1 MB，XMind 5 MB）');
      const bytes = readFileSync(file);
      const parsed = extension === '.md' ? parseMarkdown(bytes.toString('utf8'), path.basename(file)) : parseXmind(bytes, path.basename(file));
      assertNoImportCredentials(parsed.document.text);
      return parsed;
    },
    listImportDrafts(input) { return imports.list(projectInput.parse(input).projectId); },
    loadImportDraft(input) { const value = projectInput.extend({ id: z.uuid() }).parse(input); return imports.read(value.projectId, value.id); },
    saveImportDraft(input) {
      const value = projectInput.extend({ draft: z.unknown(), revision: z.union([z.literal(''), revision]) }).parse(input);
      return imports.save(value.projectId, validateImportDraft(value.draft), value.revision);
    },
    commitImportDraft(input) {
      const value = projectInput.extend({ id: z.uuid(), revision, duplicate: z.enum(['skip', 'copy']) }).parse(input);
      return imports.commit(value.projectId, value.id, value.revision, value.duplicate);
    },
    compileImportCases(input) {
      const value = projectInput.extend({ cases: uniqueCases, variables: z.unknown() }).parse(input);
      const project = store.project(value.projectId);
      const publicVariables = validateVariables(value.variables);
      if (Buffer.byteLength(JSON.stringify(publicVariables)) > 1024 * 1024) throw new Error('公共变量超过 1 MB');
      const checkVariables = (variables: Record<string, unknown>): void => {
        for (const [key, value] of Object.entries(variables)) {
          assertNoImportCredentials(`${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);
          if (value && typeof value === 'object') checkVariables(value as Record<string, unknown>);
        }
      };
      checkVariables(publicVariables);
      const options = { variables: { ...project.assets?.variables, ...publicVariables }, flows: project.assets?.flows };
      const workflows: Record<string, { text: string; specHash: string; edited: boolean }> = {}, issues: Record<string, ReturnType<typeof caseIssues>> = {};
      for (const spec of value.cases) {
        assertCaseCredentials(spec);
        issues[spec.id] = caseIssues(spec, options);
        if (issues[spec.id]!.some(issue => !issue.resolved && issue.blocks === 'generation')) continue;
        const compiled = compileCaseSpec(spec, options);
        const document = parseWorkflow(compiled.text);
        if (Object.keys(publicVariables).length) document.testo = { variables: publicVariables };
        workflows[spec.id] = { text: stringify(document), specHash: compiled.specHash, edited: false };
      }
      return { workflows, issues };
    },
    knowledge(input) { return readKnowledge(store.project(projectInput.parse(input).projectId).root); },
    saveKnowledge(input) {
      const value = projectInput.extend({ revision, entries: z.array(knowledgeEntrySchema).max(500) }).parse(input);
      return saveKnowledge(store.project(value.projectId).root, { revision: value.revision, entries: value.entries });
    },
    async planImportDocument(input) {
      const value = projectInput.extend({ requestId: z.string().uuid(), mode: z.enum(['existing', 'design']), document: z.unknown() }).parse(input);
      const document = planningDocument(value.document);
      if (jobs.size) throw new Error('已有文档正在识别，请等待完成或取消');
      const project = store.project(value.projectId), controller = new AbortController();
      jobs.set(value.requestId, controller);
      try {
        const result = await planInWorker({ document, mode: value.mode, knowledge: readKnowledge(project.root).entries, flows: project.assets?.flows }, environment(), controller.signal);
        controller.signal.throwIfAborted();
        // Merge only new titles into the latest revision. Existing human edits survive.
        if (result.knowledge.length) {
          const latest = readKnowledge(project.root), titles = new Set(latest.entries.map(entry => entry.title.trim().toLowerCase()));
          const additions = result.knowledge.filter(entry => { const title = entry.title.trim().toLowerCase(); if (titles.has(title)) return false; titles.add(title); return true; }).map(entry => ({ ...entry, id: randomUUID(), status: 'draft' as const, source: 'ai' as const, updatedAt: new Date().toISOString() }));
          if (additions.length) {
            try { saveKnowledge(project.root, { revision: latest.revision, entries: [...latest.entries, ...additions] }); }
            catch { result.warnings.push('知识草稿未保存，请保留本次生成结果并检查项目知识库'); }
          }
        }
        return result;
      } finally { jobs.delete(value.requestId); }
    },
    cancelImportPlan(input) { const value = z.object({ requestId: z.string().uuid() }).strict().parse(input); jobs.get(value.requestId)?.abort(new Error('文档识别已取消')); },
  };
  return { handlers, cancelAll() { for (const controller of jobs.values()) controller.abort(new Error('应用正在退出')); } };
}
