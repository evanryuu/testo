import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { stringify } from 'yaml';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { unzipSync } from 'fflate';
import { exportRunBundle } from '../src/runner/report-bundle.js';
import { startRun } from '../src/runner/run.js';
import type { WorkerEvent } from '../src/runner/messages.js';
import { createWaitNodes, waitInputSchema } from '../src/runner/wait-nodes.js';

test('AI wait progress records attempts and elapsed time without repeating actions', async () => {
  let checks = 0;
  const events: WorkerEvent[] = [];
  const node = createWaitNodes(() => ({ aiAssert: async () => ({ pass: ++checks === 3, thought: 'generating' }) } as any), { onProgress: event => events.push(event) })[0]!;
  await node.execute({ scope: 'case', case: { phase: 'steps', stepIndex: 4 }, input: waitInputSchema.parse({ prompt: 'answer complete', timeoutMs: 1000, checkIntervalMs: 100 }), signal: new AbortController().signal } as any);
  const finished = events.at(-1)!;
  assert.equal(finished.type, 'wait-progress');
  if (finished.type === 'wait-progress') { assert.equal(finished.modelCalls, 3); assert.equal(finished.status, 'passed'); assert.ok(finished.elapsedMs >= 180); }
});

test('native runner uses shared variables, waits for real DOM, saves diagnostics and rejects wrong targets', { timeout: 60000 }, async () => {
  let sends = 0;
  const server = createServer((request, response) => {
    if (request.url === '/sent') { sends++; response.end('ok'); return; }
    if (request.url === '/missing') { response.statusCode = 404; response.end('missing'); return; }
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(`<!doctype html><input aria-label="Library name" style="position:absolute;left:20px;top:20px;width:200px;height:30px"><button data-testid="send" style="position:absolute;left:20px;top:80px;width:100px;height:40px" onclick="fetch('/sent');document.querySelector('p').textContent=document.querySelector('input').value">Send</button><p style="position:absolute;top:150px"></p><script>setTimeout(()=>{document.querySelector('button').dataset.ready='yes';console.error('fixture console evidence');fetch('/missing')},600)</script>`);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  await mkdir('artifacts', { recursive: true });
  const root = await mkdtemp(path.resolve('artifacts/execution-features-'));
  const file = path.join(root, 'workflow.yaml');
  try {
    const source = stringify({ testo: { variables: { libraryName: 'default' }, datasets: [{ id: 'demo', name: 'Demo', variables: { libraryName: 'dataset' } }] }, cases: [{ name: 'shared parameters', steps: [
      { gotoUrl: '${baseUrl}' },
      { waitForElement: { selector: 'button[data-ready=yes]', state: 'visible', timeoutMs: 3000 }, testo: { metric: 'first-response' } },
      { useFlow: { id: 'type' } },
      { recordedAction: { actionType: 'Tap', payload: { x: 70, y: 100 }, target: { tag: 'button', role: 'button', name: 'Send', testId: 'send' } } },
      { assertText: '${libraryName}' },
    ] }], afterEach: [{ recordToReport: 'End' }] });
    await writeFile(file, source);
    const events: WorkerEvent[] = [];
    const options = { workflowPath: file, artifactRoot: root, baseUrl: `http://127.0.0.1:${address.port}`, channel: 'chrome', datasetId: 'demo', variables: { libraryName: 'release-123' }, flows: { type: { name: 'Fill', steps: [{ recordedAction: { actionType: 'Input', payload: { x: 70, y: 35, value: '${libraryName}', mode: 'replace' }, target: { tag: 'input', name: 'Library name' } } }] } } };
    const handle = startRun(options, event => events.push(event));
    await writeFile(file, 'broken after start');
    const success = await handle.result;
    assert.equal(success.status, 'passed', JSON.stringify(success));
    assert.equal(sends, 1);
    assert.equal(await readFile(path.join(success.artifactDirectory, 'workflow.yaml'), 'utf8'), source);
    assert.equal(success.checks?.[0]?.metric, 'first-response');
    assert.equal(success.checks?.[0]?.modelCalls, 0);
    assert.ok(events.some(event => event.type === 'diagnostic' && event.kind === 'network' && event.message.includes('404')));
    assert.ok(events.some(event => event.type === 'diagnostic' && event.kind === 'console'));
    const bundle = await exportRunBundle({ runId: success.runId, projectId: 'fixture', caseId: 'shared-parameters', caseName: 'Shared parameters', environment: 'test', status: 'passed', startedAt: success.startedAt, result: success, events }, path.join(root, 'report.zip'));
    const extracted = path.join(root, 'portable');
    for (const [name, bytes] of Object.entries(unzipSync(await readFile(bundle)))) { const target = path.join(extracted, name); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, bytes); }
    const viewer = await chromium.launch({ channel: 'chrome', headless: true });
    try {
      const page = await viewer.newPage();
      await page.goto(pathToFileURL(path.join(extracted, 'index.html')).href);
      await page.getByRole('link', { name: '报告 1', exact: true }).click();
      await page.getByText('Execution', { exact: true }).waitFor();
      await page.getByText('Screenshot', { exact: true }).nth(1).click();
      await page.getByText('please select a task', { exact: true }).waitFor({ state: 'hidden' });
      assert.match(await page.title(), /Report.*Midscene/);
      await page.screenshot({ path: path.join(root, 'portable-report.png') });
    } finally { await viewer.close(); }
    const failedSource = stringify({ cases: [{ name: 'Do not click a wrong target', steps: [{ gotoUrl: '${baseUrl}' }, { recordedAction: { actionType: 'Tap', payload: { x: 70, y: 100 }, target: { name: 'Delete' } } }] }], afterEach: [{ recordToReport: 'Mismatch' }] });
    const failedEvents: WorkerEvent[] = [];
    const failed = await startRun({ ...options, datasetId: undefined, workflowText: failedSource }, event => failedEvents.push(event)).result;
    assert.equal(failed.status, 'failed', JSON.stringify(failed));
    assert.match(failed.error!, /目标不匹配/);
    assert.equal(sends, 1, 'wrong-target run must not dispatch a click');
    assert.ok(failedEvents.some(event => event.type === 'step-evidence' && event.stage === 'failed' && event.image));
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
