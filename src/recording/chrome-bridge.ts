import { AgentOverChromeBridge } from '@midscene/web/bridge-mode';
import { waitForStableViewport, type ViewportSize } from './viewport.js';

const pinnedViewports = new WeakMap<AgentOverChromeBridge, ViewportSize>();
type DebuggerPage = { sendCommandToDebugger(method: string, params: Record<string, unknown>): Promise<unknown> };

// Midscene Bridge ignores regular viewport options. Use the pinned official
// extension's CDP forwarding; never compensate by scaling recorded coordinates.
export async function pinChromeViewport(agent: AgentOverChromeBridge, size: ViewportSize, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const previous = pinnedViewports.get(agent);
  let setting: Promise<unknown> = Promise.resolve();
  if (!previous || previous.width !== size.width || previous.height !== size.height) {
    pinnedViewports.set(agent, { ...size }); // Also clean up an uncertain/timed-out command.
    setting = (agent.interface as unknown as DebuggerPage).sendCommandToDebugger('Emulation.setDeviceMetricsOverride', {
      width: size.width, height: size.height, deviceScaleFactor: 0, mobile: false,
    });
  }
  return waitForStableViewport(async () => { await setting; return agent.interface.size(); }, { expected: size, signal });
}

async function clearChromeViewport(agent: AgentOverChromeBridge) {
  if (!pinnedViewports.has(agent)) return;
  pinnedViewports.delete(agent);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      (agent.interface as unknown as DebuggerPage).sendCommandToDebugger('Emulation.clearDeviceMetricsOverride', {}),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('恢复 Chrome 视口超时')), 1500); }),
    ]);
  } finally { clearTimeout(timer); }
}

export interface ChromeTarget { tabId: string; origin: string; sessionToken?: string }

export function createChromeBridge(reportFileName?: string) {
  const agent = new AgentOverChromeBridge({
    host: '::ffff:127.0.0.1',
    ...(process.env.WORKSPACE_BRIDGE_PORT ? { port: Number(process.env.WORKSPACE_BRIDGE_PORT) } : {}),
    closeConflictServer: false, closeNewTabsAfterDisconnect: false,
    serverListeningTimeout: 30_000, enableWaterFlowAnimation: false,
    generateReport: !!reportFileName, autoPrintReportMsg: false, cache: false,
    ...(reportFileName ? { reportFileName, outputFormat: 'single-html' as const } : {}),
  });
  // 1.12.4's bridge Proxy invents a function for every missing capability.
  // Hide unsupported capabilities so the official preview uses actionSpace/MJPEG fallback.
  const unsupported = new Set(['inputPrimitives', 'startMjpegStream', 'mjpegStreamUrl', 'openFrameSource', 'describe']);
  const original = agent.interface;
  agent.interface = new Proxy(original, {
    get(target, name, receiver) {
      if (unsupported.has(String(name))) return undefined;
      // The official extension caches size; a user can resize desktop Chrome.
      if (name === 'size') return () => bridgeValue(target, '({width: innerWidth, height: innerHeight})');
      return Reflect.get(target, name, receiver);
    },
  });
  const destroy = agent.destroy.bind(agent);
  agent.destroy = async () => {
    try { await clearChromeViewport(agent); }
    finally { await destroy(); }
  };
  return agent;
}

export async function connectChrome(agent: AgentOverChromeBridge, origin: string, target?: ChromeTarget): Promise<ChromeTarget> {
  try {
    if (target) {
      if (target.origin !== origin) throw new Error('Chrome 会话与所选环境不一致，请重新连接并录制');
      const tabs = await agent.getBrowserTabList();
      const tab = tabs.find((tab) => tab.id === target.tabId);
      if (!tab || new URL(tab.url).origin !== origin) throw new Error('原来的 Chrome 标签页已关闭、移到其他窗口或离开目标网站，请重新连接');
      await agent.setActiveTabId(target.tabId);
    } else {
      // Avoid Agent's animation configuration: disabling it attaches the debugger.
      // The public page connection leaves manual login untouched until begin.
      await agent.interface.connectCurrentTab({ timeout: 30_000, enableWaterFlowAnimation: false });
    }
    const url = await agent.interface.url();
    if (new URL(url).origin !== origin) throw new Error('请先在 Chrome 当前标签页打开所选环境的网站，再重新连接');
    if (target?.sessionToken && await bridgeValue(agent.interface, `sessionStorage.getItem('__testing_workspace_bridge_session')`) !== target.sessionToken) throw new Error('原来的 Chrome 会话已更换，请重新连接并确认登录');
    const tabId = await agent.interface.getActiveTabId();
    if (!tabId) throw new Error('未找到连接的 Chrome 标签页');
    return { tabId: String(tabId), origin };
  } catch (error) {
    throw new Error(`连接 Chrome 失败：${error instanceof Error ? error.message : String(error)}。请确认已安装并允许 Midscene 扩展的 Bridge 连接，且没有其他 Midscene 会话占用连接。`);
  }
}

export async function bridgeValue(page: ReturnType<typeof createChromeBridge>['interface'], expression: string): Promise<any> {
  // ChromeExtensionProxyPage returns the raw CDP envelope, not the evaluated value.
  const response = await page.evaluateJavaScript(`JSON.stringify(${expression})`);
  if (response.exceptionDetails || typeof response.result?.value !== 'string') throw new Error('Chrome 页面脚本执行失败');
  return JSON.parse(response.result.value);
}
