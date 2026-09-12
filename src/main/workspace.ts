import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parse, stringify } from 'yaml';
import { validateVariables, compileWorkflow } from '../shared/workflow-document.js';
import type { ProjectAssets } from '../shared/workspace.js';
import type { BulkCaseInput, BulkCaseResult, Environment, Project, SaveGroupInput, Suite, TestCase, TestGroup, Workflow } from '../shared/workspace.js';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const required = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label}不能为空`);
  return value.trim();
};
const inside = (root: string, candidate: string) => {
  const relative = path.relative(root, candidate);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('文件路径不能超出项目目录');
};
function fileIn(root: string, relative: string): string {
  const file = path.resolve(root, relative);
  inside(root, file);
  let existing = file;
  while (!existsSync(existing)) existing = path.dirname(existing);
  inside(realpathSync(root), realpathSync(existing));
  return file;
}
function writeAtomic(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temporary, typeof value === 'string' ? value : stringify(value), { mode: 0o600 });
  renameSync(temporary, file);
}
function readYaml(file: string): any {
  const value = parse(readFileSync(file, 'utf8'), { uniqueKeys: true, maxAliasCount: 50 });
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('YAML 必须是一个对象');
  return value;
}

export class WorkspaceStore {
  private roots: string[];
  private caseIndexes = new WeakMap<Project, Map<string, string>>();
  private workflowIndexes = new WeakMap<Project, Map<string, { file: string; platform: string; caseFile: string; caseRevision: string }>>();
  constructor(private dataDir: string, private projectsDir: string) {
    mkdirSync(dataDir, { recursive: true });
    const recent = path.join(dataDir, 'projects.json');
    this.roots = existsSync(recent) ? JSON.parse(readFileSync(recent, 'utf8')) : [];
  }
  private register(root: string): string {
    const project = this.readProject(root);
    if (!this.roots.includes(root)) {
      if (this.roots.some((existing) => { try { return this.readProject(existing).id === project.id; } catch { return false; } })) throw new Error('已打开具有相同 ID 的项目');
      this.roots.push(root);
      writeAtomic(path.join(this.dataDir, 'projects.json'), JSON.stringify(this.roots));
    }
    return project.id;
  }
  open(root: string): string { return this.register(realpathSync(root)); }
  list(): { projects: Project[]; errors: string[] } {
    const projects: Project[] = [], errors: string[] = [];
    for (const root of this.roots) {
      try { projects.push(this.readProject(root)); }
      catch (error) { errors.push(`${root}: ${String(error)}`); }
    }
    return { projects, errors };
  }
  project(id: string): Project {
    const project = this.list().projects.find((item) => item.id === id);
    if (!project) throw new Error('项目不存在或项目文件无法读取');
    return project;
  }
  create(name: string, description: string): string {
    name = required(name, '项目名称');
    const id = randomUUID();
    const root = path.resolve(this.projectsDir, id);
    mkdirSync(root, { recursive: true });
    const suiteId = randomUUID();
    writeAtomic(path.join(root, 'workspace.yaml'), { schemaVersion: 1, project: { id, name, description }, suites: [{ id: suiteId, name: 'General', directory: 'cases/general' }] });
    writeAtomic(path.join(root, 'environments/local.yaml'), { id: randomUUID(), name: 'Local', web: { baseUrl: 'http://localhost:3000' } });
    return this.register(root);
  }
  private readProject(root: string): Project {
    const config = readYaml(fileIn(root, 'workspace.yaml'));
    if (config.schemaVersion !== 1 || !Array.isArray(config.suites)) throw new Error('不支持的 workspace.yaml 格式');
    const suites: Suite[] = config.suites.map((s: any) => ({ id: required(s.id, 'Suite ID'), name: required(s.name, 'Suite 名称'), directory: required(s.directory, 'Suite 目录') }));
    if (new Set(suites.map((s) => s.id)).size !== suites.length || new Set(suites.map((s) => s.directory)).size !== suites.length) throw new Error('Suite ID 或目录重复');
    const cases: TestCase[] = [], environments: Environment[] = [], errors: string[] = [];
    const caseIds = new Set<string>();
    const caseIndex = new Map<string, string>();
    const workflowIndex = new Map<string, { file: string; platform: string; caseFile: string; caseRevision: string }>();
    for (const suite of suites) {
      const directory = fileIn(root, suite.directory);
      if (!existsSync(directory)) continue;
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        try {
          const caseFile = fileIn(root, path.join(suite.directory, entry.name, 'case.yaml'));
          const text = readFileSync(caseFile, 'utf8'), item = readYaml(caseFile);
          if (item.schemaVersion !== 1 || item.suiteId !== suite.id) throw new Error('Case 版本或 Suite 关联错误');
          const id = required(item.id, 'Case ID');
          if (caseIds.has(id)) throw new Error('Case ID 重复');
          const workflows: Workflow[] = (item.workflows ?? []).map((w: any) => {
            if (!['web', 'android', 'ios'].includes(w.platform)) throw new Error('不支持的平台');
            const definitionPath = required(w.definitionPath, 'Workflow 路径');
            const file = fileIn(root, path.join(suite.directory, entry.name, definitionPath));
            return { id: required(w.id, 'Workflow ID'), platform: w.platform, definitionPath, ready: existsSync(file) };
          });
          if (new Set(workflows.map((w) => w.id)).size !== workflows.length || new Set(workflows.map((w) => w.platform)).size !== workflows.length) throw new Error('Workflow ID 或平台重复');
          if (!Array.isArray(item.tags) || !item.tags.every((t: unknown) => typeof t === 'string')) throw new Error('Tags 格式错误');
          cases.push({ id, name: required(item.name, 'Case 名称'), description: item.description ?? '', suiteId: suite.id, priority: item.priority ?? 'P1', tags: item.tags, workflows, revision: hash(text) });
          caseIds.add(id);
          caseIndex.set(id, caseFile);
          for (const workflow of workflows) workflowIndex.set(JSON.stringify([id, workflow.id]), { file: fileIn(root, path.join(suite.directory, entry.name, workflow.definitionPath)), platform: workflow.platform, caseFile, caseRevision: hash(text) });
        } catch (error) { errors.push(`${suite.name}/${entry.name}: ${String(error)}`); }
      }
    }
    const envDir = fileIn(root, 'environments');
    if (existsSync(envDir)) for (const name of readdirSync(envDir).filter((name) => /\.ya?ml$/.test(name))) {
      try {
        const e = readYaml(fileIn(root, `environments/${name}`));
        const id = required(e.id, 'Environment ID');
        if (environments.some((env) => env.id === id)) throw new Error('Environment ID 重复');
        environments.push({ id, name: required(e.name, '环境名称'), web: { baseUrl: required(e.web?.baseUrl, '环境地址') }, variables: validateVariables(e.variables ?? {}) });
      } catch (error) { errors.push(`${name}: ${String(error)}`); }
    }
    const groups: TestGroup[] = [];
    try {
      const directory = fileIn(root, 'groups');
      if (existsSync(directory)) for (const name of readdirSync(directory).filter(name => name.endsWith('.yaml'))) {
        try {
          const file = fileIn(root, `groups/${name}`), text = readFileSync(file, 'utf8'), value = readYaml(file);
          const id = this.groupId(value.id);
          if (value.schemaVersion !== 1 || name !== `${id}.yaml`) throw new Error('Group 版本或文件名与 ID 不匹配');
          if (typeof value.description !== 'string') throw new Error('Group 描述必须是文本');
          const references = this.groupCaseIds(value.caseIds);
          groups.push({ id, name: required(value.name, 'Group 名称'), description: value.description, caseIds: references, revision: hash(text) });
          const missing = references.filter(id => !caseIds.has(id));
          if (missing.length) errors.push(`${name}: Group 引用了 ${missing.length} 个不存在的用例，请编辑修复`);
        } catch (error) { errors.push(`groups/${name}: ${String(error)}`); }
      }
    } catch (error) { errors.push(`groups: ${String(error)}`); }
    const project: Project = { id: required(config.project?.id, 'Project ID'), name: required(config.project?.name, '项目名称'), description: config.project.description ?? '', root, suites, cases, environments, groups, errors, assets: this.readAssets(root) };
    this.workflowIndexes.set(project, workflowIndex);
    this.caseIndexes.set(project, caseIndex);
    return project;
  }
  private groupId(value: unknown): string {
    const id = required(value, 'Group ID');
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(id)) throw new Error('Group ID 格式错误');
    return id;
  }
  private groupCaseIds(value: unknown): string[] {
    if (!Array.isArray(value) || value.some(id => typeof id !== 'string' || !id.trim())) throw new Error('Group 用例引用格式错误');
    if (new Set(value).size !== value.length) throw new Error('Group 用例引用重复');
    return [...value];
  }
  saveGroup(input: SaveGroupInput): string {
    const project = this.project(input.projectId);
    const id = input.id === undefined ? randomUUID() : this.groupId(input.id);
    const file = fileIn(project.root, `groups/${id}.yaml`);
    if (input.id !== undefined) {
      if (!existsSync(file)) throw new Error('Group 不存在');
      if (hash(readFileSync(file, 'utf8')) !== input.revision) throw new Error('Group 已被外部修改，请重新加载后再保存');
    }
    const caseIds = this.groupCaseIds(input.caseIds);
    const available = new Set(project.cases.map(item => item.id));
    if (caseIds.some(caseId => !available.has(caseId))) throw new Error('Group 引用了不存在的用例，请重新选择');
    if (typeof input.description !== 'string') throw new Error('Group 描述必须是文本');
    writeAtomic(file, { schemaVersion: 1, id, name: required(input.name, 'Group 名称'), description: input.description, caseIds });
    return id;
  }
  deleteGroup(projectId: string, id: string, revision: string): void {
    const project = this.project(projectId);
    const file = fileIn(project.root, `groups/${this.groupId(id)}.yaml`);
    if (!existsSync(file)) throw new Error('Group 不存在');
    if (hash(readFileSync(file, 'utf8')) !== revision) throw new Error('Group 已被外部修改，请重新加载后再删除');
    unlinkSync(file);
  }
  workflowLocationFromProject(project: Project, caseId: string, workflowId: string): { file: string; platform: string } {
    const location = this.workflowIndexes.get(project)?.get(JSON.stringify([caseId, workflowId]));
    if (!location) throw new Error('Workflow 不存在或项目快照已失效，请重新加载');
    const caseFile = fileIn(project.root, path.relative(project.root, location.caseFile));
    if (!existsSync(caseFile) || hash(readFileSync(caseFile, 'utf8')) !== location.caseRevision) throw new Error('排队期间用例定义已修改，请重新加载后再运行');
    return { file: fileIn(project.root, path.relative(project.root, location.file)), platform: location.platform };
  }
  createSuite(projectId: string, name: string): string {
    const p = this.project(projectId), file = fileIn(p.root, 'workspace.yaml'), config = readYaml(file);
    const id = randomUUID();
    config.suites.push({ id, name: required(name, 'Suite 名称'), directory: `cases/${id}` });
    writeAtomic(file, config); return id;
  }
  createCase(projectId: string, name: string, suiteId: string, platforms: string[]): string {
    const p = this.project(projectId), suite = p.suites.find((s) => s.id === suiteId);
    if (!suite) throw new Error('请选择有效的 Suite');
    if (!Array.isArray(platforms) || !platforms.length || platforms.some((v) => !['web', 'android', 'ios'].includes(v))) throw new Error('请选择平台');
    const id = randomUUID();
    writeAtomic(fileIn(p.root, `${suite.directory}/${id}/case.yaml`), { schemaVersion: 1, id, name: required(name, '用例名称'), description: '', suiteId, priority: 'P1', tags: [], workflows: [...new Set(platforms)].map((platform) => ({ id: randomUUID(), platform, definitionPath: `${platform}.yaml` })) });
    return id;
  }
  caseLocation(projectId: string, caseId: string): { project: Project; item: TestCase; file: string } {
    const project = this.project(projectId), item = project.cases.find((c) => c.id === caseId);
    if (!item) throw new Error('用例不存在或格式错误');
    const suite = project.suites.find((s) => s.id === item.suiteId)!;
    const dir = fileIn(project.root, suite.directory);
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const file = fileIn(project.root, `${suite.directory}/${entry.name}/case.yaml`);
      if (existsSync(file) && readYaml(file).id === caseId) return { project, item, file };
    }
    throw new Error('未找到用例文件');
  }
  saveCase(input: { projectId: string; caseId: string; revision: string; name: string; description: string; priority: string; tags: string[] }): void {
    const { item, file } = this.caseLocation(input.projectId, input.caseId);
    if (item.revision !== input.revision) throw new Error('用例已被外部修改，请重新加载后再保存');
    if (!['P0', 'P1', 'P2'].includes(input.priority) || !Array.isArray(input.tags) || !input.tags.every((t) => typeof t === 'string')) throw new Error('优先级或标签格式错误');
    const data = readYaml(file);
    Object.assign(data, { name: required(input.name, '用例名称'), description: input.description, priority: input.priority, tags: input.tags });
    writeAtomic(file, data);
  }
  bulkCases(input: BulkCaseInput): BulkCaseResult {
    const project = this.project(input.projectId), operation = input.operation;
    if (!Array.isArray(input.cases) || !input.cases.length || input.cases.some(item => !item || typeof item.id !== 'string' || typeof item.revision !== 'string')) throw new Error('请选择有效的用例');
    const ids = new Set(input.cases.map(item => item.id));
    if (ids.size !== input.cases.length) throw new Error('所选用例不能重复');
    if (!operation || !['delete', 'moveSuite', 'addGroup', 'removeGroup'].includes(operation.kind)) throw new Error('不支持的批量操作');
    if (project.errors.length) throw new Error('项目文件存在错误，请先修复后再批量操作：' + project.errors[0]);
    const available = new Map(project.cases.map(item => [item.id, item]));
    const locations = this.caseIndexes.get(project)!;
    const selected = input.cases.map(reference => {
      const item = available.get(reference.id);
      if (!item || item.revision !== reference.revision) throw new Error('所选用例已被修改或删除，请刷新列表后重新选择');
      return { item, file: locations.get(item.id)! };
    });
    const writes: { file: string; before: string; after: string }[] = [];
    const moves: { from: string; to: string }[] = [];
    const within = (directory: string, file: string) => file === directory || file.startsWith(directory + path.sep);
    if (operation.kind === 'addGroup' || operation.kind === 'removeGroup' || operation.kind === 'delete') {
      const groups = operation.kind === 'delete' ? (project.groups ?? []).filter(group => group.caseIds.some(id => ids.has(id)))
        : (project.groups ?? []).filter(group => group.id === operation.groupId);
      if (operation.kind !== 'delete' && (!groups.length || groups[0]!.revision !== operation.revision)) throw new Error('目标 Group 已被修改或删除，请刷新后重新选择');
      for (const group of groups) {
        const file = fileIn(project.root, `groups/${group.id}.yaml`), before = readFileSync(file, 'utf8'), data = readYaml(file);
        data.caseIds = operation.kind === 'addGroup' ? [...new Set([...group.caseIds, ...ids])] : group.caseIds.filter(id => !ids.has(id));
        writes.push({ file, before, after: stringify(data) });
      }
    }
    if (operation.kind === 'moveSuite' || operation.kind === 'delete') {
      const target = operation.kind === 'moveSuite' ? project.suites.find(suite => suite.id === operation.suiteId) : undefined;
      if (operation.kind === 'moveSuite' && !target) throw new Error('目标 Suite 不存在，请刷新后重新选择');
      const affected = selected.filter(({ item }) => !target || item.suiteId !== target.id);
      const directories = affected.map(({ file }) => path.dirname(file));
      // A case directory is movable only when it owns its contents. Imported layouts
      // can contain nested suites or workflows referenced by another case.
      const checkTree = (directory: string): void => {
        if (lstatSync(directory).isSymbolicLink() || realpathSync(directory) !== directory) throw new Error('用例目录包含符号链接，请先整理文件路径');
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
          if (entry.isSymbolicLink()) throw new Error('用例目录包含符号链接，请先整理文件路径');
          if (entry.isDirectory()) checkTree(path.join(directory, entry.name));
        }
      };
      const references = project.cases.filter(item => !ids.has(item.id)).map(item => {
        const caseFile = locations.get(item.id)!;
        const files = [caseFile, ...item.workflows.map(workflow => fileIn(project.root, path.resolve(path.dirname(caseFile), workflow.definitionPath)))];
        return { name: item.name, files: files.flatMap(file => existsSync(file) ? [file, realpathSync(file)] : [file]) };
      });
      for (const directory of directories) {
        checkTree(directory);
        if (['workspace.yaml', 'resources.yaml', 'groups', 'environments'].some(relative => within(directory, fileIn(project.root, relative)))) throw new Error('用例目录包含项目配置，无法批量操作');
        if (project.suites.some(suite => within(directory, fileIn(project.root, suite.directory)))) throw new Error('用例目录内包含 Suite，无法批量移动或删除');
        if (directories.some(other => other !== directory && within(directory, other))) throw new Error('用例目录存在嵌套，无法批量操作');
        const reference = references.find(reference => reference.files.some(file => within(directory, file)));
        if (reference) throw new Error(`用例「${reference.name}」仍引用所选用例目录，请先解除共享文件引用`);
      }
      if (target) {
        for (const { file } of affected) {
          const from = path.dirname(file), to = fileIn(project.root, path.join(target.directory, path.basename(from)));
          if (existsSync(to) || moves.some(move => move.to === to)) throw new Error('目标 Suite 存在同名用例目录，未移动任何用例');
          moves.push({ from, to });
        }
        for (const { file } of selected) {
          const before = readFileSync(file, 'utf8'), data = readYaml(file), move = moves.find(move => move.from === path.dirname(file));
          let changed = !!move;
          if (move) data.suiteId = target.id;
          for (const workflow of data.workflows ?? []) {
            const original = fileIn(project.root, path.resolve(path.dirname(file), workflow.definitionPath));
            if (existsSync(original) && realpathSync(original) !== original && moves.some(candidate => within(candidate.from, realpathSync(original)))) throw new Error('Workflow 通过符号链接引用待移动目录，请先整理文件路径');
            const owner = moves.find(candidate => within(candidate.from, original));
            const destination = owner ? path.join(owner.to, path.relative(owner.from, original)) : original;
            if (move || owner) {
              workflow.definitionPath = path.relative(move?.to ?? path.dirname(file), destination).split(path.sep).join('/');
              changed = true;
            }
          }
          if (changed) writes.push({ file, before, after: stringify(data) });
        }
      } else {
        for (const directory of directories) moves.push({ from: directory, to: '' });
      }
    }
    // Validate the entire plan before touching any selected case. Roll back completed
    // writes and renames on an I/O failure, rather than leaving a partial batch.
    for (const { item, file } of selected) if (hash(readFileSync(fileIn(project.root, file), 'utf8')) !== item.revision) throw new Error('用例已被外部修改，请刷新后重试');
    for (const write of writes) if (readFileSync(fileIn(project.root, write.file), 'utf8') !== write.before) throw new Error('项目文件已被外部修改，请刷新后重试');
    const appliedWrites: typeof writes = [], appliedMoves: typeof moves = [];
    let staging: string | undefined;
    try {
      if (operation.kind === 'delete') {
        staging = mkdtempSync(path.join(project.root, '.testo-delete-'));
        moves.forEach((move, index) => { move.to = path.join(staging!, String(index)); });
      }
      for (const write of writes) { writeAtomic(write.file, write.after); appliedWrites.push(write); }
      for (const move of moves) {
        fileIn(project.root, move.from); fileIn(project.root, move.to);
        mkdirSync(path.dirname(move.to), { recursive: true });
        renameSync(move.from, move.to); appliedMoves.push(move);
      }
    } catch (error) {
      const rollbackErrors: unknown[] = [];
      for (const move of appliedMoves.reverse()) try { renameSync(move.to, move.from); } catch (failure) { rollbackErrors.push(failure); }
      for (const write of appliedWrites.reverse()) try { writeAtomic(write.file, write.before); } catch (failure) { rollbackErrors.push(failure); }
      if (rollbackErrors.length) throw new AggregateError([error, ...rollbackErrors], '批量操作失败且部分文件未能恢复，请检查项目文件后再操作');
      if (staging) rmSync(staging, { recursive: true, force: true });
      throw error;
    }
    if (staging) {
      try { rmSync(staging, { recursive: true, force: true }); }
      catch { return { count: selected.length, warning: `用例已删除，但临时备份未能清理：${staging}` }; }
    }
    return { count: selected.length };
  }
  workflowLocation(projectId: string, caseId: string, workflowId: string): { file: string; platform: string } {
    const { project, item, file } = this.caseLocation(projectId, caseId);
    const workflow = item.workflows.find((w) => w.id === workflowId);
    if (!workflow) throw new Error('Workflow 不存在');
    return { file: fileIn(project.root, path.relative(project.root, path.resolve(path.dirname(file), workflow.definitionPath))), platform: workflow.platform };
  }
  workflow(projectId: string, caseId: string, workflowId: string): { text: string; revision: string } {
    const { file } = this.workflowLocation(projectId, caseId, workflowId);
    const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
    return { text, revision: hash(text) };
  }
  saveWorkflow(input: { projectId: string; caseId: string; workflowId: string; text: string; revision: string }): void {
    const { file } = this.workflowLocation(input.projectId, input.caseId, input.workflowId);
    if (this.workflow(input.projectId, input.caseId, input.workflowId).revision !== input.revision) throw new Error('Workflow 已被外部修改，请重新加载后再保存');
    const data = parse(input.text, { uniqueKeys: true, maxAliasCount: 50 });
    if (!data || !Array.isArray(data.cases) || data.cases.length !== 1 || !data.cases[0].name || !Array.isArray(data.cases[0].steps) || !data.cases[0].steps.length) throw new Error('YAML 必须包含一个具名 Case 和非空 steps；Markdown 无法直接执行');
    writeAtomic(file, input.text);
  }
  private readAssets(root: string): ProjectAssets {
    const file = fileIn(root, 'resources.yaml');
    const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
    const data = text ? readYaml(file) : { schemaVersion: 1, variables: {}, flows: {} };
    if (data.schemaVersion !== 1) throw new Error('不支持的共享资源版本');
    return { revision: hash(text), variables: validateVariables(data.variables ?? {}), flows: this.validateFlows(data.flows ?? {}) };
  }
  private validateFlows(value: unknown): ProjectAssets['flows'] {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('共享步骤格式错误');
    const flows = value as ProjectAssets['flows'];
    for (const [id, flow] of Object.entries(flows)) {
      if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id) || ['__proto__', 'constructor', 'prototype'].includes(id)) throw new Error('共享步骤 ID 格式错误');
      required(flow?.name, '共享步骤名称');
      if (!Array.isArray(flow.steps) || !flow.steps.length) throw new Error('共享步骤不能为空');
      compileWorkflow(stringify({ cases: [{ name: flow.name, steps: [{ useFlow: { id } }] }] }), { flows });
    }
    return flows;
  }
  saveAssets(input: { projectId: string; revision: string; variables: ProjectAssets['variables']; flows: ProjectAssets['flows'] }): ProjectAssets {
    const project = this.project(input.projectId);
    const current = this.readAssets(project.root);
    if (current.revision !== input.revision) throw new Error('共享资源已被外部修改，请刷新后保存');
    const flows = this.validateFlows(input.flows);
    const removed = Object.keys(current.flows).filter(id => !Object.hasOwn(flows, id));
    if (removed.length) {
      for (const item of project.cases) for (const workflow of item.workflows) {
        if (!workflow.ready) continue;
        const { file } = this.workflowLocationFromProject(project, item.id, workflow.id);
        const document = readYaml(file);
        const references = (value: unknown): boolean => !!value && typeof value === 'object' &&
          (typeof (value as any).useFlow?.id === 'string' && removed.includes((value as any).useFlow.id) || Object.values(value).some(references));
        if (references(document)) throw new Error(`${item.name} 仍在引用待删除的共享步骤，请先修改该用例`);
      }
    }
    writeAtomic(fileIn(project.root, 'resources.yaml'), { schemaVersion: 1, variables: validateVariables(input.variables), flows });
    return this.readAssets(project.root);
  }
  saveEnvironment(input: { projectId: string; id?: string; name: string; baseUrl: string; variables?: ProjectAssets['variables'] }): void {
    const p = this.project(input.projectId);
    if (!/^https?:$/.test(new URL(input.baseUrl).protocol)) throw new Error('环境地址必须使用 HTTP 或 HTTPS');
    const id = input.id ?? randomUUID();
    if (input.id && !p.environments.some((e) => e.id === input.id)) throw new Error('环境不存在');
    let file = fileIn(p.root, `environments/${id}.yaml`);
    if (input.id) {
      const dir = fileIn(p.root, 'environments');
      const existing = readdirSync(dir).filter((name) => /\.ya?ml$/.test(name)).find((name) => { try { return readYaml(fileIn(p.root, `environments/${name}`)).id === id; } catch { return false; } });
      if (existing) file = fileIn(p.root, `environments/${existing}`);
    }
    const previous = existsSync(file) ? readYaml(file) : {};
    writeAtomic(file, { ...previous, id, name: required(input.name, '环境名称'), web: { baseUrl: input.baseUrl }, variables: validateVariables(input.variables ?? previous.variables ?? {}) });
  }
}
