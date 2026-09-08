import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, type Browser, type BrowserServer, type Page, type Frame } from 'playwright';
import { PlaywrightAgent } from '@midscene/web/playwright';
import { playgroundForSessionManager, createMjpegPreviewDescriptor, describeRecorderUIEvent, type LaunchPlaygroundResult } from '@midscene/playground';
import { findAvailablePort } from '@midscene/shared/node';
import type { RecordingRequest, RecordingResponse, RecordedEvent } from '../shared/recording.js';
import { RecorderEvents } from './events.js';

let browser: Browser | undefined, browserServer: BrowserServer | undefined, page: Page | undefined;
let playground: LaunchPlaygroundResult | undefined, agent: PlaywrightAgent | undefined;
let sessionId = '', stopping = false, reviewing = false;
let pollTimer: ReturnType<typeof setInterval> | undefined, refreshing: Promise<RecordedEvent[]> | undefined;
let cleanupPromise: Promise<void> | undefined;
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
  async describe(event) {
    let config;
    try { config = agent!.modelConfigManager.getModelConfig('default'); }
    catch { return { ...event, semantic: { source: 'aiDescribe', status: 'failed', error: '请在 Model Settings 配置模型后开始录制；原始操作和截图已保留' } }; }
    let described: RecordedEvent = event;
    if (event.type !== 'scroll') {
      try { described = (await request('/recorder/describe-event', 'POST', { event }, 65_000)).event ?? event; }
      catch { /* The official screenshot describer below is Studio's fallback. */ }
      if (described.semantic?.status === 'ready') return described;
    }
    const screenshot = event.screenshotAsset
      ? `data:${event.screenshotAsset.mimeType};base64,${(await readFile(assetFile(event))).toString('base64')}`
      : event.screenshotWithBox || event.screenshotBefore || event.screenshotAfter;
    const result = await describeRecorderUIEvent({ event: { ...event, screenshotBefore: screenshot }, target: { platformId: 'web', values: {} } }, config, { maxRetries: 1 });
    if (result.usedFallback) throw new Error('描述生成失败');
    return { ...event, semantic: { ...result.event.semantic!, fallbackFrom: described.semantic }, elementDescription: result.event.elementDescription };
  },
  changed(events) { emit({ type: 'events', events }); },
  idle() { if (reviewing) void cleanup().finally(() => { if (process.connected) process.disconnect(); }); },
});
async function events(): Promise<RecordedEvent[]> {
  if (!refreshing) refreshing = (async () => {
    const result = await request('/recorder/events?since=0&flushPending=false');
    await collector.update(result.events);
    return collector.values;
  })().finally(() => { refreshing = undefined; });
  return refreshing;
}
async function frame() {
  if (!page || page.isClosed()) throw new Error('录制网页已关闭，请停止录制后重新开始');
  const shot = await request('/screenshot');
  return { screenshot: shot.screenshot, width: 1280, height: 800, url: page.url() };
}
function cleanup(): Promise<void> {
  if (!cleanupPromise) cleanupPromise = (async () => {
    stopping = true;
    clearInterval(pollTimer);
    collector.close();
    // Keep official assets and our durable copies for review and recovery.
    if (playground) { await playground.close().catch(() => {}); playground = undefined; }
    await browser?.close().catch(() => {});
    await browserServer?.close().catch(() => {});
  })();
  return cleanupPromise;
}
async function execute(message: RecordingRequest): Promise<unknown> {
  if (message.method === 'start') {
    sessionId = message.input.id;
    browserServer = await chromium.launchServer({ host: '127.0.0.1', channel: 'chrome', headless: true, timeout: 20_000 });
    emit({ type: 'browser', pid: browserServer.process().pid! });
    browser = await chromium.connect(browserServer.wsEndpoint());
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
    page = await context.newPage();
    page.setDefaultTimeout(20_000);
    context.on('page', (opened) => { if (opened !== page) void opened.close(); });
    await page.goto(message.input.baseUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 });
    agent = new PlaywrightAgent(page, { generateReport: false, autoPrintReportMsg: false, cache: false });
    playground = await playgroundForSessionManager().launch({
      port: await findAvailablePort(20000 + Math.floor(Math.random() * 20000), 100), openBrowser: false, verbose: false,
      staticPath: fileURLToPath(new URL('../../../dist-preview', import.meta.url)),
      configureServer(server) {
        server.setPreparedPlatform({ platformId: 'web', title: 'Testing Workspace', preview: createMjpegPreviewDescriptor(), sessionManager: {
          async createSession() { return {
            agent, platformId: 'web', preview: createMjpegPreviewDescriptor(),
            subscribeNavigationEvents(listener) {
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
      },
    });
    await request('/session', 'POST', {});
    await request('/recorder/start', 'POST', { sessionId });
    await events();
    const value = { frame: await frame(), events: collector.values, preview: { url: `http://127.0.0.1:${playground.port}`, token } };
    pollTimer = setInterval(() => { void events().catch(() => {}); }, 500);
    return value;
  }
  if (message.method === 'frame') { await events(); return { frame: await frame(), events: collector.values }; }
  if (message.method === 'interact') {
    await request('/interact', 'POST', message.input);
    await events();
    return { frame: await frame(), events: collector.values };
  }
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
