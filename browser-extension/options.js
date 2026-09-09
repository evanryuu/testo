const form = document.querySelector('#settings');
const name = document.querySelector('#name'), pairing = document.querySelector('#pairing');
const status = document.querySelector('#status'), error = document.querySelector('#error');
async function request(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (response?.error) throw new Error(response.error);
  return response;
}
async function load() {
  const response = await request({ type: 'settings' });
  name.value = response.settings.name; pairing.value = response.settings.pairingCode;
  status.textContent = response.status?.message || '尚未连接';
}
form.addEventListener('submit', async event => {
  event.preventDefault(); error.textContent = '';
  try { await request({ type: 'save', settings: { name: name.value, pairingCode: pairing.value } }); status.textContent = '配对已保存，请回 Testo 刷新连接'; }
  catch (e) { error.textContent = e.message; }
});
document.querySelector('#disconnect').addEventListener('click', async () => {
  error.textContent = '';
  try { await request({ type: 'disconnect' }); status.textContent = '已断开连接'; }
  catch (e) { error.textContent = e.message; }
});
chrome.storage.onChanged.addListener((changes, area) => { if (area === 'session' && changes.connectorStatus) status.textContent = changes.connectorStatus.newValue.message; });
void load().catch(e => { error.textContent = e.message; });
