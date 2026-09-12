export interface RunOptions {
  workflowPath: string;
  workflowText?: string;
  defaults?: import('../shared/workflow-document.js').Variables;
  variables?: import('../shared/workflow-document.js').Variables;
  datasetId?: string;
  flows?: Record<string, import('../shared/workflow-document.js').SharedFlow>;
  debug?: import('../shared/workflow-document.js').DebugSelection;
  chromeTarget?: import('../recording/chrome-bridge.js').ChromeTarget;
  baseUrl: string;
  artifactRoot: string;
  channel?: string;
  headless?: boolean;
  timeoutMs?: number;
}

export type RunStatus = 'passed' | 'failed' | 'cancelled' | 'error';

export interface WaitMetric {
  phase: string;
  index: number;
  metric?: 'first-response' | 'response-complete';
  elapsedMs: number;
  modelCalls: number;
  status: 'passed' | 'failed';
}

export interface RunResult {
  runId: string;
  status: RunStatus;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  artifactDirectory: string;
  reportPaths: string[];
  definitionHash?: string;
  error?: string;
  runnerVersion: '1.12.4';
  checks?: WaitMetric[];
}

export type WorkerEvent =
  | { type: 'steps-planned'; steps: import('../shared/run-steps.js').RunStepInfo[] }
  | { type: 'step-evidence'; phase: string; index: number; stage: 'before' | 'after' | 'failed'; image?: string; url?: string; target?: string; warning?: string }
  | { type: 'wait-progress'; metric?: 'first-response' | 'response-complete'; phase: string; index: number; prompt: string; attempt: number; elapsedMs: number; timeoutMs: number; status: 'checking' | 'waiting' | 'passed' | 'failed'; reason?: string; modelCalls: number }
  | { type: 'diagnostic'; kind: 'network' | 'console' | 'pageerror' | 'capability'; message: string; url?: string; at: string }
  | { type: 'ready' }
  | { type: 'browser-started'; pid: number }
  | { type: 'browser-closed' }
  | { type: 'step-started'; node: string; phase: string; index: number; total: number }
  | { type: 'step-finished'; node: string; phase: string; index: number; status: string; durationMs: number; error?: string }
  | { type: 'finished'; checks?: WaitMetric[]; status: RunStatus; reportPaths: string[]; definitionHash?: string; error?: string };

export type WorkerCommand =
  | { type: 'start'; options: RunOptions; artifactDirectory: string; runId: string }
  | { type: 'cancel' };
