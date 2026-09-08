import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { parse, stringify } from 'yaml';
import { buildRecordedWorkflow, RECORDING_VIEWPORT, type RecorderEvent } from '../src/recording/workflow.js';
import { startRun } from '../src/runner/run.js';

function event(actionType: string, rawPayload: Record<string, unknown>, id = actionType): RecorderEvent {
  return { hashId: id, actionType, rawPayload: { actionType, ...rawPayload }, pageInfo: RECORDING_VIEWPORT };
}

test('conversion preserves merged input and separates recorded steps, AI steps and assertions', () => {
  const source = buildRecordedWorkflow({ name: 'Recording', events: [
    event('InitialNavigation', { url: 'https://recorded.example/private' }),
    event('Tap', { x: 22, y: 31 }),
    event('Input', { value: 'hello world', mode: 'typeOnly' }),
    { ...event('Navigate', { implicitNavigationState: true }), type: 'navigation' },
    event('KeyboardPress', { keyName: 'Enter' }),
    event('Navigate', { url: 'https://example.com/next' }, 'explicit-navigation'),
  ], choices: [{ hashId: 'KeyboardPress', mode: 'ai', prompt: '提交输入内容' }], assertions: [
    { kind: 'text', text: '成功' }, { kind: 'ai', text: '页面显示成功提示' },
  ] });
  const doc = parse(source);
  assert.deepEqual(doc.cases[0].steps[0], { setViewportSize: RECORDING_VIEWPORT });
  assert.deepEqual(doc.cases[0].steps[1], { gotoUrl: { url: '${baseUrl}' } });
  assert.equal(doc.cases[0].steps.filter((step: object) => 'gotoUrl' in step).length, 2);
  assert.deepEqual(doc.cases[0].steps[3].recordedAction.payload, { value: 'hello world', mode: 'typeOnly' });
  assert.equal(doc.cases[0].steps[4].aiAct, '提交输入内容');
  assert.deepEqual(doc.cases[0].steps.slice(-2), [{ assertText: { text: '成功' } }, { aiAssert: '页面显示成功提示' }]);
  assert.ok(doc.afterEach[0].recordToReport);
});

test('unsupported actions, wrong viewport and invalid payload cannot become apparently runnable YAML', () => {
  assert.throws(() => buildRecordedWorkflow({ name: 'x', events: [event('Pinch', {})] }), /暂不支持/);
  assert.throws(() => buildRecordedWorkflow({ name: 'x', events: [event('DragAndDrop', { x: 40, y: 20 })] }), /起点和终点/);
  assert.throws(() => buildRecordedWorkflow({ name: 'x', events: [event('Tap', { x: 40 })] }), /y|坐标/);
  assert.throws(() => buildRecordedWorkflow({ name: 'x', events: [event('Tap', { x: 1281, y: 20 })] }));
  assert.throws(() => buildRecordedWorkflow({ name: 'x', events: [{ ...event('Input', { value: 'x' }), pageInfo: { width: 640, height: 400 } }] }), /视口/);
  assert.throws(() => buildRecordedWorkflow({ name: 'x', events: [event('Input', { value: 'x' })], choices: [{ hashId: 'Input', mode: 'ai' }] }), /操作描述/);
  const document = parse(buildRecordedWorkflow({ name: 'x', events: [event('DragAndDrop', {}), event('Input', { value: 'kept' })], choices: [{ hashId: 'DragAndDrop', mode: 'skip' }] }));
  assert.equal(document.cases[0].steps.length, 3);
});

test('recorded actions replay through real Midscene in Chrome, with visible assertions and failure report', { timeout: 60000 }, async () => {
  const server = createServer((_request, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(`<!doctype html><style>body{height:2000px}input{position:absolute;left:20px;top:20px;width:200px;height:30px}button{position:absolute;left:20px;top:80px;width:100px;height:40px}#result{position:fixed;top:150px}#scroll{position:fixed;top:190px}</style><input id="field" onkeydown="if(event.key==='Enter')document.getElementById('key').textContent='Enter received'"><p id="key" style="position:fixed;top:230px"></p><button onclick="document.getElementById('result').textContent=document.getElementById('field').value">Send</button><p id="result"></p><p id="scroll"></p><p hidden>Hidden success</p><script>addEventListener('scroll',()=>document.getElementById('scroll').textContent='Scrolled')</script>`);
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const directory = await mkdtemp(path.join(process.cwd(), 'artifacts/recorded-workflow-'));
    const file = path.join(directory, 'workflow.yaml');
    const document = buildRecordedWorkflow({ name: 'Replay input, keyboard, click and scroll', events: [
      event('Tap', { x: 80, y: 35 }, 'focus'),
      event('Input', { value: 'old content', mode: 'replace', x: 80, y: 35 }, 'old'),
      event('Input', { value: '', mode: 'clear', x: 80, y: 35 }, 'clear'),
      event('Input', { value: 'Hello worl', mode: 'typeOnly' }),
      event('KeyboardPress', { keyName: 'Enter' }),
      event('Input', { value: 'd', mode: 'typeOnly' }, 'append'),
      event('Tap', { x: 70, y: 100 }, 'send'),
      event('Scroll', { direction: 'down', distance: 300, x: 500, y: 500 }),
    ], assertions: [{ kind: 'text', text: 'Hello world' }, { kind: 'text', text: 'Scrolled' }, { kind: 'text', text: 'Enter received' }] });
    await writeFile(file, document);
    const options = { workflowPath: file, artifactRoot: directory, baseUrl: `http://127.0.0.1:${address.port}`, channel: process.env.TEST_BROWSER_CHANNEL || 'chrome' };
    const success = await startRun(options).result;
    assert.equal(success.status, 'passed', JSON.stringify(success));
    assert.ok(success.reportPaths.length);
    const failed = parse(document);
    failed.cases[0].steps.push({ assertText: { text: 'Hidden success', timeoutMs: 100 } });
    await writeFile(file, stringify(failed));
    const failure = await startRun(options).result;
    assert.equal(failure.status, 'failed', JSON.stringify(failure));
    assert.match(failure.error!, /assertText/);
    assert.ok(failure.reportPaths.length, 'afterEach must save a native report even when the assertion fails');
    assert.ok((await readFile(failure.reportPaths[0]!, 'utf8')).length > 1000);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
