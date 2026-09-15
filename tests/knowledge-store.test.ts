import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { readKnowledge, saveKnowledge } from '../src/main/knowledge.js';
import { validateKnowledgeEntries } from '../src/shared/knowledge.js';
import type { KnowledgeEntry } from '../src/shared/knowledge.js';

const entry: KnowledgeEntry = { id: 'agents', title: 'Agent 列表', aliases: ['我的 Agent'], content: '点击「我的 Agent」，等待 Agent 列表显示。', status: 'draft', source: 'ai', updatedAt: '2026-09-15T00:00:00.000Z', sourceCaseId: 'case-1', sourceWorkflowId: 'workflow-1' };
function project(t: { after(fn: () => void): void }): string {
  const root = mkdtempSync(path.join(tmpdir(), 'knowledge-store-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
test('knowledge CRUD roundtrips entries and permissions in the project JSON file', t => {
  const root = project(t), empty = readKnowledge(root);
  assert.deepEqual(empty, { revision: createHash('sha256').update('').digest('hex'), entries: [] });
  const created = saveKnowledge(root, { revision: empty.revision, entries: [entry] });
  assert.deepEqual(readKnowledge(root), created);
  assert.equal(statSync(path.join(root, 'knowledge.json')).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(path.join(root, 'knowledge.json'), 'utf8')), { version: 1, entries: [entry] });
  const edited = saveKnowledge(root, { revision: created.revision, entries: [{ ...entry, status: 'confirmed', content: '打开侧栏中的 Agent 列表。' }] });
  assert.equal(readKnowledge(root).entries[0]!.status, 'confirmed');
  const removed = saveKnowledge(root, { revision: edited.revision, entries: [] });
  assert.deepEqual(readKnowledge(root), removed);
});
test('stale knowledge revisions never overwrite newer edits', t => {
  const root = project(t), first = readKnowledge(root);
  const saved = saveKnowledge(root, { revision: first.revision, entries: [entry] });
  assert.throws(() => saveKnowledge(root, { revision: first.revision, entries: [] }), /已被修改/);
  assert.deepEqual(readKnowledge(root), saved);
});
test('malformed or unsupported knowledge files are reported and preserved', t => {
  const root = project(t), revision = readKnowledge(root).revision, file = path.join(root, 'knowledge.json');
  for (const content of ['{broken', '{"version":2,"entries":[]}', '{"version":1,"entries":[],"extra":true}', '{"version":1,"entries":[{}]}']) {
    writeFileSync(file, content);
    assert.throws(() => readKnowledge(root), /知识库/);
    assert.throws(() => saveKnowledge(root, { revision, entries: [] }), /知识库/);
    assert.equal(readFileSync(file, 'utf8'), content);
  }
});
test('knowledge is isolated between projects', t => {
  const first = project(t), second = project(t);
  saveKnowledge(first, { revision: readKnowledge(first).revision, entries: [entry] });
  assert.deepEqual(readKnowledge(second).entries, []);
});
test('knowledge rejects existing and dangling symlinks without reading or writing their targets', t => {
  const outside = project(t);
  for (const existing of [false, true]) {
    const root = project(t), revision = readKnowledge(root).revision, target = path.join(outside, existing ? 'existing.json' : 'missing.json');
    if (existing) writeFileSync(target, 'untouched');
    symlinkSync(target, path.join(root, 'knowledge.json'));
    assert.throws(() => readKnowledge(root), /符号链接/);
    assert.throws(() => saveKnowledge(root, { revision, entries: [entry] }), /符号链接/);
    if (existing) assert.equal(readFileSync(target, 'utf8'), 'untouched');
  }
});
test('knowledge validates field types, strict keys, IDs and bounded content', () => {
  assert.deepEqual(validateKnowledgeEntries([entry]), [entry]);
  for (const invalid of [[entry, entry], [{ ...entry, status: 'unknown' }], [{ ...entry, title: ' ' }], [{ ...entry, content: 'x'.repeat(12001) }], [{ ...entry, updatedAt: 'yesterday' }], [{ ...entry, extra: true }], [{ ...entry, aliases: [1] }]]) assert.throws(() => validateKnowledgeEntries(invalid), /知识库格式无效/);
});
