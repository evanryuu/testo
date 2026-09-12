import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { parse, stringify } from 'yaml';
import { WorkspaceStore } from '../src/main/workspace.js';
import { HistoryStore } from '../src/main/history.js';
import { assertWorkflowModel, validateWorkflow } from '../src/main/workflow-validation.js';
import { retryItems } from '../src/main/batch-retry.js';
import { mergeRecordedWorkflow, buildRecordedWorkflow } from '../src/recording/workflow.js';
import type { BatchRun } from '../src/shared/workspace.js';

test('preflight rejects bad node inputs and unsupported Bridge options before executing', () => {
  assert.throws(() => validateWorkflow(stringify({ cases: [{name: 'bad', steps: [{gotoUrl: {url: 123}}]}] })), /gotoUrl/);
  assert.throws(() => validateWorkflow(stringify({ cases: [{name: 'bad', steps: [{gotoUrl: {url: 'https://example.com', waitUntil: 'networkidle'}}]}] }), {}, false, true), /gotoUrl/);
  assert.throws(() => validateWorkflow(stringify({ beforeEach: [{waitForElement: {selector: '', state: 'visible'}}], cases: [{name: 'bad', steps: [{wait: {duration:5,unit:'ms'}}]}] })), /waitForElement/);
  assert.doesNotThrow(() => validateWorkflow('cases:\n  - name: parameter\n    steps:\n      - wait: {duration: "${duration}", unit: ms}\n', {}, true));
});

test('resources preserve optimistic revisions, referenced flows and environment defaults', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'testo-resources-'));
  try {
    const store = new WorkspaceStore(path.join(dir, 'data'), path.join(dir, 'projects'));
    const projectId = store.create('Local', ''), project = store.project(projectId);
    const caseId = store.createCase(projectId, 'Create KB', project.suites[0]!.id, ['web']);
    const workflowId = store.project(projectId).cases[0]!.workflows[0]!.id;
    const assets = store.saveAssets({ projectId, revision: project.assets!.revision, variables: {knowledgeBaseName: 'project-default'}, flows: {setup: {name: 'setup', steps: [{wait: {duration:5,unit:'ms'}}]}} });
    const workflow = store.workflow(projectId, caseId, workflowId);
    store.saveWorkflow({projectId,caseId,workflowId,revision:workflow.revision,text:'cases:\n  - name: create\n    steps:\n      - useFlow: {id: setup}\n'});
    assert.throws(() => store.saveAssets({projectId,revision:assets.revision,variables:{},flows:{}}), /仍在引用/);
    assert.throws(() => store.saveAssets({projectId,revision:project.assets!.revision,variables:{},flows:assets.flows}), /外部修改/);
    writeFileSync(path.join(project.root,'environments/broken.yaml'),'invalid: [');
    store.saveEnvironment({projectId,id:project.environments[0]!.id,name:'Changed',baseUrl:'https://example.com',variables:{knowledgeBaseName:'env-default'}});
    assert.equal(store.project(projectId).environments[0]!.variables!.knowledgeBaseName,'env-default');
    assert.equal(store.project(projectId).assets!.variables.knowledgeBaseName,'project-default');
  } finally { rmSync(dir,{recursive:true,force:true}); }
});

