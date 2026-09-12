import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { unzipSync, strFromU8 } from 'fflate';
import { exportRunBundle } from '../src/runner/report-bundle.js';
import type { HistoryRun } from '../src/shared/workspace.js';

function fixture() {
  mkdirSync('artifacts', { recursive: true });
  const root = mkdtempSync(path.resolve('artifacts/report-bundle-'));
  const runRoot = path.join(root, 'run'); mkdirSync(path.join(runRoot, 'report'), { recursive: true }); mkdirSync(path.join(runRoot, 'steps'));
  const report = path.join(runRoot, 'report', 'native.html'); writeFileSync(report, '<html><h1>Native report</h1></html>');
  writeFileSync(path.join(runRoot, 'workflow.yaml'), 'cases: []'); writeFileSync(path.join(runRoot, 'steps', 'steps-0-after.png'), Buffer.from([1, 2, 3]));
  writeFileSync(path.join(runRoot, '.env'), 'MIDSCENE_MODEL_API_KEY=credential'); writeFileSync(path.join(runRoot, 'model.json'), '{"apiKey":"credential"}');
  writeFileSync(path.join(runRoot, 'run-configuration.json'), JSON.stringify({ variables: { libraryName: 'release', apiKey: 'credential', nested: { password: 'credential' } }, model: { name: 'model', apiKey: 'credential' } }));
  const run: HistoryRun = { runId: 'run', projectId: 'project', caseId: 'case', caseName: '<Case>', environment: 'test', startedAt: 'now', status: 'passed', events: [{ type: 'step-started', node: 'gotoUrl', phase: 'steps', index: 0, total: 1 }], result: { runId: 'run', status: 'passed', artifactDirectory: runRoot, reportPaths: [report], startedAt: 'now', finishedAt: 'later', durationMs: 10, runnerVersion: '1.12.4' } };
  return { root, runRoot, report, run };
}
test('portable ZIP includes native report, safe configuration and images without application credentials', async () => {
  const data = fixture();
  const target = await exportRunBundle(data.run, path.join(data.root, 'export.zip'));
  const files = unzipSync(readFileSync(target));
  for (const name of ['index.html', 'summary.json', 'run-configuration.json', 'README.txt', 'events.jsonl', 'workflow.yaml', 'report/native.html', 'steps/steps-0-after.png']) assert.ok(files[name], name);
  assert.equal(files['.env'], undefined); assert.equal(files['model.json'], undefined);
  const configuration = strFromU8(files['run-configuration.json']!); assert.match(configuration, /release/); assert.doesNotMatch(configuration, /credential/);
  assert.match(strFromU8(files['index.html']!), /&lt;Case&gt;/); assert.match(strFromU8(files['index.html']!), /href="report\/native.html"/);
});
test('portable ZIP preserves effective variables separately from the requested run snapshot', async () => {
  const data = fixture();
  const effectiveVariables = { projectOnly: 'project', environmentOnly: 'staging', workflowOnly: 'default', datasetOnly: 'row-a', libraryName: 'runtime-name', apiKey: 'credential' };
  writeFileSync(path.join(data.runRoot, 'run-configuration.json'), JSON.stringify({ variables: effectiveVariables, datasetId: 'a', baseUrl: 'https://staging.example.com' }));
  data.run.snapshot = { environmentId: 'staging', baseUrl: 'https://staging.example.com', variables: { libraryName: 'runtime-name', apiKey: 'credential' }, defaults: { projectOnly: 'project', environmentOnly: 'staging' }, model: { name: 'vision-model', baseUrl: 'https://model.example.com', family: 'openai' }, git: { commit: 'abc123', branch: 'main', dirty: false } };
  const target = await exportRunBundle(data.run, path.join(data.root, 'effective.zip'));
  const configuration = JSON.parse(strFromU8(unzipSync(readFileSync(target))['run-configuration.json']!));
  assert.deepEqual(configuration.variables, { ...effectiveVariables, apiKey: '[REDACTED]' });
  assert.equal(configuration.datasetId, 'a');
  assert.deepEqual(configuration.snapshot.variables, { libraryName: 'runtime-name', apiKey: '[REDACTED]' });
  assert.equal(configuration.snapshot.model.name, 'vision-model');
  assert.equal(configuration.snapshot.git.commit, 'abc123');
  assert.doesNotMatch(JSON.stringify(configuration), /credential/);
});
test('portable ZIP rejects paths outside the run and symbolic link artifacts', async () => {
  const data = fixture();
  const outside = path.join(data.root, 'outside.html'); writeFileSync(outside, 'private');
  await assert.rejects(exportRunBundle({ ...data.run, result: { ...data.run.result!, reportPaths: [outside] } }, path.join(data.root, 'outside.zip')), /超出/);
  const link = path.join(data.runRoot, 'report', 'link.html'); symlinkSync(outside, link);
  await assert.rejects(exportRunBundle({ ...data.run, result: { ...data.run.result!, reportPaths: [link] } }, path.join(data.root, 'link.zip')), /符号链接/);
  await assert.rejects(exportRunBundle(data.run, path.join(data.runRoot, 'output.zip')), /目录之外/);
  await assert.rejects(exportRunBundle({ ...data.run, status: 'running' }, path.join(data.root, 'running.zip')), /运行结束/);
});
