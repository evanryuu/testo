import type { RecordingDraft, RecordingFrame, RecordingInteraction } from './recording.js';
import type { RecordingStepChoice, RecordingAssertion } from '../recording/workflow.js';
import type { RunResult, WorkerEvent } from '../runner/messages.js';

export interface Suite { id: string; name: string; directory: string }
export interface Environment { id: string; name: string; web: { baseUrl: string } }
export interface Workflow { id: string; platform: 'web' | 'android' | 'ios'; definitionPath: string; ready: boolean }
export interface TestCase {
  id: string; name: string; description: string; suiteId: string; priority: string;
  tags: string[]; workflows: Workflow[]; revision: string;
}
export interface Project {
  id: string; name: string; description: string; root: string;
  suites: Suite[]; cases: TestCase[]; environments: Environment[]; errors: string[];
}
export interface HistoryRun {
  runId: string; projectId: string; caseId: string; caseName: string; environment: string;
  status: 'running' | 'interrupted' | RunResult['status']; startedAt: string;
  result?: RunResult; events: WorkerEvent[];
}
export interface ModelSettings { name: string; baseUrl: string; family: string; hasApiKey: boolean }
export interface WorkspaceState { projects: Project[]; runs: HistoryRun[]; activeRunId?: string; recording?: RecordingDraft; model: ModelSettings; errors: string[] }
export interface DesktopApi {
  state(): Promise<WorkspaceState>;
  createProject(input: { name: string; description: string }): Promise<string>;
  openProject(): Promise<string | null>;
  createSuite(input: { projectId: string; name: string }): Promise<string>;
  createCase(input: { projectId: string; name: string; suiteId: string; platforms: string[] }): Promise<string>;
  saveCase(input: { projectId: string; caseId: string; revision: string; name: string; description: string; priority: string; tags: string[] }): Promise<void>;
  workflow(input: { projectId: string; caseId: string; workflowId: string }): Promise<{ text: string; revision: string }>;
  importFile(): Promise<string | null>;
  saveWorkflow(input: { projectId: string; caseId: string; workflowId: string; text: string; revision: string }): Promise<void>;
  saveEnvironment(input: { projectId: string; id?: string; name: string; baseUrl: string }): Promise<void>;
  run(input: { projectId: string; caseId: string; workflowId: string; environmentId: string; browserMode?: 'isolated' | 'bridge' }): Promise<string>;
  cancelRun(): Promise<void>;
  runPlan(input: { runId: string }): Promise<import('./run-steps.js').RunStepInfo[]>;
  runScreenshot(input: { runId: string; image: string }): Promise<string>;
  retryRecording(input: { id: string }): Promise<void>;
  openReport(input: { runId: string }): Promise<void>;
  saveModel(input: { name: string; baseUrl: string; family: string; apiKey: string }): Promise<void>;
  startRecording(input: { projectId: string; caseId: string; workflowId: string; environmentId: string; browserMode?: 'isolated' | 'bridge' }): Promise<string>;
  confirmChromeSession(input: { id: string }): Promise<void>;
  beginRecording(input: { id: string }): Promise<void>;
  recordingFrame(input: { id: string }): Promise<RecordingFrame>;
  recordingScreenshot(input: { id: string; hashId: string }): Promise<string>;
  recordingInteract(input: { id: string; action: RecordingInteraction }): Promise<void>;
  stopRecording(input: { id: string }): Promise<void>;
  discardRecording(input: { id: string }): Promise<void>;
  buildRecording(input: { id: string; choices: RecordingStepChoice[]; assertions: RecordingAssertion[] }): Promise<string>;
  saveRecording(input: { id: string; choices: RecordingStepChoice[]; assertions: RecordingAssertion[] }): Promise<void>;
  onChange(listener: () => void): () => void;
}

declare global { interface Window { workspace: DesktopApi } }
