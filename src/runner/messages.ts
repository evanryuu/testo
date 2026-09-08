export interface RunOptions {
  workflowPath: string;
  chromeTarget?: import('../recording/chrome-bridge.js').ChromeTarget;
  baseUrl: string;
  artifactRoot: string;
  channel?: string;
  headless?: boolean;
  timeoutMs?: number;
}

export type RunStatus = 'passed' | 'failed' | 'cancelled' | 'error';

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
}

export type WorkerEvent =
  | { type: 'steps-planned'; steps: import('../shared/run-steps.js').RunStepInfo[] }
  | { type: 'step-evidence'; phase: string; index: number; stage: 'before' | 'after' | 'failed'; image?: string; url?: string; target?: string; warning?: string }
  | { type: 'ready' }
  | { type: 'browser-started'; pid: number }
  | { type: 'browser-closed' }
  | { type: 'step-started'; node: string; phase: string; index: number; total: number }
  | { type: 'step-finished'; node: string; phase: string; index: number; status: string; durationMs: number; error?: string }
  | { type: 'finished'; status: RunStatus; reportPaths: string[]; definitionHash?: string; error?: string };

export type WorkerCommand =
  | { type: 'start'; options: RunOptions; artifactDirectory: string; runId: string }
  | { type: 'cancel' };
