import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { validateKnowledgeEntries } from '../shared/knowledge.js';
import type { KnowledgeSnapshot, SaveKnowledgeInput } from '../shared/knowledge.js';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
function knowledgeFile(root: string): string {
  const file = path.join(realpathSync(root), 'knowledge.json');
  try {
    const stat = lstatSync(file);
    if (stat.isSymbolicLink()) throw new Error('知识库文件不能是符号链接');
    if (!stat.isFile()) throw new Error('知识库路径必须是文件');
    if (stat.size > 8 * 1024 * 1024) throw new Error('知识库文件超过 8 MB');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return file;
}
export function readKnowledge(root: string): KnowledgeSnapshot {
  const file = knowledgeFile(root);
  let text: string;
  try { text = readFileSync(file, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { revision: hash(''), entries: [] };
    throw error;
  }
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { throw new Error('知识库 JSON 无法解析，请修复 knowledge.json 后重试'); }
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['version', 'entries'].includes(key)) || !('version' in value) || value.version !== 1 || !('entries' in value)) throw new Error('知识库版本或文件格式无效');
  return { revision: hash(text), entries: validateKnowledgeEntries(value.entries) };
}
export function saveKnowledge(root: string, input: SaveKnowledgeInput): KnowledgeSnapshot {
  const entries = validateKnowledgeEntries(input.entries);
  const current = readKnowledge(root);
  if (typeof input.revision !== 'string' || input.revision !== current.revision) throw new Error('知识库已被修改，请重新加载后再保存');
  const file = knowledgeFile(root), temporary = `${file}.${randomUUID()}.tmp`;
  const text = JSON.stringify({ version: 1, entries }, null, 2) + '\n';
  if (Buffer.byteLength(text) > 8 * 1024 * 1024) throw new Error('知识库文件超过 8 MB');
  try {
    writeFileSync(temporary, text, { mode: 0o600, flag: 'wx' });
    renameSync(temporary, file);
  } finally {
    try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  return { revision: hash(text), entries };
}
