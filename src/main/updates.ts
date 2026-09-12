import { createRequire } from 'node:module';
import type { AppUpdater } from 'electron-updater';
import type { UpdateState } from '../shared/workspace.js';

/** Updates are opt-in at both packaging time and at each user action. */
export class UpdateService {
  private updater?: AppUpdater;
  private value: UpdateState;
  constructor(version: string, enabled: boolean, private changed: () => void) {
    this.value = { version, enabled, status: 'idle', message: enabled ? '点击检查 GitHub Release 中的正式版本' : '当前为开发或本地测试版本，自动更新在签名发布后启用' };
  }
  state(): UpdateState { return { ...this.value }; }
  private set(input: Partial<UpdateState>) { Object.assign(this.value, input); this.changed(); }
  private client(): AppUpdater {
    if (!this.value.enabled) throw new Error(this.value.message);
    if (!this.updater) {
      const updater = createRequire(import.meta.url)('electron-updater').autoUpdater as AppUpdater;
      updater.autoDownload = false;
      updater.autoInstallOnAppQuit = false;
      updater.allowPrerelease = false;
      updater.on('error', error => this.set({ status: 'error', message: error.message }));
      updater.on('update-not-available', () => this.set({ status: 'current', message: '已经是最新正式版本' }));
      updater.on('update-available', info => this.set({ status: 'available', nextVersion: info.version, message: `可以更新到 ${info.version}` }));
      updater.on('download-progress', info => this.set({ percent: Math.round(info.percent) }));
      updater.on('update-downloaded', () => this.set({ status: 'downloaded', percent: 100, message: '下载完成，点击安装后将重启应用' }));
      this.updater = updater;
    }
    return this.updater;
  }
  async check() {
    if (['checking', 'downloading', 'downloaded'].includes(this.value.status)) throw new Error('请先完成当前更新操作');
    const client = this.client();
    this.set({ status: 'checking', nextVersion: undefined, percent: undefined, message: '正在检查更新' });
    try { await client.checkForUpdates(); } catch (error) { this.set({ status: 'error', message: String(error) }); }
    return this.state();
  }
  async download() {
    if (this.value.status !== 'available') throw new Error('请先检查可用版本');
    this.set({ status: 'downloading', percent: 0, message: '正在下载更新' });
    try { await this.client().downloadUpdate(); } catch (error) { this.set({ status: 'error', message: String(error) }); }
    return this.state();
  }
  install() {
    if (this.value.status !== 'downloaded') throw new Error('更新尚未下载完成');
    this.client().quitAndInstall();
  }
}
