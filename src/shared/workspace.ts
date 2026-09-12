import type { Variables, DebugSelection } from './workflow-document.js';
import type { ChromeProfileInfo } from './browser.js';
import type { RecordingDraft, RecordingFrame, RecordingInteraction } from './recording.js';
import type { RecordingStepChoice, RecordingAssertion, RecordingReviewStep } from '../recording/workflow.js';
import type { RunResult, WorkerEvent } from '../runner/messages.js';

export interface Suite { id: string; name: string; directory: string }
export interface TestGroup { id: string; name: string; description: string; caseIds: string[]; revision: string }
export interface SaveGroupInput { projectId: string; id?: string; revision?: string; name: string; description: string; caseIds: string[] }
export interface GroupBatchInput extends RunConfiguration { projectId: string; environmentId: string; failurePolicy: 'stop' | 'continue'; sessionId: string; groupIds: string[]; datasetIds?: Record<string, string> }
export interface Environment { id: string; name: string; web: { baseUrl: string }; variables?: Variables }
export interface Workflow { id: string; platform: 'web' | 'android' | 'ios'; definitionPath: string; ready: boolean }
export interface TestCase {
  id: string; name: string; description: string; suiteId: string; priority: string;
  tags: string[]; workflows: Workflow[]; revision: string;
}
export interface Project {
  id: string; name: string; description: string; root: string;
  assets?: ProjectAssets; groups?: TestGroup[]; suites: Suite[]; cases: TestCase[]; environments: Environment[]; errors: string[];
}
export interface HistoryRun {
  runId: string; projectId: string; caseId: string; caseName: string; environment: string;
  status: 'running' | 'interrupted' | RunResult['status']; startedAt: string;
  batchId?: string; sessionName?: string; snapshot?: RunSnapshot;
  result?: RunResult; events: WorkerEvent[];
}
export interface BrowserSession {
  id: string; name: string; projectId: string; environmentId: string; origin: string;
  profileId?: string; profileName?: string; profileInstallationId?: string;
  tabId?: string; windowId?: number; title?: string; url?: string;
}
export interface BatchInput extends RunConfiguration {
  projectId: string; environmentId: string; failurePolicy: 'stop' | 'continue';
  items: { caseId: string; workflowId: string; sessionId: string; datasetId?: string }[];
}
export interface BatchRun {
  id: string; projectId: string; environment: string; startedAt: string; finishedAt?: string;
  groups?: { id: string; name: string }[]; environmentId?: string; sourceBatchId?: string; retryMode?: RetryMode; snapshot?: RunSnapshot; dependent?: boolean;
  failurePolicy: 'stop' | 'continue'; status: 'running' | 'passed' | 'failed' | 'cancelled' | 'interrupted';
  items: { caseId: string; caseName: string; workflowId: string; sessionName: string; sessionId?: string; datasetId?: string; definition?: string; definitionHash?: string; groupNames?: string[];
    status: 'queued' | 'running' | 'skipped' | 'interrupted' | RunResult['status']; runId?: string; error?: string }[];
}
export interface ProjectAssets { revision: string; variables: Variables; flows: Record<string, { name: string; steps: Record<string, unknown>[] }> }
export interface RunConfiguration { variables?: Variables; timeoutMs?: number; loginCondition?: string; dependent?: boolean }
export type RetryMode = 'failed' | 'unfinished' | 'all';
export interface RunSnapshot { environmentId: string; baseUrl: string; variables: Variables; defaults?: Variables; flows?: ProjectAssets['flows']; model: { name: string; baseUrl: string; family: string }; git?: { commit?: string; branch?: string; dirty: boolean }; timeoutMs?: number; loginCondition?: string }
export interface RunInput extends RunConfiguration { projectId: string; caseId: string; workflowId: string; environmentId: string; browserMode?: 'isolated' | 'bridge'; sessionId?: string; datasetId?: string; debug?: DebugSelection }
export interface RetryBatchInput { id: string; mode: RetryMode; sessionId: string; variables?: Variables }
export interface PreflightResult { ready: boolean; checks: { name: string; status: 'passed' | 'failed' | 'info'; message: string }[]; variables: Variables; steps: number }
export interface HistoryQuery { projectId?: string; caseId?: string; status?: string; environment?: string; after?: string; before?: string; offset?: number; limit?: number }
export interface HistoryPage { runs: HistoryRun[]; total: number }
export interface ModelSettings { name: string; baseUrl: string; family: string; hasApiKey: boolean }
export interface WorkspaceState { projects: Project[]; runs: HistoryRun[]; batches?: BatchRun[]; sessions?: BrowserSession[]; activeBatchId?: string; connectingSession?: boolean; activeRunId?: string; recording?: RecordingDraft; model: ModelSettings; errors: string[] }
export interface UpdateState { version: string; enabled: boolean; status: 'idle' | 'checking' | 'current' | 'available' | 'downloading' | 'downloaded' | 'error'; message: string; nextVersion?: string; percent?: number }
export interface DesktopApi {
  appInfo(): Promise<{ dataDirectory: string; update: UpdateState }>;
  checkUpdate(): Promise<UpdateState>;
  downloadUpdate(): Promise<UpdateState>;
  installUpdate(): Promise<void>;
  state(): Promise<WorkspaceState>;
  createProject(input: { name: string; description: string }): Promise<string>;
  openProject(): Promise<string | null>;
  saveGroup(input: SaveGroupInput): Promise<string>;
  deleteGroup(input: { projectId: string; id: string; revision: string }): Promise<void>;
  runGroups(input: GroupBatchInput): Promise<string>;
  createSuite(input: { projectId: string; name: string }): Promise<string>;
  createCase(input: { projectId: string; name: string; suiteId: string; platforms: string[] }): Promise<string>;
  saveCase(input: { projectId: string; caseId: string; revision: string; name: string; description: string; priority: string; tags: string[] }): Promise<void>;
  workflow(input: { projectId: string; caseId: string; workflowId: string }): Promise<{ text: string; revision: string }>;
  importFile(): Promise<string | null>;
  saveWorkflow(input: { projectId: string; caseId: string; workflowId: string; text: string; revision: string }): Promise<void>;
  saveEnvironment(input: { projectId: string; id?: string; name: string; baseUrl: string; variables?: Variables }): Promise<void>;
  run(input: RunInput): Promise<string>;
  preflight(input: RunInput): Promise<PreflightResult>;
  saveAssets(input: { projectId: string; revision: string; variables: Variables; flows: ProjectAssets['flows'] }): Promise<ProjectAssets>;
  retryBatch(input: RetryBatchInput): Promise<string>;
  history(input: HistoryQuery): Promise<HistoryPage>;
  runDetail(input: { runId: string }): Promise<HistoryRun>;
  exportRun(input: { runId: string }): Promise<string | null>;
  gitStatus(input: { projectId: string }): Promise<{ branch: string; commit: string; status: string; diff: string }>;
  cancelRun(): Promise<void>;
  browserProfiles(): Promise<ChromeProfileInfo[]>;
  addBrowserProfile(): Promise<ChromeProfileInfo>;
  refreshBrowserProfile(input: { id: string }): Promise<ChromeProfileInfo>;
  focusBrowserTab(input: { profileId: string; tabId: string }): Promise<void>;
  useBrowserTab(input: { projectId: string; environmentId: string; profileId: string; tabId: string }): Promise<string>;
  removeBrowserProfile(input: { id: string }): Promise<void>;
  openBrowserConnector(): Promise<void>;
  copyBrowserPairingCode(input: { id: string }): Promise<void>;
  captureSession(input: { projectId: string; environmentId: string; name: string }): Promise<string>;
  runBatch(input: BatchInput): Promise<string>;
  cancelBatch(input: { id: string }): Promise<void>;
  runPlan(input: { runId: string }): Promise<import('./run-steps.js').RunStepInfo[]>;
  runScreenshot(input: { runId: string; image: string }): Promise<string>;
  retryRecording(input: { id: string }): Promise<void>;
  openReport(input: { runId: string }): Promise<void>;
  saveModel(input: { name: string; baseUrl: string; family: string; apiKey: string }): Promise<void>;
  startRecording(input: { projectId: string; caseId: string; workflowId: string; environmentId: string; browserMode?: 'isolated' | 'bridge'; sessionId?: string; replace?: { revision: string; start: number; deleteCount: number; originalText: string } }): Promise<string>;
  confirmChromeSession(input: { id: string }): Promise<void>;
  beginRecording(input: { id: string }): Promise<void>;
  recordingFrame(input: { id: string }): Promise<RecordingFrame>;
  recordingScreenshot(input: { id: string; hashId: string }): Promise<string>;
  recordingInteract(input: { id: string; action: RecordingInteraction }): Promise<void>;
  stopRecording(input: { id: string }): Promise<void>;
  discardRecording(input: { id: string }): Promise<void>;
  buildRecording(input: { id: string; choices: RecordingStepChoice[]; assertions?: RecordingAssertion[]; steps?: RecordingReviewStep[] }): Promise<string>;
  saveRecording(input: { id: string; choices: RecordingStepChoice[]; assertions?: RecordingAssertion[]; steps?: RecordingReviewStep[] }): Promise<void>;
  onRunChange(listener: (run: HistoryRun) => void): () => void;
  onChange(listener: () => void): () => void;
}

declare global { interface Window { workspace: DesktopApi } }
