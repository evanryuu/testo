import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { zipSync, strToU8 } from 'fflate';
import { parse } from 'yaml';
import { parseMarkdown } from '../src/import/markdown.js';
import { parseXmind } from '../src/import/xmind.js';
import { caseIssues, compileCaseSpec } from '../src/import/compiler.js';
import { validateWorkflow } from '../src/main/workflow-validation.js';
import { compileWorkflow } from '../src/shared/workflow-document.js';
import { executeWorkflow } from '../src/runner/midscene.js';
import type { WorkerEvent } from '../src/runner/messages.js';

const fixture = readFileSync('tests/fixtures/document-import/login.md', 'utf8');
const xmindJson = readFileSync('tests/fixtures/document-import/content.json', 'utf8');
const zip = (text = xmindJson) => zipSync({ 'content.json': strToU8(text) });
test('template Markdown retains source locations, variables, preparation and every assertion without a model', () => {
  const result = parseMarkdown(fixture, 'login.md');
  assert.equal(result.needsAI, false);
  assert.equal(result.cases.length, 1);
  const spec = result.cases[0]!;
  assert.equal(spec.sourceId, 'LOGIN-001');
  assert.equal(spec.title, '密码错误不能登录');
  assert.deepEqual(spec.path, ['登录模块']);
  assert.equal(spec.ref.line, 3);
  assert.equal(spec.steps[0]!.ref.line, 10);
  assert.equal(spec.expectations[0]!.ref.line, 14);
  assert.deepEqual(spec.preconditions.map(item => ({ text: item.text, kind: item.kind })), [{ text: '未登录', kind: 'check' }, { text: '打开登录页', kind: 'action' }]);
  assert.deepEqual(spec.preconditions.map(item => item.ref.line), [5, 5]);
  assert.deepEqual(spec.preconditions.map(item => item.ref.endLine), [5, 5]);
  assert.deepEqual(spec.data.map(item => item.value), ['${testUser}', '${wrongPassword}']);
  const compiled = compileCaseSpec(spec);
  assert.deepEqual(compiled.issues.map(item => item.code).sort(), ['missing-variable-testUser', 'missing-variable-wrongPassword'].sort());
  const steps = parse(compiled.text).cases[0].steps;
  assert.deepEqual(steps.map((step: Record<string, unknown>) => Object.keys(step).find(key => key !== 'testo')), ['gotoUrl', 'aiAssert', 'aiAct', 'aiAct', 'aiAct', 'aiAct', 'assertText', 'aiAssert']);
  assert.equal(steps[1].aiAssert, '未登录');
  assert.equal(steps[2].aiAct, '打开登录页');
  assert.equal(steps[6].assertText.text, '账号或密码错误');
  assert.equal(steps[7].aiAssert, '当前仍处于未登录状态');
  assert.equal(validateWorkflow(compiled.text, { variables: { testUser: 'sample-user', wrongPassword: 'dummy-value' } }).steps, 8);
  assert.doesNotMatch(compiled.text, /recordedAction|requireViewport|screenshot/);
  assert.equal(parseMarkdown(fixture).cases[0]!.id, spec.id);
});
test('multiple Markdown cases stay separate and retain ordered steps and nested heading paths', () => {
  const result = parseMarkdown(`${fixture}\n## [LOGIN-002] 退出登录\n- 步骤：\n  1. 点击退出登录\n  2. 等待登录页面\n- 预期结果：\n  - 当前处于未登录状态`);
  assert.equal(result.cases.length, 2);
  assert.equal(result.cases[0]!.steps.length, 3);
  assert.deepEqual(result.cases[1]!.steps.map(step => step.text), ['点击退出登录', '等待登录页面']);
  for (const spec of result.cases) assert.equal(parse(compileCaseSpec(spec).text).cases.length, 1);
  const nested = parseMarkdown('# 模块\n## 分类\n### [A] 用例\n- 步骤：\n  1. 点击按钮\n- 预期结果：\n  - 页面正常');
  assert.deepEqual(nested.cases[0]!.path, ['模块', '分类']);
  const sections = parseMarkdown('# 模块\n## 不带 ID 的用例\n### 步骤\n1. 点击按钮\n### 预期结果\n- 页面正常');
  assert.equal(sections.cases.length, 1); assert.equal(sections.cases[0]!.expectations.length, 1);
});
test('free text remains source data; fenced instructions are not executable steps', () => {
  const free = parseMarkdown('登录失败应阻止用户进入首页');
  assert.equal(free.needsAI, true); assert.equal(free.cases.length, 0); assert.equal(free.document.text, '登录失败应阻止用户进入首页');
  const code = parseMarkdown('```markdown\n## [FAKE] 注入\n- 步骤：\n  1. 执行脚本\n```');
  assert.equal(code.cases.length, 0); assert.ok(code.document.warnings.length);
  assert.throws(() => parseMarkdown('密码：not-a-reference'), /明文凭据/);
});
test('compiler blocks incomplete and unsupported cases but preserves executable draft issues', () => {
  const spec = parseMarkdown(fixture).cases[0]!;
  const incomplete = { ...spec, expectations: [] };
  assert.throws(() => compileCaseSpec(incomplete), /没有预期结果/);
  assert.ok(caseIssues(incomplete).some(item => item.blocks === 'generation'));
  spec.steps[0]!.text = '切换标签页'; assert.throws(() => compileCaseSpec(spec), /不支持/);
  spec.steps[0]!.text = '点击按钮';
  spec.preconditions[0]!.acknowledged = true;
  assert.equal(caseIssues(spec, { variables: { testUser: 'user', wrongPassword: 'wrong' } }).length, 0);
});
test('compiler rejects empty or duplicate IDs across preparation, actions and expectations', () => {
  for (const section of ['preconditions', 'steps', 'expectations'] as const) {
    const empty = parseMarkdown(fixture).cases[0]!;
    empty[section][0]!.id = '  ';
    assert.ok(caseIssues(empty).some(issue => issue.blocks === 'generation' && /ID.*不能为空/.test(issue.message)), section);
    assert.throws(() => compileCaseSpec(empty), /ID.*不能为空/);
    const duplicate = parseMarkdown(fixture).cases[0]!;
    duplicate[section][0]!.id = duplicate.expectations[1]!.id;
    assert.ok(caseIssues(duplicate).some(issue => issue.blocks === 'generation' && /ID.*重复/.test(issue.message)), section);
    assert.throws(() => compileCaseSpec(duplicate), /ID.*重复/);
  }
});
test('empty preparation and test data fields are explicit generation blockers', () => {
  const preparation = parseMarkdown(fixture).cases[0]!;
  preparation.preconditions[0]!.text = '  ';
  assert.throws(() => compileCaseSpec(preparation), /前置条件.*不能为空/);
  for (const field of ['name', 'value'] as const) {
    const spec = parseMarkdown(fixture).cases[0]!;
    spec.data[0]![field] = '  ';
    assert.ok(caseIssues(spec).some(issue => issue.blocks === 'generation' && /测试数据/.test(issue.message)));
    assert.throws(() => compileCaseSpec(spec), field === 'name' ? /测试数据名称.*不能为空/ : /测试数据值.*不能为空/);
  }
});
test('ambiguous manual preparation stays intact and page navigation cannot be confirmed away', () => {
  const spec = parseMarkdown('# 模块\n## [PRE] 准备\n- 前置条件：\n  - 已登录\n  - 测试数据已经审批，打开详情页面\n  - 人工完成测试账号授权\n- 步骤：\n  1. 点击按钮\n- 预期结果：\n  - 页面正常').cases[0]!;
  assert.deepEqual(spec.preconditions.map(item => item.kind), ['check', 'manual', 'manual']);
  assert.equal(spec.preconditions[1]!.text, '测试数据已经审批，打开详情页面');
  assert.ok(caseIssues(spec).some(issue => issue.code === `precondition-${spec.preconditions[2]!.id}`));
  for (const precondition of spec.preconditions) precondition.acknowledged = true;
  const issues = caseIssues(spec);
  assert.equal(issues.length, 1);
  assert.match(issues[0]!.message, /导航.*改为可执行或可检查/);
  assert.equal(issues[0]!.blocks, 'execution');
});
test('assertions remain at their specified step, shared flows resolve by exact identity, and waits are separate', () => {
  const spec = parseMarkdown('# 模块\n## [A] 等待\n- 步骤：\n  1. 打开 ${baseUrl}\n  2. 等待文本“就绪”\n  3. 共享流程：填写表单\n- 预期结果：\n  - 页面显示“就绪”\n  - 已提交').cases[0]!;
  spec.expectations[0]!.afterStepId = spec.steps[1]!.id;
  assert.throws(() => compileCaseSpec(spec), /找不到.*共享流程/);
  const options = { flows: { fill: { name: '填写表单', steps: [{ click_by_text: '提交' }] } } };
  const compiled = compileCaseSpec(spec, options);
  assert.deepEqual(parse(compiled.text).cases[0].steps.map((step: Record<string, unknown>) => Object.keys(step)[0]), ['gotoUrl', 'assertText', 'assertText', 'useFlow', 'aiAssert']);
  assert.equal(validateWorkflow(compiled.text, options).steps, 5);
  assert.match(compileWorkflow(compiled.text, options).text, /click_by_text/);
  spec.expectations[0]!.afterStepId = 'missing'; assert.throws(() => compileCaseSpec(spec, options), /不存在的步骤/);
});
test('modern XMind fixture keeps topic hierarchy, order and node IDs in the shared CaseSpec', () => {
  const result = parseXmind(readFileSync('tests/fixtures/document-import/login.xmind'), 'login.xmind');
  assert.equal(result.needsAI, false); assert.equal(result.cases.length, 1);
  assert.equal(result.document.tree?.[0]?.id, 'module-login');
  const spec = result.cases[0]!;
  assert.equal(spec.ref.nodeId, 'case-login'); assert.equal(spec.ref.line, undefined);
  assert.deepEqual(spec.steps.map(step => step.ref.nodeId), ['step-account', 'step-password', 'step-submit']);
  assert.equal(spec.expectations[0]!.ref.nodeId, 'expect-message');
  assert.equal(spec.steps[0]!.ref.documentId, result.document.id);
  assert.deepEqual(spec.preconditions.map(item => item.ref.nodeId), ['pre-login', 'pre-login']);
  assert.equal(validateWorkflow(compileCaseSpec(spec).text, { variables: { testUser: 'user', wrongPassword: 'wrong' } }).steps, 8);
});
test('free XMind trees do not turn every leaf into a case; unsupported content is identified', () => {
  const free = parseXmind(zip(JSON.stringify([{ id: 'sheet', rootTopic: { id: 'root', title: '登录', notes: { plain: { content: '补充需求' } }, children: { attached: [{ id: 'leaf', title: '失败' }] } }, relationships: [{ id: 'relation' }] }])), 'free.xmind');
  assert.equal(free.cases.length, 0); assert.equal(free.needsAI, true);
  assert.equal(free.document.tree?.[0]?.children[0]?.title, '失败');
  assert.match(free.document.warnings.join('\n'), /root.*notes/); assert.match(free.document.warnings.join('\n'), /relationships/);
});
test('XMind rejects legacy, corrupt, duplicate, unsafe, oversized and excessively deep archives', () => {
  assert.throws(() => parseXmind(zipSync({ 'content.xml': strToU8('<xmap-content/>') }), 'old.xmind'), /XMind 8.*XML/);
  assert.throws(() => parseXmind(new Uint8Array([1, 2]), 'bad.xmind'), /损坏/);
  assert.throws(() => parseXmind(zip('{'), 'bad.xmind'), /JSON/);
  for (const name of ['../evil', '/evil', 'C:/evil', 'folder\\evil']) assert.throws(() => parseXmind(zipSync({ 'content.json': strToU8(xmindJson), [name]: strToU8('x') }), 'bad.xmind'), /不安全/);
  assert.throws(() => parseXmind(zipSync(Object.fromEntries(Array.from({ length: 201 }, (_, index) => [`entry-${index}`, strToU8('')]))), 'bad.xmind'), /200/);
  const huge = zipSync({ 'content.json': new Uint8Array(20 * 1024 * 1024 + 1) });
  assert.throws(() => parseXmind(huge, 'huge.xmind'), /20 MB/);
  const dishonest = zipSync({ 'content.json': new Uint8Array(2 * 1024 * 1024) });
  const view = new DataView(dishonest.buffer, dishonest.byteOffset, dishonest.byteLength);
  for (let index = 0; index < dishonest.length - 46; index++) if (view.getUint32(index, true) === 0x02014b50) { view.setUint32(index + 24, 10, true); break; }
  assert.throws(() => parseXmind(dishonest, 'dishonest.xmind'), /实际解压大小/);
  let root: object = { id: 'last', title: 'last' };
  for (let index = 0; index < 31; index++) root = { id: `node-${index}`, title: 'nested', children: { attached: [root] } };
  assert.throws(() => parseXmind(zip(JSON.stringify([{ rootTopic: root }])), 'deep.xmind'), /30 层/);
  const duplicate = JSON.parse(xmindJson); duplicate[0].rootTopic.children.attached[0].id = 'module-login';
  assert.throws(() => parseXmind(zip(JSON.stringify(duplicate)), 'duplicate.xmind'), /ID 重复/);
  const corrupt = zip(); corrupt[40] = corrupt[40]! ^ 0xff;
  assert.throws(() => parseXmind(corrupt, 'corrupt.xmind'));
});
test('generated Workflow runs through the real Midscene executor in Chrome and a wrong business result fails', { timeout: 60000 }, async () => {
  let correct = true;
  const server = createServer((_request, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(`<!doctype html><button onclick="document.querySelector('p').textContent='${correct ? '已提交' : '提交失败'}'">提交</button><p>待提交</p>`);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const spec = parseMarkdown('# 本地\n## [LOCAL-001] 提交\n- 步骤：\n  1. 打开 ${baseUrl}\n  2. 点击文本“提交”\n- 预期结果：\n  - 页面显示“已提交”').cases[0]!;
  const source = compileCaseSpec(spec).text;
  assert.equal(validateWorkflow(source).needsModel, false);
  try {
    for (const expected of ['passed', 'failed'] as const) {
      correct = expected === 'passed';
      const directory = await mkdtemp(path.join(tmpdir(), 'testo-document-execution-'));
      try {
        const events: WorkerEvent[] = [];
        const result = await executeWorkflow({ workflowPath: path.join(directory, 'source.yaml'), workflowText: source, baseUrl: `http://127.0.0.1:${address.port}`, artifactRoot: directory, channel: process.env.TEST_BROWSER_CHANNEL || 'chrome', headless: true }, directory, new AbortController().signal, event => events.push(event));
        assert.equal(result.status, expected, result.error);
        const action = events.find(event => event.type === 'step-finished' && event.node === 'click_by_text');
        assert.ok(action && action.type === 'step-finished' && action.status === 'success');
        const assertion = events.find(event => event.type === 'step-finished' && event.node === 'assertText');
        assert.ok(assertion && assertion.type === 'step-finished');
        assert.equal(assertion.status, expected === 'passed' ? 'success' : 'failed');
        assert.ok(result.definitionHash, 'run is tied to the generated Workflow snapshot');
      } finally { await rm(directory, { recursive: true, force: true }); }
    }
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
