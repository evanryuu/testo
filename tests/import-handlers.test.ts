import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { parse } from 'yaml';
import { createImportHandlers } from '../src/main/import-handlers.js';
import { WorkspaceStore } from '../src/main/workspace.js';
import type { ParsedImport, SourceNode } from '../src/shared/case-spec.js';
import type { DocumentImportApi } from '../src/shared/document-import-api.js';

const fixture = readFileSync('tests/fixtures/document-import/login.md', 'utf8');
function setup(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'import-handlers-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new WorkspaceStore(path.join(dir, 'data'), path.join(dir, 'projects'));
  const projectId = store.create('Handlers', '');
  let modelStarts = 0, picks = 0;
  const api = createImportHandlers(store, () => { modelStarts++; throw new Error('TEST_MODEL_START'); }, async () => { picks++; return undefined; });
  t.after(api.cancelAll);
  const invoke = (name: string, input?: unknown): unknown => api.handlers[name]!(input);
  const parsed = invoke('parseImportDocument', { text: fixture, name: 'login.md' }) as ParsedImport;
  return { store, projectId, invoke, parsed, starts: () => modelStarts, picks: () => picks };
}
test('template parsing and compilation use no model and embed only explicit public variables', t => {
  const { store, projectId, invoke, starts, parsed } = setup(t);
  const project = store.project(projectId);
  store.saveAssets({ projectId, revision: project.assets!.revision, variables: { testUser: 'private-user-sentinel', wrongPassword: 'private-password-sentinel', internal: 'private-project-sentinel' }, flows: {} });
  assert.equal(parsed.needsAI, false);
  assert.equal(parsed.cases.length, 1);
  const compiled = invoke('compileImportCases', { projectId, cases: parsed.cases, variables: { publicLabel: 'Agents' } }) as Awaited<ReturnType<DocumentImportApi['compileImportCases']>>;
  const workflow = compiled.workflows[parsed.cases[0]!.id]!;
  assert.ok(workflow);
  assert.deepEqual(parse(workflow.text).testo.variables, { publicLabel: 'Agents' });
  assert.doesNotMatch(workflow.text, /private-(?:user|password|project)-sentinel/);
  assert.match(workflow.text, /\$\{testUser\}/);
  assert.match(workflow.text, /\$\{wrongPassword\}/);
  assert.equal(compiled.issues[parsed.cases[0]!.id]!.length, 0);
  assert.equal(starts(), 0);
});
test('all handler inputs reject unknown parameters before effects', async t => {
  const { invoke, projectId, parsed, starts, picks } = setup(t);
  const inputs: Record<string, unknown> = {
    parseImportDocument: { text: fixture, name: 'login.md', unknown: true },
    pickImportDocument: { unknown: true },
    listImportDrafts: { projectId, unknown: true },
    loadImportDraft: { projectId, id: randomUUID(), unknown: true },
    saveImportDraft: { projectId, draft: {}, revision: '', unknown: true },
    commitImportDraft: { projectId, id: randomUUID(), revision: 'a'.repeat(64), duplicate: 'skip', unknown: true },
    compileImportCases: { projectId, cases: parsed.cases, variables: {}, unknown: true },
    knowledge: { projectId, unknown: true },
    saveKnowledge: { projectId, revision: 'a'.repeat(64), entries: [], unknown: true },
    planImportDocument: { projectId, requestId: randomUUID(), mode: 'existing', document: parsed.document, unknown: true },
    cancelImportPlan: { requestId: randomUUID(), unknown: true },
  };
  for (const [name, input] of Object.entries(inputs)) await assert.rejects(async () => invoke(name, input), /Unrecognized|Invalid input|无效/, name);
  assert.equal(starts(), 0);
  assert.equal(picks(), 0);
});
test('malformed planning documents never reach the model boundary', async t => {
  const { invoke, projectId, parsed, starts } = setup(t), valid = parsed.document;
  const invalid: unknown[] = [null, {}, { text: 'free text' }, { ...valid, unknown: true }, { ...valid, text: '' }, { ...valid, text: ' ' }, { ...valid, id: '' }, { ...valid, id: 'x'.repeat(101) }, { ...valid, name: '' }, { ...valid, name: 'x'.repeat(201) }, { ...valid, format: 'html' }, { ...valid, warnings: 'bad' }, { ...valid, warnings: [1] }, { ...valid, tree: {} }, { ...valid, tree: [{ id: 'root', title: 'root', children: [], unknown: true }] }, { ...valid, tree: [{ id: '', title: 'root', children: [] }] }, { ...valid, tree: [{ id: 'root', title: 1, children: [] }] }, { ...valid, tree: [{ id: 'root', title: 'root', children: {} }] }];
  for (const document of invalid) await assert.rejects(async () => invoke('planImportDocument', { projectId, requestId: randomUUID(), mode: 'existing', document }), error => { assert.doesNotMatch(String(error), /TEST_MODEL_START/); return true; });
  assert.equal(starts(), 0);
});
test('oversized, repeated, cyclic and deep planning trees are rejected without starting a model', async t => {
  const { invoke, projectId, parsed, starts } = setup(t), valid = parsed.document;
  let deep: SourceNode = { id: 'last', title: 'last', children: [] };
  for (let index = 0; index < 31; index++) deep = { id: `node-${index}`, title: 'node', children: [deep] };
  const cyclic: SourceNode = { id: 'cycle', title: 'cycle', children: [] }; cyclic.children.push(cyclic);
  const invalid = [
    { ...valid, text: 'x'.repeat(1024 * 1024 + 1) },
    { ...valid, text: 'x'.repeat(350001) },
    { ...valid, text: '中'.repeat(400000) },
    { ...valid, warnings: Array(201).fill('warning') },
    { ...valid, tree: [deep] },
    { ...valid, tree: [cyclic] },
    { ...valid, tree: [{ id: 'duplicate', title: 'first', children: [] }, { id: 'duplicate', title: 'second', children: [] }] },
    { ...valid, tree: Array.from({ length: 5001 }, (_, index) => ({ id: `node-${index}`, title: 'node', children: [] })) },
  ];
  for (const document of invalid) await assert.rejects(async () => invoke('planImportDocument', { projectId, requestId: randomUUID(), mode: 'design', document }), error => { assert.doesNotMatch(String(error), /TEST_MODEL_START/); return true; });
  assert.equal(starts(), 0);
});
test('sensitive literals are rejected in pasted documents, planned tree text, cases and public variables', async t => {
  const { invoke, projectId, parsed, starts } = setup(t);
  assert.throws(() => invoke('parseImportDocument', { text: 'password: literal-secret', name: 'secrets.md' }), /凭据/);
  const cases = structuredClone(parsed.cases); cases[0]!.steps[0]!.text = 'password: literal-secret';
  assert.throws(() => invoke('compileImportCases', { projectId, cases, variables: {} }), /凭据/);
  assert.throws(() => invoke('compileImportCases', { projectId, cases: parsed.cases, variables: { password: 'literal-secret' } }), /凭据/);
  assert.throws(() => invoke('compileImportCases', { projectId, cases: parsed.cases, variables: { config: { password: 'nested-secret' } } }), /凭据/);
  assert.throws(() => invoke('compileImportCases', { projectId, cases: parsed.cases, variables: { label: 'Bearer abcdefghijklmnop' } }), /Token/);
  await assert.rejects(async () => invoke('planImportDocument', { projectId, requestId: randomUUID(), mode: 'existing', document: { ...parsed.document, text: 'password: literal-secret' } }), /凭据/);
  await assert.rejects(async () => invoke('planImportDocument', { projectId, requestId: randomUUID(), mode: 'existing', document: { ...parsed.document, format: 'xmind', tree: [{ id: 'root', title: 'password: literal-secret', children: [] }] } }), /凭据/);
  assert.equal(starts(), 0);
});
test('compile rejects duplicate or reserved case IDs instead of replacing another workflow', t => {
  const { invoke, projectId, parsed, starts } = setup(t);
  assert.throws(() => invoke('compileImportCases', { projectId, cases: [parsed.cases[0], parsed.cases[0]], variables: {} }), /ID/);
  for (const id of ['__proto__', 'constructor', 'prototype']) assert.throws(() => invoke('compileImportCases', { projectId, cases: [{ ...parsed.cases[0], id }], variables: {} }), /ID/);
  assert.equal(starts(), 0);
});
test('valid document reaches only the instrumented model boundary and failed attempts release the job', async t => {
  const { invoke, projectId, parsed, starts } = setup(t);
  for (let attempt = 0; attempt < 2; attempt++) await assert.rejects(async () => invoke('planImportDocument', { projectId, requestId: randomUUID(), mode: 'existing', document: parsed.document }), /TEST_MODEL_START/);
  assert.equal(starts(), 2);
});
