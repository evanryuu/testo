import { ExtensionBridgePageBrowserSide } from '@midscene/web/bridge-mode-browser';
// Real official extension implementation in an isolated test-only extension page.
// Approval is automatic only for this local fixture, never in the product.
window.debuggerAttachCalls = 0;
const attach = chrome.debugger.attach.bind(chrome.debugger);
chrome.debugger.attach = (...args) => { window.debuggerAttachCalls++; return attach(...args); };
window.attachBridge = async (url) => {
  const bridge = new ExtensionBridgePageBrowserSide(url, () => {}, () => {}, false, async () => true);
  await bridge.connect();
  window.testBridge = bridge;
};
