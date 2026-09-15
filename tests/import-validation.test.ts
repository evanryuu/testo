import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { stringify } from 'yaml';
import { compileCaseSpec } from '../src/import/compiler.js';
import { assertImportedRun, importedWorkflowStatus, recordImportedValidation } from '../src/main/import-validation.js';
import type { CaseSpec } from '../src/shared/case-spec.js';
import type { RunSnapshot } from '../src/shared/workspace.js';
import { parseWorkflow } from '../src/shared/workflow-document.js';

function fixture(t: TestContext, modify?: (spec: CaseSpec, snapshot: RunSnapshot) => void) {
  const directory = mkdtempSync(path.join(tmpdir(), 'testo-import-validation-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const ref = { documentId: 'doc-login', line: 1 };
  const spec: CaseSpec = { id: 'login', title: '登录验证', description: '', path: ['账户'], priority: 'P1', tags: [], origin: 'source', ref,
    preconditions: [], data: [], steps: [{ id: 's1', text: '点击文本“登录”', kind: 'action', origin: 'source', ref }],
    expectations: [{ id: 'e1', text: '页面显示“欢迎”', kind: 'text', origin: 'source', ref, afterStepId: 's1' }], questions: [] };
  const snapshot: RunSnapshot = { environmentId: 'staging', baseUrl: 'https://test.example.test', variables: {}, defaults: {}, model: { name: 'local-test', baseUrl: 'https://model.example.test/v1', family: 'gpt-5' } };
  modify?.(spec, snapshot);
  const compiled = compileCaseSpec(spec, { variables: snapshot.variables, flows: snapshot.flows });
  const workflowPath = path.join(directory, 'workflow.yaml');
  const sourcePath = path.join(directory, 'source.json');
  const validationPath = path.join(directory, 'validation.json');
  const saveSpec = (next: CaseSpec = spec) => writeFileSync(sourcePath, JSON.stringify({ version: 1, document: { id: 'doc-login', name: 'login.md', format: 'markdown', text: '登录验证', warnings: [] }, spec: next, fingerprint: 'source-fingerprint', workflowHash: compiled.specHash }));
  writeFileSync(workflowPath, compiled.text);
  saveSpec();
  const status = (text = compiled.text, nextSnapshot = snapshot) => importedWorkflowStatus(workflowPath, text, nextSnapshot);
  const record = (passed = true, runId = 'run-success') => recordImportedValidation(workflowPath, compiled.text, snapshot, runId, passed);
  return { directory, workflowPath, sourcePath, validationPath, spec, snapshot, text: compiled.text, saveSpec, status, record };
}

test('an imported generated workflow starts pending and needs an explicit trial', t => {
  const f = fixture(t);
  assert.deepEqual(f.status(), { imported: true, status: 'pending', issues: ['当前 Workflow 或运行配置尚未验证'] });
  assert.throws(() => assertImportedRun(f.workflowPath, f.text, f.snapshot), /先显式试跑/);
  assert.doesNotThrow(() => assertImportedRun(f.workflowPath, f.text, f.snapshot, undefined, 'isolated', true));
});

test('missing business expectations or generated assertions make an import incomplete', t => {
  const f = fixture(t);
  f.saveSpec({ ...f.spec, expectations: [] });
  assert.equal(f.status().status, 'incomplete');
  assert.match(f.status().issues.join(' '), /预期|断言/);
  assert.throws(() => assertImportedRun(f.workflowPath, f.text, f.snapshot, undefined, 'isolated', true), /待补充/);
  f.saveSpec();
  const withoutAssertion = 'cases:\n  - name: 登录验证\n    steps:\n      - click_by_text: { text: 登录, exact: true }\n';
  assert.equal(f.status(withoutAssertion).status, 'incomplete');
  assert.match(f.status(withoutAssertion).issues.join(' '), /断言/);
});

test('precondition assertions cannot replace a removed, disabled, or changed business assertion', t => {
  const f = fixture(t, spec => {
    spec.preconditions.push({ id: 'p1', text: '登录入口可见', kind: 'check', origin: 'source', ref: spec.ref });
  });
  assert.equal(f.status().status, 'pending');
  for (const change of ['remove', 'disable', 'change-operation', 'change-id']) {
    const document = parseWorkflow(f.text);
    const steps = document.cases[0]!.steps;
    const index = steps.findIndex(step => (step.testo as { id?: string } | undefined)?.id === 'e1');
    assert.ok(index >= 0);
    if (change === 'remove') steps.splice(index, 1);
    else if (change === 'disable') (steps[index]!.testo as Record<string, unknown>).disabled = true;
    else if (change === 'change-operation') steps[index] = { aiAct: '查看页面', testo: steps[index]!.testo };
    else (steps[index]!.testo as Record<string, unknown>).id = 'unrelated-assertion';
    const text = stringify(document);
    assert.equal(f.status(text).status, 'incomplete', change);
    assert.match(f.status(text).issues.join(' '), /业务预期对应的断言/);
    assert.throws(() => assertImportedRun(f.workflowPath, text, f.snapshot, undefined, 'isolated', true), /待补充/);
    recordImportedValidation(f.workflowPath, text, f.snapshot, `run-${change}`, true);
    assert.equal(JSON.parse(readFileSync(f.validationPath, 'utf8')).status, 'failed');
  }
});

test('missing variables and unconfirmed manual preconditions cannot be bypassed by a trial', t => {
  const f = fixture(t, spec => {
    spec.steps[0]!.text = '在用户名输入框填写 ${username}';
    spec.preconditions.push({ id: 'manual-login', text: '确认测试账号已启用', kind: 'manual', acknowledged: false, origin: 'source', ref: spec.ref });
  });
  const initial = f.status();
  assert.equal(initial.status, 'incomplete');
  assert.match(initial.issues.join(' '), /username/);
  assert.match(initial.issues.join(' '), /人工/);
  assert.throws(() => assertImportedRun(f.workflowPath, f.text, f.snapshot, undefined, 'isolated', true), /待补充/);
  f.record();
  assert.equal(f.status().status, 'incomplete');
  assert.equal(JSON.parse(readFileSync(f.validationPath, 'utf8')).status, 'failed');
  f.spec.preconditions[0]!.acknowledged = true;
  f.saveSpec();
  f.snapshot.variables.username = 'test-user';
  assert.equal(f.status().status, 'pending');
});

test('successful trial binds validation to the exact workflow and configuration', t => {
  const f = fixture(t);
  f.record(true, 'run-123');
  assert.deepEqual(f.status(), { imported: true, status: 'passed', issues: [], runId: 'run-123' });
  assert.doesNotThrow(() => assertImportedRun(f.workflowPath, f.text, f.snapshot));
  const persisted = JSON.parse(readFileSync(f.validationPath, 'utf8'));
  assert.equal(persisted.version, 1);
  assert.equal(persisted.runId, 'run-123');
  assert.match(persisted.workflowHash, /^[a-f0-9]{64}$/);
  assert.match(persisted.configurationHash, /^[a-f0-9]{64}$/);
  assert.ok(Number.isFinite(Date.parse(persisted.at)));
});

test('manual workflow changes and shared flow changes invalidate a previously passed trial', t => {
  const f = fixture(t, (spec, snapshot) => {
    snapshot.flows = { login: { name: '登录流程', steps: [{ click_by_text: { text: '登录', exact: true } }] } };
    spec.steps[0] = { ...spec.steps[0]!, text: '登录流程', kind: 'flow', flowId: 'login' };
  });
  f.record();
  assert.equal(f.status().status, 'passed');
  assert.equal(f.status(`${f.text}\n# 人工编辑\n`).status, 'pending');
  const changed = structuredClone(f.snapshot);
  changed.flows!.login!.steps[0] = { click_by_text: { text: '继续登录', exact: true } };
  assert.equal(f.status(f.text, changed).status, 'pending');
  assert.throws(() => assertImportedRun(f.workflowPath, f.text, changed), /先显式试跑/);
});

test('environment, variables, model, timeout, and browser mode changes require a new trial', t => {
  const f = fixture(t);
  f.record();
  const changes: Array<(snapshot: RunSnapshot) => void> = [
    snapshot => { snapshot.baseUrl = 'https://another.example.test'; },
    snapshot => { snapshot.environmentId = 'production'; },
    snapshot => { snapshot.variables.username = 'different-user'; },
    snapshot => { snapshot.defaults = { region: 'new-region' }; },
    snapshot => { snapshot.model.name = 'another-model'; },
    snapshot => { snapshot.model.baseUrl = 'https://another-model.example.test/v1'; },
    snapshot => { snapshot.model.family = 'another-family'; },
    snapshot => { snapshot.timeoutMs = 90000; },
    snapshot => { snapshot.loginCondition = '已登录管理员账号'; },
  ];
  for (const change of changes) {
    const changed = structuredClone(f.snapshot);
    change(changed);
    assert.equal(f.status(f.text, changed).status, 'pending');
  }
  assert.equal(importedWorkflowStatus(f.workflowPath, f.text, f.snapshot, undefined, 'bridge').status, 'pending');
  assert.equal(f.status().status, 'passed');
});

test('a failed trial records failure and cannot enter unattended regression', t => {
  const f = fixture(t);
  f.record(false, 'failed-run');
  assert.equal(f.status().status, 'failed');
  assert.equal(f.status().runId, 'failed-run');
  assert.throws(() => assertImportedRun(f.workflowPath, f.text, f.snapshot), /先显式试跑/);
  assert.doesNotThrow(() => assertImportedRun(f.workflowPath, f.text, f.snapshot, undefined, 'isolated', true));
  f.record(true, 'retry-passed');
  assert.equal(f.status().status, 'passed');
  assert.equal(f.status().runId, 'retry-passed');
});

test('legacy workflows without import source remain unaffected', t => {
  const f = fixture(t);
  rmSync(f.sourcePath);
  assert.deepEqual(f.status(), { imported: false, status: 'pending', issues: [] });
  assert.doesNotThrow(() => assertImportedRun(f.workflowPath, f.text, f.snapshot));
  f.record();
  assert.throws(() => readFileSync(f.validationPath), { code: 'ENOENT' });
});

test('source and validation symlinks are refused for status reads and recording', t => {
  for (const kind of ['source', 'validation'] as const) {
    const f = fixture(t);
    const target = path.join(f.directory, `${kind}-outside.json`);
    const file = kind === 'source' ? f.sourcePath : f.validationPath;
    const original = kind === 'source' ? readFileSync(f.sourcePath, 'utf8') : '{}';
    writeFileSync(target, original);
    if (kind === 'source') rmSync(file);
    symlinkSync(target, file);
    assert.throws(() => f.status(), /符号链接/);
    assert.throws(() => f.record(), /符号链接/);
    assert.equal(readFileSync(target, 'utf8'), original);
  }
});

test('dangling source and validation symlinks are also refused when recording', t => {
  for (const kind of ['source', 'validation'] as const) {
    const f = fixture(t);
    const file = kind === 'source' ? f.sourcePath : f.validationPath;
    if (kind === 'source') rmSync(file);
    symlinkSync(path.join(f.directory, 'missing-target.json'), file);
    assert.throws(() => f.status(), /符号链接/);
    assert.throws(() => f.record(), /符号链接/);
  }
});
