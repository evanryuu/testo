import { ProfileBridge } from './connector.js';
import { parsePairingCode, validateSettings } from './config.js';
let settings, installationId, bridge, timer, generation = 0, connecting = false;
const alarmName = 'testo-connector-reconnect';
const status = (state, message) => chrome.storage.session.set({ connectorStatus: { state, message } });
const boot = (async () => {
  const saved = await chrome.storage.local.get(['profileInstallationId', 'connectorSettings']);
  installationId = saved.profileInstallationId || crypto.randomUUID();
  if (!saved.profileInstallationId) await chrome.storage.local.set({ profileInstallationId: installationId });
  settings = saved.connectorSettings || { name: '我的 Chrome', pairingCode: '', enabled: false };
})();
function schedule() {
  clearTimeout(timer);
  if (settings?.enabled) timer = setTimeout(() => { void connect(); }, 3000);
}
async function connect() {
  await boot;
  if (!settings.enabled || bridge || connecting) return;
  const attemptGeneration = generation;
  connecting = true;
  let attempt;
  try {
    attempt = new ProfileBridge({ ...parsePairingCode(settings.pairingCode), name: settings.name }, installationId, () => {
      if (bridge === attempt) {
        bridge = undefined;
        void status(settings.enabled ? 'disconnected' : 'disabled', settings.enabled ? '等待 Testo 的下一次操作' : '已断开连接');
        schedule();
      }
    });
    bridge = attempt;
    await status('connecting', '正在连接本机 Testo');
    await attempt.connect();
    if (attemptGeneration !== generation || !settings.enabled) { await attempt.destroy(); return; }
    await status('ready', '已连接 Testo');
  } catch {
    if (bridge === attempt) bridge = undefined;
    await attempt?.destroy().catch(() => {});
    if (attemptGeneration === generation) await status('disconnected', '配对已保存，请回 Testo 刷新连接');
  } finally {
    connecting = false;
    if (!bridge) schedule();
  }
}
async function restart() {
  generation++; clearTimeout(timer);
  const previous = bridge; bridge = undefined;
  await previous?.destroy().catch(() => {});
  if (settings.enabled) {
    await chrome.alarms.create(alarmName, { periodInMinutes: 0.5 });
    await connect();
  } else {
    await chrome.alarms.clear(alarmName);
    await status('disabled', '已断开连接');
  }
}
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return;
  void (async () => {
    await boot;
    if (message?.type === 'settings') return { settings, status: (await chrome.storage.session.get('connectorStatus')).connectorStatus };
    if (message?.type === 'save') {
      settings = validateSettings({ ...message.settings, enabled: true });
      await chrome.storage.local.set({ connectorSettings: settings });
      void restart();
      return { ok: true };
    }
    if (message?.type === 'disconnect') {
      settings = { ...settings, enabled: false };
      await chrome.storage.local.set({ connectorSettings: settings });
      await restart();
      return { ok: true };
    }
    throw new Error('不支持的请求');
  })().then(sendResponse, error => sendResponse({ error: error.message }));
  return true;
});
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === alarmName) void connect(); });
chrome.action.onClicked.addListener(() => { void chrome.runtime.openOptionsPage(); });
void boot.then(() => restart());
