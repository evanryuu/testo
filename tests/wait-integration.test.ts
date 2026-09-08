import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { expect } from '@playwright/test';
import { _electron as electron, type ElectronApplication } from 'playwright';
import { parse } from 'yaml';
import { buildRecordedWorkflow } from '../src/recording/workflow.js';
import { startRun } from '../src/runner/run.js';

const cleanEnvironment = () => Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] =>
  entry[1] !== undefined && entry[0] !== 'ELECTRON_RUN_AS_NODE' && !entry[0].startsWith('MIDSCENE_MODEL') && !entry[0].startsWith('OPENAI_')));
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

test('real Chrome waits for a delayed answer, bounds absent answers and cancels a hanging model request', { timeout: 90000 }, async () => {
  mkdirSync('artifacts', { recursive: true });
  const root = mkdtempSync(path.resolve('artifacts/wait-integration-'));
  let ready = false, followUps = 0, sends = 0;
  const calls: { model: string; pass: boolean; image: boolean; version?: string }[] = [];
  const held: ServerResponse[] = [];
  const server = createServer((request, response) => {
    if (request.url === '/send') { sends++; response.end('ok'); return; }
    if (request.url === '/ready') { ready = true; response.end('ok'); return; }
    if (request.url === '/follow-up') { followUps++; response.end('ok'); return; }
    if (request.url !== '/v1/chat/completions') {
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end(`<!doctype html><button style="position:absolute;left:20px;top:20px;width:120px;height:40px" onclick="fetch('/send');document.querySelector('p').textContent='Inferring...';setTimeout(()=>{document.querySelector('p').textContent='Current answer is ready';fetch('/ready')},3500)">Send</button><button style="position:absolute;left:200px;top:20px;width:120px;height:40px" onclick="fetch('/follow-up');document.querySelector('p').textContent='Follow-up complete'">Continue</button><p style="position:absolute;top:100px"></p>`);
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
      const sentBeforeRun = sends;
      const yaml = buildRecordedWorkflow({
        name: model,
        events: [
          { hashId: 'send', actionType: 'Tap', rawPayload: { x: 70, y: 40 }, pageInfo: { width: 1280, height: 800 } },
          { hashId: 'continue', actionType: 'Tap', rawPayload: { x: 250, y: 40 }, pageInfo: { width: 1280, height: 800 } },
        ],
        steps: [
          { kind: 'event', hashId: 'send' },
          { kind: 'check', id: 'answer-ready', assertion: { kind: 'wait', text: 'The current answer is visible', timeoutMs: model === 'wait-timeout' ? 1800 : 15000 } },
          { kind: 'event', hashId: 'continue' },
          { kind: 'check', id: 'follow-up-result', assertion: { kind: 'text', text: 'Follow-up complete' } },
        ],
      });
      writeFileSync(workflowPath, yaml);
      const continueIndex = parse(yaml).cases[0].steps.findIndex((step: any) => step.recordedAction?.payload.x === 250);
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
      assert.equal(sends - sentBeforeRun, 1, 'waiting never repeats the send action');
      const observed = calls.filter(call => call.model === model);
      assert.ok(observed.length > 0);
      if (model === 'wait-success') {
        assert.equal(observed[0]!.pass, false, 'the first check occurs before the delayed answer');
        assert.equal(observed.at(-1)!.pass, true, 'a later real page update satisfies the wait');
        assert.equal(followUps, 1);
        assert.ok(result.reportPaths.length);
      } else {
        assert.equal(followUps, 1, 'failure/cancellation must not execute the subsequent action');
        assert.ok(!events.some(event => event.type === 'step-started' && event.index === continueIndex));
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
    writeFileSync(path.join(root, 'observations.json'), JSON.stringify({ calls, followUps, sends }, null, 2));
    console.log('Wait integration evidence:', root);
  } finally {
    for (const response of held) response.end();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('Electron Timeline inserts, moves, removes and restores checks between recorded actions', { timeout: 90000 }, async () => {
  mkdirSync('artifacts', { recursive: true });
  const root = process.cwd(), data = mkdtempSync(path.resolve('artifacts/wait-ui-'));
  const server = createServer((_req, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end('<!doctype html><button style="position:absolute;left:20px;top:20px;width:120px;height:40px" onclick="this.textContent=\'Sent\'">Send</button><button style="position:absolute;left:200px;top:20px;width:120px;height:40px" onclick="this.textContent=\'Continued\'">Continue</button>');
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
    await page.mouse.click(box.x + 250 * box.width / 1280, box.y + 40 * box.height / 800);
    await expect.poll(() => page.evaluate(async () => (await window.workspace.state()).recording!.events.filter(event => event.actionType === 'Tap').length)).toBe(2);
    await page.getByRole('button', { name: '停止录制并检查', exact: true }).click();
    await page.getByRole('button', { name: '插入等待条件', exact: true }).waitFor();
    const draft = await page.evaluate(async () => (await window.workspace.state()).recording!);
    const tapEvents = draft.events.filter(event => event.actionType === 'Tap');
    const sendId = tapEvents[0]!.hashId, continueId = tapEvents[1]!.hashId;
    const reviewKey = 'recording-review:' + draft.id;

    // A draft from the previous release restores its tail checks before editing.
    await page.evaluate(key => localStorage.setItem(key, JSON.stringify({
      choices: [], assertions: [{ kind: 'wait', text: '旧草稿的等待条件', timeoutMs: 45000 }],
    })), reviewKey);
    await page.reload();
    await page.getByRole('button', { name: '打开录制', exact: true }).click();
    await expect(page.getByLabel('断言 1 内容', { exact: true })).toHaveValue('旧草稿的等待条件');
    await expect(page.getByLabel('等待条件 1 最长等待秒数')).toHaveValue('45');
    await expect(page.locator('[data-review-step]').last()).toHaveAttribute('data-review-check', /.+/);
    await page.getByRole('button', { name: '移除断言 1', exact: true }).click();

    await page.getByLabel('检查步骤插入位置').selectOption(String(draft.events.findIndex(event => event.hashId === sendId) + 1));
    await page.getByRole('button', { name: '插入等待条件', exact: true }).click();
    await page.getByLabel('断言 1 内容', { exact: true }).fill('回复生成结束，停止按钮消失');
    await expect(page.getByLabel('等待条件 1 最长等待秒数')).toHaveValue('60');
    await page.getByLabel('等待条件 1 最长等待秒数').fill('120');
    const waitId = await page.locator('[data-review-check]').first().getAttribute('data-review-check'); assert.ok(waitId);
    const order = () => page.locator('[data-review-step]').evaluateAll((elements, ids) => elements.map(element => element.getAttribute('data-review-step')).filter(id => ids.includes(id!)), [sendId, continueId, waitId]);
    assert.deepEqual(await order(), [sendId, waitId, continueId]);
    await page.getByRole('button', { name: '下移检查 1', exact: true }).click();
    assert.deepEqual(await order(), [sendId, continueId, waitId]);
    await page.getByRole('button', { name: '上移检查 1', exact: true }).click();
    assert.deepEqual(await order(), [sendId, waitId, continueId]);

    const currentOrder = await page.locator('[data-review-step]').evaluateAll(elements => elements.map(element => element.getAttribute('data-review-step')));
    await page.getByLabel('检查步骤插入位置').selectOption(String(currentOrder.indexOf(waitId) + 1));
    await page.getByRole('button', { name: '插入断言', exact: true }).click();
    await page.getByLabel('断言 2 内容', { exact: true }).fill('应删除的临时检查');
    await page.getByRole('button', { name: '移除断言 2', exact: true }).click();
    await expect(page.locator('[data-review-check]')).toHaveCount(1);
    await page.getByRole('button', { name: '添加断言', exact: true }).click();
    await page.getByLabel('断言 2 类型', { exact: true }).selectOption('ai');
    await page.getByLabel('断言 2 内容', { exact: true }).fill('继续操作成功');

    const storedBeforeReload = await page.evaluate(key => JSON.parse(localStorage.getItem(key)!), reviewKey);
    await page.reload();
    await page.getByRole('button', { name: '打开录制', exact: true }).click();
    await expect(page.getByLabel('断言 1 内容', { exact: true })).toHaveValue('回复生成结束，停止按钮消失');
    await expect(page.getByLabel('等待条件 1 最长等待秒数')).toHaveValue('120');
    await expect(page.getByLabel('断言 2 类型', { exact: true })).toHaveValue('ai');
    await expect(page.getByLabel('断言 2 内容', { exact: true })).toHaveValue('继续操作成功');
    assert.deepEqual(await order(), [sendId, waitId, continueId], 'refresh restores the wait between its original actions');
    assert.deepEqual(await page.evaluate(key => JSON.parse(localStorage.getItem(key)!), reviewKey), storedBeforeReload, 'refresh preserves stable check identities and all review content');


    // Damaged draft references must be repaired explicitly, without silently relocating checks.
    await page.evaluate(({ key, review, missingId }) => localStorage.setItem(key, JSON.stringify({
      ...review, steps: review.steps.filter((step: any) => step.kind !== 'event' || step.hashId !== missingId),
    })), { key: reviewKey, review: storedBeforeReload, missingId: sendId });
    await page.reload();
    await page.getByRole('button', { name: '打开录制', exact: true }).click();
    await expect(page.getByText(/保存的步骤与当前录制事件不一致/)).toBeVisible();
    await expect(page.getByRole('button', { name: '保存到当前用例', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: '预览 YAML', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: '恢复事件顺序并将检查移至末尾', exact: true }).click();
    assert.deepEqual(await order(), [sendId, continueId, waitId]);
    await expect(page.getByLabel('断言 1 内容', { exact: true })).toHaveValue('回复生成结束，停止按钮消失');
    await expect(page.getByLabel('等待条件 1 最长等待秒数')).toHaveValue('120');
    await expect(page.getByLabel('断言 2 内容', { exact: true })).toHaveValue('继续操作成功');
    await expect(page.getByRole('button', { name: '保存到当前用例', exact: true })).toBeEnabled();
    await page.evaluate(({ key, review }) => localStorage.setItem(key, JSON.stringify(review)), { key: reviewKey, review: storedBeforeReload });
    await page.reload();
    await page.getByRole('button', { name: '打开录制', exact: true }).click();
    assert.deepEqual(await order(), [sendId, waitId, continueId]);

    await page.getByRole('button', { name: '预览 YAML', exact: true }).click();
    const yaml = await page.getByLabel('生成的 Workflow YAML').innerText();
    const generatedSteps = parse(yaml).cases[0].steps;
    assert.deepEqual(generatedSteps.map((step: any) => Object.keys(step)[0]), ['setViewportSize', 'gotoUrl', 'recordedAction', 'aiWaitFor', 'recordedAction', 'aiAssert']);
    assert.equal(generatedSteps[2].recordedAction.payload.x, tapEvents[0]!.rawPayload!.x);
    assert.deepEqual(generatedSteps[3], { aiWaitFor: { prompt: '回复生成结束，停止按钮消失', timeoutMs: 120000 } });
    assert.equal(generatedSteps[4].recordedAction.payload.x, tapEvents[1]!.rawPayload!.x);
    assert.deepEqual(generatedSteps[5], { aiAssert: '继续操作成功' });
    assert.ok(!yaml.includes('应删除的临时检查') && !yaml.includes('旧草稿的等待条件'));
    writeFileSync(path.join(data, 'preview.yaml'), yaml);
    await page.locator('[data-review-check]').first().scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(data, 'wait-review.png'), fullPage: true });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1600, 1200));
    await page.locator('[data-recorder-event="' + sendId + '"]').evaluate(element => element.parentElement!.scrollTop = (element as HTMLElement).offsetTop - (element.parentElement as HTMLElement).offsetTop);
    await page.locator('[data-slot="card"]').filter({ has: page.getByText('Timeline', { exact: true }) }).screenshot({ path: path.join(data, 'timeline-middle-wait.png') });
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
