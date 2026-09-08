import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod/v4';
import type { RecordingDraft, RecordingFrame, RecordingInteraction, RecordingResponse } from '../shared/recording.js';

const interactionSchema = z.discriminatedUnion('actionType', [
  z.object({ actionType: z.literal('Tap'), x: z.number().min(0).max(1279), y: z.number().min(0).max(799) }).strict(),
  z.object({ actionType: z.literal('Input'), value: z.string().max(10_000), mode: z.enum(['typeOnly', 'replace', 'clear']).optional(), x: z.number().min(0).max(1279).optional(), y: z.number().min(0).max(799).optional() }).strict(),
  z.object({ actionType: z.literal('KeyboardPress'), keyName: z.enum(['Enter', 'Tab', 'Backspace', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']) }).strict(),
  z.object({ actionType: z.literal('Scroll'), direction: z.enum(['up', 'down']), distance: z.number().min(1).max(2000) }).strict(),
  z.object({ actionType: z.literal('Navigate'), url: z.string().url().refine((v) => /^https?:/.test(v), '地址必须使用 HTTP 或 HTTPS') }).strict(),
]);

type Update = { events: RecordingDraft['events']; frame: RecordingFrame; preview?: { url: string; token: string } };
export class RecordingService {
  draft?: RecordingDraft;
  private child?: ChildProcess;
  private browserPid?: number;
  private pending = new Map<string, { resolve(value: any): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  private lastFrame?: RecordingFrame;
  private preview?: { url: string; token: string };
  authorization(url: string): string | undefined {
    return this.preview && new URL(url).origin === this.preview.url ? this.preview.token : undefined;
  }
  private file: string;
  private frameFile: string;
  private polling?: Promise<RecordingFrame>;
  constructor(private dataDir: string, private changed: () => void) {
    this.file = path.join(dataDir, 'recording-draft.json');
    this.frameFile = path.join(dataDir, 'recording-preview.json');
    if (existsSync(this.file)) {
      this.draft = JSON.parse(readFileSync(this.file, 'utf8')) ?? undefined;
      if (this.draft?.status === 'recording' || this.draft?.status === 'starting') {
        this.draft.status = 'interrupted'; this.draft.error = '上次录制已中断，已采集的步骤仍可检查和保存。'; this.persist();
      }
      if (existsSync(this.frameFile)) this.lastFrame = JSON.parse(readFileSync(this.frameFile, 'utf8'));
      this.interruptDescriptions();
    }
  }
  get active() { return !!this.child && !!this.draft && ['starting', 'recording'].includes(this.draft.status); }
  private interruptDescriptions() {
    if (!this.draft) return;
    let changed = false;
    for (const event of this.draft.events) if (event.semantic?.status === 'pending') {
      event.semantic = { ...event.semantic, status: 'failed', error: '描述生成已中断，原始操作和截图已保留' };
      event.descriptionLoading = false; changed = true;
    }
    if (changed) this.persist();
  }
  private persist() {
    const temporary = `${this.file}.tmp`;
    writeFileSync(temporary, JSON.stringify(this.draft ?? null), { mode: 0o600 });
    renameSync(temporary, this.file);
    if (this.draft) {
      const archive = path.join(this.dataDir, 'recordings', this.draft.id, 'draft.json');
      mkdirSync(path.dirname(archive), { recursive: true, mode: 0o700 });
      writeFileSync(`${archive}.tmp`, JSON.stringify(this.draft), { mode: 0o600 });
      renameSync(`${archive}.tmp`, archive);
    }
  }
  private accept(update: Update) {
    if (!this.draft) return;
    if (update.preview) this.preview = update.preview;
    this.draft.events = update.events;
    this.lastFrame = update.frame;
    this.persist();
    writeFileSync(this.frameFile, JSON.stringify(update.frame), { mode: 0o600 });
    this.changed();
  }
  private killBrowser() {
    if (this.browserPid) {
      try { process.kill(process.platform === 'win32' ? this.browserPid : -this.browserPid, 'SIGKILL'); } catch {}
      this.browserPid = undefined;
    }
  }
  private rpc(method: 'start' | 'frame' | 'interact' | 'stop', input?: unknown): Promise<Update> {
    const child = this.child;
    if (!child?.connected) return Promise.reject(new Error('录制进程未连接'));
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        this.killBrowser(); child.kill('SIGKILL');
        reject(new Error('录制操作超时，已停止浏览器。已采集的步骤仍保留。'));
      }, method === 'start' ? 45_000 : 30_000);
      this.pending.set(requestId, { resolve, reject, timer });
      child.send({ requestId, method, input }, (error) => {
        if (error) { clearTimeout(timer); this.pending.delete(requestId); reject(error); }
      });
    });
  }
  async start(input: Omit<RecordingDraft, 'id' | 'status' | 'events' | 'createdAt'>, environment: NodeJS.ProcessEnv = process.env) {
    if (this.active) throw new Error('已有录制会话，请先停止');
    if (this.draft && this.draft.status !== 'saved') throw new Error('请先保存当前录制草稿，或明确放弃后重新录制');
    if (!/^https?:$/.test(new URL(input.baseUrl).protocol)) throw new Error('录制地址必须使用 HTTP 或 HTTPS');
    await this.closeWorker();
    this.lastFrame = undefined;
    writeFileSync(this.frameFile, 'null', { mode: 0o600 });
    this.draft = { ...input, id: randomUUID(), status: 'starting', events: [], createdAt: new Date().toISOString() };
    this.persist(); this.changed();
    const runDir = path.join(this.dataDir, 'recordings', this.draft.id);
    mkdirSync(runDir, { recursive: true, mode: 0o700 });
    const child = fork(fileURLToPath(new URL('../recording/worker.js', import.meta.url)), [], {
      cwd: runDir, execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      env: { ...environment, MIDSCENE_RUN_DIR: runDir, MIDSCENE_PLAYGROUND_HOST: '127.0.0.1' },
    });
    this.child = child;
    let readyResolve: () => void, readyReject: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    const readyTimer = setTimeout(() => { child.kill('SIGKILL'); readyReject(new Error('录制组件启动超时')); }, 30_000);
    child.on('message', (message: RecordingResponse) => {
      if ('type' in message) {
        if (message.type === 'events' && this.child === child && this.draft) {
          this.draft.events = message.events; this.persist(); this.changed();
        }
        if (message.type === 'browser') this.browserPid = message.pid;
        if (message.type === 'ready') { clearTimeout(readyTimer); readyResolve(); }
        return;
      }
      const request = this.pending.get(message.requestId);
      if (!request) return;
      clearTimeout(request.timer); this.pending.delete(message.requestId);
      if (message.ok) request.resolve(message.value); else request.reject(new Error(message.error));
    });
    child.on('error', () => { child.kill(); });
    child.on('close', () => {
      clearTimeout(readyTimer); readyReject(new Error('录制进程已退出'));
      this.killBrowser();
      for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(new Error('录制进程已退出')); }
      this.pending.clear(); this.child = undefined; this.preview = undefined;
      this.interruptDescriptions();
      if (this.draft && ['recording', 'starting'].includes(this.draft.status)) {
        this.draft.status = 'interrupted'; this.draft.error = '录制进程已退出，已采集的步骤仍保留。'; this.persist();
      }
      this.changed();
    });
    try {
      await ready;
      this.accept(await this.rpc('start', { id: this.draft.id, baseUrl: input.baseUrl }));
      this.draft.status = 'recording'; this.persist(); this.changed();
      return this.draft.id;
    } catch (error) {
      this.draft.status = 'interrupted'; this.draft.error = String(error); this.persist(); this.changed();
      throw error;
    }
  }
  async frame(id: string): Promise<RecordingFrame> {
    this.require(id);
    if (!this.active || this.draft!.status !== 'recording') {
      if (!this.lastFrame) throw new Error('暂无录制画面');
      return this.lastFrame;
    }
    if (!this.polling) this.polling = this.rpc('frame').then((update) => { this.accept(update); return update.frame; }).finally(() => { this.polling = undefined; });
    const frame = await this.polling;
    return { ...frame, previewUrl: this.preview?.url };
  }
  async interact(id: string, input: RecordingInteraction): Promise<void> {
    this.require(id);
    if (this.draft!.status !== 'recording') throw new Error('当前不在录制中');
    if (this.draft!.events.length >= 500) throw new Error('本次录制已达到 500 步，请停止后保存');
    if (input.actionType === 'Input' && input.mode === 'clear' && (input.x === undefined || input.y === undefined)) throw new Error('清空输入框前，请先点击目标输入框');
    this.accept(await this.rpc('interact', interactionSchema.parse(input)));
  }
  async stop(id: string) {
    this.require(id);
    if (!this.active) return;
    try {
      this.accept(await this.rpc('stop'));
      this.draft!.status = 'review'; this.draft!.error = undefined;
      this.persist(); this.changed();
    } catch (error) {
      this.draft!.status = 'interrupted'; this.draft!.error = String(error); this.persist(); this.changed(); throw error;
    }
  }
  require(id: string): RecordingDraft {
    if (!this.draft || this.draft.id !== id) throw new Error('录制草稿不存在或已经更换');
    return this.draft;
  }
  screenshot(id: string, hashId: string): string {
    const event = this.require(id).events.find((event) => event.hashId === hashId);
    if (!event) throw new Error('录制事件不存在');
    const asset = event.screenshotAsset;
    if (asset) {
      if (!/^[a-zA-Z0-9_-]+$/.test(asset.id) || !['image/png', 'image/jpeg'].includes(asset.mimeType)) throw new Error('无效的录制截图');
      const file = path.join(this.dataDir, 'recordings', id, 'screenshots', asset.id);
      if (!existsSync(file)) throw new Error('本地录制截图不可用');
      return `data:${asset.mimeType};base64,${readFileSync(file).toString('base64')}`;
    }
    const screenshot = event.screenshotWithBox || event.screenshotBefore || event.screenshotAfter;
    if (!screenshot) throw new Error('官方未为此事件保留截图');
    return screenshot.startsWith('data:') ? screenshot : `data:image/png;base64,${screenshot}`;
  }
  saved(id: string) { this.require(id); this.draft!.status = 'saved'; this.persist(); this.changed(); }
  async discard(id: string) {
    this.require(id);
    if (this.active) await this.stop(id);
    await this.closeWorker();
    // Keep the local snapshot as a recoverable discarded draft, but remove it from the active slot.
    const archive = path.join(this.dataDir, 'recordings', id, 'discarded.json');
    mkdirSync(path.dirname(archive), { recursive: true });
    writeFileSync(archive, JSON.stringify(this.draft), { mode: 0o600 });
    this.draft = undefined; this.lastFrame = undefined; this.persist(); this.changed();
  }
  async shutdown() {
    if (this.draft && this.active) await this.stop(this.draft.id).catch(() => {});
    await this.closeWorker();
  }
  private async closeWorker() {
    const child = this.child;
    if (!child) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { this.killBrowser(); child.kill('SIGKILL'); }, 3000);
      child.once('close', () => { clearTimeout(timer); resolve(); });
      child.kill('SIGTERM');
    });
  }
}
