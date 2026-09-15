import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { NodeRegistry } from '@midscene/test';
import { stringify } from 'yaml';
import { createMidsceneOperationNodes, createPlaywrightOperationNodes, operationStepTimeoutMs } from '../src/runner/operation-nodes.js';
import { assertWorkflowModel, validateWorkflow } from '../src/main/workflow-validation.js';
import { operationCatalog, createOperationStep } from '../src/shared/operation-catalog.js';
import { startRun } from '../src/runner/run.js';

const source = (steps: unknown[], extra: Record<string, unknown> = {}) => stringify({ ...extra, cases: [{ name: 'Operations', steps }] });
const runNode = async (registry: NodeRegistry, name: string, input: Record<string, unknown>, signal = new AbortController().signal) => {
  const node = registry.require(name);
  return node.execute({ input: node.inputSchema!.parse(input), signal } as any);
};

test('Midscene operations forward prompts, values and options to the supported SDK overloads', async () => {
  const calls: { name: string; args: unknown[] }[] = [];
  const agent = new Proxy({}, { get: (_target, name) => name === 'then' ? undefined : async (...args: unknown[]) => { calls.push({ name: String(name), args }); return name === 'aiQuery' ? { count: 3 } : name === 'aiLocate' ? { center: [5, 6], rect: { left: 1, top: 2, width: 3, height: 4 }, dpr: 1 } : undefined; } });
  const registry = new NodeRegistry(createMidsceneOperationNodes(() => agent as any));
  for (const name of ['aiHover', 'aiDoubleClick', 'aiRightClick', 'aiClearInput', 'aiLocate']) {
    await runNode(registry, name, { prompt: '提交按钮', options: { deepLocate: true } });
    assert.deepEqual(calls.at(-1), { name, args: ['提交按钮', { deepLocate: true }] });
  }
  await runNode(registry, 'aiInput', { prompt: '姓名', value: '', mode: 'clear', options: { inputStrategy: 'bulk', keyboardTypeDelay: 10 } });
  assert.deepEqual(calls.at(-1), { name: 'aiInput', args: ['姓名', { inputStrategy: 'bulk', keyboardTypeDelay: 10, value: '', mode: 'clear' }] });
  await runNode(registry, 'aiKeyboardPress', { keyName: 'Enter' });
  assert.deepEqual(calls.at(-1), { name: 'aiKeyboardPress', args: [undefined, { keyName: 'Enter' }] });
  await runNode(registry, 'aiScroll', { direction: 'down', distance: 400, scrollType: 'singleAction', options: { cacheable: false } });
  assert.deepEqual(calls.at(-1), { name: 'aiScroll', args: [undefined, { cacheable: false, direction: 'down', distance: 400, scrollType: 'singleAction' }] });
  const result = await runNode(registry, 'aiQuery', { dataDemand: { count: '数量' }, options: { domIncluded: 'visible-only' } });
  assert.deepEqual(calls.at(-1), { name: 'aiQuery', args: [{ count: '数量' }, { domIncluded: 'visible-only' }] });
  assert.deepEqual(result, { data: { count: 3 } });
  const controller = new AbortController(); controller.abort(new Error('cancelled operation'));
  const before = calls.length;
  await assert.rejects(runNode(registry, 'aiHover', { prompt: 'button' }, controller.signal), /cancelled operation/);
  assert.equal(calls.length, before);
});

test('validation distinguishes model usage and rejects unsupported Bridge operations and invalid inputs', () => {
  const plain = validateWorkflow(source([{ click_by_text: '提交' }, { fill: { selector: 'input', value: '' } }, { reload: {} }]));
  assert.equal(plain.needsModel, false);
  assert.doesNotThrow(() => assertWorkflowModel(plain, undefined));
  const ai = validateWorkflow(source([{ aiInput: { prompt: '姓名', value: 'Ada' } }]));
  assert.equal(ai.needsModel, true);
  assert.throws(() => assertWorkflowModel(ai, undefined), /模型名称/);
  assert.equal(validateWorkflow(source([{ wait: { duration: 1 } }], { beforeAll: [{ aiHover: '提交' }] })).needsModel, true);
  assert.throws(() => validateWorkflow(source([{ click_by_text: '提交' }]), {}, false, true), /Chrome Bridge 不支持.*click_by_text/);
  assert.throws(() => validateWorkflow(source([{ wait: { duration: 1 } }], { afterAll: [{ reload: {} }] }), {}, true, true), /Chrome Bridge 不支持.*reload/);
  for (const step of [{ fill: { selector: 'input' } }, { click_by_role: { role: 'invalid-role', name: 'Submit' } }, { click: { selector: '#x', timeoutMs: 25001 } }, { aiInput: { value: 'Ada' } }, { aiScroll: { direction: 'diagonal' } }]) {
    assert.throws(() => validateWorkflow(source([step])), /参数无效/);
  }
  assert.equal(operationStepTimeoutMs('click', {}), 11000);
  assert.equal(operationStepTimeoutMs('click', { timeoutMs: 25000 }), 26000);
  assert.equal(operationStepTimeoutMs('aiInput', {}), undefined);
});

test('every selectable operation resolves to a registered executable schema', () => {
  for (const definition of operationCatalog) {
    const step = createOperationStep(definition.id);
    const key = Object.keys(step)[0]!;
    const fillBlanks = (value: unknown): unknown => value === '' ? 'example' : Array.isArray(value) ? value.map(fillBlanks) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, fillBlanks(item)])) : value;
    step[key] = fillBlanks(step[key]);
    assert.doesNotThrow(() => validateWorkflow(source([step])), definition.id);
  }
});

