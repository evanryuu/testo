const { contextBridge, ipcRenderer } = require('electron');
const methods = ['state', 'createProject', 'openProject', 'createSuite', 'createCase', 'saveCase', 'workflow', 'importFile', 'saveWorkflow', 'saveEnvironment', 'run', 'cancelRun', 'captureSession', 'runBatch', 'cancelBatch', 'openReport', 'runPlan', 'runScreenshot', 'retryRecording', 'saveModel', 'startRecording', 'beginRecording', 'confirmChromeSession', 'recordingFrame', 'recordingScreenshot', 'recordingInteract', 'stopRecording', 'discardRecording', 'buildRecording', 'saveRecording'];
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
contextBridge.exposeInMainWorld('workspace', api);
