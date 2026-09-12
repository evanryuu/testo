const { contextBridge, ipcRenderer } = require('electron');
const methods = ['appInfo', 'checkUpdate', 'downloadUpdate', 'installUpdate', 'saveAssets', 'preflight', 'retryBatch', 'history', 'runDetail', 'exportRun', 'gitStatus', 'state', 'createProject', 'openProject', 'createSuite', 'saveGroup', 'deleteGroup', 'runGroups', 'createCase', 'saveCase', 'bulkCases', 'workflow', 'importFile', 'saveWorkflow', 'saveEnvironment', 'run', 'cancelRun', 'browserProfiles', 'addBrowserProfile', 'refreshBrowserProfile', 'focusBrowserTab', 'useBrowserTab', 'removeBrowserProfile', 'openBrowserConnector', 'copyBrowserPairingCode', 'captureSession', 'runBatch', 'cancelBatch', 'openReport', 'runPlan', 'runScreenshot', 'retryRecording', 'saveModel', 'startRecording', 'beginRecording', 'confirmChromeSession', 'recordingFrame', 'recordingScreenshot', 'recordingInteract', 'stopRecording', 'discardRecording', 'buildRecording', 'saveRecording'];
const api = Object.fromEntries(methods.map((method) => [method, async (input) => {
  const result = await ipcRenderer.invoke('workspace:call', method, input);
  if (!result.ok) throw new Error(result.error);
  return result.value;
}]));
api.onChange = (listener) => {
  const handler = () => listener();
  ipcRenderer.on('workspace:changed', handler);
  return () => ipcRenderer.removeListener('workspace:changed', handler);
};
api.onRunChange = (listener) => { const handler = (_, run) => listener(run); ipcRenderer.on('workspace:run-changed', handler); return () => ipcRenderer.removeListener('workspace:run-changed', handler); };
contextBridge.exposeInMainWorld('workspace', api);
