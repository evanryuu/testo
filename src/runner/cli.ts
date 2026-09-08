import { parseArgs } from 'node:util';
import { startRun } from './run.js';

try {
  const { values } = parseArgs({ options: {
    workflow: { type: 'string' }, 'base-url': { type: 'string' },
    artifacts: { type: 'string', default: 'artifacts' },
    channel: { type: 'string' }, headed: { type: 'boolean', default: false },
  } });
  if (!values.workflow || !values['base-url']) {
    throw new Error('Usage: --workflow <web.yaml> --base-url <http(s) URL> [--channel chrome] [--headed]');
  }
  const run = startRun({
    workflowPath: values.workflow, baseUrl: values['base-url'],
    artifactRoot: values.artifacts!, channel: values.channel, headless: !values.headed,
  }, (event) => console.log(JSON.stringify(event)));
  process.once('SIGINT', () => run.cancel());
  process.once('SIGTERM', () => run.cancel());
  const result = await run.result;
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.status === 'passed' ? 0 : result.status === 'cancelled' ? 130 : 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
