import { app, BrowserWindow, dialog, ipcMain, safeStorage } from 'electron';
import { mkdirSync, existsSync, readFileSync, writeFileSync, realpathSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { collectWorkflowDocument, NodeRegistry } from '@midscene/test';
import { createMidsceneNodes } from '@midscene/test/midscene';
import { createPlaywrightNodes } from '@midscene/test/playwright';
import { PlaywrightAgent } from '@midscene/web/playwright';
import { WorkspaceStore } from './workspace.js';
import { RecordingService } from './recording.js';
import { captureChromeSession, type ChromeTarget } from '../recording/chrome-bridge.js';
import { buildRecordedWorkflow } from '../recording/workflow.js';
import { createWaitNodes } from '../runner/wait-nodes.js';
import { createRecordedNodes } from '../runner/recorded-nodes.js';
import { parse } from 'yaml';
import { runPlanFromYaml } from '../shared/run-steps.js';
import { expandGroups } from './group-plan.js';
import { BatchQueue } from './batch.js';
import { HistoryStore } from './history.js';
import { startRun, type RunHandle } from '../runner/run.js';
import type { HistoryRun, ModelSettings, BrowserSession, BatchInput, GroupBatchInput, Project } from '../shared/workspace.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const dataDir = path.resolve(process.env.WORKSPACE_DATA_DIR || path.join(root, '.desktop-data'));
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
app.setPath('userData', dataDir);
app.setName('Testing Workspace');
const uiFile = path.join(root, 'dist-ui/index.html');
let mainWindow: BrowserWindow;
let active: RunHandle | undefined;
let quitting = false;
void app.whenReady().then(() => {
const store = new WorkspaceStore(dataDir, path.resolve(process.env.WORKSPACE_PROJECTS_DIR || path.join(root, 'projects')));
const history = new HistoryStore(path.join(dataDir, 'runs.db'));
const modelFile = path.join(dataDir, 'model.json');
const modelData = (): Record<string, string> => existsSync(modelFile) ? JSON.parse(readFileSync(modelFile, 'utf8')) : {};
const modelSettings = (): ModelSettings => {
  const m = modelData();
  return { name: m.name ?? '', baseUrl: m.baseUrl ?? '', family: m.family ?? '', hasApiKey: !!m.encryptedKey };
};
const change = () => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('workspace:changed'); };

const recorder = new RecordingService(dataDir, change);
// Bindings live only for this app session; no cookies or Chrome profile are copied.
const sessions = new Map<string, { info: BrowserSession; target: ChromeTarget }>();
let preparing = false;
let connectingSession = false;
let connectionResult: Promise<ChromeTarget> | undefined;
const batchQueue = new BatchQueue(batch => { history.saveBatch(batch); change(); });
const occupied = () => !!active || !!batchQueue.active || preparing || quitting;
const chromeTargets = new Map<string, ChromeTarget>();
const chromeKey = (i: { projectId: string; caseId: string; workflowId: string; environmentId: string }) => JSON.stringify([i.projectId, i.caseId, i.workflowId, i.environmentId]);

function modelEnvironment(): NodeJS.ProcessEnv {
  const m = modelData();
  const env = { ...process.env };
  for (const [field, key] of [['name', 'MIDSCENE_MODEL_NAME'], ['baseUrl', 'MIDSCENE_MODEL_BASE_URL'], ['family', 'MIDSCENE_MODEL_FAMILY']] as const) {
    if (m[field]) env[key] = m[field];
  }
  if (m.encryptedKey) env.MIDSCENE_MODEL_API_KEY = safeStorage.decryptString(Buffer.from(m.encryptedKey, 'base64'));
  return env;
}
function validateWorkflow(text: string): void {
  const draft = path.join(dataDir, `validate-${randomUUID()}.yaml`);
  try {
    writeFileSync(draft, text, { mode: 0o600 });
    const unavailable = (): never => { throw new Error('校验阶段不能操作浏览器'); };
    const registry = new NodeRegistry([
      ...createPlaywrightNodes({ getPage: unavailable }),
      ...createRecordedNodes({ getPage: unavailable, getAgent: unavailable }),
      ...createWaitNodes(unavailable),
      ...createMidsceneNodes({ agentClass: PlaywrightAgent, getAgent: unavailable }),
    ]);
    const document = collectWorkflowDocument({ projectId: 'validation', sourcePath: draft, absolutePath: draft }, {
      resolveNode: (name) => registry.get(name), variables: { baseUrl: 'http://localhost' }, env: process.env,
    });
    if (document.cases.length !== 1) throw new Error('每个平台 Workflow 必须只包含一个 Case');
  } finally { if (existsSync(draft)) unlinkSync(draft); }
}

const workflowHash = (text: string) => createHash('sha256').update(text).digest('hex');
function prepareRun(i: { projectId: string; caseId: string; workflowId: string; environmentId: string }, project = store.project(i.projectId)) {
  const item = project.cases.find(item => item.id === i.caseId);
  if (!item) throw new Error('用例不存在或无法读取');
  const { file, platform } = store.workflowLocationFromProject(project, i.caseId, i.workflowId);
  if (platform !== 'web') throw new Error('当前版本只支持执行 Web Workflow');
  const environment = project.environments.find(e => e.id === i.environmentId);
  if (!environment) throw new Error('请选择运行环境');
  if (!existsSync(file)) throw new Error(`${item.name} 尚未保存 Workflow`);
  const text = readFileSync(file, 'utf8');
  validateWorkflow(text);
  return { project, item, file, environment, revision: workflowHash(text), input: i };
}
function launchRun(plan: ReturnType<typeof prepareRun>, chromeTarget?: ChromeTarget, batchId?: string, sessionName?: string): RunHandle {
  const current = store.workflowLocationFromProject(plan.project, plan.input.caseId, plan.input.workflowId);
  if (current.file !== plan.file || workflowHash(readFileSync(current.file, 'utf8')) !== plan.revision) {
    throw new Error('排队期间 Workflow 已修改，请重新发起批次');
  }
  const { project, item, file, environment } = plan;
  const environmentVariables = modelEnvironment();
  const run = startRun({ workflowPath: file, baseUrl: environment.web.baseUrl, artifactRoot: path.join(dataDir, 'artifacts'), channel: 'chrome', headless: false, chromeTarget }, event => {
    record.events.push(event); history.save(record); change();
  }, environmentVariables);
  const record: HistoryRun = { runId: run.runId, projectId: project.id, caseId: item.id, caseName: item.name,
    environment: environment.name, status: 'running', startedAt: new Date().toISOString(), events: [], batchId, sessionName };
  active = run;
  history.save(record);
  void run.result.then(result => {
    record.status = result.status; record.result = result;
    history.save(record); if (active === run) active = undefined; change();
  });
  return run;
}

async function startBatch(i: BatchInput, project: Project, groupPlan?: ReturnType<typeof expandGroups>): Promise<string> {
  if (occupied() || recorder.active) throw new Error('请先结束运行、录制或窗口连接');
  if (!Array.isArray(i.items) || !i.items.length || i.items.length > 10000) throw new Error('请选择 1 至 10000 个用例');
  if (i.failurePolicy !== 'stop' && i.failurePolicy !== 'continue') throw new Error('请选择失败处理方式');
  const plans = i.items.map(item => {
    const plan = prepareRun({ ...item, projectId: i.projectId, environmentId: i.environmentId }, project);
    const session = sessions.get(item.sessionId);
    if (!session || session.info.projectId !== i.projectId || session.info.environmentId !== i.environmentId || session.target.origin !== new URL(plan.environment.web.baseUrl).origin) throw new Error(`请为 ${plan.item.name} 选择此环境已确认的登录窗口`);
    return { plan, session: { info: { ...session.info }, target: { ...session.target } } };
  });
  preparing = true;
  try {
    await recorder.release();
    if (quitting) throw new Error('应用正在退出');
    return batchQueue.start({ projectId: i.projectId, environment: plans[0]!.plan.environment.name, failurePolicy: i.failurePolicy, ...(groupPlan ? { groups: groupPlan.groups } : {}),
      items: plans.map(({ plan, session }) => ({ caseId: plan.item.id, caseName: plan.item.name, workflowId: plan.input.workflowId, sessionName: session.info.name, ...(groupPlan ? { groupNames: groupPlan.groupNames.get(plan.item.id) } : {}), status: 'queued' })) },
      (index, batchId) => { const { plan, session } = plans[index]!; return launchRun(plan, session.target, batchId, session.info.name); });
  } finally { preparing = false; }
}

const handlers: Record<string, (input: any) => unknown> = {
  state: () => ({ ...store.list(), runs: history.list(), activeRunId: active?.runId, batches: history.batches(), sessions: [...sessions.values()].map(s => s.info), activeBatchId: batchQueue.active?.id, connectingSession, recording: recorder.draft, model: modelSettings() }),
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
  workflow: (i) => store.workflow(i.projectId, i.caseId, i.workflowId),
  importFile: async () => {
    const result = await dialog.showOpenDialog(mainWindow, { properties: ['openFile'], filters: [{ name: 'Midscene Workflow', extensions: ['yaml', 'yml'] }] });
    return result.canceled ? null : readFileSync(result.filePaths[0]!, 'utf8');
  },
  saveWorkflow: (i) => {
    const { platform } = store.workflowLocation(i.projectId, i.caseId, i.workflowId);
    if (platform === 'web') validateWorkflow(i.text);
    store.saveWorkflow(i);
  },
  saveEnvironment: (i) => store.saveEnvironment(i),
  run: async (i) => {
    if (occupied()) throw new Error('已有测试正在运行或会话正在连接，请等待完成或先取消');
    if (recorder.active) throw new Error('请先停止录制，再运行测试');
    const plan = prepareRun(i);
    const chromeTarget = i.browserMode === 'bridge' ? chromeTargets.get(chromeKey(i)) : undefined;
    if (i.browserMode === 'bridge' && !chromeTarget) throw new Error('请先为此用例和环境连接 Chrome 并确认登录；应用重启后需要重新连接');
    preparing = true;
    try {
      await recorder.release();
      if (quitting) throw new Error('应用正在退出');
      return launchRun(plan, chromeTarget).runId;
    } finally { preparing = false; }
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
      for (const [key, previous] of chromeTargets) if (previous.tabId === target.tabId && previous.origin === target.origin) chromeTargets.set(key, target);
      for (const session of sessions.values()) if (session.target.tabId === target.tabId && session.target.origin === target.origin) session.target = target;
      const existing = [...sessions.values()].find(s => s.target.tabId === target.tabId && s.info.projectId === i.projectId && s.info.environmentId === i.environmentId);
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
    return startBatch({ projectId: i.projectId, environmentId: i.environmentId, failurePolicy: i.failurePolicy,
      items: groupPlan.caseIds.map(caseId => ({ caseId, workflowId: cases.get(caseId)!.workflows.find(workflow => workflow.platform === 'web')!.id, sessionId: i.sessionId })) }, project, groupPlan);
  },
  cancelBatch: (i) => batchQueue.cancel(i.id),
  startRecording: async (i) => {
    if (occupied()) throw new Error('请先等待测试结束，再开始录制');
    const { project, item } = store.caseLocation(i.projectId, i.caseId);
    const { platform } = store.workflowLocation(i.projectId, i.caseId, i.workflowId);
    if (platform !== 'web') throw new Error('当前只支持 Web 录制');
    const environment = project.environments.find((e) => e.id === i.environmentId);
    if (!environment) throw new Error('请选择录制环境');
    preparing = true;
    try { return await recorder.start({ projectId: project.id, caseId: item.id, workflowId: i.workflowId, caseName: item.name, environmentId: environment.id, baseUrl: environment.web.baseUrl, revision: store.workflow(i.projectId, i.caseId, i.workflowId).revision, browserMode: i.browserMode === 'bridge' ? 'bridge' : 'isolated', existingWorkflow: existsSync(store.workflowLocation(i.projectId, i.caseId, i.workflowId).file) }, modelEnvironment());
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
        for (const session of sessions.values()) if (session.target.tabId === draft.chromeTarget.tabId && session.target.origin === draft.chromeTarget.origin) session.target = draft.chromeTarget;
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
        for (const session of sessions.values()) if (session.target.tabId === draft.chromeTarget.tabId && session.target.origin === draft.chromeTarget.origin) session.target = draft.chromeTarget;
      }
    } finally { preparing = false; }
  },
  recordingFrame: (i) => recorder.frame(i.id),
  recordingScreenshot: (i) => recorder.screenshot(i.id, i.hashId),
  recordingInteract: (i) => recorder.interact(i.id, i.action),
  stopRecording: (i) => recorder.stop(i.id),
  discardRecording: (i) => recorder.discard(i.id),
  buildRecording: (i) => {
    const draft = recorder.require(i.id);
    if (recorder.active) throw new Error('请先停止录制');
    return buildRecordedWorkflow({ name: draft.caseName, events: draft.events, choices: i.choices, assertions: i.assertions, steps: i.steps, ...(draft.browserMode === 'bridge' ? { viewport: draft.viewport, startUrl: draft.startUrl } : {}) });
  },
  saveRecording: (i) => {
    const draft = recorder.require(i.id);
    if (recorder.active) throw new Error('请先停止录制');
    if (draft.status === 'saved') throw new Error('本次录制已经保存');
    const text = buildRecordedWorkflow({ name: draft.caseName, events: draft.events, choices: i.choices, assertions: i.assertions, steps: i.steps, ...(draft.browserMode === 'bridge' ? { viewport: draft.viewport, startUrl: draft.startUrl } : {}) });
    validateWorkflow(text);
    store.saveWorkflow({ projectId: draft.projectId, caseId: draft.caseId, workflowId: draft.workflowId, revision: draft.revision, text });
    recorder.saved(i.id);
  },
  cancelRun: () => { if (batchQueue.active) batchQueue.cancel(batchQueue.active.id); else active?.cancel(); },
  runPlan: (i) => {
    const run = history.list().find(r => r.runId === i.runId);
    if (!run) throw new Error('运行记录不存在');
    const planned = run.events.find(e => e.type === 'steps-planned');
    if (planned?.type === 'steps-planned') return planned.steps;
    if (!/^[a-zA-Z0-9-]+$/.test(i.runId)) throw new Error('无效运行记录');
    const file = path.join(dataDir, 'artifacts', i.runId, 'workflow.yaml');
    return existsSync(file) ? runPlanFromYaml(parse(readFileSync(file, 'utf8'))) : [];
  },
  runScreenshot: (i) => {
    const run = history.list().find(r => r.runId === i.runId);
    if (!run || !/^[a-zA-Z0-9-]+$/.test(i.runId) || !/^(steps|beforeAll|beforeEach|afterEach|afterAll)-\d+-(before|after|failed)\.(png|jpg)$/.test(i.image)) throw new Error('运行截图不存在');
    if (!run.events.some(e => e.type === 'step-evidence' && e.image === i.image)) throw new Error('运行截图不属于本次运行');
    const directory = realpathSync(path.join(dataDir, 'artifacts', i.runId, 'steps'));
    const relative = path.relative(realpathSync(path.join(dataDir, 'artifacts')), directory);
    const file = realpathSync(path.join(directory, i.image));
    if (relative.startsWith('..') || path.isAbsolute(relative) || path.dirname(file) !== directory) throw new Error('无效截图路径');
    return `data:image/${i.image.endsWith('.jpg') ? 'jpeg' : 'png'};base64,${readFileSync(file).toString('base64')}`;
  },
  openReport: async (i) => {
    const report = history.list().find((r) => r.runId === i.runId)?.result?.reportPaths[0];
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
    if (!['state', 'workflow', 'importFile', 'openReport', 'recordingFrame', 'recordingScreenshot', 'buildRecording'].includes(name)) change();
    return { ok: true, value };
  } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
});

function createWindow(): void {
  mainWindow = new BrowserWindow({ width: 1380, height: 900, minWidth: 980, minHeight: 680, title: 'Testing Workspace', backgroundColor: '#f8f9fc', titleBarStyle: 'hiddenInset', webPreferences: { preload: path.join(root, 'src/preload/index.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false } });
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
    active?.cancel(); void Promise.allSettled([connectionResult, batchQueue.result, active?.result, recorder.shutdown()]).finally(() => app.quit());
  }
});
app.on('window-all-closed', () => app.quit());
createWindow();
}).catch((error) => { console.error(error); app.exit(1); });
