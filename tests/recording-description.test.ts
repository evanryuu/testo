import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { RecordingService } from '../src/main/recording.js';

async function until(predicate: () => boolean, timeout = 25_000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for official recorder description');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test('official model requests enrich recorded events after stop and save; official fallback and failures preserve evidence', { timeout: 90_000 }, async () => {
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
        const fail = payload.model === 'recorder-failure' || (payload.model === 'recorder-fallback' && primary);
        const content = fail ? {} : primary ? { description: '消息输入框 official-test-42' } : { elementDescription: '消息输入框 official-test-42', confidence: 'high' };
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ id: 'local-test', object: 'chat.completion', created: 1700000000, model: payload.model, choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(content) }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }));
      };
      if (payload.model === 'recorder-primary') held = () => reply(response);
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
    for (const model of ['recorder-primary', 'recorder-fallback', 'recorder-failure']) {
      const id = await recorder.start({ projectId: 'p', caseId: 'c', workflowId: 'w', caseName: 'Local describe', environmentId: 'local', baseUrl, revision: 'r' }, {
        ...environment, MIDSCENE_MODEL_NAME: model, MIDSCENE_MODEL_BASE_URL: `${baseUrl}/v1`, MIDSCENE_MODEL_API_KEY: 'local-test-key', MIDSCENE_MODEL_RETRY_COUNT: '0', MIDSCENE_MODEL_TIMEOUT: '10000',
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
        assert.equal(tap().semantic?.source, model === 'recorder-primary' ? 'aiDescribe' : 'recorderAI');
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
    assert.ok(calls.some((call) => call.model === 'recorder-fallback' && call.primary));
    assert.ok(calls.some((call) => call.model === 'recorder-fallback' && !call.primary));
  } finally {
    held?.();
    await recorder.shutdown();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
