import { app, BrowserWindow, dialog, ipcMain, safeStorage } from 'electron';
import { mkdirSync, existsSync, readFileSync, writeFileSync, realpathSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { collectWorkflowDocument, NodeRegistry } from '@midscene/test';
import { createMidsceneNodes } from '@midscene/test/midscene';
import { createPlaywrightNodes } from '@midscene/test/playwright';
import { PlaywrightAgent } from '@midscene/web/playwright';
import { WorkspaceStore } from './workspace.js';
import { RecordingService } from './recording.js';
import { buildRecordedWorkflow } from '../recording/workflow.js';
import { createRecordedNodes } from '../runner/recorded-nodes.js';
import { HistoryStore } from './history.js';
import { startRun, type RunHandle } from '../runner/run.js';
import type { HistoryRun, ModelSettings } from '../shared/workspace.js';

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
      ...createMidsceneNodes({ agentClass: PlaywrightAgent, getAgent: unavailable }),
    ]);
    const document = collectWorkflowDocument({ projectId: 'validation', sourcePath: draft, absolutePath: draft }, {
      resolveNode: (name) => registry.get(name), variables: { baseUrl: 'http://localhost' }, env: process.env,
    });
    if (document.cases.length !== 1) throw new Error('每个平台 Workflow 必须只包含一个 Case');
  } finally { if (existsSync(draft)) unlinkSync(draft); }
}

const handlers: Record<string, (input: any) => unknown> = {
  state: () => ({ ...store.list(), runs: history.list(), activeRunId: active?.runId, recording: recorder.draft, model: modelSettings() }),
  createProject: (i) => store.create(i.name, i.description ?? ''),
  openProject: async () => {
    const result = await dialog.showOpenDialog(mainWindow, { title: '打开包含 workspace.yaml 的项目文件夹', properties: ['openDirectory'] });
    return result.canceled ? null : store.open(result.filePaths[0]!);
  },
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
  run: (i) => {
    if (active) throw new Error('已有测试正在运行，请等待完成或先取消');
    if (recorder.active) throw new Error('请先停止录制，再运行测试');
    const { project, item } = store.caseLocation(i.projectId, i.caseId);
    const { file, platform } = store.workflowLocation(i.projectId, i.caseId, i.workflowId);
    if (platform !== 'web') throw new Error('当前版本只支持执行 Web Workflow');
    const environment = project.environments.find((e) => e.id === i.environmentId);
    if (!environment) throw new Error('请选择运行环境');
    const environmentVariables = modelEnvironment();
    const run = startRun({ workflowPath: file, baseUrl: environment.web.baseUrl, artifactRoot: path.join(dataDir, 'artifacts'), channel: 'chrome', headless: false }, (event) => {
      record.events.push(event);
      history.save(record);
      change();
    }, environmentVariables);
    const record: HistoryRun = { runId: run.runId, projectId: project.id, caseId: item.id, caseName: item.name, environment: environment.name, status: 'running', startedAt: new Date().toISOString(), events: [] };
    active = run;
    history.save(record);
    void run.result.then((result) => {
      record.status = result.status; record.result = result;
      history.save(record); active = undefined; change();
    });
    return run.runId;
  },
  startRecording: (i) => {
    if (active) throw new Error('请先等待测试结束，再开始录制');
    const { project, item } = store.caseLocation(i.projectId, i.caseId);
    const { platform } = store.workflowLocation(i.projectId, i.caseId, i.workflowId);
    if (platform !== 'web') throw new Error('当前只支持 Web 录制');
    const environment = project.environments.find((e) => e.id === i.environmentId);
    if (!environment) throw new Error('请选择录制环境');
    return recorder.start({ projectId: project.id, caseId: item.id, workflowId: i.workflowId, caseName: item.name, environmentId: environment.id, baseUrl: environment.web.baseUrl, revision: store.workflow(i.projectId, i.caseId, i.workflowId).revision }, modelEnvironment());
  },
  recordingFrame: (i) => recorder.frame(i.id),
  recordingScreenshot: (i) => recorder.screenshot(i.id, i.hashId),
  recordingInteract: (i) => recorder.interact(i.id, i.action),
  stopRecording: (i) => recorder.stop(i.id),
  discardRecording: (i) => recorder.discard(i.id),
  buildRecording: (i) => {
    const draft = recorder.require(i.id);
    if (recorder.active) throw new Error('请先停止录制');
    return buildRecordedWorkflow({ name: draft.caseName, events: draft.events, choices: i.choices, assertions: i.assertions });
  },
  saveRecording: (i) => {
    const draft = recorder.require(i.id);
    if (recorder.active) throw new Error('请先停止录制');
    if (draft.status === 'saved') throw new Error('本次录制已经保存');
    const text = buildRecordedWorkflow({ name: draft.caseName, events: draft.events, choices: i.choices, assertions: i.assertions });
    validateWorkflow(text);
    store.saveWorkflow({ projectId: draft.projectId, caseId: draft.caseId, workflowId: draft.workflowId, revision: draft.revision, text });
    recorder.saved(i.id);
  },
  cancelRun: () => active?.cancel(),
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
    active?.cancel(); void Promise.allSettled([active?.result, recorder.shutdown()]).finally(() => app.quit());
  }
});
app.on('window-all-closed', () => app.quit());
createWindow();
}).catch((error) => { console.error(error); app.exit(1); });
