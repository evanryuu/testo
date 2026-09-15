import type { CaseIssue, CaseSpec, GeneratedWorkflow, ImportDocument, ImportDraft, ImportDraftSnapshot, ParsedImport } from './case-spec.js';
import type { KnowledgeEntry, KnowledgeSnapshot } from './knowledge.js';
import type { Variables } from './workflow-document.js';

export interface ImportPlanResult { cases: CaseSpec[]; usedKnowledgeIds: string[]; knowledge: { title: string; aliases: string[]; content: string }[]; warnings: string[] }
export interface DocumentImportApi {
  parseImportDocument(input: { text: string; name: string }): Promise<ParsedImport>;
  pickImportDocument(): Promise<ParsedImport | null>;
  listImportDrafts(input: { projectId: string }): Promise<ImportDraftSnapshot[]>;
  loadImportDraft(input: { projectId: string; id: string }): Promise<ImportDraftSnapshot>;
  saveImportDraft(input: { projectId: string; draft: ImportDraft; revision: string }): Promise<ImportDraftSnapshot>;
  commitImportDraft(input: { projectId: string; id: string; revision: string; duplicate: 'skip' | 'copy' }): Promise<{ snapshot: ImportDraftSnapshot; saved: { specId: string; caseId: string; workflowId: string }[]; skipped: string[] }>;
  planImportDocument(input: { projectId: string; document: ImportDocument; mode: 'existing' | 'design'; requestId: string }): Promise<ImportPlanResult>;
  cancelImportPlan(input: { requestId: string }): Promise<void>;
  compileImportCases(input: { projectId: string; cases: CaseSpec[]; variables: Variables }): Promise<{ workflows: Record<string, GeneratedWorkflow>; issues: Record<string, CaseIssue[]> }>;
  knowledge(input: { projectId: string }): Promise<KnowledgeSnapshot>;
  saveKnowledge(input: { projectId: string; revision: string; entries: KnowledgeEntry[] }): Promise<KnowledgeSnapshot>;
  importValidation(input: { projectId: string; caseId: string; workflowId: string; environmentId: string; variables?: Variables; datasetId?: string; browserMode?: 'isolated' | 'bridge'; loginCondition?: string; timeoutMs?: number }): Promise<{ imported: boolean; status: 'incomplete' | 'pending' | 'passed' | 'failed'; issues: string[]; runId?: string; preconditions?: { text: string; kind: 'action' | 'check' | 'manual' }[] }>;
}
