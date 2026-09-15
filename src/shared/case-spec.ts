import { z } from 'zod/v4';
import type { Variables } from './workflow-document.js';

const short = z.string().max(500);
export const sourceRefSchema = z.object({ documentId: z.string().min(1).max(100), line: z.number().int().positive().optional(), endLine: z.number().int().positive().optional(), nodeId: z.string().max(200).optional() }).strict();
export const originSchema = z.enum(['source', 'ai', 'manual']);
const sourced = { text: z.string().max(10000), origin: originSchema, ref: sourceRefSchema };
export const caseSpecSchema = z.object({
  id: z.string().min(1).max(100), sourceId: short.optional(), title: short, description: z.string().max(10000),
  path: z.array(short).max(30), priority: z.enum(['P0', 'P1', 'P2']), tags: z.array(short).max(30), origin: originSchema, ref: sourceRefSchema,
  preconditions: z.array(z.object({ id: short, ...sourced, kind: z.enum(['action', 'check', 'manual']), acknowledged: z.boolean().optional() }).strict()).max(100),
  data: z.array(z.object({ name: short, value: z.string().max(10000), origin: originSchema, ref: sourceRefSchema }).strict()).max(100),
  steps: z.array(z.object({ id: short, ...sourced, kind: z.enum(['action', 'wait', 'flow']), flowId: short.optional() }).strict()).max(200),
  expectations: z.array(z.object({ id: short, ...sourced, kind: z.enum(['text', 'semantic']), afterStepId: short.optional() }).strict()).max(200),
  questions: z.array(z.object({ code: short, message: z.string().max(2000), blocks: z.enum(['generation', 'execution']), resolved: z.boolean().optional() }).strict()).max(100),
}).strict();
export const caseSpecsSchema = z.array(caseSpecSchema).max(200);
export type CaseSpec = z.infer<typeof caseSpecSchema>;
export type SourceRef = z.infer<typeof sourceRefSchema>;
export type CaseIssue = CaseSpec['questions'][number];
export interface SourceNode { id: string; title: string; children: SourceNode[] }
export interface ImportDocument { id: string; name: string; format: 'markdown' | 'xmind'; text: string; tree?: SourceNode[]; warnings: string[] }
export interface ParsedImport { document: ImportDocument; cases: CaseSpec[]; needsAI: boolean }
export interface GeneratedWorkflow { text: string; specHash: string; edited: boolean }
export interface ImportDraft {
  id: string; document: ImportDocument; mode: 'existing' | 'design'; cases: CaseSpec[]; selectedIds: string[];
  workflows: Record<string, GeneratedWorkflow>; variables: Variables; suiteId: string; newSuiteName?: string;
  saved: Record<string, { caseId: string; workflowId: string; fingerprint: string }>;
}
export interface ImportDraftSnapshot { revision: string; draft: ImportDraft }
export interface ImportedCaseSource {
  version: 1; document: ImportDocument; spec: CaseSpec; fingerprint: string; workflowHash: string;
  validation?: { status: 'passed' | 'failed'; runId: string; workflowHash: string; configurationHash: string; at: string };
}
