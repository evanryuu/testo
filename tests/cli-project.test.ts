import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { stringify } from 'yaml';
import { WorkspaceStore } from '../src/main/workspace.js';
import { planProjectRun, runProject, selectProjectCases, junitReport } from '../src/runner/project-run.js';

function fixture(baseUrl = 'http://127.0.0.1:3000') {
  mkdirSync('artifacts', { recursive: true });
  const root = mkdtempSync(path.resolve('artifacts/cli-project-'));
  const store = new WorkspaceStore(path.join(root, 'registry'), path.join(root, 'projects'));
  const projectId = store.create('CLI project', '');
  const project = store.project(projectId);
  store.saveEnvironment({ projectId, id: project.environments[0]!.id, name: 'Test', baseUrl, variables: { libraryName: 'environment' } });
  const cases = ['Create', 'Delete', 'Other'].map(name => {
    const id = store.createCase(projectId, name, project.suites[0]!.id, ['web']);
    const item = store.project(projectId).cases.find(item => item.id === id)!;
    store.saveCase({ projectId, caseId: id, revision: item.revision, name, description: '', priority: 'P1', tags: name === 'Other' ? ['other'] : ['smoke'] });
    const workflowId = item.workflows[0]!.id;
    const text = stringify({ testo: { variables: { action: name.toLowerCase() }, datasets: [{ id: 'a', name: 'Row A', variables: { libraryName: 'row-a' } }, { id: 'b', name: 'Row B', variables: { libraryName: 'row-b' } }] }, cases: [{ name, steps: [{ useFlow: { id: 'open' } }, { assertText: '${libraryName}' }] }] });
    store.saveWorkflow({ projectId, caseId: id, workflowId, revision: store.workflow(projectId, id, workflowId).revision, text });
    return { id, name, workflowId, file: store.workflowLocation(projectId, id, workflowId).file };
  });
  const assets = store.project(projectId).assets!;
  store.saveAssets({ projectId, revision: assets.revision, variables: { libraryName: 'project' }, flows: { open: { name: 'Open library', steps: [{ gotoUrl: '${baseUrl}/${action}/${libraryName}' }] } } });
  store.saveGroup({ projectId, name: 'Scenario', description: '', caseIds: cases.slice(0, 2).map(item => item.id) });
  store.saveGroup({ projectId, name: 'Extended', description: '', caseIds: cases.slice(1).map(item => item.id) });
  return { root, store, project: store.project(projectId), cases };
}

test('CLI planning deduplicates groups, applies tag filters and expands datasets without changing the project', () => {
  const fixtureData = fixture();
  const { project } = fixtureData;
  assert.deepEqual(selectProjectCases(project, { groups: ['Scenario', 'Extended'] }), fixtureData.cases.map(item => item.id));
  assert.deepEqual(selectProjectCases(project, { groups: ['Scenario', 'Extended'], tags: ['smoke'] }), fixtureData.cases.slice(0, 2).map(item => item.id));
  const original = readFileSync(path.join(project.root, 'workspace.yaml'), 'utf8');
  const plan = planProjectRun({ projectDir: project.root, environment: 'Test', groups: ['Scenario'], allDatasets: true, variables: { libraryName: 'run-name' }, artifactRoot: fixtureData.root });
  assert.equal(plan.items.length, 4);
  assert.deepEqual(plan.items.map(item => item.datasetId), ['a', 'b', 'a', 'b']);
  assert.equal(plan.snapshot.variables.libraryName, 'run-name');
  assert.equal(plan.snapshot.defaults?.libraryName, 'environment');
  assert.equal(readFileSync(path.join(project.root, 'workspace.yaml'), 'utf8'), original);
  assert.throws(() => planProjectRun({ projectDir: project.root, environment: 'Test', cases: ['Create'], datasetId: 'missing', artifactRoot: fixtureData.root }), /没有数据集/);
});

