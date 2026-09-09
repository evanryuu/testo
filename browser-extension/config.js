export function parsePairingCode(value) {
  if (typeof value !== 'string' || value.length > 1024) throw new Error('请粘贴 Testo 生成的连接代码');
  let code;
  try { code = new URL(value.trim()); } catch { throw new Error('连接代码格式不正确'); }
  if (code.protocol !== 'testo:' || code.hostname !== 'connect' || code.username || code.password || code.port || code.hash || !['', '/'].includes(code.pathname)
    || [...code.searchParams.keys()].some(key => !['port', 'token'].includes(key))
    || code.searchParams.getAll('port').length !== 1 || code.searchParams.getAll('token').length !== 1) throw new Error('只支持 Testo 生成的本机连接代码');
  const rawPort = code.searchParams.get('port'), token = code.searchParams.get('token'), port = Number(rawPort);
  if (!/^\d+$/.test(rawPort) || !Number.isInteger(port) || port < 1024 || port > 65535 || !/^[A-Za-z0-9_-]{16,256}$/.test(token)) throw new Error('连接代码中的端口或凭证无效');
  return { port, token, endpoint: `http://127.0.0.1:${port}` };
}
export function validateSettings(input) {
  const name = typeof input?.name === 'string' ? input.name.trim() : '';
  if (!name || name.length > 80) throw new Error('请输入 1 至 80 字的名称');
  parsePairingCode(input.pairingCode);
  return { name, pairingCode: input.pairingCode.trim(), enabled: input.enabled === true };
}
