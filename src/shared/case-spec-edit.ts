import { caseSpecSchema, type CaseSpec, type CaseIssue } from './case-spec.js';

function checked(input: CaseSpec): CaseSpec {
  const spec = caseSpecSchema.parse(input);
  const ids = new Set<string>();
  for (const step of spec.steps) {
    if (!step.id || ids.has(step.id)) throw new Error(`用例「${spec.title}」存在空的或重复的步骤 ID，请先修正`);
    ids.add(step.id);
  }
  for (const expectation of spec.expectations) if (expectation.afterStepId && !ids.has(expectation.afterStepId)) throw new Error(`用例「${spec.title}」的预期结果引用了不存在的步骤：${expectation.afterStepId}`);
  return spec;
}

function allocator() {
  const used = new Set<string>();
  return (requested: string): string => {
    const base = requested || 'item';
    let candidate = base, suffix = 1;
    while (used.has(candidate)) { const end = `-${suffix++}`; candidate = base.slice(0, 500 - end.length) + end; }
    used.add(candidate);
    return candidate;
  };
}

/** Give every embedded item a unique ID and update assertion references together. */
function uniqueItems(spec: CaseSpec, allocate = allocator()): void {
  const stepIds = new Map<string, string>();
  for (const step of spec.steps) { const previous = step.id; step.id = allocate(previous); stepIds.set(previous, step.id); }
  for (const precondition of spec.preconditions) precondition.id = allocate(precondition.id);
  for (const expectation of spec.expectations) {
    expectation.id = allocate(expectation.id);
    if (expectation.afterStepId) expectation.afterStepId = stepIds.get(expectation.afterStepId)!;
  }
  const questionCode = allocator();
  for (const question of spec.questions) question.code = questionCode(question.code);
}

function review(code: string, message: string): CaseIssue { return { code, message, blocks: 'generation' }; }

/** at is the zero-based first step of the second case. Neither input nor source references are mutated. */
export function splitCaseSpec(input: CaseSpec, at: number, newId: string): [CaseSpec, CaseSpec] {
  const spec = checked(input);
  if (!Number.isInteger(at) || at <= 0 || at >= spec.steps.length) throw new Error('拆分位置必须位于两个操作步骤之间');
  if (!newId.trim() || newId.length > 100 || newId === spec.id) throw new Error('拆分后的用例必须使用不同的有效 ID');
  const first = structuredClone(spec), second = structuredClone(spec);
  first.steps = first.steps.slice(0, at);
  second.steps = second.steps.slice(at);
  second.id = newId;
  first.origin = 'manual'; second.origin = 'manual';
  const firstIds = new Set(first.steps.map(step => step.id));
  first.expectations = first.expectations.filter(expectation => expectation.afterStepId && firstIds.has(expectation.afterStepId));
  second.expectations = second.expectations.filter(expectation => !expectation.afterStepId || !firstIds.has(expectation.afterStepId));
  const allocate = allocator();
  for (const [index, part] of [first, second].entries()) {
    for (const precondition of part.preconditions) if (precondition.kind === 'manual') precondition.acknowledged = false;
    part.questions.push(
      review('split-preconditions-review', `请审核拆分后第 ${index + 1} 段的前置条件：原条件已保留，第二段是否需要第一段产生的状态必须由用户确认，系统不会自动补写准备操作。`),
      review('split-expectations-review', `请审核拆分后第 ${index + 1} 段的预期结果：按指定步骤归属分配断言，原先在全部操作后检查的结果归入第二段。${part.expectations.length ? '请确认这些断言仍能证明本段测试目的。' : '本段没有预期结果，请补充后再生成。'}`),
    );
    uniqueItems(part, allocate);
  }
  return [caseSpecSchema.parse(first), caseSpecSchema.parse(second)];
}

/** Cases and their steps follow input order. Final assertions become attached to each original case's last step. */
export function mergeCaseSpecs(inputs: CaseSpec[]): CaseSpec {
  if (inputs.length < 2) throw new Error('请选择至少两个用例进行合并');
  const specs = inputs.map(checked), first = specs[0]!;
  const merged: CaseSpec = { ...structuredClone(first), origin: 'manual', description: specs.map(spec => `${spec.title}${spec.sourceId ? ` [${spec.sourceId}]` : ''}${spec.description ? `\n${spec.description}` : ''}`).join('\n\n'), preconditions: [], data: [], steps: [], expectations: [], questions: [], tags: [...new Set(specs.flatMap(spec => spec.tags))], priority: specs.map(spec => spec.priority).sort()[0]! };
  // A combined case no longer corresponds to a single source case ID; original IDs remain in the description.
  delete merged.sourceId;
  merged.path = first.path.filter((segment, index) => specs.every(spec => spec.path[index] === segment && spec.path.slice(0, index).every((part, parent) => part === first.path[parent])));
  const allocate = allocator(), dataValues = new Map<string, Set<string>>();
  for (const [caseIndex, spec] of specs.entries()) {
    const stepIds = new Map<string, string>();
    for (const step of spec.steps) {
      const copy = structuredClone(step);
      copy.id = allocate(copy.id);
      stepIds.set(step.id, copy.id);
      merged.steps.push(copy);
    }
    for (const precondition of spec.preconditions) {
      const copy = structuredClone(precondition); copy.id = allocate(copy.id);
      if (copy.kind === 'manual') copy.acknowledged = false;
      merged.preconditions.push(copy);
    }
    for (const expectation of spec.expectations) {
      const copy = structuredClone(expectation); copy.id = allocate(copy.id);
      const originalStep = expectation.afterStepId ?? spec.steps.at(-1)?.id;
      if (originalStep) copy.afterStepId = stepIds.get(originalStep)!;
      else merged.questions.push(review(`merge-empty-case-${caseIndex}`, `原用例「${spec.title}」没有操作步骤，其预期结果没有可确定的检查时机，请补充对应步骤和断言时机。`));
      merged.expectations.push(copy);
    }
    if (!spec.expectations.length) merged.questions.push(review(`merge-missing-expectation-${caseIndex}`, `原用例「${spec.title}」没有预期结果，请补充该用例对应的断言，不能用其他用例的结果代替。`));
    for (const data of spec.data) {
      merged.data.push(structuredClone(data));
      const values = dataValues.get(data.name) ?? new Set<string>(); values.add(data.value); dataValues.set(data.name, values);
    }
    merged.questions.push(...structuredClone(spec.questions));
  }
  for (const [name, values] of dataValues) if (values.size > 1) merged.questions.push(review(`merge-data-conflict-${merged.questions.length}`, `测试数据「${name}」存在 ${values.size} 个不同值；所有原值与来源均已保留，请明确每个值适用的步骤或统一数据后再生成。`));
  merged.questions.push(review('merge-preconditions-review', '请审核合并后的前置条件及执行顺序：各原用例的准备条件均已保留，但后续用例的准备是否应在对应步骤前执行需要用户确认。请同时核对原用例末尾断言的检查时机。'));
  const questionCode = allocator();
  for (const question of merged.questions) question.code = questionCode(question.code);
  return caseSpecSchema.parse(merged);
}
