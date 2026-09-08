import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { expect } from '@playwright/test';
import { _electron as electron, type ElectronApplication } from 'playwright';
import { parse, stringify } from 'yaml';
import { startRun } from '../src/runner/run.js';

const cleanEnvironment = () => Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] =>
  entry[1] !== undefined && entry[0] !== 'ELECTRON_RUN_AS_NODE' && !entry[0].startsWith('MIDSCENE_MODEL') && !entry[0].startsWith('OPENAI_')));
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

test('real Chrome waits for a delayed answer, bounds absent answers and cancels a hanging model request', { timeout: 90000 }, async () => {
  mkdirSync('artifacts', { recursive: true });
  const root = mkdtempSync(path.resolve('artifacts/wait-integration-'));
  let ready = false, followUps = 0;
  const calls: { model: string; pass: boolean; image: boolean; version?: string }[] = [];
  const held: ServerResponse[] = [];
  const server = createServer((request, response) => {
    if (request.url === '/ready') { ready = true; response.end('ok'); return; }
    if (request.url === '/follow-up') { followUps++; response.end('ok'); return; }
    if (request.url !== '/v1/chat/completions') {
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end(`<!doctype html><button style="position:absolute;left:20px;top:20px;width:120px;height:40px" onclick="document.querySelector('p').textContent='Inferring...';setTimeout(()=>{document.querySelector('p').textContent='Current answer is ready';fetch('/ready')},3500)">Send</button><button style="position:absolute;left:200px;top:20px;width:120px;height:40px" onclick="fetch('/follow-up')">Continue</button><p style="position:absolute;top:100px"></p>`);
      return;
    }
    let body = '';
    request.on('data', chunk => body += chunk);
    request.on('end', () => {
      const payload = JSON.parse(body);
      const pass = ready && payload.model === 'wait-success';
      const image = payload.messages.flatMap((message: any) => Array.isArray(message.content) ? message.content : []).some((part: any) => part.type === 'image_url' && /^data:image\//.test(part.image_url?.url));
      calls.push({ model: payload.model, pass, image, version: request.headers['x-midscene-version'] as string });
      assert.equal(request.headers.authorization, 'Bearer local-wait-test-key');
      assert.equal(payload.stream, false);
      if (payload.model === 'wait-cancel') { held.push(response); return; }
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ id: 'local-wait', object: 'chat.completion', created: 1700000000, model: payload.model,
        choices: [{ index: 0, message: { role: 'assistant', content: `<observation>${pass ? 'Current answer is visible' : 'Inferring...; current answer is absent'}</observation><data-json>{"StatementIsTruthy":${pass}}</data-json>` }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    for (const model of ['wait-success', 'wait-timeout', 'wait-cancel']) {
      ready = false;
      const workflowPath = path.join(root, model + '.yaml');
      const steps = [
        { gotoUrl: { url: '${baseUrl}' } },
        { recordedAction: { actionType: 'Tap', payload: { x: 70, y: 40 } } },
        { aiWaitFor: { prompt: 'The current answer is visible', timeoutMs: model === 'wait-timeout' ? 1800 : 15000, checkIntervalMs: 200 } },
        { recordedAction: { actionType: 'Tap', payload: { x: 250, y: 40 } } },
      ];
      writeFileSync(workflowPath, stringify({ cases: [{ name: model, steps }], afterEach: [{ recordToReport: 'After waiting' }] }));
      const events: any[] = [];
      const handle = startRun({ workflowPath, artifactRoot: root, baseUrl, channel: 'chrome', headless: true }, event => events.push(event), {
        ...cleanEnvironment(), MIDSCENE_MODEL_NAME: model, MIDSCENE_MODEL_FAMILY: 'gpt-5', MIDSCENE_MODEL_BASE_URL: baseUrl + '/v1',
        MIDSCENE_MODEL_API_KEY: 'local-wait-test-key', MIDSCENE_MODEL_RETRY_COUNT: '0', MIDSCENE_MODEL_TIMEOUT: '30000',
      });
      if (model === 'wait-cancel') {
        await expect.poll(() => calls.filter(call => call.model === model).length, { timeout: 15000 }).toBe(1);
        handle.cancel();
      }
      const result = await handle.result;
      assert.equal(result.status, model === 'wait-success' ? 'passed' : model === 'wait-timeout' ? 'failed' : 'cancelled', JSON.stringify(result));
      const observed = calls.filter(call => call.model === model);
      assert.ok(observed.length > 0);
      if (model === 'wait-success') {
        assert.equal(observed[0]!.pass, false, 'the first check occurs before the delayed answer');
        assert.equal(observed.at(-1)!.pass, true, 'a later real page update satisfies the wait');
        assert.equal(followUps, 1);
        assert.ok(result.reportPaths.length);
      } else {
        assert.equal(followUps, 1, 'failure/cancellation must not execute the subsequent action');
        assert.ok(!events.some(event => event.type === 'step-started' && event.index === 3));
        if (model === 'wait-timeout') assert.match(result.error ?? '', /等待条件超时/);
        if (model === 'wait-cancel') {
          const count = calls.length;
          for (const response of held) response.end();
          await sleep(400);
          assert.equal(calls.length, count, 'cancelled waits do not start more model checks');
          assert.ok(result.durationMs < 15000, 'cancellation must not wait for model timeout');
        }
      }
    }
    assert.ok(calls.every(call => call.image && call.version), 'the official SDK sends a fresh real screenshot through HTTP');
    writeFileSync(path.join(root, 'observations.json'), JSON.stringify({ calls, followUps }, null, 2));
    console.log('Wait integration evidence:', root);
  } finally {
    for (const response of held) response.end();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('Electron recording review configures and saves waits in the chosen order', { timeout: 90000 }, async () => {
  mkdirSync('artifacts', { recursive: true });
  const root = process.cwd(), data = mkdtempSync(path.resolve('artifacts/wait-ui-'));
  const server = createServer((_req, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end('<!doctype html><button style="position:absolute;left:20px;top:20px;width:120px;height:40px" onclick="this.textContent=\'Sent\'">Send</button>');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  let app: ElectronApplication | undefined;
  try {
    app = await electron.launch({ args: [root], env: { ...cleanEnvironment(), WORKSPACE_DATA_DIR: path.join(data, 'app'), WORKSPACE_PROJECTS_DIR: path.join(data, 'projects') } });
    const page = await app.firstWindow(); page.setDefaultTimeout(15000);
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await page.getByRole('button', { name: '新建项目', exact: true }).click();
    await page.getByLabel('项目名称', { exact: true }).fill('等待条件验证');
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await page.getByRole('button', { name: '新建用例', exact: true }).first().click();
    await page.getByLabel('用例名称', { exact: true }).fill('等待本次回答');
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await page.getByRole('button', { name: 'Environments', exact: true }).click();
    await page.getByRole('button', { name: '编辑', exact: true }).click();
    await page.getByLabel('Web 地址', { exact: true }).fill(baseUrl);
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await page.getByRole('button', { name: /^Test Cases/ }).click();
    await page.getByRole('button', { name: /等待本次回答/ }).click();
    await page.getByRole('button', { name: '开始录制', exact: true }).click();
    const preview = page.frameLocator('iframe[title="Midscene 官方录制预览"]');
    await preview.locator('[data-midscene-device-interaction-layer]').waitFor({ timeout: 50000 });
    const box = await preview.locator('.screenshot-image').boundingBox(); assert.ok(box);
    await page.mouse.click(box.x + 70 * box.width / 1280, box.y + 40 * box.height / 800);
    await expect.poll(() => page.evaluate(async () => (await window.workspace.state()).recording!.events.some(event => event.actionType === 'Tap'))).toBeTruthy();
    await page.getByRole('button', { name: '停止录制并检查', exact: true }).click();
    await page.getByRole('button', { name: '添加等待条件', exact: true }).click();
    await page.getByLabel('断言 1 内容', { exact: true }).fill('最新消息下方出现非空的 AI 回复');
    await expect(page.getByLabel('等待条件 1 最长等待秒数')).toHaveValue('60');
    await page.getByRole('button', { name: '添加等待条件', exact: true }).click();
    await page.getByLabel('断言 2 内容', { exact: true }).fill('回复生成结束，停止按钮消失');
    await page.getByLabel('等待条件 2 最长等待秒数').fill('120');
    await page.getByRole('button', { name: '添加断言', exact: true }).click();
    await page.getByLabel('断言 3 类型', { exact: true }).selectOption('ai');
    await page.getByLabel('断言 3 内容', { exact: true }).fill('回答与本次问题相关');
    await page.getByRole('button', { name: '预览 YAML', exact: true }).click();
    const yaml = await page.getByLabel('生成的 Workflow YAML').innerText();
    assert.deepEqual(parse(yaml).cases[0].steps.slice(-3), [
      { aiWaitFor: { prompt: '最新消息下方出现非空的 AI 回复', timeoutMs: 60000 } },
      { aiWaitFor: { prompt: '回复生成结束，停止按钮消失', timeoutMs: 120000 } },
      { aiAssert: '回答与本次问题相关' },
    ]);
    writeFileSync(path.join(data, 'preview.yaml'), yaml);
    await page.getByRole('button', { name: '添加等待条件', exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(data, 'wait-review.png'), fullPage: true });
    await page.getByRole('button', { name: '保存到当前用例', exact: true }).click();
    await page.getByRole('button', { name: '运行', exact: true }).waitFor();
    const state = await page.evaluate(() => window.workspace.state());
    assert.equal(state.recording?.status, 'saved');
    await page.getByRole('button', { name: '查看 / 编辑', exact: true }).click();
    assert.deepEqual(parse(await page.getByLabel('Workflow YAML', { exact: true }).inputValue()), parse(yaml), 'saved workflow reloads through the actual editor');
    await page.screenshot({ path: path.join(data, 'saved-waits.png') });
    assert.deepEqual(errors, []);
    console.log('Wait UI evidence:', data);
  } finally {
    await app?.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