test('project CLI executes a frozen multi-case scenario with one shared name and emits JUnit', { timeout: 60000 }, async () => {
  const visited: string[] = [];
  const server = createServer((request, response) => {
    if (request.url === '/favicon.ico') { response.statusCode = 204; response.end(); return; }
    visited.push(request.url ?? ''); response.setHeader('Content-Type', 'text/html'); response.end(`<p>${(request.url ?? '').split('/').at(-1)}</p>`);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const data = fixture(`http://127.0.0.1:${address.port}`);
  try {
    let changed = false;
    const junit = path.join(data.root, 'junit.xml');
    const result = await runProject({ projectDir: data.project.root, environment: 'Test', groups: ['Scenario', 'Extended'], tags: ['smoke'], variables: { libraryName: 'release-123' }, artifactRoot: data.root, channel: 'chrome', junit }, { onEvent: event => {
      if (!changed && event.type === 'step-started') { changed = true; writeFileSync(data.cases[1]!.file, 'broken while queued'); }
    } });
    assert.equal(result.status, 'passed', JSON.stringify(result));
    assert.deepEqual(result.items.map(item => item.caseName), ['Create', 'Delete']);
    assert.ok(visited.includes('/create/release-123'));
    assert.ok(visited.includes('/delete/release-123'));
    assert.match(readFileSync(junit, 'utf8'), /tests="2" failures="0"/);
    assert.ok(readFileSync(path.join(data.root, result.id, 'batch-summary.json'), 'utf8').includes('release-123'));
    const variableFile = path.join(data.root, 'variables.json'); writeFileSync(variableFile, '{"libraryName":"cli-456"}');
    const child = spawn(process.execPath, ['dist/src/runner/cli.js', '--project', data.project.root, '--environment', 'Test', '--case', 'Create', '--variables', variableFile, '--channel', 'chrome', '--artifacts', data.root, '--junit', path.join(data.root, 'command.xml')], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', chunk => output += chunk); child.stderr.on('data', chunk => output += chunk);
    const code = await new Promise<number | null>(resolve => child.once('close', resolve));
    assert.equal(code, 0, output.slice(-5000));
    assert.ok(visited.includes('/create/cli-456'));
    assert.match(readFileSync(path.join(data.root, 'command.xml'), 'utf8'), /tests="1" failures="0"/);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('JUnit preserves failed/skipped outcomes and escapes page error strings', () => {
  const report = junitReport({ projectName: 'A&B', environment: 'test', startedAt: 'now', items: [{ caseId: 'a', caseName: 'fail<one>', definitionHash: 'a', status: 'failed', result: { error: '<script>&"', durationMs: 125 } as any }, { caseId: 'b', caseName: 'skipped', definitionHash: 'b', status: 'skipped' }] });
  assert.match(report, /failures="1" skipped="1"/);
  assert.match(report, /&lt;script&gt;&amp;&quot;/);
  assert.doesNotMatch(report, /<script>/);
});


test('CLI stops or continues after failure and SIGINT cancels before the next case', { timeout: 60000 }, async () => {
  const server = createServer((request, response) => { response.setHeader('Content-Type', 'text/html'); response.end(`<p>${(request.url ?? '').split('/').at(-1)}</p>`); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const data = fixture(`http://127.0.0.1:${address.port}`);
  try {
    writeFileSync(data.cases[0]!.file, stringify({ cases: [{ name: 'Create', steps: [{ gotoUrl: '${baseUrl}' }, { assertText: { text: 'never present', timeoutMs: 100 } }] }] }));
    const common = { projectDir: data.project.root, environment: 'Test', groups: ['Scenario'], artifactRoot: data.root, channel: 'chrome', variables: { libraryName: 'run-value' } };
    const stopped = await runProject({ ...common, failurePolicy: 'stop' });
    assert.deepEqual(stopped.items.map(item => item.status), ['failed', 'skipped']);
    const continued = await runProject({ ...common, failurePolicy: 'continue' });
    assert.deepEqual(continued.items.map(item => item.status), ['failed', 'passed']);
    writeFileSync(data.cases[0]!.file, stringify({ cases: [{ name: 'Create', steps: [{ gotoUrl: '${baseUrl}' }, { wait: { duration: 30, unit: 's' } }] }] }));
    const child = spawn(process.execPath, ['dist/src/runner/cli.js', '--project', data.project.root, '--environment', 'Test', '--group', 'Scenario', '--channel', 'chrome', '--artifacts', data.root], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', pending = '', interrupted = false;
    child.stdout.on('data', chunk => {
      output += chunk; pending += chunk;
      const lines = pending.split('\n'); pending = lines.pop()!;
      for (const line of lines) { try { const event = JSON.parse(line); if (!interrupted && event.type === 'step-started' && event.node === 'wait') { interrupted = true; child.kill('SIGINT'); } } catch { /* Final summary spans several lines. */ } }
    });
    child.stderr.on('data', chunk => output += chunk);
    const code = await new Promise<number | null>(resolve => child.once('close', resolve));
    assert.equal(code, 130, output.slice(-5000));
    assert.equal(interrupted, true);
    assert.match(output, /"status": "cancelled"/);
    assert.match(output, /"status": "skipped"/);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});


test('CLI help exits successfully without a project or creating artifacts', { timeout: 15000 }, async () => {
  mkdirSync('artifacts', { recursive: true });
  const cwd = mkdtempSync(path.resolve('artifacts/cli-help-'));
  for (const option of ['--help', '-h']) {
    const child = spawn(process.execPath, [path.resolve('dist/src/runner/cli.js'), option], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', errors = '';
    child.stdout.on('data', chunk => output += chunk);
    child.stderr.on('data', chunk => errors += chunk);
    const code = await new Promise<number | null>(resolve => child.once('close', resolve));
    assert.equal(code, 0, errors);
    assert.equal(errors, '');
    for (const option of ['--project', '--environment', '--group', '--workflow', '--variables', '--all-datasets', '--junit']) assert.ok(output.includes(option), option);
    assert.equal(existsSync(path.join(cwd, 'artifacts')), false);
  }
});


test('CLI rejects missing model configuration before launching any selected case', async () => {
  const data = fixture();
  writeFileSync(data.cases[0]!.file, stringify({ cases: [{ name: 'Ordinary', steps: [{ assertText: 'aiAgent' }] }] }));
  writeFileSync(data.cases[1]!.file, stringify({ cases: [{ name: 'AI', steps: [{ aiAssert: 'Reply is visible' }] }] }));
  const options = { projectDir: data.project.root, environment: 'Test', groups: ['Scenario'], artifactRoot: path.join(data.root, 'output') };
  assert.doesNotThrow(() => planProjectRun({ ...options, groups: undefined, cases: ['Create'] }, {}));
  assert.throws(() => planProjectRun(options, {}), /模型|MIDSCENE_MODEL_NAME/);
  assert.throws(() => planProjectRun(options, { MIDSCENE_MODEL_NAME: '   ' }), /模型|MIDSCENE_MODEL_NAME/);
  await assert.rejects(runProject(options, { environment: {} }), /模型|MIDSCENE_MODEL_NAME/);
  assert.equal(existsSync(options.artifactRoot), false);
  assert.doesNotThrow(() => planProjectRun(options, { MIDSCENE_MODEL_NAME: 'vision-model' }));
  assert.doesNotThrow(() => planProjectRun(options, { MIDSCENE_MODEL_NAME: 'default-model', MIDSCENE_INSIGHT_MODEL_NAME: 'vision-model', MIDSCENE_PLANNING_MODEL_NAME: 'planning-model' }));
  assert.throws(() => planProjectRun(options, { MIDSCENE_INSIGHT_MODEL_NAME: 'vision-model', MIDSCENE_PLANNING_MODEL_NAME: 'planning-model' }), /MIDSCENE_MODEL_NAME/);
  assert.throws(() => planProjectRun(options, { OPENAI_MODEL: 'legacy-name' }), /MIDSCENE_MODEL_NAME/);
});
