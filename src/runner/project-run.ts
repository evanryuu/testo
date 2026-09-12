import { randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WorkspaceStore } from '../main/workspace.js';
import { expandGroups } from '../main/group-plan.js';
import { gitInfo } from '../main/git-info.js';
import { assertWorkflowModel, validateWorkflow } from '../main/workflow-validation.js';
import { parseWorkflow, validateVariables, type Variables } from '../shared/workflow-document.js';
import type { Project, RunSnapshot } from '../shared/workspace.js';
import { startRun } from './run.js';
import type { RunOptions, RunResult, WorkerEvent } from './messages.js';

export interface ProjectRunOptions {
  projectDir: string;
  environment: string;
  groups?: string[];
  cases?: string[];
  tags?: string[];
  variables?: Variables;
  datasetId?: string;
  allDatasets?: boolean;
  artifactRoot: string;
  channel?: string;
  headless?: boolean;
  failurePolicy?: 'stop' | 'continue';
  timeoutMs?: number;
  junit?: string;
}
export interface ProjectPlan {
  id: string;
  projectId: string;
  projectName: string;
  environment: string;
  snapshot: RunSnapshot;
  failurePolicy: 'stop' | 'continue';
  artifactDirectory: string;
  items: { caseId: string; caseName: string; datasetId?: string; datasetName?: string; definitionHash: string; options: RunOptions }[];
}
export interface ProjectRunSummary {
  id: string;
  projectId: string;
  projectName: string;
  environment: string;
  browserMode: 'isolated';
  snapshot: RunSnapshot;
  status: 'passed' | 'failed' | 'cancelled';
  startedAt: string;
  finishedAt?: string;
  items: { caseId: string; caseName: string; datasetId?: string; datasetName?: string; definitionHash: string; status: 'queued' | 'skipped' | RunResult['status']; result?: RunResult }[];
}
function resolveNamed<T extends { id: string; name: string }>(items: T[], value: string, label: string): T {
  const exact = items.find(item => item.id === value);
  if (exact) return exact;
  const matches = items.filter(item => item.name === value);
  if (matches.length !== 1) throw new Error(matches.length ? `${label}名称重复，请使用 ID：${value}` : `找不到${label}：${value}`);
  return matches[0]!;
}
export function selectProjectCases(project: Project, options: Pick<ProjectRunOptions, 'groups' | 'cases' | 'tags'>): string[] {
  const ids: string[] = [];
  if (options.groups?.length) ids.push(...expandGroups(project, [...new Set(options.groups.map(value => resolveNamed(project.groups ?? [], value, '分组').id))]).caseIds);
  if (options.cases?.length) ids.push(...options.cases.map(value => resolveNamed(project.cases, value, '用例').id));
  if (!options.groups?.length && !options.cases?.length) ids.push(...project.cases.filter(item => item.workflows.some(workflow => workflow.platform === 'web' && workflow.ready)).map(item => item.id));
  const byId = new Map(project.cases.map(item => [item.id, item]));
  const result = [...new Set(ids)].filter(id => !options.tags?.length || options.tags.some(tag => byId.get(id)!.tags.includes(tag)));
  if (!result.length) throw new Error('所选条件没有可运行的 Web 用例');
  return result;
}
export function planProjectRun(input: ProjectRunOptions, environment: NodeJS.ProcessEnv = process.env): ProjectPlan {
  const options = structuredClone(input);
  if (options.datasetId && options.allDatasets) throw new Error('--dataset 与 --all-datasets 不能同时使用');
  if (options.failurePolicy !== undefined && !['stop', 'continue'].includes(options.failurePolicy)) throw new Error('失败策略必须是 stop 或 continue');
  const registry = mkdtempSync(path.join(tmpdir(), 'testo-cli-registry-'));
  try {
    const store = new WorkspaceStore(registry, path.join(registry, 'projects'));
    const projectId = store.open(options.projectDir), project = store.project(projectId);
    const selectedEnvironment = resolveNamed(project.environments, options.environment, '环境');
    if (!/^https?:$/.test(new URL(selectedEnvironment.web.baseUrl).protocol)) throw new Error('运行环境必须使用 HTTP 或 HTTPS');
    const id = randomUUID();
    const artifactDirectory = path.resolve(options.artifactRoot, id);
    const git = gitInfo(project.root);
    const snapshot: RunSnapshot = {
      environmentId: selectedEnvironment.id, baseUrl: selectedEnvironment.web.baseUrl,
      variables: validateVariables(options.variables ?? {}), defaults: { ...project.assets?.variables, ...selectedEnvironment.variables }, flows: structuredClone(project.assets?.flows ?? {}),
      model: { name: environment.MIDSCENE_MODEL_NAME ?? '', family: environment.MIDSCENE_MODEL_FAMILY ?? '', baseUrl: environment.MIDSCENE_MODEL_BASE_URL ?? environment.OPENAI_BASE_URL ?? '' },
      ...(git.commit ? { git: { commit: git.commit, branch: git.branch || undefined, dirty: !!git.status } } : {}), timeoutMs: options.timeoutMs,
    };
    const items = selectProjectCases(project, options).flatMap(caseId => {
      const item = project.cases.find(item => item.id === caseId)!;
      const workflow = item.workflows.find(workflow => workflow.platform === 'web' && workflow.ready);
      if (!workflow) throw new Error(`用例「${item.name}」没有可运行的 Web Workflow`);
      const workflowPath = store.workflowLocationFromProject(project, caseId, workflow.id).file;
      const workflowText = readFileSync(workflowPath, 'utf8');
      const definitionHash = createHash('sha256').update(workflowText).digest('hex');
      const datasets = parseWorkflow(workflowText).testo?.datasets ?? [];
      const selected = options.allDatasets && datasets.length ? datasets : [options.datasetId ? datasets.find(row => row.id === options.datasetId) : undefined];
      if (options.datasetId && !selected[0]) throw new Error(`用例「${item.name}」没有数据集 ${options.datasetId}`);
      return selected.map(dataset => {
        const runOptions: RunOptions = { workflowPath, workflowText, baseUrl: snapshot.baseUrl, defaults: snapshot.defaults, variables: snapshot.variables, flows: snapshot.flows, datasetId: dataset?.id, artifactRoot: artifactDirectory, channel: options.channel, headless: options.headless ?? true, timeoutMs: options.timeoutMs };
        const validation = validateWorkflow(workflowText, runOptions);
        assertWorkflowModel(validation, snapshot.model.name);
        return { caseId, caseName: item.name, datasetId: dataset?.id, datasetName: dataset?.name, definitionHash, options: runOptions };
      });
    });
    if (items.length > 10000) throw new Error('单次运行最多支持 10000 个用例数据组合');
    return { id, projectId, projectName: project.name, environment: selectedEnvironment.name, snapshot, artifactDirectory, failurePolicy: options.failurePolicy ?? 'stop', items };
  } finally { rmSync(registry, { recursive: true, force: true }); }
}
const xml = (value: unknown): string => String(value ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character]!);
export function junitReport(summary: Pick<ProjectRunSummary, 'projectName' | 'environment' | 'items' | 'startedAt'>): string {
  const failures = summary.items.filter(item => ['failed', 'error'].includes(item.status)).length;
  const skipped = summary.items.filter(item => ['queued', 'skipped', 'cancelled'].includes(item.status)).length;
  const duration = summary.items.reduce((sum, item) => sum + (item.result?.durationMs ?? 0), 0) / 1000;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites><testsuite name="${xml(summary.projectName)}" tests="${summary.items.length}" failures="${failures}" skipped="${skipped}" time="${duration}" timestamp="${xml(summary.startedAt)}"><properties><property name="environment" value="${xml(summary.environment)}"/></properties>${summary.items.map(item => `<testcase classname="${xml(summary.projectName)}" name="${xml(item.caseName + (item.datasetName ? ' [' + item.datasetName + ']' : ''))}" time="${(item.result?.durationMs ?? 0) / 1000}">${['failed', 'error'].includes(item.status) ? `<failure message="${xml(item.result?.error ?? item.status)}">${xml(item.result?.error ?? item.status)}</failure>` : ['queued', 'skipped', 'cancelled'].includes(item.status) ? '<skipped/>' : ''}</testcase>`).join('')}</testsuite></testsuites>\n`;
}
export async function runProject(input: ProjectRunOptions, options: { signal?: AbortSignal; environment?: NodeJS.ProcessEnv; onEvent?: (event: WorkerEvent & { caseId: string; datasetId?: string }) => void } = {}): Promise<ProjectRunSummary> {
  const environment = { ...(options.environment ?? process.env) };
  const plan = planProjectRun(input, environment);
  mkdirSync(plan.artifactDirectory, { recursive: true, mode: 0o700 });
  const summary: ProjectRunSummary = { id: plan.id, projectId: plan.projectId, projectName: plan.projectName, environment: plan.environment, browserMode: 'isolated', snapshot: plan.snapshot, status: 'passed', startedAt: new Date().toISOString(), items: plan.items.map(({ options: _options, ...item }) => ({ ...item, status: 'queued' })) };
  const save = () => writeFileSync(path.join(plan.artifactDirectory, 'batch-summary.json'), JSON.stringify(summary, null, 2), { mode: 0o600 });
  save();
  for (let index = 0; index < plan.items.length; index++) {
    const item = plan.items[index]!, record = summary.items[index]!;
    if (options.signal?.aborted || summary.status === 'cancelled' || (summary.status === 'failed' && plan.failurePolicy === 'stop')) { record.status = 'skipped'; continue; }
    const run = startRun(item.options, event => options.onEvent?.({ ...event, caseId: item.caseId, datasetId: item.datasetId }), environment);
    const abort = () => run.cancel();
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    try { record.result = await run.result; record.status = record.result.status; }
    finally { options.signal?.removeEventListener('abort', abort); }
    if (record.status === 'cancelled') summary.status = 'cancelled';
    else if (record.status !== 'passed') summary.status = 'failed';
    save();
  }
  if (options.signal?.aborted) summary.status = 'cancelled';
  summary.finishedAt = new Date().toISOString();
  save();
  if (input.junit) { const file = path.resolve(input.junit); mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, junitReport(summary), { mode: 0o600 }); }
  return summary;
}
