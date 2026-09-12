import { app, BrowserWindow, dialog, ipcMain, safeStorage, clipboard, shell, Menu } from 'electron';
import { mkdirSync, existsSync, readFileSync, writeFileSync, realpathSync, renameSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { BrowserProfileService } from './browser-profiles.js';
import { exportRunBundle } from '../runner/report-bundle.js';
import { UpdateService } from './updates.js';
import { WorkspaceStore } from './workspace.js';
import { RecordingService } from './recording.js';
import { captureChromeSession, type ChromeTarget } from '../recording/chrome-bridge.js';
import { buildRecordedWorkflow, mergeRecordedWorkflow } from '../recording/workflow.js';
import { parse, stringify } from 'yaml';
import { parseWorkflow, validateVariables } from '../shared/workflow-document.js';
import { assertWorkflowModel, validateWorkflow } from './workflow-validation.js';
import { retryItems } from './batch-retry.js';
import { gitInfo } from './git-info.js';
import type { RunInput, RunSnapshot, RetryBatchInput, PreflightResult } from '../shared/workspace.js';
import { runPlanFromYaml } from '../shared/run-steps.js';
import { expandGroups } from './group-plan.js';
import { BatchQueue } from './batch.js';
import { HistoryStore } from './history.js';
import { startRun, type RunHandle } from '../runner/run.js';
import type { HistoryRun, ModelSettings, BrowserSession, BatchInput, GroupBatchInput, Project } from '../shared/workspace.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const dataDir = path.resolve(process.env.WORKSPACE_DATA_DIR || (app.isPackaged ? app.getPath('userData') : path.join(root, '.desktop-data')));
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
app.setPath('userData', dataDir);
// Keep the existing macOS Keychain identity so saved credentials remain readable.
// Product branding is set explicitly on windows, menus and the About panel.
app.setName('Testing Workspace');
const uiFile = path.join(root, 'dist-ui/index.html');
let mainWindow: BrowserWindow;
let active: RunHandle | undefined;
let quitting = false;
void app.whenReady().then(() => {
app.setAboutPanelOptions({ applicationName: 'Testo' });
Menu.setApplicationMenu(Menu.buildFromTemplate([
  ...(process.platform === 'darwin' ? [{ label: 'Testo', submenu: [
    { role: 'about' as const, label: '关于 Testo' }, { type: 'separator' as const },
    { role: 'services' as const }, { type: 'separator' as const },
    { role: 'hide' as const, label: '隐藏 Testo' }, { role: 'hideOthers' as const }, { role: 'unhide' as const },
    { type: 'separator' as const }, { role: 'quit' as const, label: '退出 Testo' },
  ] }] : []),
  { role: 'fileMenu' }, { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' },
]));
const store = new WorkspaceStore(dataDir, path.resolve(process.env.WORKSPACE_PROJECTS_DIR || path.join(app.isPackaged ? dataDir : root, 'projects')));
const history = new HistoryStore(path.join(dataDir, 'runs.db'));
const modelFile = path.join(dataDir, 'model.json');
const modelData = (): Record<string, string> => existsSync(modelFile) ? JSON.parse(readFileSync(modelFile, 'utf8')) : {};
const modelSettings = (): ModelSettings => {
  const m = modelData();
  return { name: m.name ?? '', baseUrl: m.baseUrl ?? '', family: m.family ?? '', hasApiKey: !!m.encryptedKey };
};
const change = () => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('workspace:changed'); };

const updates = new UpdateService(app.getVersion(), app.isPackaged && JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).testoSignedRelease === true, change);
const recorder = new RecordingService(dataDir, change, {
  encode: text => {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('系统凭证加密服务不可用，无法保存录制草稿');
    return 'testo:encrypted:v1:' + safeStorage.encryptString(text).toString('base64');
  },
  decode: text => text.startsWith('testo:encrypted:v1:') ? safeStorage.decryptString(Buffer.from(text.slice('testo:encrypted:v1:'.length), 'base64')) : text,
});
const publicDraft = () => {
  if (!recorder.draft) return;
  const { chromeTarget: _target, ...draft } = recorder.draft;
  return draft;
};
const profilesFile = path.join(dataDir, 'browser-profiles.enc');
const browserProfiles = new BrowserProfileService(change, {
  load: () => existsSync(profilesFile) ? JSON.parse(safeStorage.decryptString(readFileSync(profilesFile))) : [],
  save: entries => {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('系统凭证加密服务不可用，未保存浏览器配对');
    writeFileSync(profilesFile + '.tmp', safeStorage.encryptString(JSON.stringify(entries)), { mode: 0o600 });
    renameSync(profilesFile + '.tmp', profilesFile);
  },
});
// Bindings live only for this app session; no cookies or Chrome profile are copied.
const sessions = new Map<string, { info: BrowserSession; target: ChromeTarget }>();
let preparing = false;
let connectingSession = false;
let connectionResult: Promise<ChromeTarget> | undefined;
const batchQueue = new BatchQueue(batch => { history.saveBatch(batch); change(); });
const occupied = () => !!active || !!batchQueue.active || preparing || browserProfiles.busy || quitting;
const chromeTargets = new Map<string, ChromeTarget>();
const chromeKey = (i: { projectId: string; caseId: string; workflowId: string; environmentId: string }) => JSON.stringify([i.projectId, i.caseId, i.workflowId, i.environmentId]);

function sameTab(a: ChromeTarget, b: ChromeTarget): boolean {
  return a.tabId === b.tabId && a.origin === b.origin
    && a.profile?.connectorId === b.profile?.connectorId
    && a.profile?.profileInstallationId === b.profile?.profileInstallationId;
}
async function browserOperation<T>(operation: () => Promise<T>): Promise<T> {
  if (occupied() || recorder.active) throw new Error('请先结束运行或录制，再选择浏览器标签页');
  preparing = true; connectingSession = true; change();
  try {
    await recorder.release();
    if (quitting) throw new Error('应用正在退出');
    return await operation();
  } finally { preparing = false; connectingSession = false; change(); }
}

function modelEnvironment(): NodeJS.ProcessEnv {
  const m = modelData();
  const env = { ...process.env };
  for (const [field, key] of [['name', 'MIDSCENE_MODEL_NAME'], ['baseUrl', 'MIDSCENE_MODEL_BASE_URL'], ['family', 'MIDSCENE_MODEL_FAMILY']] as const) {
    if (m[field]) env[key] = m[field];
  }
  if (m.encryptedKey) env.MIDSCENE_MODEL_API_KEY = safeStorage.decryptString(Buffer.from(m.encryptedKey, 'base64'));
  return env;
}

const workflowHash = (text: string) => createHash('sha256').update(text).digest('hex');
function configurationSnapshot(project: Project, environmentId: string, input: RunInput | BatchInput): RunSnapshot {
  const environment = project.environments.find(e => e.id === environmentId);
  if (!environment) throw new Error('请选择运行环境');
  if (input.timeoutMs !== undefined && (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1000 || input.timeoutMs > 86400000)) throw new Error('总时限必须为 1 秒至 24 小时');
  if (input.loginCondition !== undefined && (typeof input.loginCondition !== 'string' || input.loginCondition.length > 2000)) throw new Error('登录检查条件过长');
  const env = modelEnvironment(), git = gitInfo(project.root, false);
  return { environmentId, baseUrl: environment.web.baseUrl, variables: validateVariables(input.variables ?? {}),
    defaults: { ...project.assets?.variables, ...environment.variables }, flows: structuredClone(project.assets?.flows ?? {}),
    model: { name: env.MIDSCENE_MODEL_NAME ?? '', baseUrl: env.MIDSCENE_MODEL_BASE_URL ?? env.OPENAI_BASE_URL ?? '', family: env.MIDSCENE_MODEL_FAMILY ?? '' }, git: { branch: git.branch, commit: git.commit, dirty: !!git.status },
    timeoutMs: input.timeoutMs, loginCondition: input.loginCondition?.trim() || undefined };
}
function prepareRun(i: RunInput, project = store.project(i.projectId), snapshot = configurationSnapshot(project, i.environmentId, i), savedText?: string) {
  const item = project.cases.find(item => item.id === i.caseId);
  if (!item) throw new Error('用例不存在或无法读取');
  const { file, platform } = store.workflowLocationFromProject(project, i.caseId, i.workflowId);
  if (platform !== 'web') throw new Error('当前版本只支持执行 Web Workflow');
  const environment = project.environments.find(e => e.id === i.environmentId);
  if (!environment) throw new Error('请选择运行环境');
  if (!savedText && !existsSync(file)) throw new Error(`${item.name} 尚未保存 Workflow`);
  const sourceText = savedText ?? readFileSync(file, 'utf8');
  let text = sourceText;
  if (snapshot.loginCondition) {
    const document = parseWorkflow(text);
    document.beforeAll = [{ aiWaitFor: { prompt: snapshot.loginCondition, timeoutMs: 30000 } }, ...(Array.isArray(document.beforeAll) ? document.beforeAll : [])];
    text = stringify(document);
  }
  const validation = validateWorkflow(text, { defaults: snapshot.defaults, variables: snapshot.variables, flows: snapshot.flows, datasetId: i.datasetId, debug: i.debug }, false, i.browserMode === 'bridge');
  return { project, item, file, text, sourceText, environment, revision: workflowHash(sourceText), input: i, snapshot, validation };
}
function targetFor(i: RunInput, baseUrl: string): ChromeTarget | undefined {
  if (i.browserMode !== 'bridge') return;
  const session = i.sessionId ? sessions.get(i.sessionId) : undefined;
  if (i.sessionId && (!session || session.info.projectId !== i.projectId || session.info.environmentId !== i.environmentId || session.target.origin !== new URL(baseUrl).origin)) throw new Error('请重新选择此环境的 Chrome 标签页');
  const target = session?.target ?? chromeTargets.get(chromeKey(i));
  if (!target) throw new Error('请选择 Chrome Profile、窗口和目标标签页');
  return target;
}
function publishRun(record: HistoryRun) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('workspace:run-changed', record);
}
function launchRun(plan: ReturnType<typeof prepareRun>, chromeTarget?: ChromeTarget, batchId?: string, sessionName?: string, executionEnvironment = modelEnvironment()): RunHandle {
  const { project, item, file, snapshot } = plan;
  const run = startRun({ workflowPath: file, workflowText: plan.text, baseUrl: snapshot.baseUrl, variables: snapshot.variables,
    defaults: snapshot.defaults, flows: snapshot.flows, datasetId: plan.input.datasetId, debug: plan.input.debug, timeoutMs: snapshot.timeoutMs,
    artifactRoot: path.join(dataDir, 'artifacts'), channel: 'chrome', headless: false, chromeTarget }, event => {
    record.events.push(event); history.appendEvent(record.runId, event); publishRun(record);
  }, executionEnvironment);
  const record: HistoryRun = { runId: run.runId, projectId: project.id, caseId: item.id, caseName: item.name,
    environment: plan.environment.name, status: 'running', startedAt: new Date().toISOString(), events: [], batchId, sessionName, snapshot };
  active = run; history.save(record);
  writeFileSync(path.join(dataDir, 'artifacts', run.runId, 'configuration.json'), JSON.stringify(snapshot, null, 2), { mode: 0o600 });
  void run.result.then(result => {
    record.status = result.status; record.result = result;
    history.save(record); if (active === run) active = undefined; publishRun(record); change();
  });
  return run;
}

async function startBatch(i: BatchInput, project: Project, groupPlan?: ReturnType<typeof expandGroups>, retry?: { source: import('../shared/workspace.js').BatchRun; mode: import('../shared/workspace.js').RetryMode; items: import('../shared/workspace.js').BatchRun['items'] }): Promise<string> {
  if (occupied() || recorder.active) throw new Error('请先结束运行、录制或窗口连接');
  if (!Array.isArray(i.items) || !i.items.length || i.items.length > 10000) throw new Error('请选择 1 至 10000 个用例');
  if (i.failurePolicy !== 'stop' && i.failurePolicy !== 'continue') throw new Error('请选择失败处理方式');
  const snapshot = retry?.source.snapshot ? { ...structuredClone(retry.source.snapshot), variables: validateVariables(i.variables ?? retry.source.snapshot.variables) } : configurationSnapshot(project, i.environmentId, i);
  const executionEnvironment = modelEnvironment();
  // Model identifiers stay fixed for the batch, including a retry. Credentials remain local.
  for (const key of ['MIDSCENE_MODEL_NAME', 'MIDSCENE_MODEL_BASE_URL', 'MIDSCENE_MODEL_FAMILY', 'OPENAI_BASE_URL']) delete executionEnvironment[key];
  for (const [key, value] of Object.entries({ MIDSCENE_MODEL_NAME: snapshot.model.name, MIDSCENE_MODEL_BASE_URL: snapshot.model.baseUrl, MIDSCENE_MODEL_FAMILY: snapshot.model.family })) if (value) executionEnvironment[key] = value;
  const plans = i.items.map((entry, index) => {
    const plan = prepareRun({ ...entry, ...i, caseId: entry.caseId, workflowId: entry.workflowId, datasetId: entry.datasetId, browserMode: 'bridge' }, project, snapshot, retry?.items[index]?.definition);
    assertWorkflowModel(plan.validation, snapshot.model.name);
    const session = sessions.get(entry.sessionId);
    targetFor({ ...plan.input, sessionId: entry.sessionId }, snapshot.baseUrl);
    if (!session) throw new Error(`请为 ${plan.item.name} 选择运行标签页`);
    return { plan, session: structuredClone(session) };
  });
  preparing = true;
  try {
    await recorder.release();
    if (quitting) throw new Error('应用正在退出');
    return batchQueue.start({ projectId: i.projectId, environmentId: i.environmentId, environment: plans[0]!.plan.environment.name, failurePolicy: i.failurePolicy, snapshot, dependent: i.dependent,
      ...(retry ? { sourceBatchId: retry.source.id, retryMode: retry.mode, groups: retry.source.groups } : groupPlan ? { groups: groupPlan.groups } : {}),
      items: plans.map(({ plan, session }, index) => ({ caseId: plan.item.id, caseName: plan.item.name, workflowId: plan.input.workflowId, sessionName: session.info.name, sessionId: session.info.id,
        definition: plan.sourceText, definitionHash: plan.revision, datasetId: plan.input.datasetId,
        groupNames: retry?.items[index]?.groupNames ?? groupPlan?.groupNames.get(plan.item.id), status: 'queued' })) },
      (index, batchId) => { const { plan, session } = plans[index]!; return launchRun(plan, session.target, batchId, session.info.name, executionEnvironment); });
  } finally { preparing = false; }
}

function recordingDefinition(input: Parameters<typeof buildRecordedWorkflow>[0] & { id: string }) {
  const draft = recorder.require(input.id);
  if (recorder.active) throw new Error('请先停止录制');
  const text = buildRecordedWorkflow({ name: draft.caseName, events: draft.events, choices: input.choices, assertions: input.assertions, steps: input.steps,
    ...(draft.browserMode === 'bridge' ? { viewport: draft.viewport, startUrl: draft.startUrl } : {}), baseUrl: draft.baseUrl });
  return draft.replace ? mergeRecordedWorkflow(draft.replace.originalText, text, draft.replace.start, draft.replace.deleteCount) : text;
}

const handlers: Record<string, (input: any) => unknown> = {
  appInfo: () => ({ dataDirectory: dataDir, update: updates.state() }),
  checkUpdate: () => updates.check(),
  downloadUpdate: () => updates.download(),
  installUpdate: async () => {
    if (occupied() || recorder.active) throw new Error('请先结束测试和录制，再安装更新');
    if (updates.state().status !== 'downloaded') throw new Error('更新尚未下载完成');
    preparing = true;
    try { await Promise.all([recorder.shutdown(), browserProfiles.destroy()]); quitting = true; updates.install(); }
    finally { preparing = false; }
  },
  state: () => ({ ...store.list(), runs: [...new Map([...history.query({ limit: 50 }).runs, ...history.latestByCase()].map(run => [run.runId, run])).values()].sort((a,b) => b.startedAt.localeCompare(a.startedAt)), activeRunId: active?.runId, batches: history.batches(), sessions: [...sessions.values()].map(s => s.info), activeBatchId: batchQueue.active?.id, connectingSession, recording: publicDraft(), model: modelSettings() }),
  history: i => history.query(i),
  runDetail: i => { const run = history.get(i.runId); if (!run) throw new Error('运行记录不存在'); return run; },
  saveAssets: i => store.saveAssets(i),
  gitStatus: i => gitInfo(store.project(i.projectId).root),
  preflight: (i: RunInput): PreflightResult => {
    const checks: PreflightResult['checks'] = [];
    try {
      const plan = prepareRun(i); const target = targetFor(i, plan.snapshot.baseUrl);
      checks.push({ name: 'Workflow', status: 'passed', message: `${plan.validation.steps} 个步骤，变量和共享步骤校验通过` });
      checks.push({ name: '运行环境', status: 'passed', message: plan.snapshot.baseUrl });
      checks.push({ name: '运行目标', status: 'passed', message: target ? `Profile ${target.profile?.connectorId ?? 'Midscene'} · 标签页 ${target.tabId}` : '独立浏览器会话' });
      const needsModel = plan.validation.needsModel;
      const modelName = plan.snapshot.model.name.trim();
      checks.push({ name: '模型', status: needsModel && !modelName ? 'failed' : 'info', message: needsModel ? (modelName ? `使用 ${modelName}；实际模型调用在执行时验证` : '请先配置模型名称') : '本次没有 AI 步骤' });
      if (plan.snapshot.loginCondition) checks.push({ name: '登录条件', status: 'info', message: '执行前检查：' + plan.snapshot.loginCondition });
      return { ready: checks.every(c => c.status !== 'failed'), checks, variables: plan.validation.compiled.variables, steps: plan.validation.steps };
    } catch (error) { checks.push({ name: '运行检查', status: 'failed', message: String(error instanceof Error ? error.message : error) }); return { ready: false, checks, variables: {}, steps: 0 }; }
  },
  retryBatch: (i: RetryBatchInput) => {
    const source = history.batch(i.id); if (!source) throw new Error('原批次不存在');
    if (!source.snapshot || !source.environmentId) throw new Error('旧批次没有完整配置快照，请配置新批次');
    const items = retryItems(source, i.mode), project = store.project(source.projectId);
    if (items.some(item => !item.definition)) throw new Error('原批次缺少用例快照，请配置新批次');
    return startBatch({ projectId: source.projectId, environmentId: source.environmentId, failurePolicy: source.failurePolicy, dependent: source.dependent, variables: i.variables ?? source.snapshot.variables,
      items: items.map(item => ({ caseId: item.caseId, workflowId: item.workflowId, datasetId: item.datasetId, sessionId: i.sessionId })) }, project, undefined, { source, mode: i.mode, items });
  },
  createProject: (i) => store.create(i.name, i.description ?? ''),
  openProject: async () => {
    const result = await dialog.showOpenDialog(mainWindow, { title: '打开包含 workspace.yaml 的项目文件夹', properties: ['openDirectory'] });
    return result.canceled ? null : store.open(result.filePaths[0]!);
  },
  saveGroup: (i) => store.saveGroup(i),
  deleteGroup: (i) => store.deleteGroup(i.projectId, i.id, i.revision),
  createSuite: (i) => store.createSuite(i.projectId, i.name),
  createCase: (i) => store.createCase(i.projectId, i.name, i.suiteId, i.platforms),
  saveCase: (i) => store.saveCase(i),
  bulkCases: (i) => {
    if (occupied()) throw new Error('请等待当前运行或浏览器连接结束后再批量操作');
    const draft = recorder.draft;
    if (draft && draft.status !== 'saved' && draft.projectId === i.projectId && i.cases.some((item: { id: string }) => item.id === draft.caseId)) {
      throw new Error('所选用例有未保存的录制，请先保存或放弃录制');
    }
    return store.bulkCases(i);
  },
  workflow: (i) => store.workflow(i.projectId, i.caseId, i.workflowId),
  importFile: async () => {
    const result = await dialog.showOpenDialog(mainWindow, { properties: ['openFile'], filters: [{ name: 'Midscene Workflow', extensions: ['yaml', 'yml'] }] });
    return result.canceled ? null : readFileSync(result.filePaths[0]!, 'utf8');
  },
  saveWorkflow: (i) => {
    const { platform } = store.workflowLocation(i.projectId, i.caseId, i.workflowId);
    if (platform === 'web') validateWorkflow(i.text, { flows: store.project(i.projectId).assets?.flows }, true);
    store.saveWorkflow(i);
  },
  saveEnvironment: (i) => store.saveEnvironment(i),
  run: async (i) => {
    if (occupied()) throw new Error('已有测试正在运行或会话正在连接，请等待完成或先取消');
    if (recorder.active) throw new Error('请先停止录制，再运行测试');
    const plan = prepareRun(i);
    assertWorkflowModel(plan.validation, plan.snapshot.model.name);
    const chromeTarget = targetFor(i, plan.snapshot.baseUrl);
    preparing = true;
    try {
      await recorder.release();
      if (quitting) throw new Error('应用正在退出');
      return launchRun(plan, chromeTarget).runId;
    } finally { preparing = false; }
  },
  browserProfiles: () => browserProfiles.list(),
  addBrowserProfile: () => browserOperation(() => browserProfiles.create()),
  refreshBrowserProfile: (i) => browserOperation(() => browserProfiles.refresh(i.id)),
  focusBrowserTab: (i) => browserOperation(() => browserProfiles.focus(i.profileId, i.tabId)),
  useBrowserTab: (i) => browserOperation(async () => {
    const project = store.project(i.projectId);
    const environment = project.environments.find(e => e.id === i.environmentId);
    if (!environment) throw new Error('请选择运行环境');
    const { target, tab, profile } = await browserProfiles.capture(i.profileId, i.tabId, new URL(environment.web.baseUrl).origin);
    for (const [key, previous] of chromeTargets) if (sameTab(previous, target)) chromeTargets.set(key, target);
    for (const session of sessions.values()) if (sameTab(session.target, target)) session.target = target;
    const existing = [...sessions.values()].find(s => sameTab(s.target, target) && s.info.projectId === i.projectId && s.info.environmentId === i.environmentId);
    const id = existing?.info.id ?? randomUUID();
    const name = `${profile.name} · 窗口 ${tab.windowId} · ${tab.title || tab.url}`;
    sessions.set(id, { info: { id, name, projectId: i.projectId, environmentId: i.environmentId, origin: target.origin,
      profileId: profile.id, profileName: profile.name, profileInstallationId: profile.profileInstallationId,
      tabId: tab.tabId, windowId: tab.windowId, title: tab.title, url: tab.url }, target });
    return id;
  }),
  removeBrowserProfile: (i) => browserOperation(async () => {
    browserProfiles.remove(i.id);
    for (const [id, session] of sessions) if (session.info.profileId === i.id) sessions.delete(id);
    for (const [key, target] of chromeTargets) if (target.profile?.connectorId === i.id) chromeTargets.delete(key);
  }),
  openBrowserConnector: async () => {
    const directory = app.isPackaged ? path.join(process.resourcesPath, 'browser-extension') : path.join(root, 'dist-browser-extension');
    if (!existsSync(path.join(directory, 'manifest.json'))) throw new Error('连接扩展尚未构建，请先运行 npm run build:connector');
    const error = await shell.openPath(directory);
    if (error) throw new Error(error);
  },
  copyBrowserPairingCode: (i) => {
    const profile = browserProfiles.list().find(profile => profile.id === i.id);
    if (!profile) throw new Error('浏览器配置不存在');
    clipboard.writeText(profile.pairingCode);
  },
  captureSession: async (i) => {
    if (occupied() || recorder.active) throw new Error('请先结束运行或录制，再确认登录窗口');
    const name = typeof i.name === 'string' ? i.name.trim() : '';
    if (!name || name.length > 80) throw new Error('请输入不超过 80 字的窗口名称');
    const project = store.list().projects.find(p => p.id === i.projectId);
    const environment = project?.environments.find(e => e.id === i.environmentId);
    if (!environment) throw new Error('请选择运行环境');
    preparing = true; connectingSession = true; change();
    try {
      await recorder.release();
      if (quitting) throw new Error('应用正在退出');
      connectionResult = captureChromeSession(new URL(environment.web.baseUrl).origin);
      const target = await connectionResult;
      // Reconfirming a tab refreshes all bindings to its new token.
      for (const [key, previous] of chromeTargets) if (sameTab(previous, target)) chromeTargets.set(key, target);
      for (const session of sessions.values()) if (sameTab(session.target, target)) session.target = target;
      const existing = [...sessions.values()].find(s => sameTab(s.target, target) && s.info.projectId === i.projectId && s.info.environmentId === i.environmentId);
      const id = existing?.info.id ?? randomUUID();
      sessions.set(id, { info: { id, name, projectId: i.projectId, environmentId: i.environmentId, origin: target.origin }, target });
      return id;
    } finally { preparing = false; connectingSession = false; connectionResult = undefined; change(); }
  },
  runBatch: (i: BatchInput) => startBatch(i, store.project(i.projectId)),
  runGroups: (i: GroupBatchInput) => {
    if (occupied() || recorder.active) throw new Error('请先结束运行、录制或窗口连接');
    const project = store.project(i.projectId);
    const groupPlan = expandGroups(project, i.groupIds);
    const cases = new Map(project.cases.map(item => [item.id, item]));
    return startBatch({ projectId: i.projectId, environmentId: i.environmentId, failurePolicy: i.failurePolicy, variables: i.variables, timeoutMs: i.timeoutMs, loginCondition: i.loginCondition, dependent: i.dependent,
      items: groupPlan.caseIds.map(caseId => ({ caseId, workflowId: cases.get(caseId)!.workflows.find(workflow => workflow.platform === 'web')!.id, sessionId: i.sessionId, datasetId: i.datasetIds?.[caseId] || undefined })) }, project, groupPlan);
  },
  cancelBatch: (i) => batchQueue.cancel(i.id),
  startRecording: async (i) => {
    if (occupied()) throw new Error('请先等待测试结束，再开始录制');
    const { project, item } = store.caseLocation(i.projectId, i.caseId);
    const { platform } = store.workflowLocation(i.projectId, i.caseId, i.workflowId);
    if (platform !== 'web') throw new Error('当前只支持 Web 录制');
    const environment = project.environments.find((e) => e.id === i.environmentId);
    if (!environment) throw new Error('请选择录制环境');
    const current = store.workflow(i.projectId, i.caseId, i.workflowId);
    if (i.replace) {
      if (i.replace.revision !== current.revision || i.replace.originalText !== current.text) throw new Error('Workflow 已被修改，请重新打开编辑器再录制');
      const count = parseWorkflow(current.text).cases[0]!.steps.length;
      if (!Number.isInteger(i.replace.start) || !Number.isInteger(i.replace.deleteCount) || i.replace.start < 0 || i.replace.deleteCount < 0 || i.replace.start + i.replace.deleteCount > count) throw new Error('局部录制位置无效');
    }
    const chromeTarget = i.browserMode === 'bridge' ? targetFor(i, environment.web.baseUrl) : undefined;
    preparing = true;
    try { return await recorder.start({ projectId: project.id, caseId: item.id, workflowId: i.workflowId, caseName: item.name, environmentId: environment.id, baseUrl: environment.web.baseUrl, revision: current.revision, browserMode: i.browserMode === 'bridge' ? 'bridge' : 'isolated', chromeTarget, replace: i.replace, existingWorkflow: existsSync(store.workflowLocation(i.projectId, i.caseId, i.workflowId).file) }, modelEnvironment());
    } finally { preparing = false; }
  },
  retryRecording: async (i) => {
    if (occupied()) throw new Error('请先等待测试结束，再重试连接');
    preparing = true;
    try { await recorder.retry(i.id, modelEnvironment()); }
    finally { preparing = false; }
  },
  confirmChromeSession: async (i) => {
    if (occupied()) throw new Error('已有测试或窗口连接正在进行');
    preparing = true;
    try {
      await recorder.confirm(i.id);
      const draft = recorder.require(i.id);
      if (draft.chromeTarget) {
        chromeTargets.set(chromeKey(draft), draft.chromeTarget);
        for (const session of sessions.values()) if (sameTab(session.target, draft.chromeTarget)) session.target = draft.chromeTarget;
      }
    } finally { preparing = false; }
  },
  beginRecording: async (i) => {
    if (occupied()) throw new Error('已有测试或窗口连接正在进行');
    preparing = true;
    try {
      await recorder.begin(i.id);
      const draft = recorder.require(i.id);
      if (draft.chromeTarget) {
        chromeTargets.set(chromeKey(draft), draft.chromeTarget);
        for (const session of sessions.values()) if (sameTab(session.target, draft.chromeTarget)) session.target = draft.chromeTarget;
      }
    } finally { preparing = false; }
  },
  recordingFrame: (i) => recorder.frame(i.id),
  recordingScreenshot: (i) => recorder.screenshot(i.id, i.hashId),
  recordingInteract: (i) => recorder.interact(i.id, i.action),
  stopRecording: (i) => recorder.stop(i.id),
  discardRecording: (i) => recorder.discard(i.id),
  buildRecording: (i) => recordingDefinition(i),
  saveRecording: (i) => {
    const draft = recorder.require(i.id);
    if (draft.status === 'saved') throw new Error('本次录制已经保存');
    const text = recordingDefinition(i);
    validateWorkflow(text, { flows: store.project(draft.projectId).assets?.flows }, true);
    store.saveWorkflow({ projectId: draft.projectId, caseId: draft.caseId, workflowId: draft.workflowId, revision: draft.revision, text });
    recorder.saved(i.id);
  },
  cancelRun: () => { if (batchQueue.active) batchQueue.cancel(batchQueue.active.id); else active?.cancel(); },
  runPlan: (i) => {
    const run = history.get(i.runId);
    if (!run) throw new Error('运行记录不存在');
    const planned = run.events.find(e => e.type === 'steps-planned');
    if (planned?.type === 'steps-planned') return planned.steps;
    if (!/^[a-zA-Z0-9-]+$/.test(i.runId)) throw new Error('无效运行记录');
    const file = path.join(dataDir, 'artifacts', i.runId, 'workflow.yaml');
    return existsSync(file) ? runPlanFromYaml(parse(readFileSync(file, 'utf8'))) : [];
  },
  runScreenshot: (i) => {
    const run = history.get(i.runId);
    if (!run || !/^[a-zA-Z0-9-]+$/.test(i.runId) || !/^(steps|beforeAll|beforeEach|afterEach|afterAll)-\d+-(before|after|failed)\.(png|jpg)$/.test(i.image)) throw new Error('运行截图不存在');
    if (!run.events.some(e => e.type === 'step-evidence' && e.image === i.image)) throw new Error('运行截图不属于本次运行');
    const directory = realpathSync(path.join(dataDir, 'artifacts', i.runId, 'steps'));
    const relative = path.relative(realpathSync(path.join(dataDir, 'artifacts')), directory);
    const file = realpathSync(path.join(directory, i.image));
    if (relative.startsWith('..') || path.isAbsolute(relative) || path.dirname(file) !== directory) throw new Error('无效截图路径');
    return `data:image/${i.image.endsWith('.jpg') ? 'jpeg' : 'png'};base64,${readFileSync(file).toString('base64')}`;
  },
  exportRun: async (i) => {
    const run = history.get(i.runId);
    if (!run?.result || run.status === 'running') throw new Error('请等待运行结束后导出报告');
    const selected = await dialog.showSaveDialog(mainWindow, { title: '导出运行报告', defaultPath: `Testo-${run.runId}.zip`, filters: [{ name: 'ZIP 报告包', extensions: ['zip'] }] });
    if (selected.canceled || !selected.filePath) return null;
    return exportRunBundle(run, selected.filePath);
  },
  openReport: async (i) => {
    const report = history.get(i.runId)?.result?.reportPaths[0];
    if (!report || !existsSync(report)) throw new Error('本次运行没有可用报告');
    const relative = path.relative(realpathSync(path.join(dataDir, 'artifacts')), realpathSync(report));
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('报告不在运行产物目录内');
    const window = new BrowserWindow({ width: 1300, height: 900, title: 'Midscene Report', webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event) => event.preventDefault());
    await window.loadFile(report);
  },
  saveModel: (i) => {
    if (i.baseUrl && !/^https?:$/.test(new URL(i.baseUrl).protocol)) throw new Error('模型服务地址必须使用 HTTP 或 HTTPS');
    const previous = modelData();
    let encryptedKey = previous.encryptedKey;
    if (i.apiKey) {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('系统凭证加密服务不可用，未保存 API Key');
      encryptedKey = safeStorage.encryptString(i.apiKey).toString('base64');
    }
    writeFileSync(modelFile, JSON.stringify({ name: i.name, baseUrl: i.baseUrl, family: i.family, encryptedKey }), { mode: 0o600 });
  },
};
ipcMain.handle('workspace:call', async (event, name: string, input: unknown) => {
  if (event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame || !Object.hasOwn(handlers, name)) return { ok: false, error: '不允许的操作' };
  try {
    const value = await handlers[name]!(input);
    if (!['appInfo', 'state', 'history', 'runDetail', 'gitStatus', 'preflight', 'runPlan', 'runScreenshot', 'browserProfiles', 'copyBrowserPairingCode', 'openBrowserConnector', 'workflow', 'importFile', 'exportRun', 'openReport', 'recordingFrame', 'recordingScreenshot', 'buildRecording'].includes(name)) change();
    return { ok: true, value };
  } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
});

function createWindow(): void {
  mainWindow = new BrowserWindow({ width: 1380, height: 900, minWidth: 980, minHeight: 680, title: 'Testo', backgroundColor: '#f8f9fc', titleBarStyle: 'hiddenInset', webPreferences: { preload: path.join(root, 'src/preload/index.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false } });
  mainWindow.webContents.session.webRequest.onBeforeSendHeaders({ urls: ['http://127.0.0.1:*/*'] }, (details, callback) => {
    const token = details.webContentsId === mainWindow.webContents.id ? recorder.authorization(details.url) : undefined;
    callback({ requestHeaders: { ...details.requestHeaders, ...(token ? { 'X-Workspace-Recorder-Token': token } : {}) } });
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  void mainWindow.loadFile(uiFile);
}
app.on('before-quit', (event) => {
  if (!quitting) {
    event.preventDefault(); quitting = true;
    if (batchQueue.active) batchQueue.cancel(batchQueue.active.id);
    active?.cancel(); void Promise.allSettled([browserProfiles.destroy(), connectionResult, batchQueue.result, active?.result, recorder.shutdown()]).finally(() => app.quit());
  }
});
app.on('window-all-closed', () => app.quit());
createWindow();
}).catch((error) => { console.error(error); app.exit(1); });