test('Playwright operations interact with a real page, automatically wait and reject ambiguous matches', { timeout: 60000 }, async () => {
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html');
    response.end(`<!doctype html><title>${request.url}</title>
      <button id="submit" data-testid="submit" onclick="document.querySelector('output').textContent='submitted'">Submit</button>
      <button class="duplicate">Duplicate</button><button class="duplicate">Duplicate</button>
      <input id="name" onkeydown="if(event.key==='Enter')document.querySelector('output').textContent='entered'">
      <input id="agree" type="checkbox"><select id="choice"><option value="a">A</option><option value="b">B</option></select><output></output>
      <div id="hover" onmouseenter="document.querySelector('output').textContent='hovered'">Hover target</div>
      <button id="double" ondblclick="document.querySelector('output').textContent='double'">Double</button>
      <button id="right" oncontextmenu="event.preventDefault();document.querySelector('output').textContent='right'">Right</button>
      <div id="drag" draggable="true" ondragstart="event.dataTransfer.setData('text/plain','x')">Drag</div>
      <div id="drop" style="height:80px" ondragover="event.preventDefault()" ondrop="event.preventDefault();document.querySelector('output').textContent='dropped'">Drop</div>`);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const browser = await chromium.launch({ channel: process.env.TEST_BROWSER_CHANNEL || 'chrome', headless: true });
  try {
    const page = await browser.newPage();
    const registry = new NodeRegistry(createPlaywrightOperationNodes(() => page));
    const baseUrl = `http://127.0.0.1:${address.port}`;
    await page.goto(baseUrl + '/first');
    for (const [name, input] of [['click_by_text', { text: 'Submit' }], ['click_by_role', { role: 'button', name: 'Submit' }], ['click_by_test_id', { testId: 'submit' }], ['click', { selector: '#submit' }]] as const) {
      await page.locator('output').evaluate(el => { el.textContent = ''; });
      await runNode(registry, name, input);
      assert.equal(await page.locator('output').textContent(), 'submitted');
    }
    await runNode(registry, 'fill', { selector: '#name', value: 'Ada' });
    assert.equal(await page.locator('#name').inputValue(), 'Ada');
    await runNode(registry, 'press', { selector: '#name', key: 'Enter' });
    assert.equal(await page.locator('output').textContent(), 'entered');
    await runNode(registry, 'fill', { selector: '#name', value: '' });
    assert.equal(await page.locator('#name').inputValue(), '');
    await runNode(registry, 'check', { selector: '#agree' }); assert.equal(await page.locator('#agree').isChecked(), true);
    await runNode(registry, 'uncheck', { selector: '#agree' }); assert.equal(await page.locator('#agree').isChecked(), false);
    await runNode(registry, 'select_option', { selector: '#choice', value: 'b' }); assert.equal(await page.locator('#choice').inputValue(), 'b');
    for (const [name, selector, expected] of [['hover', '#hover', 'hovered'], ['double_click', '#double', 'double'], ['right_click', '#right', 'right']] as const) {
      await runNode(registry, name, { selector }); assert.equal(await page.locator('output').textContent(), expected);
    }
    await runNode(registry, 'drag_and_drop', { selector: '#drag', targetSelector: '#drop' });
    assert.equal(await page.locator('output').textContent(), 'dropped');
    await page.evaluate(() => { setTimeout(() => { const button = document.createElement('button'); button.textContent = 'Delayed'; button.onclick = () => { document.querySelector('output')!.textContent = 'delayed'; }; document.body.append(button); }, 200); });
    await runNode(registry, 'click_by_text', { text: 'Delayed', timeoutMs: 3000 });
    assert.equal(await page.locator('output').textContent(), 'delayed');
    await assert.rejects(runNode(registry, 'click_by_text', { text: 'Duplicate', timeoutMs: 500 }), /strict mode violation/);
    await assert.rejects(runNode(registry, 'click', { selector: '#missing', timeoutMs: 200 }), /Timeout/);
    await page.goto(baseUrl + '/second');
    await runNode(registry, 'goBack', {}); assert.equal(new URL(page.url()).pathname, '/first');
    await runNode(registry, 'goForward', {}); assert.equal(new URL(page.url()).pathname, '/second');
    await runNode(registry, 'fill', { selector: '#name', value: 'reset on reload' });
    await runNode(registry, 'reload', {}); assert.equal(await page.locator('#name').inputValue(), '');
  } finally { await browser.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('a real workflow runs navigation, locator operations and assertions without a model', { timeout: 60000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'testo-operations-'));
  const server = createServer((_request, response) => {
    response.setHeader('Content-Type', 'text/html');
    response.end('<input id="name"><button onclick="document.querySelector(\'output\').textContent=document.querySelector(\'input\').value">Submit</button><output></output>');
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  try {
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const workflowPath = path.join(directory, 'workflow.yaml');
    await writeFile(workflowPath, source([{ fill: { selector: '#name', value: '${name}' } }, { click_by_text: { text: 'Submit' } }, { assertText: { text: 'Ada Lovelace' } }], { beforeEach: [{ gotoUrl: '${baseUrl}' }] }));
    const environment = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && !key.startsWith('MIDSCENE_MODEL') && !key.startsWith('OPENAI_')));
    const result = await startRun({ workflowPath, artifactRoot: directory, baseUrl: `http://127.0.0.1:${address.port}`, variables: { name: 'Ada Lovelace' }, channel: process.env.TEST_BROWSER_CHANNEL || 'chrome', headless: true }, () => {}, environment).result;
    assert.equal(result.status, 'passed', JSON.stringify(result));
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await rm(directory, { recursive: true, force: true }); }
});
