import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { after, before, test } from 'node:test';
import { startRun, type RunHandle } from '../src/runner/run.js';
import type { WorkerEvent } from '../src/runner/messages.js';

const root = process.cwd();
let baseUrl = '';
let requests = 0;
const server = createServer((request, response) => {
  if (request.url === '/disconnect') { request.socket.destroy(); return; }
  requests++;
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.end('<!doctype html><html><head><title>Workspace runner fixture</title></head><body><h1>Web runner verification</h1><p id="status">Ready</p><button onclick="document.querySelector(\'#status\').textContent=\'Clicked\'">Send</button></body></html>');
});
before(async () => {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  baseUrl = `http://127.0.0.1:${address.port}`;
});
after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function start(fixture: string, events: WorkerEvent[], callback?: (event: WorkerEvent) => void, timeoutMs?: number): RunHandle {
  return startRun({
    workflowPath: path.join(root, 'tests/fixtures', fixture), baseUrl,
    artifactRoot: path.join(root, 'artifacts'),
    channel: process.env.TEST_BROWSER_CHANNEL || 'chrome',
    timeoutMs,
  }, (event) => { events.push(event); callback?.(event); });
}

async function assertBrowserExited(events: WorkerEvent[]): Promise<void> {
  const started = events.find((event) => event.type === 'browser-started');
  assert.ok(started?.type === 'browser-started', 'A real browser process must start');
  for (let attempt = 0; attempt < 30; attempt++) {
    try { process.kill(started.pid, 0); }
    catch (error) {
      assert.equal((error as NodeJS.ErrnoException).code, 'ESRCH');
      return;
    }
    await delay(100);
  }
  assert.fail(`Browser process ${started.pid} is still alive`);
}

test('runs selected YAML in a real browser and persists a native Midscene report', { timeout: 45_000 }, async () => {
  const events: WorkerEvent[] = [];
  const previousRequests = requests;
  const run = start('passed.yaml', events);
  const result = await run.result;
  assert.equal(result.status, 'passed', JSON.stringify(result));
  assert.ok(requests > previousRequests, 'Browser must request the live HTTP fixture');
  assert.deepEqual(events.filter((e) => e.type === 'step-started').map((e) => e.node), ['gotoUrl', 'recordToReport']);
  assert.ok(events.some((e) => e.type === 'step-finished' && e.status === 'success'));
  assert.ok(result.reportPaths.length > 0, 'Native report must be returned by Midscene cleanup');
  for (const report of result.reportPaths) {
    assert.ok(report.startsWith(`${run.artifactDirectory}${path.sep}`));
    const html = await readFile(report, 'utf8');
    assert.match(html, /html/i);
    assert.ok(html.length > 1000);
  }
  assert.deepEqual(JSON.parse(await readFile(path.join(run.artifactDirectory, 'summary.json'), 'utf8')), result);
  assert.match(result.definitionHash!, /^[a-f0-9]{64}$/);
  await assertBrowserExited(events);
});

test('reports a real navigation failure and executes afterEach before closing the browser', { timeout: 45_000 }, async () => {
  const events: WorkerEvent[] = [];
  const result = await start('failed.yaml', events).result;
  assert.equal(result.status, 'failed', JSON.stringify(result));
  assert.match(result.error!, /gotoUrl/);
  assert.ok(events.some((e) => e.type === 'step-finished' && e.node === 'gotoUrl' && e.status === 'failed'));
  assert.ok(events.some((e) => e.type === 'step-finished' && e.phase === 'afterEach' && e.status === 'success'));
  assert.ok(result.reportPaths.length > 0);
  await assertBrowserExited(events);
});

test('cancel interrupts a running step and preserves cleanup and report', { timeout: 45_000 }, async () => {
  const events: WorkerEvent[] = [];
  const run = start('cancelled.yaml', events, (event) => {
    if (event.type === 'step-started' && event.node === 'wait') run.cancel();
  });
  const result = await run.result;
  assert.equal(result.status, 'cancelled', JSON.stringify(result));
  assert.ok(result.durationMs < 30_000, 'Cancellation must not wait the full minute');
  assert.ok(events.some((e) => e.type === 'step-finished' && e.phase === 'afterEach' && e.status === 'success'));
  assert.ok(result.reportPaths.length > 0);
  await assertBrowserExited(events);
});

test('unregistered nodes fail before browser startup', { timeout: 15_000 }, async () => {
  const events: WorkerEvent[] = [];
  const result = await start('invalid.yaml', events).result;
  assert.equal(result.status, 'error');
  assert.match(result.error!, /imaginaryNode/);
  assert.ok(!events.some((e) => e.type === 'browser-started'));
});

test('rejects multiple Cases instead of silently running unrelated tests', { timeout: 15_000 }, async () => {
  const events: WorkerEvent[] = [];
  const result = await start('multiple.yaml', events).result;
  assert.equal(result.status, 'error');
  assert.match(result.error!, /每个平台 Workflow 必须包含一个用例/);
  assert.ok(!events.some((e) => e.type === 'browser-started'));
});

test('cancel during worker startup does not open a browser', { timeout: 15_000 }, async () => {
  const events: WorkerEvent[] = [];
  const run = start('passed.yaml', events);
  run.cancel();
  run.cancel();
  const result = await run.result;
  assert.equal(result.status, 'cancelled', JSON.stringify(result));
  assert.ok(!events.some((e) => e.type === 'browser-started'));
});

test('unexpected worker exit becomes an error and the supervisor closes the browser', { timeout: 45_000 }, async () => {
  const events: WorkerEvent[] = [];
  const run = start('cancelled.yaml', events, (event) => {
    if (event.type === 'step-started' && event.node === 'wait') process.kill(run.workerPid!, 'SIGKILL');
  });
  const result = await run.result;
  assert.equal(result.status, 'error', JSON.stringify(result));
  assert.match(result.error!, /Worker exited/);
  await assertBrowserExited(events);
});

test('a run deadline returns an error and releases the browser', { timeout: 30_000 }, async () => {
  const events: WorkerEvent[] = [];
  const result = await start('cancelled.yaml', events, undefined, 8000).result;
  assert.equal(result.status, 'error', JSON.stringify(result));
  assert.match(result.error!, /time limit/);
  await assertBrowserExited(events);
});
