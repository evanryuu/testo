import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { RecorderEvents } from '../src/recording/events.js';
import { RecordingService } from '../src/main/recording.js';
import type { RecordedEvent, RecordingDraft } from '../src/shared/recording.js';

const event = (id: string): RecordedEvent => ({
  hashId: id, type: 'input', source: 'studio-preview', actionType: 'Input', timestamp: 123,
  rawPayload: { actionType: 'Input', value: 'hi', mode: 'typeOnly' }, value: 'hi',
  pageInfo: { width: 1280, height: 800 }, elementRect: { x: 10, y: 20 },
  mergedHashIds: ['input-a', 'input-b'], screenshotAsset: { id: 'asset_1', mimeType: 'image/png', bytes: 3 },
  semantic: { source: 'aiDescribe', status: 'pending' },
});
const drain = () => new Promise<void>((resolve) => setImmediate(resolve));

test('retains official fields, coalesces same-hash navigation and keeps generated descriptions across polls', async () => {
  const saved: string[] = [];
  const events = new RecorderEvents({
    persistScreenshot: async (event) => { saved.push(event.hashId); },
    describe: async (event) => ({ ...event, semantic: { source: 'aiDescribe', status: 'ready', actionSummary: 'Input into message', replayInstruction: 'Input hi into message', confidence: 'low', aiDescribe: { verifyPrompt: true, verifyPassed: false } } }),
    changed() {}, idle() {},
  });
  const input = event('input');
  const navigation: RecordedEvent = { ...event('nav'), type: 'navigation', actionType: 'Navigate', rawPayload: { implicitNavigationState: true, beforeUrl: '/a', afterUrl: '/b' }, url: '/b' };
  await events.update([input, navigation, { ...navigation, url: '/c', rawPayload: { ...navigation.rawPayload, afterUrl: '/c' } }]);
  await drain();
  assert.equal(events.values.length, 2);
  assert.equal(events.values[1]!.url, '/c');
  assert.deepEqual(events.values[0]!.rawPayload, input.rawPayload);
  assert.deepEqual(events.values[0]!.mergedHashIds, input.mergedHashIds);
  assert.deepEqual(events.values[0]!.screenshotAsset, input.screenshotAsset);
  assert.equal(events.values[0]!.source, 'studio-preview');
  assert.equal(events.values[0]!.semantic!.confidence, 'low');
  await events.update([input, { ...navigation, url: '/c', rawPayload: { ...navigation.rawPayload, afterUrl: '/c' } }]);
  assert.equal(events.values[0]!.semantic!.status, 'ready');
  assert.deepEqual(saved, ['input', 'nav']);
  events.close();
});

test('description queue limits concurrency and stale responses cannot overwrite a merged input', async () => {
  const pending: { event: RecordedEvent; resolve(event: RecordedEvent): void }[] = [];
  const events = new RecorderEvents({
    persistScreenshot: async () => {}, changed() {}, idle() {},
    describe: (event) => new Promise((resolve) => pending.push({ event, resolve })),
  });
  await events.update([event('a'), event('b'), event('c')]);
  assert.equal(pending.length, 2);
  const merged = { ...event('a'), value: 'hi again', rawPayload: { value: 'hi again', mode: 'typeOnly' } };
  await events.update([merged, event('b'), event('c')]);
  pending[0]!.resolve({ ...pending[0]!.event, semantic: { source: 'aiDescribe', status: 'ready', actionSummary: 'STALE' } });
  await drain();
  assert.equal(events.values[0]!.value, 'hi again');
  assert.notEqual(events.values[0]!.semantic?.actionSummary, 'STALE');
  assert.equal(pending.length, 3);
  events.close();
  pending.slice(1).forEach(({ event, resolve }) => resolve(event));
  await drain();
});

test('model and screenshot failures retain usable original recording evidence', async () => {
  const events = new RecorderEvents({
    persistScreenshot: async () => { throw new Error('disk'); },
    describe: async () => { throw new Error('secret provider details must not be exposed'); }, changed() {}, idle() {},
  });
  await events.update([event('a')]);
  await drain();
  assert.equal(events.values[0]!.value, 'hi');
  assert.equal(events.values[0]!.screenshotError, '截图未能保存到本地');
  assert.equal(events.values[0]!.semantic?.status, 'failed');
  assert.doesNotMatch(JSON.stringify(events.values), /secret provider/);
  events.close();
});

test('saved screenshot and event details survive restart; stale and arbitrary screenshot requests are rejected', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'workspace-recorder-events-'));
  const draft: RecordingDraft = { id: 'recording-1', projectId: 'p', caseId: 'c', workflowId: 'w', caseName: 'Chat', environmentId: 'local', baseUrl: 'https://example.com', revision: 'r', status: 'review', events: [event('input')], createdAt: new Date().toISOString() };
  mkdirSync(path.join(root, 'recordings', draft.id, 'screenshots'), { recursive: true });
  writeFileSync(path.join(root, 'recording-draft.json'), JSON.stringify(draft));
  writeFileSync(path.join(root, 'recordings', draft.id, 'screenshots', 'asset_1'), Buffer.from([1, 2, 3]));
  const service = new RecordingService(root, () => {});
  assert.equal(service.screenshot(draft.id, 'input'), 'data:image/png;base64,AQID');
  assert.equal(service.draft!.events[0]!.semantic!.status, 'failed', 'interrupted descriptions must not spin forever');
  assert.deepEqual(service.draft!.events[0]!.mergedHashIds, ['input-a', 'input-b']);
  assert.throws(() => service.screenshot('stale', 'input'), /不存在/);
  assert.throws(() => service.screenshot(draft.id, '../../model.json'), /不存在/);
  service.saved(draft.id);
  const archived = JSON.parse(readFileSync(path.join(root, 'recordings', draft.id, 'draft.json'), 'utf8'));
  assert.equal(archived.status, 'saved');
  assert.equal(archived.events[0].screenshotAsset.id, 'asset_1');
});


test('a stalled model becomes a failed description and releases the stopped recording queue', async () => {
  let finished!: () => void;
  const idle = new Promise<void>((resolve) => { finished = resolve; });
  const events = new RecorderEvents({
    persistScreenshot: async () => {}, describe: () => new Promise(() => {}),
    changed() {}, idle: finished, descriptionTimeoutMs: 20,
  });
  await events.update([event('slow')]);
  await idle;
  assert.equal(events.pending, 0);
  assert.equal(events.values[0]!.semantic?.status, 'failed');
  assert.equal(events.values[0]!.value, 'hi');
  events.close();
});


test('upstream ready descriptions without verification still enter the verification queue', async () => {
  let calls = 0;
  const events = new RecorderEvents({ persistScreenshot: async () => {}, changed() {}, idle() {}, describe: async (input) => {
    calls++;
    return { ...input, semantic: { source: 'aiDescribe', status: 'failed', aiDescribe: { verifyPrompt: true, verifyPassed: false } } };
  } });
  const input = { ...event('unverified'), semantic: { source: 'aiDescribe' as const, status: 'ready' as const, actionSummary: 'Wrong chat' } };
  await events.update([input]); await drain();
  assert.equal(calls, 1);
  assert.equal(events.values[0]!.semantic?.status, 'failed');
  assert.deepEqual(events.values[0]!.rawPayload, input.rawPayload);
  await events.update([input]); await drain();
  assert.equal(calls, 1, 'polling does not repeatedly schedule the same event');
  events.close();
});
