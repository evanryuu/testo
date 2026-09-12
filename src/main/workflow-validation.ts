import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { collectWorkflowDocument, NodeRegistry } from '@midscene/test';
import { createMidsceneNodes } from '@midscene/test/midscene';
import { createPlaywrightNodes } from '@midscene/test/playwright';
import { PlaywrightAgent } from '@midscene/web/playwright';
import { createBridgeNodes } from '../runner/bridge-nodes.js';
import { createWaitNodes } from '../runner/wait-nodes.js';
import { createRecordedNodes } from '../runner/recorded-nodes.js';
import { compileWorkflow } from '../shared/workflow-document.js';

export function validateWorkflow(text: string, options: Parameters<typeof compileWorkflow>[1] = {}, editing = false, bridge = false) {
  const compiled = compileWorkflow(text, options);
  const variables = { ...compiled.variables, baseUrl: 'http://localhost', baseOrigin: 'http://localhost' };
  if (editing) for (const match of compiled.text.matchAll(/\$\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g)) {
    if (!(match[1]! in variables)) Object.assign(variables, { [match[1]!]: 'parameter' });
  }
  const directory = mkdtempSync(path.join(tmpdir(), 'testo-validate-'));
  const file = path.join(directory, 'workflow.yaml');
  try {
    writeFileSync(file, compiled.text, { mode: 0o600 });
    const unavailable = (): never => { throw new Error('校验阶段不能操作浏览器'); };
    const midsceneNodes = createMidsceneNodes({ agentClass: PlaywrightAgent, getAgent: unavailable });
    const modelNodes = new Set(midsceneNodes.filter(node => node.name.startsWith('ai')).map(node => node.name));
    modelNodes.add('aiWaitFor');
    const registry = new NodeRegistry([
      ...(bridge ? createBridgeNodes(unavailable, 'http://localhost') : createPlaywrightNodes({ getPage: unavailable })),
      ...createRecordedNodes({ getPage: unavailable, getAgent: unavailable }),
      ...createWaitNodes(unavailable),
      ...midsceneNodes,
    ]);
    const document = collectWorkflowDocument({ projectId: 'validation', sourcePath: file, absolutePath: file }, {
      resolveNode: name => registry.get(name), variables, env: process.env,
    });
    if (document.cases.length !== 1) throw new Error('每个平台 Workflow 必须只包含一个 Case');
    const executableSteps = [...Object.values(document.lifecycle).flat(), ...document.cases.flatMap(item => item.definition.steps)];
    const needsModel = executableSteps.some(step => modelNodes.has(step.node));
    // Collection resolves variables and normalizes metadata; input schemas are normally deferred until execution.
    // While editing, unresolved runtime parameters have placeholder values and cannot be checked for type yet.
    if (!editing || !/\$\{/.test(compiled.text)) {
      for (const step of executableSteps) {
        const node = registry.get(step.node)!;
        try { node.inputSchema?.parse(step.input); }
        catch (error) { throw new Error(`${step.node} 参数无效：${error instanceof Error ? error.message : String(error)}`); }
      }
    }
    return { compiled, steps: document.cases[0]!.definition.steps.length, needsModel };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}


/** Midscene 1.12.4 requires the default name even when intent-specific models are configured. */
export function assertWorkflowModel(validation: Pick<ReturnType<typeof validateWorkflow>, 'needsModel'>, modelName: string | undefined): void {
  if (validation.needsModel && !modelName?.trim()) throw new Error('此用例包含 AI 步骤，请先配置模型名称（MIDSCENE_MODEL_NAME）');
}
