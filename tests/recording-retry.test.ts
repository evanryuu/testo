import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RecordingService } from '../src/main/recording.js';
import type { RecordingDraft } from '../src/shared/recording.js';

function fixture(t: { after(fn: () => void): void }, patch: Partial<RecordingDraft> = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'workspace-recording-retry-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const draft: RecordingDraft = { id: 'same-draft', projectId: 'project', caseId: 'case', workflowId: 'web', caseName: '发送消息', environmentId: 'staging', baseUrl: 'https://example.com', revision: 'revision', existingWorkflow: true, browserMode: 'bridge', status: 'interrupted', events: [], createdAt: new Date().toISOString(), error: '连接失败', ...patch };
  writeFileSync(path.join(dir, 'recording-draft.json'), JSON.stringify(draft));
  return { service: new RecordingService(dir, () => {}), dir, draft };
}

test('retry preserves the draft and existing workflow, discarding only stale connection state', async t => {
  const { service, dir, draft } = fixture(t, { startUrl: 'https://example.com/old', viewport: { width: 1920, height: 902 }, chromeTarget: { tabId: '42', origin: 'https://example.com', profile: { connectorId: 'work', port: 13788, connectionToken: 'private-pairing-token', profileInstallationId: 'profile-A' } } });
  let launches = 0;
  t.mock.method(service as any, 'launchWorker', async () => { launches++; service.draft!.status = 'ready'; return service.draft!.id; });
  assert.equal(await service.retry(draft.id), draft.id);
  assert.equal(launches, 1);
  assert.equal(service.draft!.existingWorkflow, true);
  assert.equal(service.draft!.caseId, draft.caseId);
  assert.equal(service.draft!.revision, draft.revision);
  assert.equal(service.draft!.createdAt, draft.createdAt);
  assert.equal(service.draft!.error, undefined);
  assert.equal(service.draft!.startUrl, undefined);
  assert.equal(service.draft!.viewport, undefined);
  assert.deepEqual(service.draft!.chromeTarget, draft.chromeTarget, 'retry must retain the explicit profile/tab binding');
  assert.equal(JSON.parse(readFileSync(path.join(dir, 'recording-preview.json'), 'utf8')), null);
});

test('retry refuses recorded events without modifying or deleting their evidence', async t => {
  const event = { hashId: 'send', actionType: 'Tap', type: 'click', timestamp: Date.now(), pageInfo: { width: 1280, height: 800 }, rawPayload: { actionType: 'Tap', x: 100, y: 200 } } as RecordingDraft['events'][number];
  const { service, dir, draft } = fixture(t, { events: [event] });
  const original = readFileSync(path.join(dir, 'recording-draft.json'), 'utf8');
  await assert.rejects(service.retry(draft.id), /已经采集录制事件/);
  assert.equal(readFileSync(path.join(dir, 'recording-draft.json'), 'utf8'), original);
  assert.deepEqual(service.draft!.events, [event]);
});

test('repeated retries cannot launch overlapping workers; a later failure remains retryable', async t => {
  const { service, draft } = fixture(t);
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let launches = 0;
  t.mock.method(service as any, 'launchWorker', async () => { launches++; await pending; throw new Error('扩展未连接'); });
  const first = service.retry(draft.id);
  await assert.rejects(service.retry(draft.id), /正在重新连接/);
  release();
  await assert.rejects(first, /扩展未连接/);
  assert.equal(launches, 1);
  assert.equal(service.draft!.status, 'interrupted');
  await assert.rejects(service.retry(draft.id), /扩展未连接/);
  assert.equal(launches, 2);
});

test('preparation failure preserves recorded events and releases the unusable worker', async t => {
  const { service, draft } = fixture(t);
  service.draft!.status = 'ready';
  let closed = false;
  t.mock.method(service as any, 'rpc', async () => { throw new Error('Chrome 标签页已关闭'); });
  t.mock.method(service as any, 'closeWorker', async () => { closed = true; });
  await assert.rejects(service.begin(draft.id), /标签页已关闭/);
  assert.equal(closed, true);
  assert.equal(service.draft!.status, 'interrupted');
  assert.equal(service.draft!.id, draft.id);
  assert.equal(service.draft!.existingWorkflow, true);
  assert.deepEqual(service.draft!.events, []);
});
