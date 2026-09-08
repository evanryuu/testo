import { defineNode } from '@midscene/test';
import { z } from 'zod/v4';
import { setTimeout as delay } from 'node:timers/promises';
import type { AgentOverChromeBridge } from '@midscene/web/bridge-mode';

// Pinned Midscene 1.12.4/1.12.5 adapter: this method is private in the typings,
// but is forwarded by the official Bridge RPC. Real extension tests cover it.
type DebuggerPage = { sendCommandToDebugger(method: string, params: Record<string, unknown>): Promise<any> };
async function bounded<T>(work: Promise<T>, signal: AbortSignal, timeoutMs: number, message: () => string): Promise<T> {
  signal.throwIfAborted();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => reject(new Error(message())), Math.max(1, timeoutMs));
    })]);
  } finally {
    clearTimeout(timer);
    if (abort) signal.removeEventListener('abort', abort);
  }
}

export function createBridgeNodes(getAgent: () => AgentOverChromeBridge, baseUrl: string) {
  return [defineNode({
    name: 'gotoUrl', stringInputKey: 'url',
    inputSchema: z.object({
      url: z.string().min(1),
      waitUntil: z.enum(['commit', 'domcontentloaded', 'load']).default('domcontentloaded'),
      // Leave room for cleanup before the Workflow's 30-second step deadline.
      timeoutMs: z.number().int().positive().max(25000).default(20000),
    }).strict(),
    async execute(ctx) {
      ctx.signal.throwIfAborted();
      const url = new URL(ctx.input.url, baseUrl);
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('导航地址必须使用 HTTP 或 HTTPS');
      const page = getAgent().interface as unknown as DebuggerPage;
      const waitUntil = ctx.input.waitUntil ?? 'domcontentloaded';
      const timeoutMs = ctx.input.timeoutMs ?? 20000;
      const deadline = Date.now() + timeoutMs;
      let phase = '发起导航', lastUrl = url.href;
      const timeoutMessage = () => `导航超时：等待${phase}（${waitUntil}），目标 ${url.href}，当前 ${lastUrl}，上限 ${timeoutMs}ms`;
      const command = (method: string, params: Record<string, unknown> = {}) => {
        ctx.signal.throwIfAborted();
        if (Date.now() >= deadline) throw new Error(timeoutMessage());
        return bounded(page.sendCommandToDebugger(method, params), ctx.signal, deadline - Date.now(), timeoutMessage);
      };
      try {
        const before = (await command('Page.getFrameTree')).frameTree.frame;
        const navigation = await command('Page.navigate', { url: url.href });
        if (navigation.errorText || navigation.isDownload) throw new Error(`导航失败：${navigation.errorText || '目标返回了下载文件'}`);
        phase = '新文档就绪';
        while (true) {
          const frame = (await command('Page.getFrameTree')).frameTree.frame;
          lastUrl = frame.url + (frame.urlFragment ?? '');
          if (frame.unreachableUrl || frame.url.startsWith('chrome-error:')) throw new Error(`导航失败：无法访问 ${frame.unreachableUrl || url.href}`);
          const newDocument = navigation.loaderId ? frame.loaderId === navigation.loaderId && frame.loaderId !== before.loaderId : lastUrl === url.href;
          if (frame.id === navigation.frameId && newDocument && /^https?:/.test(frame.url)) {
            if (waitUntil === 'commit') return;
            phase = waitUntil === 'load' ? '页面 load 事件' : '页面 DOMContentLoaded 事件';
            try {
              const response = await command('Runtime.evaluate', {
                expression: `(() => { const n = performance.getEntriesByType('navigation')[0]; return { href: location.href, domReady: !!n && n.domContentLoadedEventEnd > 0, loaded: document.readyState === 'complete' }; })()`,
                returnByValue: true, timeout: Math.min(1000, Math.max(1, deadline - Date.now())),
              });
              if (response.exceptionDetails) throw new Error('导航状态读取失败');
              const state = response.result?.value;
              // A context can change between probes; never accept the old document.
              if (state?.href === lastUrl && (waitUntil === 'load' ? state.loaded : state.domReady || state.loaded)) return;
            } catch (error) {
              if (!/Execution context was destroyed|Cannot find context|Inspected target navigated/.test(String(error))) throw error;
            }
          }
          await delay(Math.min(100, Math.max(1, deadline - Date.now())), undefined, { signal: ctx.signal });
        }
      } catch (error) {
        // A rejected Promise alone does not stop navigation in the user's tab.
        await bounded(page.sendCommandToDebugger('Page.stopLoading', {}), new AbortController().signal, 1000, () => '停止导航超时').catch(() => {});
        throw error;
      }
    },
  })];
}
