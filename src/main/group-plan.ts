import type { Project } from '../shared/workspace.js';

/** Expand saved groups in selection order; shared cases run once at first occurrence. */
export function expandGroups(project: Project, groupIds: string[]) {
  if (!Array.isArray(groupIds) || !groupIds.length || groupIds.length > 1000 || new Set(groupIds).size !== groupIds.length) throw new Error('请选择 1 至 1000 个不同的 Group');
  const availableGroups = new Map((project.groups ?? []).map(group => [group.id, group]));
  const availableCases = new Map(project.cases.map(item => [item.id, item]));
  const caseIds: string[] = [], groupNames = new Map<string, string[]>();
  const groups = groupIds.map(id => {
    const group = availableGroups.get(id);
    if (!group) throw new Error('所选 Group 不存在或无法读取，请刷新后重试');
    if (!group.caseIds.length) throw new Error(`Group「${group.name}」没有用例，请先添加用例`);
    for (const caseId of group.caseIds) {
      const item = availableCases.get(caseId);
      if (!item) throw new Error(`Group「${group.name}」引用的用例 ${caseId} 已不存在或无法读取，请编辑 Group 修复`);
      if (!item.workflows.some(workflow => workflow.platform === 'web' && workflow.ready)) throw new Error(`Group「${group.name}」中的「${item.name}」没有可运行的 Web Workflow`);
      const names = groupNames.get(caseId);
      if (names) names.push(group.name);
      else { caseIds.push(caseId); groupNames.set(caseId, [group.name]); }
    }
    return { id: group.id, name: group.name };
  });
  if (caseIds.length > 10000) throw new Error('单次运行最多支持 10000 个不同用例，请拆分 Group 运行');
  return { groups, caseIds, groupNames };
}
