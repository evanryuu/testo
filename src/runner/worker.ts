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
  try {
    // Load Midscene only after configuring the per-run artifact directory.
    const { executeWorkflow } = await import('./midscene.js');
    emit(await executeWorkflow(command.options, command.artifactDirectory, controller.signal, emit));
  } catch (error) {
    emit({ type: 'finished', status: 'error', reportPaths: [], error: error instanceof Error ? error.message : String(error) });
  } finally {
    if (process.connected) process.disconnect();
  }
});
process.on('disconnect', () => controller.abort(new Error('Parent disconnected')));
process.on('SIGTERM', () => controller.abort(new Error('Run terminated')));
emit({ type: 'ready' });
