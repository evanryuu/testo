import { ExtensionBridgePageBrowserSide } from '@midscene/web/bridge-mode-browser';
export class ProfileBridge extends ExtensionBridgePageBrowserSide {
  constructor(config, installationId, onDisconnect) {
    // Saving a local pairing code explicitly authorizes this connector.
    super(config.endpoint, onDisconnect, () => {}, false, async () => true);
    this.catalogConfig = config; this.installationId = installationId;
    this.waterFlowAnimationEnabled = false;
  }
  async getBrowserTabList() {
    const tabs = await chrome.tabs.query({});
    return { version: 1, connectionToken: this.catalogConfig.token,
      profileInstallationId: this.installationId, name: this.catalogConfig.name,
      tabs: tabs.filter(tab => Number.isInteger(tab.id) && /^https?:\/\//.test(tab.url ?? '')).map(tab => ({
        tabId: String(tab.id), windowId: tab.windowId, index: tab.index,
        title: tab.title ?? '', url: tab.url, active: tab.active,
      })),
    };
  }
  async setActiveTabId(tabId, options = {}) {
    if (!/^[1-9]\d*$/.test(String(tabId)) || !Number.isSafeInteger(Number(tabId))) throw new Error('标签页标识无效');
    const tab = await chrome.tabs.get(Number(tabId));
    if (!/^https?:\/\//.test(tab.url ?? '')) throw new Error('只能连接 HTTP 或 HTTPS 页面');
    await chrome.windows.update(tab.windowId, { focused: true });
    await super.setActiveTabId(Number(tabId), options);
  }
}
