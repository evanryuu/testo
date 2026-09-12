import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { describeRecordedTarget } from '../src/recording/describe.js';
import { describeInWorker } from '../src/recording/description-worker.js';
import type { RecordedEvent } from '../src/shared/recording.js';
import { RecordingService } from '../src/main/recording.js';

async function until(predicate: () => boolean, timeout = 25_000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for official recorder description');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test('verified official model requests finish after stop and save; failures preserve evidence', { timeout: 90_000 }, async () => {
  const calls: { model: string; primary: boolean; image: string; version?: string }[] = [];
  let held: (() => void) | undefined;
  const server = createServer((request, response) => {
    if (request.url !== '/v1/chat/completions') {
      response.setHeader('Content-Type', 'text/html');
      response.end('<!doctype html><input aria-label="message" style="position:absolute;left:20px;top:20px;width:200px;height:40px">');
      return;
    }
    let body = '';
    request.on('data', (chunk) => body += chunk);
    request.on('end', () => {
      const payload = JSON.parse(body);
      const primary = JSON.stringify(payload.messages[0]).includes('Describe the real page element');
      const image = payload.messages.flatMap((m: any) => Array.isArray(m.content) ? m.content : []).find((part: any) => part.type === 'image_url')?.image_url?.url;
      calls.push({ model: payload.model, primary, image, version: request.headers['x-midscene-version'] as string });
      assert.equal(payload.stream, false);
      assert.equal(request.headers.authorization, 'Bearer local-test-key');
      const reply = (res: ServerResponse) => {
        const fail = payload.model === 'recorder-failure';
        const content = fail ? {} : primary ? { description: '消息输入框 official-test-42' } : { bbox: [20, 20, 220, 60] };
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ id: 'local-test', object: 'chat.completion', created: 1700000000, model: payload.model, choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(content) }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }));
      };
      if (payload.model === 'recorder-primary' && primary && calls.filter((call) => call.model === payload.model && call.primary).length === 1) held = () => reply(response);
      else reply(response);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const root = mkdtempSync(path.join(tmpdir(), 'workspace-recorder-description-'));
  const recorder = new RecordingService(root, () => {});
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('MIDSCENE_MODEL') && !key.startsWith('OPENAI_')));
  try {
    for (const model of ['recorder-primary', 'recorder-failure']) {
      const id = await recorder.start({ projectId: 'p', caseId: 'c', workflowId: 'w', caseName: 'Local describe', environmentId: 'local', baseUrl, revision: 'r' }, {
        ...environment, MIDSCENE_MODEL_NAME: model, MIDSCENE_MODEL_FAMILY: 'gpt-5', MIDSCENE_MODEL_BASE_URL: `${baseUrl}/v1`, MIDSCENE_MODEL_API_KEY: 'local-test-key', MIDSCENE_MODEL_RETRY_COUNT: '0', MIDSCENE_MODEL_TIMEOUT: '10000',
      });
      await recorder.interact(id, { actionType: 'Tap', x: 60, y: 35 });
      await until(() => calls.some((call) => call.model === model));
      await recorder.stop(id);
      const tap = () => recorder.draft!.events.find((event) => event.actionType === 'Tap')!;
      if (model === 'recorder-primary') {
        assert.equal(tap().semantic?.status, 'pending');
        assert.equal(recorder.active, false, 'review must be usable while description is running');
        recorder.saved(id);
        const finish = held!; held = undefined; finish();
      }
      await until(() => tap().semantic?.status !== 'pending');
      assert.ok(tap().screenshotAsset);
      const screenshot = recorder.screenshot(id, tap().hashId);
      assert.match(screenshot, /^data:image/);
      assert.deepEqual(tap().rawPayload, { actionType: 'Tap', x: 60, y: 35 });
      if (model === 'recorder-failure') {
        assert.equal(tap().semantic?.status, 'failed');
      } else {
        assert.equal(tap().semantic?.status, 'ready');
        assert.equal(tap().semantic?.source, 'aiDescribe');
        assert.equal(tap().semantic?.aiDescribe?.verifyPassed, true);
        assert.match(tap().semantic!.actionSummary!, /official-test-42/);
        assert.match(tap().semantic!.replayInstruction!, /official-test-42/);
        const archived = JSON.parse(readFileSync(path.join(root, 'recordings', id, 'draft.json'), 'utf8'));
        assert.equal(archived.events.find((event: any) => event.actionType === 'Tap').semantic.status, 'ready');
        if (model === 'recorder-primary') {
          assert.equal(archived.status, 'saved');
          assert.notEqual(calls.find((call) => call.model === model)!.image, screenshot, 'official describer adds the target callout');
        }
      }
      recorder.saved(id);
    }
    assert.ok(calls.every((call) => call.version && /^data:image\//.test(call.image)));
    assert.ok(calls.some((call) => call.model === 'recorder-primary' && !call.primary), 'description must be followed by a real locator model request');
  } finally {
    held?.();
    await recorder.shutdown();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});


test('saved Retina screenshots verify the recorded point, retry wrong targets and retain failures', { timeout: 30000 }, async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1920, height: 902 }, deviceScaleFactor: 2 });
    await page.setContent('<button style="position:absolute;left:1450px;top:375px;width:40px;height:40px">Send</button>');
    const screenshot = 'data:image/png;base64,' + (await page.screenshot()).toString('base64');
    await page.setContent('The current page has changed and must not be used for verification');
    const event: RecordedEvent = { hashId: 'send', type: 'click', actionType: 'Tap', timestamp: 1, pageInfo: { width: 1920, height: 902 }, elementRect: { x: 1467, y: 391 }, rawPayload: { actionType: 'Tap', x: 1467, y: 391 }, screenshotAsset: { id: 'saved', mimeType: 'image/png', bytes: 1 } };
    for (const scenario of ['retry-success', 'wrong-target', 'locate-error', 'describe-error']) {
      let descriptions = 0, locations = 0;
      const depths: boolean[] = [];
      const fakeAgent = {
        modelConfigManager: { getModelConfig: () => ({ modelName: 'fixture-model', apiKey: 'local-test-key' }) },
        service: {
          describe: async (point: number[], _runtime: unknown, options: any) => {
            descriptions++;
            if (scenario === 'describe-error') throw new Error('provider details');
            assert.deepEqual(point, [2934, 782]);
            assert.deepEqual(options.context.shotSize, { width: 3840, height: 1804 });
            assert.equal(options.context.screenshot.base64, screenshot);
            depths.push(options.deepDescribe);
            return { description: descriptions === 1 ? '左侧历史会话' : '发送按钮' };
          },
          locate: async (_prompt: unknown, options: any) => {
            locations++;
            assert.equal(options.context.screenshot.base64, screenshot);
            if (scenario === 'locate-error') throw new Error('provider details');
            const correct = scenario === 'retry-success' && descriptions === 2;
            return { element: correct ? { center: [2940, 790], rect: { left: 2900, top: 750, width: 80, height: 80 } } : { center: [100, 700], rect: { left: 40, top: 680, width: 120, height: 40 } } };
          },
        },
      } as unknown as Parameters<typeof describeRecordedTarget>[0];
      const result = await describeRecordedTarget(fakeAgent, event, screenshot);
      assert.deepEqual(result.rawPayload, event.rawPayload);
      assert.deepEqual(result.screenshotAsset, event.screenshotAsset);
      if (scenario === 'retry-success') {
        assert.equal(result.semantic?.status, 'ready');
        assert.equal(result.semantic?.aiDescribe?.verifyPassed, true);
        assert.match(result.semantic!.replayInstruction!, /发送按钮/);
        assert.deepEqual(depths, [false, true]);
      } else {
        assert.equal(result.semantic?.status, 'failed');
        assert.equal(result.semantic?.aiDescribe?.verifyPassed, false);
        assert.equal(result.semantic?.replayInstruction, undefined);
        assert.equal(result.elementDescription, undefined);
        assert.doesNotMatch(JSON.stringify(result), /provider details/);
      }
      assert.equal(descriptions, scenario === 'describe-error' ? 1 : 2);
      assert.equal(locations, scenario === 'describe-error' ? 0 : 2);
    }
  } finally { await browser.close(); }
});