test('partial recording preserves comments, settings, hooks and explicit navigation', () => {
  const original = '# team note\ntesto:\n  variables: {name: original}\nbeforeEach:\n  - wait: {duration: 10, unit: ms}\ncases:\n  - name: workflow\n    steps:\n      - aiAct: before # preserve comment\n      - aiAct: replaced\n      - aiAct: after\nafterEach:\n  - recordToReport: done\n';
  const recorded = buildRecordedWorkflow({name:'new',baseUrl:'https://example.com/app', events:[
    {hashId:'tap',actionType:'Tap',rawPayload:{x:20,y:30},pageInfo:{width:1280,height:800}},
    {hashId:'navigation',actionType:'Navigate',rawPayload:{url:'https://example.com/other'},pageInfo:{width:1280,height:800}},
  ]});
  const result = mergeRecordedWorkflow(original,recorded,1,1), data = parse(result);
  assert.match(result, /# team note/); assert.match(result, /# preserve comment/);
  assert.equal(data.cases[0].steps.length,4);
  assert.ok(data.cases[0].steps[1].recordedAction);
  assert.equal(data.cases[0].steps[2].gotoUrl.url,'${baseOrigin}/other');
  assert.deepEqual(data.testo,parse(original).testo); assert.deepEqual(data.beforeEach,parse(original).beforeEach);
  assert.deepEqual(data.afterEach,parse(original).afterEach);
  assert.throws(() => mergeRecordedWorkflow(original,recorded,2,2), /位置无效/);
});

test('paged history keeps every event in detail and finds old cases latest result', () => {
  const history = new HistoryStore(':memory:');
  try {
    for(let index=0;index<160;index++) history.save({runId:`r${index}`,caseId:index ? 'current' : 'older',projectId:'p',caseName:'KB',environment:'staging',status:index%2 ? 'passed' : 'failed',startedAt:new Date(1000*index).toISOString(),snapshot:{environmentId:'env',baseUrl:'https://example.com',variables:{name:'shared'},model:{name:'',baseUrl:'',family:''}},events:[{type:'ready'}]});
    history.appendEvent('r159',{type:'step-started',node:'wait',phase:'steps',index:0,total:1});
    const page = history.query({projectId:'p',status:'passed',offset:50,limit:50});
    assert.equal(page.total,80); assert.equal(page.runs.length,30); assert.ok(page.runs.every(run=>run.events.length===0 && !run.snapshot));
    assert.equal(history.get('r159')!.events.length,2); assert.equal(history.get('r159')!.snapshot!.variables.name,'shared');
    assert.equal(history.query({caseId:'older'}).total,1);
    assert.equal(history.latestByCase().length,2);
  } finally { history.close(); }
});

test('batch retry keeps definitions, order and shared inputs; dependent scenarios restart completely', () => {
  const batch: BatchRun = {id:'b',projectId:'p',environment:'staging',status:'failed',startedAt:'',failurePolicy:'stop',snapshot:{environmentId:'env',baseUrl:'https://example.com',variables:{knowledgeBaseName:'one-name'},model:{name:'',baseUrl:'',family:''}},items:['passed','failed','skipped'].map((status,index)=>({caseId:String(index),caseName:String(index),workflowId:'web',sessionName:'selected',definition:`frozen-${index}`,status:status as 'passed'|'failed'|'skipped'}))};
  assert.deepEqual(retryItems(batch,'failed').map(item=>item.caseId),['1']);
  assert.deepEqual(retryItems(batch,'unfinished').map(item=>item.caseId),['2']);
  const retry = retryItems({...batch,dependent:true},'failed');
  assert.deepEqual(retry.map(item=>item.definition),['frozen-0','frozen-1','frozen-2']);
  retry[0]!.definition = 'edited'; assert.equal(batch.items[0]!.definition,'frozen-0');
  assert.equal(batch.snapshot!.variables.knowledgeBaseName,'one-name');
});


test('preflight detects model requirements from executable nodes rather than text or metadata', () => {
  const validate = (document: Record<string, unknown>, options: Parameters<typeof validateWorkflow>[1] = {}) => validateWorkflow(stringify(document), options);
  const ordinary = validate({ cases: [{ name: 'aiAgent', steps: [{ assertText: 'aiAgent and aiAssert' }, { recordToReport: 'aiWaitFor' }, { aiAct: 'disabled', testo: { disabled: true } }] }] });
  assert.equal(ordinary.needsModel, false);
  assert.equal(validate({ cases: [{ name: 'test', steps: [{ useFlow: { id: 'setup' } }] }] }, { flows: { setup: { name: 'aiAct metadata only', steps: [{ assertText: 'aiAgent' }] } } }).needsModel, false);
  assert.equal(validate({ cases: [{ name: 'test', steps: [{ useFlow: { id: 'setup' } }] }] }, { flows: { setup: { name: 'setup', steps: [{ aiAssert: 'The result exists' }] } } }).needsModel, true);
  assert.equal(validate({ beforeEach: [{ aiWaitFor: 'Ready' }], cases: [{ name: 'test', steps: [{ assertText: 'Ready' }] }] }).needsModel, true);
  assert.equal(validate({ cases: [{ name: 'test', steps: [{ aiAct: 'Click send' }] }] }).needsModel, true);
});


test('run model checks use the frozen name and allow ordinary DOM workflows without a model', () => {
  const ai = validateWorkflow(stringify({ cases: [{ name: 'AI', steps: [{ aiAssert: 'Ready' }] }] }));
  const dom = validateWorkflow(stringify({ cases: [{ name: 'DOM', steps: [{ assertText: 'aiAgent' }] }] }));
  assert.doesNotThrow(() => assertWorkflowModel(dom, undefined));
  const snapshot = { model: { name: '' } };
  const currentSettings = { name: 'newly-configured-model' };
  assert.throws(() => assertWorkflowModel(ai, snapshot.model.name), /MIDSCENE_MODEL_NAME/);
  assert.doesNotThrow(() => assertWorkflowModel(ai, currentSettings.name));
  assert.throws(() => assertWorkflowModel(ai, '  '), /MIDSCENE_MODEL_NAME/);
});
