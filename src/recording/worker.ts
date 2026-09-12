import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import { chromium, type Browser, type BrowserServer, type Page, type Frame } from 'playwright';
import { PlaywrightAgent } from '@midscene/web/playwright';
import { playgroundForSessionManager, createMjpegPreviewDescriptor, type LaunchPlaygroundResult } from '@midscene/playground';
import { findAvailablePort } from '@midscene/shared/node';
import type { RecordingRequest, RecordingResponse, RecordedEvent, RecordedTarget } from '../shared/recording.js';
import { createChromeBridge, connectChrome, bridgeValue, pinChromeViewport, type ChromeTarget } from './chrome-bridge.js';
import { inspectRecordedTarget } from '../shared/recorded-target.js';
import { describeInWorker } from './description-worker.js';
import { RecorderEvents } from './events.js';
import { waitForStableViewport } from './viewport.js';

let browser: Browser | undefined, browserServer: BrowserServer | undefined, page: Page | undefined;
let playground: LaunchPlaygroundResult | undefined, agent: PlaywrightAgent | ReturnType<typeof createChromeBridge> | undefined;
let bridge = false, baseUrl = '', chromeTarget: ChromeTarget | undefined;
let sessionId = '', stopping = false, reviewing = false;
let pollTimer: ReturnType<typeof setInterval> | undefined, refreshing: Promise<RecordedEvent[]> | undefined;
let cleanupPromise: Promise<void> | undefined;
const recordingController = new AbortController();
const token = randomUUID();
const emit = (message: RecordingResponse) => { if (process.connected) process.send?.(message); };
const headers = { 'Content-Type': 'application/json', 'X-Workspace-Recorder-Token': token };
function serviceUrl(route: string) {
  if (!playground) throw new Error('录制服务尚未就绪');
  return `http://127.0.0.1:${playground.port}${route}`;
}
async function request(route: string, method = 'GET', body?: unknown, timeout = 25_000): Promise<any> {
  const response = await fetch(serviceUrl(route), {
    method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(timeout),
  });
  const value = await response.json();
  if (!response.ok || value.ok === false || value.error) throw new Error(value.error || `录制服务错误 ${response.status}`);
  return value;
}
function assetFile(event: RecordedEvent) {
  const id = event.screenshotAsset?.id;
  if (!id || !/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('无效的录制截图');
  return path.join(process.cwd(), 'screenshots', id);
}
const assets = new Set<string>();
const collector = new RecorderEvents({
  async persistScreenshot(event) {
    const asset = event.screenshotAsset;
    if (!asset || assets.has(asset.id)) return;
    const response = await fetch(serviceUrl(`/recorder/assets/${encodeURIComponent(asset.id)}`), { headers, signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error('录制截图读取失败');
    await mkdir(path.dirname(assetFile(event)), { recursive: true, mode: 0o700 });
    await writeFile(assetFile(event), Buffer.from(await response.arrayBuffer()), { mode: 0o600 });
    assets.add(asset.id);
  },
  async describe(event, signal) {
    try { agent!.modelConfigManager.getModelConfig('default'); }
    catch { return { ...event, semantic: { source: 'aiDescribe', status: 'failed', error: '请在 Model Settings 配置模型后开始录制；原始操作和截图已保留' } }; }
    const screenshot = event.screenshotAsset
      ? `data:${event.screenshotAsset.mimeType};base64,${(await readFile(assetFile(event))).toString('base64')}`
      : event.screenshotWithBox || event.screenshotBefore || event.screenshotAfter;
    if (!screenshot) throw new Error('录制截图不可用');
    return describeInWorker(event, screenshot, signal);
  },
  changed(events) { emit({ type: 'events', events }); },
  idle() { if (reviewing) void cleanup().finally(() => { if (process.connected) process.disconnect(); }); },
});
async function events(): Promise<RecordedEvent[]> {
  if (!refreshing) refreshing = (async () => {
    const result = await request('/recorder/events?since=0&flushPending=false');
    await collector.update(result.events.map((event: RecordedEvent) => {
      const payload = event.rawPayload;
      if (!payload || !('__testoTarget' in payload)) return event;
      const { __testoTarget, ...rawPayload } = payload;
      return { ...event, rawPayload, ...(__testoTarget ? { target: __testoTarget as RecordedTarget } : {}) };
    }));
    return collector.values;
  })().finally(() => { refreshing = undefined; });
  return refreshing;
}
async function frame() {
  if (!bridge && (!page || page.isClosed())) throw new Error('录制网页已关闭，请停止录制后重新开始');
  const shot = await request('/screenshot');
  const size = await agent!.interface.size();
  return { screenshot: shot.screenshot, width: size.width, height: size.height, url: bridge ? await agent!.interface.url!() : page!.url() };
}
function cleanup(): Promise<void> {
  if (!cleanupPromise) cleanupPromise = (async () => {
    stopping = true;
    recordingController.abort(new Error('录制已结束'));
    clearInterval(pollTimer);
    collector.close();
    // Keep official assets and our durable copies for review and recovery.
    if (playground) { await playground.close().catch(() => {}); playground = undefined; }
    if (bridge) await agent?.destroy().catch(() => {});
    await browser?.close().catch(() => {});
    await browserServer?.close().catch(() => {});
  })();
  return cleanupPromise;
}
async function execute(message: RecordingRequest): Promise<unknown> {
  if (message.method === 'start') {
    sessionId = message.input.id;
    baseUrl = message.input.baseUrl;
    bridge = message.input.browserMode === 'bridge';
    if (bridge) {
      const selected = message.input.chromeTarget as ChromeTarget | undefined;
      agent = createChromeBridge(undefined, selected?.profile?.port);
      chromeTarget = await connectChrome(agent, new URL(baseUrl).origin, selected);
      // Session validation attaches the debugger. Release it while the user
      // prepares the page; begin/confirm reattach through the official API.
      await agent.interface.detachDebugger(Number(chromeTarget.tabId));
      return { events: [], chromeTarget };
    }
    browserServer = await chromium.launchServer({ host: '127.0.0.1', channel: 'chrome', headless: true, timeout: 20_000 });
    emit({ type: 'browser', pid: browserServer.process().pid! });
    browser = await chromium.connect(browserServer.wsEndpoint());
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
    page = await context.newPage();
    page.setDefaultTimeout(20_000);
    context.on('page', (opened) => { if (opened !== page) void opened.close(); });
    await page.goto(message.input.baseUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 });
    agent = new PlaywrightAgent(page, { generateReport: false, autoPrintReportMsg: false, cache: false });
  }
  if (message.method === 'confirm' || message.method === 'begin') {
    if (!bridge || !chromeTarget || !agent) throw new Error('Chrome 尚未连接');
    if (new URL(await agent.interface.url!()).origin !== new URL(baseUrl).origin) throw new Error('请在已连接的 Chrome 标签页完成登录，并返回目标网站');
    const sessionToken = randomUUID();
    await bridgeValue((agent as ReturnType<typeof createChromeBridge>).interface, `(sessionStorage.setItem('__testing_workspace_bridge_session', ${JSON.stringify(sessionToken)}), true)`);
    chromeTarget = { ...chromeTarget, sessionToken };
    if (message.method === 'confirm') { reviewing = true; return { events: [], chromeTarget }; }
  }
  if (message.method === 'start' || message.method === 'begin') {
    if (bridge && new URL(await agent!.interface.url!()).origin !== new URL(baseUrl).origin) throw new Error('请在已连接的 Chrome 标签页完成登录，并返回目标网站后开始录制');
    const startUrl = bridge ? await agent!.interface.url!() : baseUrl;
    const viewport = await waitForStableViewport(() => agent!.interface.size(), { signal: recordingController.signal });
    if (bridge) await pinChromeViewport(agent as ReturnType<typeof createChromeBridge>, viewport, recordingController.signal);
    playground = await playgroundForSessionManager().launch({
      port: await findAvailablePort(20000 + Math.floor(Math.random() * 20000), 100), openBrowser: false, verbose: false,
      staticPath: fileURLToPath(new URL('../../../dist-preview', import.meta.url)),
      configureServer(server) {
        server.setPreparedPlatform({ platformId: 'web', title: 'Testo', preview: createMjpegPreviewDescriptor(), sessionManager: {
          async createSession() { return {
            agent, platformId: 'web', preview: createMjpegPreviewDescriptor(),
            subscribeNavigationEvents(listener) {
              if (bridge) {
                let previous = startUrl, pending = false;
                const timer = setInterval(() => {
                  if (pending || stopping) return;
                  pending = true;
                  void agent!.interface.url!().then((url) => { if (url !== previous) { previous = url; listener({ url, timestamp: Date.now() }); } }).catch(() => {}).finally(() => { pending = false; });
                }, 500);
                return () => clearInterval(timer);
              }
              const currentPage = page!;
              const onNavigation = (frame: Frame) => { if (frame === currentPage.mainFrame()) listener({ url: frame.url(), timestamp: Date.now() }); };
              currentPage.on('framenavigated', onNavigation);
              return () => currentPage.off('framenavigated', onNavigation);
            },
          }; },
        } });
        server.app.use((req: { get(name: string): string | undefined; path: string }, res: { sendStatus(code: number): void }, next: () => void) => {
          if (req.get('X-Workspace-Recorder-Token') !== token) { res.sendStatus(403); return; }
          if (!/^\/(?:$|assets\/[^/]+$|session$|interact$|screenshot$|mjpeg$|status$|runtime-info$|interface-info$|recorder\/(?:start|stop|events|describe-event|assets\/[a-zA-Z0-9_-]+)$)/.test(req.path)) { res.sendStatus(404); return; }
          next();
        });
        server.app.use('/interact', express.json({ limit: '1mb' }));
        server.app.use(async (req: { method: string; path: string; body?: Record<string, any> }, _res: unknown, next: () => void) => {
          if (req.method !== 'POST' || req.path !== '/interact' || !req.body) { next(); return; }
          // The official recorder retains rawPayload, so attach the pre-action
          // target here and promote it to event.target when collecting events.
          // Never inspect the page after dispatch, when navigation may have changed it.
          delete req.body.__testoTarget;
          const { actionType, x, y } = req.body;
          const point = Number.isFinite(x) && Number.isFinite(y) ? { x, y } : undefined;
          if (point || ['Input', 'KeyboardPress'].includes(actionType)) {
            try {
              const expression = `(${inspectRecordedTarget.toString()})(${JSON.stringify(point ?? {})})`;
              req.body.__testoTarget = bridge ? await bridgeValue((agent as ReturnType<typeof createChromeBridge>).interface, expression) : await page!.evaluate(expression);
            } catch { /* Raw input remains recordable when the page has no readable DOM. */ }
          }
          next();
        });
      },
    });
    await request('/session', 'POST', {});
    await request('/recorder/start', 'POST', { sessionId });
    await events();
    const value = { chromeTarget, viewport, startUrl, frame: await frame(), events: collector.values, preview: { url: `http://127.0.0.1:${playground.port}`, token } };
    pollTimer = setInterval(() => { void events().catch(() => {}); }, 500);
    return value;
  }
  if (message.method === 'frame') { await events(); return { frame: await frame(), events: collector.values }; }
  if (message.method === 'interact') {
    await request('/interact', 'POST', message.input);
    await events();
    return { frame: await frame(), events: collector.values };
  }
  if (!playground) { reviewing = true; return { events: [] }; }
  clearInterval(pollTimer);
  await refreshing;
  await request('/recorder/stop', 'POST', {});
  await events();
  const lastFrame = await frame();
  reviewing = true;
  return { events: collector.values, frame: lastFrame };
}
let queue = Promise.resolve();
process.on('message', (message: RecordingRequest) => {
  queue = queue.then(async () => {
    try { emit({ requestId: message.requestId, ok: true, value: await execute(message) }); }
    catch (error) {
      emit({ requestId: message.requestId, ok: false, error: error instanceof Error ? error.message : String(error) });
      if (message.method === 'start' || message.method === 'stop') await cleanup();
    }
    if (reviewing && !collector.pending) await cleanup();
    if (stopping && process.connected) process.disconnect();
  });
});
process.on('disconnect', () => { void cleanup().finally(() => process.exit(0)); });
process.on('SIGTERM', () => { void cleanup().finally(() => process.exit(0)); });
emit({ type: 'ready' });
