import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { parse, stringify } from 'yaml';
import { buildRecordedWorkflow, RECORDING_VIEWPORT, type RecorderEvent, type RecordingReviewStep } from '../src/recording/workflow.js';
import { startRun } from '../src/runner/run.js';
import { runPlanFromYaml } from '../src/shared/run-steps.js';

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
  ], choices: [{ hashId: 'KeyboardPress', mode: 'ai', prompt: '提交输入内容', confirmedPrompt: '提交输入内容' }], assertions: [
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
    const executionEvents: any[] = [];
    const success = await startRun(options, event => executionEvents.push(event)).result;
    assert.equal(success.status, 'passed', JSON.stringify(success));
    assert.ok(success.reportPaths.length);
    assert.ok(executionEvents.some(e => e.type === 'steps-planned' && e.steps.some((s: any) => s.title.includes('点击'))), 'run timeline must name recorded actions');
    assert.ok(executionEvents.some(e => e.type === 'step-evidence' && e.stage === 'after' && e.image), 'run must retain an after-action screenshot');
    const sendEvidence = executionEvents.find(e => e.type === 'step-evidence' && e.stage === 'before' && e.target === 'button · Send');
    assert.ok(sendEvidence, 'before-action evidence identifies the control at the recorded coordinate');
    assert.ok((await readFile(path.join(success.artifactDirectory, 'steps', sendEvidence.image))).length > 100);
    const legacyPlan = runPlanFromYaml(parse(document));
    assert.ok(legacyPlan.some(step => step.title === '点击（70, 100）'));
    assert.ok(legacyPlan.some(step => step.detail === 'Hello worl'));
    const failed = parse(document);
    failed.cases[0].steps.push({ assertText: { text: 'Hidden success', timeoutMs: 100 } });
    failed.cases[0].steps.push({ recordedAction: { actionType: 'Tap', payload: { x: 777, y: 333 } } });
    await writeFile(file, stringify(failed));
    const failedEvents: any[] = [];
    const failure = await startRun(options, event => failedEvents.push(event)).result;
    const unexecuted = failedEvents.find(e => e.type === 'steps-planned').steps.find((step: any) => step.title === '点击（777, 333）');
    assert.ok(unexecuted, 'planned actions remain available after an earlier failure');
    assert.ok(!failedEvents.some(e => e.type === 'step-started' && e.phase === unexecuted.phase && e.index === unexecuted.index), 'the later click must not execute after the assertion fails');
    assert.equal(failure.status, 'failed', JSON.stringify(failure));
    assert.match(failure.error!, /assertText/);
    assert.ok(failure.reportPaths.length, 'afterEach must save a native report even when the assertion fails');
    assert.ok((await readFile(failure.reportPaths[0]!, 'utf8')).length > 1000);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});


test('unverified generated descriptions cannot become AI replay without explicit confirmation', () => {
  const tap = event('Tap', { x: 1467, y: 391 });
  tap.pageInfo = { width: 1920, height: 902 };
  const input = { name: 'Send', events: [tap], viewport: tap.pageInfo };
  const prompt = '点击左侧历史会话';
  assert.throws(() => buildRecordedWorkflow({ ...input, choices: [{ hashId: 'Tap', mode: 'ai', prompt }] }), /确认/);
  const recorded = parse(buildRecordedWorkflow(input));
  assert.deepEqual(recorded.cases[0].steps[2].recordedAction.payload, { x: 1467, y: 391 });
});


test('verified descriptions may be used unchanged; edits and stale confirmations require review', () => {
  const tap: RecorderEvent = { ...event('Tap', { x: 40, y: 30 }), semantic: { source: 'aiDescribe', status: 'ready', replayInstruction: '点击发送', aiDescribe: { verifyPrompt: true, verifyPassed: true } } };
  const build = (prompt: string, confirmedPrompt?: string) => buildRecordedWorkflow({ name: 'Send', events: [tap], choices: [{ hashId: 'Tap', mode: 'ai', prompt, confirmedPrompt }] });
  assert.match(build('点击发送'), /aiAct/);
  assert.throws(() => build('点击历史'), /确认/);
  assert.throws(() => build('点击历史', '点击发送'), /确认/);
  assert.match(build('点击历史', '点击历史'), /aiAct/);
  tap.semantic!.aiDescribe!.verifyPassed = false;
  assert.throws(() => build('点击发送'), /确认/);
  tap.semantic!.aiDescribe = { verifyPrompt: false };
  assert.throws(() => build('点击发送'), /确认/);
});


