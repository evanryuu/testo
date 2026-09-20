import assert from 'node:assert/strict';
import childProcess, { fork } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { startRun } from '../src/runner/run.js';
import type { WorkerEvent } from '../src/runner/messages.js';

for (const status of ['passed', 'failed', 'cancelled', 'error'] as const) {
  test(`cleanup watchdog preserves delivered ${status} result and reports cleanup separately`, async t => {
    const child = Object.assign(new EventEmitter(), {
      connected: true, pid: undefined,
      send(_message: unknown, callback: (error?: Error) => void) { callback(); },
      kill() { queueMicrotask(() => child.emit('close', null, 'SIGKILL')); return true; },
    });
    t.mock.method(childProcess, 'fork', () => child);
    syncBuiltinESMExports();
    t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const artifactRoot = mkdtempSync(path.join(tmpdir(), 'testo-lifecycle-'));
    const events: WorkerEvent[] = [];
    const run = startRun({ workflowPath: '/fixture.yaml', workflowText: 'cases: []', baseUrl: 'http://localhost', artifactRoot }, event => events.push(event));
    const finished: WorkerEvent = { type: 'finished', status, reportPaths: ['report.html'], definitionHash: 'original-hash', checks: [],
      ...(status === 'passed' ? {} : { error: 'aiTap timed out after 30000ms' }) };
    child.emit('message', finished);
    let settled = false;
    void run.result.then(() => { settled = true; });
    await Promise.resolve();
    assert.equal(settled, false, 'batch must still wait for process cleanup');
    t.mock.timers.tick(5000);
    const result = await run.result;
    assert.equal(result.status, status);
    assert.equal(result.error, finished.error);
    assert.deepEqual(result.reportPaths, finished.reportPaths);
    assert.equal(result.definitionHash, finished.definitionHash);
    assert.ok(events.some(event => event.type === 'diagnostic' && /Worker did not exit/.test(event.message)));
    assert.match(readFileSync(path.join(run.artifactDirectory, 'events.jsonl'), 'utf8'), /Worker did not exit/);
    assert.deepEqual(JSON.parse(readFileSync(path.join(run.artifactDirectory, 'summary.json'), 'utf8')), result);
  });
}

test('worker flushes its result and exits even with a remaining active handle', { timeout: 15000 }, async () => {
  const artifactDirectory = mkdtempSync(path.join(tmpdir(), 'testo-worker-exit-'));
  const child = fork(new URL('../src/runner/worker.js', import.meta.url), [], {
    execArgv: ['--import', 'data:text/javascript,setInterval(() => {}, 1000)'],
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let finished: WorkerEvent | undefined;
  let forced = false;
  let timer: NodeJS.Timeout | undefined;
  const fallback = setTimeout(() => child.kill('SIGKILL'), 12000);
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.on('error', reject);
      child.on('message', (event: WorkerEvent) => {
        if (event.type === 'ready') child.send({ type: 'start', runId: 'fixture', artifactDirectory,
          options: { workflowPath: '/fixture.yaml', workflowText: 'cases: [', baseUrl: 'http://localhost', artifactRoot: artifactDirectory } });
        if (event.type === 'finished') {
          finished = event;
          timer = setTimeout(() => { forced = true; child.kill('SIGKILL'); }, 2000);
        }
      });
      child.on('close', resolve);
    });
    assert.equal(finished?.type, 'finished', 'parent receives the final result before worker exit');
    assert.equal(forced, false, 'worker exits without relying on the supervisor watchdog');
    assert.equal(code, 0);
  } finally { clearTimeout(fallback); clearTimeout(timer); child.kill('SIGKILL'); }
});
