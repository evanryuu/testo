import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { collectWorkflowDocument, NodeRegistry, runWorkflowDocument, type WorkflowDocumentExecutionResult } from '@midscene/test';
import { createMidsceneNodes } from '@midscene/test/midscene';
import { createPlaywrightNodes } from '@midscene/test/playwright';
import { PlaywrightAgent } from '@midscene/web/playwright';
import { chromium, type Browser, type BrowserServer, type Page } from 'playwright';
import { createRecordedNodes } from './recorded-nodes.js';
import { RECORDING_VIEWPORT } from '../recording/workflow.js';
import type { RunOptions, WorkerEvent } from './messages.js';

export async function executeWorkflow(
  options: RunOptions,
  artifactDirectory: string,
  signal: AbortSignal,
  emit: (event: WorkerEvent) => void,
): Promise<Extract<WorkerEvent, { type: 'finished' }>> {
  let server: BrowserServer | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let definitionHash: string | undefined;
  let outcome: WorkflowDocumentExecutionResult | undefined;
  const agents = new Map<string, PlaywrightAgent>();
  const reportPaths = new Set<string>();
  const errors: string[] = [];
  let executionFailed = false;
  let cleanupFailed = false;

  const releaseAgent = async (id: string) => {
    const agent = agents.get(id);
    if (!agent) return;
    try {
      await agent.destroy();
      if (agent.reportFile) reportPaths.add(agent.reportFile);
      return agent.reportFile ? { reportPath: agent.reportFile } : undefined;
    } finally {
      agents.delete(id);
    }
  };

  try {
    signal.throwIfAborted();
    const source = await readFile(options.workflowPath, 'utf8');
    definitionHash = createHash('sha256').update(source).digest('hex');
    const snapshot = path.join(artifactDirectory, 'workflow.yaml');
    await writeFile(snapshot, source, { mode: 0o600 });
    const getPage = () => {
      if (!page) throw new Error('Browser is not ready');
      return page;
    };
    const getAgent = (id: string) => {
      let agent = agents.get(id);
      if (!agent) {
        agent = new PlaywrightAgent(getPage(), {
          generateReport: true,
          autoPrintReportMsg: false,
          reportFileName: id,
          outputFormat: 'single-html',
          cache: false,
        });
        agents.set(id, agent);
      }
      return agent;
    };
    const registry = new NodeRegistry([
      ...createRecordedNodes({ getPage, getAgent: (ctx) => getAgent(ctx.scope === 'case' ? ctx.case.runId : ctx.document.documentRunId) }),
      ...createPlaywrightNodes({ getPage, getBaseUrl: () => options.baseUrl }),
      ...createMidsceneNodes({
        agentClass: PlaywrightAgent,
        agentProvider: {
          getAgent,
          releaseAgent,
        },
      }),
    ]);
    // Collect only the selected immutable snapshot, never surrounding case metadata.
    const document = collectWorkflowDocument({
      projectId: 'workspace-web',
      sourcePath: options.workflowPath,
      absolutePath: snapshot,
    }, {
      resolveNode: (name) => registry.get(name),
      variables: { baseUrl: options.baseUrl },
      env: process.env,
    });
    if (document.cases.length !== 1) {
      throw new Error('V0 requires exactly one Case in each platform Workflow');
    }
    signal.throwIfAborted();
    server = await chromium.launchServer({
      host: '127.0.0.1',
      headless: options.headless ?? true,
      channel: options.channel,
      timeout: 20_000,
    });
    const pid = server.process().pid;
    if (!pid) throw new Error('Browser process has no PID');
    emit({ type: 'browser-started', pid });
    signal.throwIfAborted();
    browser = await chromium.connect(server.wsEndpoint());
    const context = await browser.newContext({ viewport: RECORDING_VIEWPORT });
    page = await context.newPage();
    signal.throwIfAborted();
    outcome = await runWorkflowDocument(document, {
      resolveNode: (name) => registry.require(name),
      signal,
      retry: 0,
      defaultTimeoutMs: 30_000,
      shouldStop: () => signal.aborted,
      stopReason: () => 'interrupted',
      onStepStart(info) {
        const step = info.scope === 'case' ? info.case : info.document;
        emit({ type: 'step-started', node: info.node, phase: step.phase, index: step.stepIndex, total: info.stepCount });
      },
      onStepResult(info, result) {
        const error = result.error?.message;
        if (error) errors.push(`${info.node}: ${error}`);
        emit({ type: 'step-finished', node: info.node, phase: result.phase, index: result.stepIndex, status: result.status, durationMs: result.durationMs, ...(error ? { error } : {}) });
      },
    });
    for (const result of [outcome.document, ...outcome.cases.flatMap((item) => item.run ? [item.run] : [])]) {
      for (const report of result.reportPaths ?? []) reportPaths.add(report);
    }
  } catch (error) {
    executionFailed = true;
    errors.push(error instanceof Error ? error.message : String(error));
  } finally {
    for (const id of agents.keys()) {
      try { await releaseAgent(id); }
      catch (error) { cleanupFailed = true; errors.push(`Report cleanup failed: ${String(error)}`); }
    }
    try {
      if (browser) await browser.close();
    } catch (error) {
      cleanupFailed = true;
      errors.push(`Browser connection cleanup failed: ${String(error)}`);
    } finally {
      if (server) {
        try { await server.close(); emit({ type: 'browser-closed' }); }
        catch (error) { cleanupFailed = true; errors.push(`Browser process cleanup failed: ${String(error)}`); }
      }
    }
  }
  const status = cleanupFailed ? 'error'
    : signal.aborted ? 'cancelled'
    : executionFailed || !outcome ? 'error'
    : outcome.document.status !== 'success' || outcome.cases.some((item) => item.status !== 'success') ? 'failed'
    : 'passed';
  return { type: 'finished', status, reportPaths: [...reportPaths], definitionHash, ...(errors.length ? { error: errors.join('\n') } : {}) };
}
