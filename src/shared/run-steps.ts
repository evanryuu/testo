export interface RunStepInfo {
  node: string; phase: string; index: number; title: string; detail?: string;
  point?: { x: number; y: number }; viewport?: { width: number; height: number };
}
export function describeRunStep(node: string, input: any, phase: string, index: number): RunStepInfo {
  const step: RunStepInfo = { node, phase, index, title: node };
  if (node === 'recordedAction') {
    const p = input?.payload ?? {};
    const names: Record<string, string> = { Tap: '点击', Input: p.mode === 'clear' ? '清空输入框' : '输入文字', KeyboardPress: '按键', Scroll: '滚动', DragAndDrop: '拖动' };
    step.title = names[input?.actionType] ?? '录制操作';
    if (typeof p.x === 'number' && typeof p.y === 'number') { step.point = { x: p.x, y: p.y }; step.title += `（${p.x}, ${p.y}）`; }
    step.viewport = input?.viewport ?? { width: 1280, height: 800 };
    if (input?.actionType === 'Input') step.detail = p.mode === 'clear' ? '清除目标输入框内容' : String(p.value ?? '');
    if (input?.actionType === 'KeyboardPress') step.detail = String(p.keyName ?? '');
    if (input?.actionType === 'Scroll') step.detail = `${p.direction ?? ''} ${p.distance ?? ''}`.trim();
    if (input?.actionType === 'DragAndDrop') step.detail = `拖动至（${p.endX}, ${p.endY}）`;
  } else if (node === 'gotoUrl') { step.title = '打开页面'; step.detail = typeof input === 'string' ? input : input?.url; }
  else if (node === 'requireViewport' || node === 'setViewportSize') { step.title = '准备回放尺寸'; step.detail = `${input?.width} × ${input?.height}`; }
  else if (node === 'aiAct') { step.title = 'AI 操作'; step.detail = typeof input === 'string' ? input : input?.prompt; }
  else if (node === 'aiAssert' || node === 'assertText') { step.title = '检查预期结果'; step.detail = typeof input === 'string' ? input : input?.prompt ?? input?.assertion ?? input?.text; }
  else if (node === 'aiWaitFor') { step.title = '等待预期状态'; step.detail = typeof input === 'string' ? input : `${input?.prompt ?? input?.assertion ?? ''}（最多等待 ${(input?.timeoutMs ?? 60000) / 1000} 秒）`; }
  else if (node === 'recordToReport') step.title = '保存运行报告';
  return step;
}
export function runPlanFromYaml(document: any): RunStepInfo[] {
  const steps: RunStepInfo[] = [];
  for (const [phase, entries] of Object.entries({ beforeAll: document?.beforeAll, beforeEach: document?.beforeEach, steps: document?.cases?.[0]?.steps, afterEach: document?.afterEach, afterAll: document?.afterAll })) {
    if (!Array.isArray(entries)) continue;
    entries.forEach((entry, index) => {
      const node = entry && typeof entry === 'object' ? Object.keys(entry).find(key => key !== '$') : undefined;
      if (node) steps.push(describeRunStep(node, entry[node], phase, index));
    });
  }
  return steps;
}
