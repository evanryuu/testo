import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { caseSpecSchema } from '../shared/case-spec.js';
import { compileWorkflow, parseWorkflow } from '../shared/workflow-document.js';
import type { RunSnapshot } from '../shared/workspace.js';
import { caseIssues } from '../import/compiler.js';

export const importHash = (value: string) => createHash('sha256').update(value).digest('hex');
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => JSON.stringify(key) + ':' + canonical(item)).join(',') + '}';
  return JSON.stringify(value) ?? 'null';
}
export function importConfigurationHash(text: string, snapshot: RunSnapshot, datasetId?: string, browserMode = 'isolated'): string {
  const compiled = compileWorkflow(text, { defaults: snapshot.defaults, variables: snapshot.variables, flows: snapshot.flows, datasetId });
  return importHash(canonical({ text: compiled.text, variables: compiled.variables, baseUrl: snapshot.baseUrl, environmentId: snapshot.environmentId, model: snapshot.model, loginCondition: snapshot.loginCondition, timeoutMs: snapshot.timeoutMs, datasetId, browserMode }));
}
function readSidecar(file: string): any | undefined {
  try { if (lstatSync(file).isSymbolicLink()) throw new Error('生成来源或验证记录不能使用符号链接'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  return JSON.parse(readFileSync(file, 'utf8'));
}
export interface ImportValidationStatus { imported: boolean; status: 'incomplete' | 'pending' | 'passed' | 'failed'; issues: string[]; runId?: string }
export function importedPreconditions(workflowPath: string): { text: string; kind: 'action' | 'check' | 'manual' }[] {
  const source = readSidecar(path.join(path.dirname(workflowPath), 'source.json'));
  return source ? caseSpecSchema.parse(source.spec).preconditions.map(({ text, kind }) => ({ text, kind })) : [];
}
export function importedWorkflowStatus(workflowPath: string, text: string, snapshot: RunSnapshot, datasetId?: string, browserMode = 'isolated'): ImportValidationStatus {
  const source = readSidecar(path.join(path.dirname(workflowPath), 'source.json'));
  if (!source) return { imported: false, status: 'pending', issues: [] };
  if (source.version !== 1) throw new Error('不支持的生成来源版本');
  const spec = caseSpecSchema.parse(source.spec);
  const compiled = compileWorkflow(text, { defaults: snapshot.defaults, variables: snapshot.variables, flows: snapshot.flows, datasetId });
  const issues = caseIssues(spec, { variables: compiled.variables, flows: snapshot.flows }).filter(issue => !issue.resolved).map(issue => issue.message);
  const workflow = parseWorkflow(compiled.text);
  const preparationIds = new Set([...spec.preconditions, ...spec.steps].map(item => item.id));
  const assertionIds = new Set(workflow.cases[0]!.steps.flatMap((step, index) => {
    const id = compiled.stepMetadata[`steps:${index}`]?.id;
    return id && !preparationIds.has(id) && ('aiAssert' in step || 'assertText' in step) ? [id] : [];
  }));
  if (!spec.expectations.length || spec.expectations.some(expected => !assertionIds.has(expected.id))) issues.push('Workflow 缺少业务预期对应的断言，请检查生成结果');
  if (issues.length) return { imported: true, status: 'incomplete', issues };
  const validation = readSidecar(path.join(path.dirname(workflowPath), 'validation.json'));
  if (!validation || validation.workflowHash !== importHash(text) || validation.configurationHash !== importConfigurationHash(text, snapshot, datasetId, browserMode)) return { imported: true, status: 'pending', issues: ['当前 Workflow 或运行配置尚未验证'] };
  return { imported: true, status: validation.status === 'passed' ? 'passed' : 'failed', issues: validation.status === 'passed' ? [] : ['上次试跑未通过，请查看运行证据'], runId: validation.runId };
}
export function assertImportedRun(workflowPath: string, text: string, snapshot: RunSnapshot, datasetId?: string, browserMode = 'isolated', explicitTrial = false): void {
  const status = importedWorkflowStatus(workflowPath, text, snapshot, datasetId, browserMode);
  if (!status.imported) return;
  if (status.status === 'incomplete') throw new Error('生成用例待补充：' + status.issues.join('；'));
  if (!explicitTrial && status.status !== 'passed') throw new Error('生成用例尚未针对当前版本和配置验证，请先显式试跑后再加入回归');
}
export function recordImportedValidation(workflowPath: string, text: string, snapshot: RunSnapshot, runId: string, passed: boolean, datasetId?: string, browserMode = 'isolated'): void {
  if (!readSidecar(path.join(path.dirname(workflowPath), 'source.json'))) return;
  const state = importedWorkflowStatus(workflowPath, text, snapshot, datasetId, browserMode);
  const file = path.join(path.dirname(workflowPath), 'validation.json');
  readSidecar(file);
  const temporary = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify({ version: 1, status: passed && state.status !== 'incomplete' ? 'passed' : 'failed', runId, workflowHash: importHash(text), configurationHash: importConfigurationHash(text, snapshot, datasetId, browserMode), at: new Date().toISOString() }, null, 2), { mode: 0o600 });
  renameSync(temporary, file);
}
