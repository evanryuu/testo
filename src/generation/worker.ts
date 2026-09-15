import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { callAIWithObjectResponse, getModelRuntime } from '@midscene/core/ai-model';
import { globalModelConfigManager } from '@midscene/shared/env';
import { planDocument, type PlanInput, type PlanResult } from './planner.js';

type Reply = { ok: true; result: PlanResult } | { ok: false; message: string };

/** Environment and model credentials belong to this child, never to the Electron main process. */
export function planInWorker(input: PlanInput, environment: NodeJS.ProcessEnv, signal: AbortSignal): Promise<PlanResult> {
  signal.throwIfAborted();
  const child = fork(fileURLToPath(import.meta.url), ['--plan-document'], {
    execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    env: { ...environment, ELECTRON_RUN_AS_NODE: '1' },
  });
  return new Promise((resolve, reject) => {
    let reply: Reply | undefined;
    let failure: Error | undefined;
    const stop = () => { child.kill('SIGKILL'); };
    const timer = setTimeout(() => { failure = new Error('AI 用例规划超过 120 秒，请缩小文档后重试'); stop(); }, 120000);
    signal.addEventListener('abort', stop, { once: true });
    child.on('message', (value: Reply) => { reply = value; });
    child.once('error', () => { failure = new Error('AI 规划进程无法启动'); stop(); });
    child.once('close', code => {
      clearTimeout(timer);
      signal.removeEventListener('abort', stop);
      if (signal.aborted) reject(signal.reason ?? new Error('已取消用例规划'));
      else if (failure) reject(failure);
      else if (code !== 0 || !reply) reject(new Error('AI 规划进程已停止，请重试'));
      else if (!reply.ok) reject(new Error(reply.message));
      else resolve(reply.result);
    });
    child.send(input, error => { if (error) { failure = new Error('AI 规划进程未连接'); stop(); } });
    if (signal.aborted) stop();
  });
}

if (process.argv.includes('--plan-document')) {
  let started = false;
  const controller = new AbortController();
  process.on('disconnect', () => { controller.abort(); process.exit(0); });
  process.on('message', async (input: PlanInput) => {
    if (started) return;
    started = true;
    let reply: Reply;
    try {
      const config = globalModelConfigManager.getModelConfig('default');
      const runtime = getModelRuntime(config);
      const result = await planDocument(input, async (messages, signal) => {
        try { return (await callAIWithObjectResponse<unknown>(messages, runtime, { abortSignal: signal, retryTimes: 0 })).content; }
        catch { throw new Error('AI 模型请求失败，请检查模型配置与网络连接'); }
      }, controller.signal);
      reply = { ok: true, result };
    } catch {
      // Provider errors can contain request headers and tokens. Never forward them across IPC.
      reply = { ok: false, message: 'AI 用例规划失败，请检查模型配置、文档内容及来源格式后重试' };
    }
    if (process.connected) process.send?.(reply, undefined, undefined, () => process.exit(0));
    else process.exit(0);
  });
}
