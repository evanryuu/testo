// Known credential fields must be references before persistence or model calls.
export function assertNoImportCredentials(text: string): void {
  for (const match of text.matchAll(/^\s*(?:[-*]\s*)?(?:密码|错误密码|password|wrongPassword|token|cookie|api[_ -]?key|authorization)\s*[:：]\s*(.+)$/gim)) {
    if (!/^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(match[1]!.trim())) throw new Error('文档包含明文凭据字段，请改用 ${变量名} 后再导入');
  }
  if (/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}|\bsk-[A-Za-z0-9_-]{16,}/.test(text)) throw new Error('文档包含疑似 Token，请删除或改为变量引用后再导入');
}
