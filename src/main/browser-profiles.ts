import { randomBytes, randomUUID } from 'node:crypto';
import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findAvailablePort } from '@midscene/shared/node';
import type { ChromeProfileBinding, ChromeProfileCatalog, ChromeProfileInfo, ChromeTabInfo } from '../shared/browser.js';
import { captureChromeSession, createChromeBridge, readChromeProfileCatalog, type ChromeTarget } from '../recording/chrome-bridge.js';

type ProfileEntry = { info: ChromeProfileInfo; port: number; connectionToken: string };
type ProfileCommand = { action: 'refresh' | 'focus' | 'capture'; port: number; connectorId: string; connectionToken: string; profileInstallationId?: string; tabId?: string; origin?: string };
type ProfileResult = { catalog: ChromeProfileCatalog; target?: ChromeTarget };
type WorkerReply = { ok: true; value: ProfileResult } | { ok: false; error: string };

/** Discovery and confirmation use disposable workers so stalled extension RPCs cannot retain a port. */
export class BrowserProfileService {
  private profiles = new Map<string, ProfileEntry>();
  private creating = false;
  private closed = false;
  private pending?: { child: ChildProcess; result: Promise<ProfileResult>; cancel: () => void };
  constructor(private changed: () => void = () => {}) {}
  get busy(): boolean { return this.creating || !!this.pending; }
  list(): ChromeProfileInfo[] { return [...this.profiles.values()].map(entry => structuredClone(entry.info)); }

  async create(): Promise<ChromeProfileInfo> {
    this.available(); this.creating = true;
    try {
      const firstPort = Math.max(13765, ...[...this.profiles.values()].map(entry => entry.port)) + 1;
      if (firstPort > 65535) throw new Error('没有可分配的浏览器连接端口');
      const port = await findAvailablePort(firstPort, Math.min(1000, 65536 - firstPort));
      if (this.closed) throw new Error('浏览器配置服务已关闭');
      const id = randomUUID(), connectionToken = randomBytes(32).toString('hex');
      const info: ChromeProfileInfo = { id, name: `Chrome 配置 ${this.profiles.size + 1}`, status: 'unconnected', pairingCode: `testo://connect?port=${port}&token=${connectionToken}`, tabs: [] };
      this.profiles.set(id, { info, port, connectionToken }); this.changed();
      return structuredClone(info);
    } finally { this.creating = false; }
  }
  remove(id: string): void {
    this.available(); this.require(id); this.profiles.delete(id); this.changed();
  }
  async refresh(id: string): Promise<ChromeProfileInfo> {
    await this.perform(id, 'refresh');
    return structuredClone(this.require(id).info);
  }
  async focus(id: string, tabId: string): Promise<void> { await this.perform(id, 'focus', { tabId }); }
  async capture(id: string, tabId: string, origin: string): Promise<{ target: ChromeTarget; tab: ChromeTabInfo; profile: ChromeProfileInfo }> {
    const result = await this.perform(id, 'capture', { tabId, origin });
    if (!result.target) throw new Error('未能确认所选 Chrome 标签页');
    const tab = result.catalog.tabs.find(tab => tab.tabId === tabId)!;
    return { target: result.target, tab, profile: structuredClone(this.require(id).info) };
  }
  cancel(): void { this.pending?.cancel(); }
  async destroy(): Promise<void> {
    this.closed = true;
    const pending = this.pending;
    pending?.cancel();
    await pending?.result.catch(() => {});
  }
  private available(): void {
    if (this.closed) throw new Error('浏览器配置服务已关闭');
    if (this.busy) throw new Error('正在连接浏览器配置，请稍候');
  }
  private require(id: string): ProfileEntry {
    const entry = this.profiles.get(id);
    if (!entry) throw new Error('浏览器配置不存在，请重新添加');
    return entry;
  }
  private async perform(id: string, action: ProfileCommand['action'], input: { tabId?: string; origin?: string } = {}): Promise<ProfileResult> {
    this.available();
    const entry = this.require(id);
    if (action !== 'refresh' && !entry.info.profileInstallationId) throw new Error('请先刷新并连接浏览器配置');
    if (input.tabId !== undefined && !/^[1-9]\d*$/.test(input.tabId)) throw new Error('标签页标识无效');
    if (action === 'capture' && (!input.origin || !/^https?:$/.test(new URL(input.origin).protocol))) throw new Error('环境地址必须使用 HTTP 或 HTTPS');
    const command: ProfileCommand = { action, port: entry.port, connectorId: id, connectionToken: entry.connectionToken, profileInstallationId: entry.info.profileInstallationId, ...input };
    const child = fork(fileURLToPath(import.meta.url), ['--browser-profile-worker'], { execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
    let reply: WorkerReply | undefined, failure: Error | undefined;
    const cancel = () => { failure ??= new Error('浏览器连接已取消'); child.kill('SIGKILL'); };
    const result = new Promise<ProfileResult>((resolve, reject) => {
      const timer = setTimeout(() => { failure = new Error('浏览器连接超过 30 秒，请检查扩展配对并重试'); child.kill('SIGKILL'); }, 30000);
      child.on('message', (message: WorkerReply) => { reply = message; });
      child.once('error', error => { failure = error; child.kill('SIGKILL'); });
      child.once('close', code => {
        clearTimeout(timer);
        if (this.pending?.child === child) this.pending = undefined;
        if (failure) reject(failure);
        else if (code !== 0 || !reply) reject(new Error('浏览器连接进程已退出，请重试'));
        else if (!reply.ok) reject(new Error(reply.error));
        else resolve(reply.value);
      });
      child.send(command, error => { if (error) { failure = error; child.kill('SIGKILL'); } });
    });
    this.pending = { child, result, cancel };
    entry.info.status = 'connecting'; entry.info.error = undefined; this.changed();
    try {
      const value = await result;
      entry.info = { ...entry.info, name: value.catalog.name, profileInstallationId: value.catalog.profileInstallationId, tabs: value.catalog.tabs, status: 'ready', checkedAt: new Date().toISOString(), error: undefined };
      return value;
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).replaceAll(entry.connectionToken, '[已隐藏]');
      entry.info.status = 'disconnected'; entry.info.error = message; throw new Error(message);
    } finally { this.changed(); }
  }
}

if (process.argv.includes('--browser-profile-worker')) {
  let started = false;
  process.on('disconnect', () => process.exit(0));
  process.on('message', async (command: ProfileCommand) => {
    if (started) return; started = true;
    let reply: WorkerReply;
    const agent = createChromeBridge(undefined, command.port);
    try {
      const catalog = await readChromeProfileCatalog(agent, command);
      let target: ChromeTarget | undefined;
      if (command.action !== 'refresh') {
        const tab = catalog.tabs.find(tab => tab.tabId === command.tabId);
        if (!tab) throw new Error('所选标签页已关闭或不可访问，请刷新后重新选择');
        if (command.action === 'focus') await agent.setActiveTabId(tab.tabId);
        else {
          const profile: ChromeProfileBinding = { connectorId: command.connectorId, port: command.port, connectionToken: command.connectionToken, profileInstallationId: catalog.profileInstallationId };
          target = await captureChromeSession(command.origin!, { tabId: tab.tabId, origin: command.origin!, profile }, agent);
        }
      }
      reply = { ok: true, value: { catalog, target } };
    } catch (error) { reply = { ok: false, error: error instanceof Error ? error.message : String(error) }; }
    try { await agent.destroy(); }
    catch { reply = { ok: false, error: '释放浏览器连接失败，请重试' }; }
    if (process.connected) process.send?.(reply, undefined, undefined, () => process.disconnect());
  });
}
