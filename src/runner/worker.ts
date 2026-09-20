import type { WorkerCommand, WorkerEvent } from './messages.js';

const controller = new AbortController();
let started = false;

function emit(event: WorkerEvent): void {
  if (process.connected) process.send?.(event);
}

process.on('message', async (command: WorkerCommand) => {
  if (command.type === 'cancel') {
    controller.abort(new Error('Run cancelled'));
    return;
  }
  if (command.type !== 'start' || started) return;
  started = true;
  process.env.MIDSCENE_RUN_DIR = command.artifactDirectory;
  let finished: Extract<WorkerEvent, { type: 'finished' }>;
  try {
    // Load Midscene only after configuring the per-run artifact directory.
    const { executeWorkflow } = await import('./midscene.js');
    finished = await executeWorkflow(command.options, command.artifactDirectory, controller.signal, emit);
  } catch (error) {
    finished = { type: 'finished', status: 'error', reportPaths: [], error: error instanceof Error ? error.message : String(error) };
  }
  // Workflow cleanup has completed. Flush the result before terminating any leftover sockets.
  if (!process.connected || !process.send) process.exit(1);
  process.send(finished, undefined, undefined, (error: Error | null) => { process.exit(error ? 1 : 0); });
});
process.on('disconnect', () => controller.abort(new Error('Parent disconnected')));
process.on('SIGTERM', () => controller.abort(new Error('Run terminated')));
emit({ type: 'ready' });
