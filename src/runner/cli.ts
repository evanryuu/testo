import { parseArgs } from 'node:util';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { startRun } from './run.js';
import { runProject, junitReport } from './project-run.js';
import { validateWorkflow } from '../main/workflow-validation.js';
import { parseWorkflow, validateVariables } from '../shared/workflow-document.js';

async function main(): Promise<void> {
  const { values } = parseArgs({ options: {
    help: { type: 'boolean', short: 'h', default: false },
    workflow: { type: 'string' }, 'base-url': { type: 'string' }, project: { type: 'string' }, environment: { type: 'string' },
    group: { type: 'string', multiple: true }, case: { type: 'string', multiple: true }, tag: { type: 'string', multiple: true },
    variables: { type: 'string' }, dataset: { type: 'string' }, 'all-datasets': { type: 'boolean', default: false },
    'failure-policy': { type: 'string', default: 'stop' }, junit: { type: 'string' }, timeout: { type: 'string' },
    artifacts: { type: 'string', default: 'artifacts' }, channel: { type: 'string' }, headed: { type: 'boolean', default: false },
  } });
  if (values.help) {
    console.log(`Testo CLI

用法：
  npm run run:workflow -- --project <项目目录> --environment <环境 ID 或名称> [选项]
  npm run run:workflow -- --workflow <web.yaml> --base-url <URL> [选项]

项目筛选：
  --group <ID 或名称>      按分组顺序选择，可重复；重复用例只执行一次
  --case <ID 或名称>       选择用例，可重复
  --tag <标签>            筛选已选用例，可重复；匹配任意标签

运行选项：
  --variables <JSON 文件>  设置本次运行的共享变量，优先级最高
  --dataset <ID>          选择一行数据，与 --all-datasets 互斥
  --all-datasets          依次运行每个用例的所有数据行
  --failure-policy <值>   stop（默认）或 continue
  --timeout <秒>          单个用例的最长运行时间
  --artifacts <目录>      产物目录，默认 artifacts
  --junit <XML 文件>      导出 JUnit 结果
  --channel <浏览器>      例如 chrome
  --headed               显示独立浏览器窗口，默认无头运行
  -h, --help             显示帮助

项目目录应包含 workspace.yaml。所有用例串行运行，使用独立浏览器会话。
退出码：0 成功，1 失败，130 取消。`);
    return;
  }
  if (!!values.workflow === !!values.project) throw new Error('请选择 --workflow <web.yaml> --base-url <URL>，或 --project <项目目录> --environment <环境 ID/名称>');
  if (values.dataset && values['all-datasets']) throw new Error('--dataset 与 --all-datasets 不能同时使用');
  if (!['stop', 'continue'].includes(values['failure-policy']!)) throw new Error('--failure-policy 必须是 stop 或 continue');
  const variables = validateVariables(values.variables ? JSON.parse(readFileSync(values.variables, 'utf8')) : {});
  const timeoutMs = values.timeout === undefined ? undefined : Number(values.timeout) * 1000;
  if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) throw new Error('--timeout 必须是正数（秒）');
  const controller = new AbortController();
  const cancel = () => controller.abort(new Error('CLI 运行已取消'));
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  try {
    if (values.project) {
      if (!values.environment) throw new Error('项目运行需要 --environment <环境 ID 或名称>');
      if (values['base-url']) throw new Error('项目运行使用所选环境地址，请不要同时传 --base-url');
      const summary = await runProject({ projectDir: values.project, environment: values.environment, groups: values.group, cases: values.case, tags: values.tag, variables, datasetId: values.dataset, allDatasets: values['all-datasets'], artifactRoot: values.artifacts!, channel: values.channel, headless: !values.headed, failurePolicy: values['failure-policy'] as 'stop' | 'continue', timeoutMs, junit: values.junit }, { signal: controller.signal, onEvent: event => console.log(JSON.stringify(event)) });
      console.log(JSON.stringify(summary, null, 2));
      process.exitCode = summary.status === 'passed' ? 0 : summary.status === 'cancelled' ? 130 : 1;
    } else {
      if (!values['base-url']) throw new Error('单用例运行需要 --base-url <HTTP(S) URL>');
      if (values.environment || values.group || values.case || values.tag) throw new Error('环境/分组/用例/标签筛选需要 --project');
      const source = readFileSync(values.workflow!, 'utf8');
      const definition = parseWorkflow(source);
      const datasets = values['all-datasets'] && definition.testo?.datasets?.length ? definition.testo.datasets.map(item => item.id) : [values.dataset];
      for (const datasetId of datasets) validateWorkflow(source, { variables, datasetId });
      const startedAt = new Date().toISOString();
      const items: Parameters<typeof junitReport>[0]['items'] = [];
      let failed = false;
      for (const datasetId of datasets) {
        if (controller.signal.aborted || (failed && values['failure-policy'] === 'stop')) { items.push({ caseId: 'workflow', caseName: definition.cases[0]!.name ?? 'Workflow', datasetId, definitionHash: '', status: 'skipped' }); continue; }
        const run = startRun({ workflowPath: values.workflow!, workflowText: source, baseUrl: values['base-url'], artifactRoot: values.artifacts!, channel: values.channel, headless: !values.headed, variables, datasetId, timeoutMs }, event => console.log(JSON.stringify(event)));
        const abort = () => run.cancel(); controller.signal.addEventListener('abort', abort, { once: true });
        if (controller.signal.aborted) abort();
        const result = await run.result; controller.signal.removeEventListener('abort', abort);
        items.push({ caseId: 'workflow', caseName: definition.cases[0]!.name ?? 'Workflow', datasetId, datasetName: definition.testo?.datasets?.find(item => item.id === datasetId)?.name, definitionHash: result.definitionHash ?? '', status: result.status, result });
        console.log(JSON.stringify(result, null, 2)); failed ||= result.status !== 'passed';
      }
      if (values.junit) { const file = path.resolve(values.junit); mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, junitReport({ projectName: 'Workflow', environment: values['base-url'], startedAt, items }), { mode: 0o600 }); }
      process.exitCode = controller.signal.aborted ? 130 : failed ? 1 : 0;
    }
  } finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); }
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
