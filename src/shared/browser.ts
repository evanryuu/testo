export interface ChromeTabInfo { tabId: string; windowId: number; index: number; title: string; url: string; active: boolean }
export interface ChromeProfileInfo {
  id: string; name: string; status: 'unconnected' | 'connecting' | 'ready' | 'disconnected';
  pairingCode: string; profileInstallationId?: string; tabs: ChromeTabInfo[]; checkedAt?: string; error?: string;
}
/** Private Bridge response; the secret is stripped before returning profile metadata to the UI. */
export interface ChromeProfileCatalog { version: 1; connectionToken: string; profileInstallationId: string; name: string; tabs: ChromeTabInfo[] }
export interface ChromeProfileBinding { connectorId: string; profileInstallationId: string; port: number; connectionToken: string }