test('AI-only workflows omit viewport requirements; mixed coordinate workflows retain them', () => {
  const a = event('Tap', { x: 100, y: 100 }, 'a');
  const b = { ...event('Tap', { x: 200, y: 100 }, 'b'), pageInfo: { width: 1440, height: 900 } };
  const choices = [a, b].map(e => ({ hashId: e.hashId, mode: 'ai' as const, prompt: '点击发送', confirmedPrompt: '点击发送' }));
  const yaml = buildRecordedWorkflow({ name: 'AI', events: [a, b], choices });
  assert.doesNotMatch(yaml, /requireViewport|setViewportSize/);
  assert.match(buildRecordedWorkflow({ name: 'mixed', events: [a, b], choices: choices.slice(1) }), /setViewportSize/);
});


test('isolated replay restores a Chrome recording viewport before coordinate actions', { timeout: 30000 }, async () => {
  const server = createServer((_request, response) => { response.end(`<!doctype html><button style="position:absolute;left:1400px;top:300px;width:100px;height:50px" onclick="document.body.innerHTML=innerWidth+'x'+innerHeight">Send</button>`); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const dir = await mkdtemp(path.join(process.cwd(), 'artifacts/viewport-'));
    const viewport = { width: 1920, height: 902 };
    const file = path.join(dir, 'workflow.yaml');
    await writeFile(file, buildRecordedWorkflow({ name: 'Chrome recording in isolated browser', viewport, events: [{ ...event('Tap', { x: 1450, y: 325 }), pageInfo: viewport }], assertions: [{ kind: 'text', text: '1920x902' }] }));
    const result = await startRun({ workflowPath: file, artifactRoot: dir, baseUrl: `http://127.0.0.1:${address.port}`, channel: 'chrome' }).result;
    assert.equal(result.status, 'passed', JSON.stringify(result));
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('wait conditions keep their order and generate explicit bounded waits without changing assertions', () => {
  const steps = parse(buildRecordedWorkflow({
    name: 'Wait for the current answer',
    events: [event('Tap', { x: 22, y: 31 })],
    assertions: [
      { kind: 'wait', text: '  最新消息下方出现回答  ' },
      { kind: 'wait', text: '生成结束', timeoutMs: 120000 },
      { kind: 'ai', text: '回答与问题相关' },
      { kind: 'text', text: '完成' },
    ],
  })).cases[0].steps;
  assert.deepEqual(steps.slice(-4), [
    { aiWaitFor: { prompt: '最新消息下方出现回答', timeoutMs: 60000 } },
    { aiWaitFor: { prompt: '生成结束', timeoutMs: 120000 } },
    { aiAssert: '回答与问题相关' },
    { assertText: { text: '完成' } },
  ]);
});

test('wait conditions reject blank prompts and invalid time limits', () => {
  const build = (text: string, timeoutMs?: number) => buildRecordedWorkflow({
    name: 'Wait', events: [event('Tap', { x: 22, y: 31 })],
    assertions: [{ kind: 'wait', text, timeoutMs }],
  });
  assert.throws(() => build('  '), /等待条件不能为空/);
  for (const timeoutMs of [0, -1000, 999, 300001, 1000.5, Number.NaN, Infinity]) {
    assert.throws(() => build('回答出现', timeoutMs), /最长等待时间/);
  }
  for (const timeoutMs of [1000, 300000]) {
    assert.equal(parse(build('回答出现', timeoutMs)).cases[0].steps.at(-1).aiWaitFor.timeoutMs, timeoutMs);
  }
});


test('Timeline checks run between the selected actions while navigation observations remain evidence', () => {
  const events = [
    event('InitialNavigation', { url: 'https://example.com' }, 'entry'),
    event('Tap', { x: 70, y: 40 }, 'send'),
    { ...event('Navigate', { implicitNavigationState: true }, 'observed-navigation'), type: 'navigation' },
    event('Tap', { x: 250, y: 40 }, 'continue'),
  ];
  const original = structuredClone(events);
  const timeline: RecordingReviewStep[] = [
    { kind: 'event', hashId: 'entry' },
    { kind: 'check', id: 'ready', assertion: { kind: 'wait', text: '输入框可以使用' } },
    { kind: 'event', hashId: 'send' },
    { kind: 'event', hashId: 'observed-navigation' },
    { kind: 'check', id: 'answer', assertion: { kind: 'wait', text: '本次回答结束生成', timeoutMs: 120000 } },
    { kind: 'check', id: 'relevant', assertion: { kind: 'ai', text: '回答与本次问题相关' } },
    { kind: 'event', hashId: 'continue' },
    { kind: 'check', id: 'destination', assertion: { kind: 'text', text: '详情' } },
  ];
  const build = (steps: RecordingReviewStep[], skip = false) => parse(buildRecordedWorkflow({
    name: 'Wait then continue', events, steps,
    choices: skip ? [{ hashId: 'send', mode: 'skip' }] : [],
  })).cases[0].steps;
  const steps = build(timeline);
  assert.deepEqual(steps.map((step: object) => Object.keys(step)[0]), [
    'setViewportSize', 'gotoUrl', 'aiWaitFor', 'recordedAction', 'aiWaitFor', 'aiAssert', 'recordedAction', 'assertText',
  ]);
  assert.equal(steps[4].aiWaitFor.timeoutMs, 120000);
  assert.deepEqual(steps[6].recordedAction.payload, { x: 250, y: 40 });
  const moved = [...timeline];
  moved.splice(6, 0, ...moved.splice(4, 1));
  assert.deepEqual(build(moved).slice(-4).map((step: object) => Object.keys(step)[0]), ['aiAssert', 'recordedAction', 'aiWaitFor', 'assertText']);
  const removed = timeline.filter(step => step.kind !== 'check' || step.id !== 'answer');
  assert.ok(!build(removed).some((step: any) => step.aiWaitFor?.prompt === '本次回答结束生成'));
  assert.equal(build(timeline, true).filter((step: object) => 'recordedAction' in step).length, 1);
  assert.deepEqual(events, original, 'editing checks must not rewrite recorded events or evidence');
});

test('stale or ambiguous Timeline edits cannot silently omit, duplicate or reorder recorded actions', () => {
  const events = [event('Tap', { x: 70, y: 40 }, 'send'), event('Tap', { x: 250, y: 40 }, 'continue')];
  const references: RecordingReviewStep[] = events.map(({ hashId }) => ({ kind: 'event', hashId }));
  const check: RecordingReviewStep = { kind: 'check', id: 'wait', assertion: { kind: 'wait', text: '本次回答完成' } };
  const build = (steps: RecordingReviewStep[]) => buildRecordedWorkflow({ name: 'Send', events, steps });
  for (const steps of [[], references.slice(1), [references[0]!, references[0]!], [...references].reverse(), [references[0]!, { kind: 'event' as const, hashId: 'stale' }]]) {
    assert.throws(() => build(steps), /Timeline/);
  }
  assert.throws(() => build([...references, check, check]), /标识重复/);
  assert.throws(() => buildRecordedWorkflow({ name: 'Send', events, steps: references, assertions: [{ kind: 'ai', text: '重复检查' }] }), /末尾断言/);
  assert.throws(() => buildRecordedWorkflow({ name: 'Send', events, steps: [...references, check], choices: events.map(({ hashId }) => ({ hashId, mode: 'skip' })) }), /至少录制一个操作/);
  assert.throws(() => build([...references, { ...check, assertion: { kind: 'wait', text: ' ' } }]), /等待条件不能为空/);
  assert.throws(() => build([...references, { ...check, assertion: { kind: 'wait', text: '完成', timeoutMs: 999 } }]), /最长等待时间/);
});
