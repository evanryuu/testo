import { parse } from 'yaml';
import { normalizeStep } from '@midscene/test';
import { waitInputSchema as nativeWaitSchema } from '@midscene/test/midscene';
import { compileWorkflow } from '../shared/workflow-document.js';
import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RunOptions, RunResult, WorkerCommand, WorkerEvent } from './messages.js';

export interface RunHandle {
  runId: string;
  artifactDirectory: string;
  workerPid: number | undefined;
  result: Promise<RunResult>;
  cancel(): void;
}

// Reserve cleanup/startup time plus each native step deadline and explicit wait window.
export function defaultRunTimeout(source: string): number {
  try {
    const document = parse(source);
    const entries = [
      ...(document?.beforeAll ?? []), ...(document?.beforeEach ?? []),
      ...(document?.cases ?? []).flatMap((item: any) => item.steps ?? []),
      ...(document?.afterEach ?? []), ...(document?.afterAll ?? []),
    ];
    return 120000 + entries.reduce((total: number, entry: any) => {
      if (!entry) return total;
      const step = normalizeStep(entry);
      if (step.meta.timeoutMs !== undefined) return total + step.meta.timeoutMs;
      if (step.node === 'wait') {
        const input = nativeWaitSchema.parse(step.input);
        return total + input.duration * (input.unit === 'min' ? 60000 : input.unit === 's' ? 1000 : 1);
      }
      if (!['aiWaitFor', 'waitForElement'].includes(step.node)) return total + 30000;
      const value = step.input.timeoutMs ?? (step.node === 'aiWaitFor' ? 60000 : 30000);
      return total + (typeof value === 'number' && Number.isInteger(value) && value >= 1000 && value <= 300000 ? value : 0);
    }, 0);
  } catch { return 120000; } // The worker reports invalid YAML through normal run history.
}

export function startRun(options: RunOptions, onEvent: (event: WorkerEvent) => void = () => {}, environment: NodeJS.ProcessEnv = process.env): RunHandle {
  options = structuredClone(options);
  if (options.workflowText === undefined) {
    try { options.workflowText = readFileSync(options.workflowPath, 'utf8'); } catch { /* Worker reports source errors in run history. */ }
  }
  let timeoutMs = options.timeoutMs ?? 120_000;
  if (options.timeoutMs === undefined) {
    try { timeoutMs = defaultRunTimeout(compileWorkflow(options.workflowText ?? readFileSync(options.workflowPath, 'utf8'), options).text); } catch { /* The worker reports file read failures. */ }
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('timeoutMs must be positive');
  if (!/^https?:$/.test(new URL(options.baseUrl).protocol)) throw new Error('baseUrl must use HTTP or HTTPS');
  const workflowPath = path.resolve(options.workflowPath);
  if (!/\.ya?ml$/i.test(workflowPath)) throw new Error('Select a YAML Workflow file');
  const runId = randomUUID();
  const started = Date.now();
  const artifactDirectory = path.resolve(options.artifactRoot, runId);
  mkdirSync(artifactDirectory, { recursive: true, mode: 0o700 });
  const child = fork(fileURLToPath(new URL('./worker.js', import.meta.url)), [], {
    cwd: path.dirname(workflowPath),
    execArgv: [],
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: { ...environment, MIDSCENE_RUN_DIR: artifactDirectory },
  });
  let finished: Extract<WorkerEvent, { type: 'finished' }> | undefined;
  let browserPid: number | undefined;
  let cancellationRequested = false;
  let timedOut = false;
  let forceTimer: NodeJS.Timeout | undefined;
  let exitTimer: NodeJS.Timeout | undefined;
  let processError: string | undefined;
  let settled = false;

  const save = (name: string, data: string) => appendFileSync(path.join(artifactDirectory, name), data, { mode: 0o600 });
  child.stdout?.on('data', (chunk: Buffer) => save('stdout.log', chunk.toString()));
  child.stderr?.on('data', (chunk: Buffer) => save('stderr.log', chunk.toString()));
  const send = (message: WorkerCommand) => {
    if (child.connected) child.send(message, (error) => { if (error) processError = error.message; });
  };
  const killBrowser = () => {
    if (!browserPid) return;
    try {
      // Playwright launches the browser as its own POSIX process group.
      process.kill(process.platform === 'win32' ? browserPid : -browserPid, 'SIGKILL');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') processError = `Browser cleanup failed: ${String(error)}`;
    }
    browserPid = undefined;
  };
  const cancel = () => {
    if (settled || cancellationRequested || finished) return;
    cancellationRequested = true;
    send({ type: 'cancel' });
    forceTimer = setTimeout(() => { killBrowser(); child.kill('SIGKILL'); }, 10_000);
  };
  const timeout = setTimeout(() => { timedOut = true; cancel(); }, timeoutMs);
  const result = new Promise<RunResult>((resolve) => {
    child.on('error', (error) => { processError = error.message; });
    child.on('message', (message: WorkerEvent) => {
      save('events.jsonl', `${JSON.stringify({ runId, at: new Date().toISOString(), ...message })}\n`);
      if (message.type === 'ready') {
        send({ type: 'start', runId, options: { ...options, workflowPath }, artifactDirectory });
        if (cancellationRequested) send({ type: 'cancel' });
      }
      if (message.type === 'browser-started') browserPid = message.pid;
      if (message.type === 'browser-closed') browserPid = undefined;
      if (message.type === 'finished') {
        finished = message;
        clearTimeout(timeout);
        if (forceTimer) clearTimeout(forceTimer);
        exitTimer = setTimeout(() => { processError = 'Worker did not exit after cleanup'; killBrowser(); child.kill('SIGKILL'); }, 5000);
      }
      onEvent(message);
    });
    // Wait for closed stdio and process exit; an early finished message is not enough.
    child.on('close', (code, signal) => {
      settled = true;
      clearTimeout(timeout);
      if (forceTimer) clearTimeout(forceTimer);
      if (exitTimer) clearTimeout(exitTimer);
      killBrowser();
      const status = timedOut || processError ? 'error'
        : cancellationRequested && !finished ? 'cancelled'
        : code !== 0 || !finished ? 'error'
        : finished.status;
      const error = timedOut ? 'Run exceeded its time limit'
        : processError ?? finished?.error ?? (status === 'error' ? `Worker exited without a valid result (code=${code}, signal=${signal})` : undefined);
      const summary: RunResult = {
        runId, status, artifactDirectory,
        startedAt: new Date(started).toISOString(), finishedAt: new Date().toISOString(), durationMs: Date.now() - started,
        reportPaths: finished?.reportPaths ?? [], definitionHash: finished?.definitionHash,
        runnerVersion: '1.12.4', checks: finished?.checks, ...(error ? { error } : {}),
      };
      writeFileSync(path.join(artifactDirectory, 'summary.json'), JSON.stringify(summary, null, 2), { mode: 0o600 });
      resolve(summary);
    });
  });
  return { runId, artifactDirectory, workerPid: child.pid, result, cancel };
}
