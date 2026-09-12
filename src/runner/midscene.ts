import { compileWorkflow } from '../shared/workflow-document.js';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { collectWorkflowDocument, NodeRegistry, runWorkflowDocument, type WorkflowDocumentExecutionResult } from '@midscene/test';
import { createMidsceneNodes, waitInputSchema as nativeWaitSchema } from '@midscene/test/midscene';
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
import type { RunOptions, WorkerEvent, WaitMetric } from './messages.js';

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
  const checks: WaitMetric[] = [];

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
    const source = options.workflowText ?? await readFile(options.workflowPath, 'utf8');
    const compiled = compileWorkflow(source, options);
    definitionHash = createHash('sha256').update(source).digest('hex');
    await writeFile(path.join(artifactDirectory, 'workflow.yaml'), source, { mode: 0o600 });
    const snapshot = path.join(artifactDirectory, 'compiled-workflow.yaml');
    await writeFile(snapshot, compiled.text, { mode: 0o600 });
    await writeFile(path.join(artifactDirectory, 'run-configuration.json'), JSON.stringify({ baseUrl: options.baseUrl, variables: compiled.variables, datasetId: options.datasetId, debug: options.debug, sharedFlows: options.flows, definitionHash, model: { name: process.env.MIDSCENE_MODEL_NAME, family: process.env.MIDSCENE_MODEL_FAMILY, baseUrl: process.env.MIDSCENE_MODEL_BASE_URL ?? process.env.OPENAI_BASE_URL } }, null, 2), { mode: 0o600 });
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
      ...createWaitNodes(ctx => getAgent(ctx.scope === 'case' ? ctx.case.runId : ctx.document.documentRunId), { ...(options.chromeTarget ? {} : { getPage }), onProgress: event => {
        const metric = compiled.stepMetadata[`${event.phase}:${event.index}`]?.metric;
        emit({ ...event, ...(metric ? { metric } : {}) });
        if (event.status === 'passed' || event.status === 'failed') checks.push({ phase: event.phase, index: event.index, ...(metric ? { metric } : {}), elapsedMs: event.elapsedMs, modelCalls: event.modelCalls, status: event.status });
      } }),
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
      variables: { ...compiled.variables, baseUrl: options.baseUrl, baseOrigin: new URL(options.baseUrl).origin },
      env: process.env,
    });
    if (document.cases.length !== 1) {
      throw new Error('V0 requires exactly one Case in each platform Workflow');
    }
    // Keep explicit per-step limits; otherwise allow navigation to report its own
    // timeout and finish cleanup before the workflow deadline fires.
    for (const step of [...Object.values(document.lifecycle).flat(), ...document.cases.flatMap(item => item.definition.steps)]) {
      if (['aiWaitFor', 'waitForElement'].includes(step.node) && step.meta.timeoutMs === undefined) step.meta.timeoutMs = (typeof step.input.timeoutMs === 'number' ? step.input.timeoutMs : 60000) + 1000;
      if (step.node === 'wait' && step.meta.timeoutMs === undefined) {
        const input = nativeWaitSchema.parse(step.input);
        step.meta.timeoutMs = input.duration * (input.unit === 'min' ? 60000 : input.unit === 's' ? 1000 : 1) + 1000;
      }
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
    ].map(step => ({ ...step, ...(compiled.stepMetadata[`${step.phase}:${step.index}`]?.name ? { title: compiled.stepMetadata[`${step.phase}:${step.index}`]!.name! } : {}), ...(compiled.stepMetadata[`${step.phase}:${step.index}`]?.metric ? { metric: compiled.stepMetadata[`${step.phase}:${step.index}`]!.metric } : {}) })) });
    signal.throwIfAborted();
    if (options.chromeTarget) {
      bridgeAgent = createChromeBridge('chrome-session', options.chromeTarget.profile?.port);
      await connectChrome(bridgeAgent, new URL(options.baseUrl).origin, options.chromeTarget);
      await waitForStableViewport(() => bridgeAgent!.interface.size(), { signal });
      emit({ type: 'diagnostic', kind: 'capability', message: 'Chrome Bridge 当前不提供网络与控制台事件订阅；此运行保留步骤截图、目标检查和等待记录', at: new Date().toISOString() });
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
    const diagnostic = (kind: 'network' | 'console' | 'pageerror', message: string, url?: string) => emit({ type: 'diagnostic', kind, message: message.slice(0, 2000), ...(url ? { url } : {}), at: new Date().toISOString() });
    context.on('requestfailed', request => diagnostic('network', `${request.method()} ${request.failure()?.errorText ?? 'request failed'}`, request.url()));
    context.on('response', response => { if (response.status() >= 400) diagnostic('network', `HTTP ${response.status()}`, response.url()); });
    context.on('page', newPage => { newPage.on('pageerror', error => diagnostic('pageerror', error.message, newPage.url())); newPage.on('console', message => { if (['error', 'warning'].includes(message.type())) diagnostic('console', message.text(), newPage.url()); }); });
    page.on('pageerror', error => diagnostic('pageerror', error.message, page!.url()));
    page.on('console', message => { if (['error', 'warning'].includes(message.type())) diagnostic('console', message.text(), page!.url()); });
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
  return { type: 'finished', status, checks, reportPaths: [...reportPaths], definitionHash, ...(errors.length ? { error: errors.join('\n') } : {}) };
}