test('cancelling an official description terminates its process and closes the actual model request', { timeout: 20000 }, async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  let received!: () => void, disconnected!: () => void;
  const requestStarted = new Promise<void>(resolve => { received = resolve; });
  const requestClosed = new Promise<void>(resolve => { disconnected = resolve; });
  const server = createServer((request, response) => {
    request.resume();
    request.once('end', received);
    response.once('close', disconnected);
    // Deliberately never respond. Cancellation must close the socket, not just abandon a promise.
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const previous = { ...process.env };
  const controller = new AbortController();
  try {
    for (const key of Object.keys(process.env)) if (key.startsWith('MIDSCENE_MODEL') || key.startsWith('OPENAI_')) delete process.env[key];
    Object.assign(process.env, { MIDSCENE_MODEL_NAME: 'local-cancellation', MIDSCENE_MODEL_FAMILY: 'gpt-5', MIDSCENE_MODEL_BASE_URL: `http://127.0.0.1:${address.port}/v1`, MIDSCENE_MODEL_API_KEY: 'local-test-key' });
    const page = await browser.newPage({ viewport: { width: 400, height: 300 } });
    await page.setContent('<button style="position:absolute;left:20px;top:20px;width:100px;height:40px">Send</button>');
    const screenshot = 'data:image/png;base64,' + (await page.screenshot()).toString('base64');
    const event: RecordedEvent = { hashId: 'cancel', type: 'click', actionType: 'Tap', timestamp: 1, pageInfo: { width: 400, height: 300 }, elementRect: { x: 50, y: 40 }, rawPayload: { actionType: 'Tap', x: 50, y: 40 } };
    const operation = describeInWorker(event, screenshot, controller.signal);
    const rejected = assert.rejects(operation, /用户取消/);
    await requestStarted;
    controller.abort(new Error('用户取消'));
    await rejected;
    await requestClosed;
  } finally {
    controller.abort();
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
    await browser.close(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
