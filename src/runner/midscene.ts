import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { collectWorkflowDocument, NodeRegistry, runWorkflowDocument, type WorkflowDocumentExecutionResult } from '@midscene/test';
import { createMidsceneNodes } from '@midscene/test/midscene';
import { z } from 'zod/v4';
import { createPlaywrightNodes, gotoUrlInputSchema } from '@midscene/test/playwright';
import { PlaywrightAgent } from '@midscene/web/playwright';
import { chromium, type Browser, type BrowserServer, type Page } from 'playwright';
import { createChromeBridge, connectChrome, pinChromeViewport } from '../recording/chrome-bridge.js';
import { createBridgeNodes } from './bridge-nodes.js';
import { waitForStableViewport } from '../recording/viewport.js';
import { captureActionEvidence } from './evidence.js';
import { describeRunStep } from '../shared/run-steps.js';
import { createWaitNodes } from './wait-nodes.js';
import { createRecordedNodes } from './recorded-nodes.js';
import { RECORDING_VIEWPORT } from '../recording/workflow.js';
import type { RunOptions, WorkerEvent } from './messages.js';

export async function executeWorkflow(
  options: RunOptions,
  artifactDirectory: string,
  signal: AbortSignal,
  emit: (event: WorkerEvent) => void,
): Promise<Extract<WorkerEvent, { type: 'finished' }>> {
  let bridgeAgent: ReturnType<typeof createChromeBridge> | undefined;
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
      if (options.chromeTarget) {
        if (!bridgeAgent) throw new Error('Chrome 尚未连接');
        return bridgeAgent;
      }
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
      ...createWaitNodes(ctx => getAgent(ctx.scope === 'case' ? ctx.case.runId : ctx.document.documentRunId)),
      ...createRecordedNodes({ ...(options.chromeTarget ? { prepareViewport: (size, signal) => pinChromeViewport(bridgeAgent!, size, signal) } : { getPage }), onAction: async (ctx, agent, stage) => {
        const step = ctx.scope === 'case' ? ctx.case : ctx.document;
        emit(await captureActionEvidence(agent, options.chromeTarget ? undefined : getPage, artifactDirectory, ctx.input, step.phase, step.stepIndex, stage));
      }, getAgent: (ctx) => getAgent(ctx.scope === 'case' ? ctx.case.runId : ctx.document.documentRunId) }),
      ...(options.chromeTarget ? createBridgeNodes(() => { if (!bridgeAgent) throw new Error('Chrome 尚未连接'); return bridgeAgent; }, options.baseUrl) : createPlaywrightNodes({ getPage, getBaseUrl: () => options.baseUrl }).map(node => node.name === 'gotoUrl' ? { ...node, inputSchema: gotoUrlInputSchema.extend({ timeoutMs: z.number().positive().default(20000) }) } : node)).map(node => node.name !== 'gotoUrl' ? node : {
        ...node,
        async execute(ctx: any) {
          const result = await node.execute(ctx);
          await waitForStableViewport(() => options.chromeTarget ? bridgeAgent!.interface.size() : getPage().evaluate(() => ({ width: innerWidth, height: innerHeight })), { signal: ctx.signal });
          return result;
        },
      }),
      ...createMidsceneNodes({
        agentClass: PlaywrightAgent,
        agentProvider: {
          getAgent,
          releaseAgent: options.chromeTarget ? undefined : releaseAgent,
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
    // Keep explicit per-step limits; otherwise allow navigation to report its own
    // timeout and finish cleanup before the workflow deadline fires.
    for (const step of [...Object.values(document.lifecycle).flat(), ...document.cases.flatMap(item => item.definition.steps)]) {
      if (step.node === 'aiWaitFor' && step.meta.timeoutMs === undefined) step.meta.timeoutMs = (typeof step.input.timeoutMs === 'number' ? step.input.timeoutMs : 60000) + 1000;
      if (step.node === 'gotoUrl' && step.meta.timeoutMs === undefined) {
        step.meta.timeoutMs = (typeof step.input.timeoutMs === 'number' ? step.input.timeoutMs : 20000) + 7000;
      }
    }
    emit({ type: 'steps-planned', steps: [
      ...document.lifecycle.beforeAll.map((step, index) => describeRunStep(step.node, step.input, 'beforeAll', index)),
      ...document.lifecycle.beforeEach.map((step, index) => describeRunStep(step.node, step.input, 'beforeEach', index)),
      ...document.cases[0]!.definition.steps.map((step, index) => describeRunStep(step.node, step.input, 'steps', index)),
      ...document.lifecycle.afterEach.map((step, index) => describeRunStep(step.node, step.input, 'afterEach', index)),
      ...document.lifecycle.afterAll.map((step, index) => describeRunStep(step.node, step.input, 'afterAll', index)),
    ] });
    signal.throwIfAborted();
    if (options.chromeTarget) {
      bridgeAgent = createChromeBridge('chrome-session', options.chromeTarget.profile?.port);
      await connectChrome(bridgeAgent, new URL(options.baseUrl).origin, options.chromeTarget);
      await waitForStableViewport(() => bridgeAgent!.interface.size(), { signal });
    } else {
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
    }
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
    if (bridgeAgent) {
      try { await bridgeAgent.destroy(); if (bridgeAgent.reportFile) reportPaths.add(bridgeAgent.reportFile); }
      catch (error) { cleanupFailed = true; errors.push(`Chrome 断开连接失败：${String(error)}`); }
    }
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
