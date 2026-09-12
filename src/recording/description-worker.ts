import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Service } from '@midscene/core';
import { globalModelConfigManager } from '@midscene/shared/env';
import { describeRecorderUIEvent } from '@midscene/playground';
import type { RecordedEvent } from '../shared/recording.js';
import { describeRecordedTarget } from './describe.js';

type Input = { event: RecordedEvent; screenshot: string };
type Reply = { ok: true; event: RecordedEvent } | { ok: false };

/** Upstream describe() has no AbortSignal. Process lifetime is the cancellation boundary. */
export function describeInWorker(event: RecordedEvent, screenshot: string, signal: AbortSignal): Promise<RecordedEvent> {
  signal.throwIfAborted();
  const child = fork(fileURLToPath(import.meta.url), ['--describe-recording'], {
    execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  return new Promise((resolve, reject) => {
    let reply: Reply | undefined, failure: Error | undefined;
    const abort = () => { child.kill('SIGKILL'); };
    signal.addEventListener('abort', abort, { once: true });
    child.on('message', (value: Reply) => { reply = value; });
    child.once('error', () => { failure = new Error('描述进程无法启动'); child.kill('SIGKILL'); });
    child.once('close', code => {
      signal.removeEventListener('abort', abort);
      if (signal.aborted) reject(signal.reason);
      else if (failure || code !== 0 || !reply?.ok) reject(failure ?? new Error('描述生成失败，原始操作和截图已保留'));
      else resolve(reply.event);
    });
    child.send({ event, screenshot } satisfies Input, error => { if (error) { failure = new Error('描述进程未连接'); child.kill('SIGKILL'); } });
    if (signal.aborted) abort();
  });
}

if (process.argv.includes('--describe-recording')) {
  let started = false;
  process.on('disconnect', () => process.exit(0));
  process.on('message', async ({ event, screenshot }: Input) => {
    if (started) return; started = true;
    let reply: Reply;
    try {
      const modelConfigManager = globalModelConfigManager;
      const config = modelConfigManager.getModelConfig('default');
      let described: RecordedEvent;
      if (event.type !== 'scroll' && Number.isFinite(event.elementRect?.x) && Number.isFinite(event.elementRect?.y)) {
        // Screenshot-bound official description and verification never consult a live page.
        const service = new Service(() => { throw new Error('录制描述只能使用保存的截图'); });
        described = await describeRecordedTarget({ service, modelConfigManager }, event, screenshot);
      } else {
        const result = await describeRecorderUIEvent({ event: { ...event, screenshotBefore: screenshot }, target: { platformId: 'web', values: {} } }, config, { maxRetries: 1 });
        if (result.usedFallback) throw new Error('描述生成失败');
        described = { ...event, semantic: { ...result.event.semantic!, confidence: 'low', error: '描述待确认：此操作没有可校验的单一目标，请检查描述后使用' }, elementDescription: undefined };
      }
      reply = { ok: true, event: described };
    } catch { reply = { ok: false }; }
    if (process.connected) process.send?.(reply, undefined, undefined, () => process.exit(0));
    else process.exit(0);
  });
}
