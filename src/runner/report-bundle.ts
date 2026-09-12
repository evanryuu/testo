import { constants, closeSync, createReadStream, lstatSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { Zip, ZipDeflate, strToU8 } from 'fflate';
import type { HistoryRun } from '../shared/workspace.js';

const escapeHtml = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
function inside(root: string, file: string): string {
  const relative = path.relative(root, file);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('报告文件不能超出本次运行目录');
  return relative.split(path.sep).join('/');
}
function safeFile(root: string, file: string): string {
  const relative = inside(root, file);
  let current = root;
  for (const component of relative.split('/')) {
    if (!component || component === '.' || component === '..') throw new Error('报告文件路径无效');
    current = path.join(current, component);
    if (lstatSync(current).isSymbolicLink()) throw new Error('报告中包含符号链接，未导出');
  }
  inside(realpathSync(root), realpathSync(file));
  if (!lstatSync(file).isFile()) throw new Error('报告产物必须是普通文件');
  return relative;
}
const secretField = /^(?:api[_-]?key|.*[_-]api[_-]?key|password|passwd|secret|.*[_-]secret|access[_-]?token|refresh[_-]?token|authorization|cookies?|encryptedKey)$/i;
function publicConfiguration(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(publicConfiguration);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, secretField.test(key) ? '[REDACTED]' : publicConfiguration(child)]));
  return value;
}
/** Export only this run's known artifacts. Application credentials, .env and arbitrary files are never scanned or copied. */
export async function exportRunBundle(run: HistoryRun, destination: string): Promise<string> {
  if (!run.result || run.status === 'running') throw new Error('请等待运行结束后再导出报告');
  const root = path.resolve(run.result.artifactDirectory);
  if (lstatSync(root).isSymbolicLink() || !lstatSync(root).isDirectory()) throw new Error('运行目录无效或包含符号链接');
  const target = path.resolve(destination);
  if (!target.toLowerCase().endsWith('.zip')) throw new Error('报告包文件名必须以 .zip 结尾');
  if (path.relative(root, target) === '' || (!path.relative(root, target).startsWith(`..${path.sep}`) && path.relative(root, target) !== '..' && !path.isAbsolute(path.relative(root, target)))) throw new Error('请将报告包保存到运行目录之外');
  try { if (lstatSync(target).isSymbolicLink()) throw new Error('报告包目标不能是符号链接'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const files = new Map<string, string>();
  const optional = (relative: string) => {
    const file = path.join(root, relative);
    try { safeFile(root, file); files.set(relative.split(path.sep).join('/'), file); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  };
  optional('workflow.yaml'); optional('compiled-workflow.yaml');
  const reports = run.result.reportPaths.map(file => {
    const relative = safeFile(root, path.resolve(file));
    if (!relative.startsWith('report/') || !/\.html?$/i.test(relative)) throw new Error('运行报告路径无效');
    files.set(relative, path.resolve(file)); return relative;
  });
  const steps = path.join(root, 'steps');
  try {
    if (lstatSync(steps).isSymbolicLink() || !lstatSync(steps).isDirectory()) throw new Error('执行截图目录无效');
    for (const entry of readdirSync(steps)) if (/^[a-zA-Z0-9_-]+\.(?:png|jpe?g|webp)$/.test(entry)) optional(path.join('steps', entry));
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const summary = publicConfiguration({ runId: run.runId, projectId: run.projectId, caseId: run.caseId, caseName: run.caseName, environment: run.environment, status: run.status, startedAt: run.startedAt, finishedAt: run.result.finishedAt, durationMs: run.result.durationMs, runnerVersion: run.result.runnerVersion, definitionHash: run.result.definitionHash, checks: run.result.checks, error: run.result.error, reports });
  let configuration: unknown = { snapshot: run.snapshot };
  const configFile = path.join(root, 'run-configuration.json');
  try { safeFile(root, configFile); configuration = { ...JSON.parse(readFileSync(configFile, 'utf8')), snapshot: run.snapshot }; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const generated: Record<string, Uint8Array> = {
    'summary.json': strToU8(JSON.stringify(summary, null, 2)),
    'run-configuration.json': strToU8(JSON.stringify(publicConfiguration(configuration ?? {}), null, 2)),
    'events.jsonl': strToU8(run.events.map(event => JSON.stringify(publicConfiguration(event))).join('\n') + '\n'),
    'README.txt': strToU8('Testo 运行报告\n\n解压后打开 index.html，或直接打开 report/ 内的 Midscene HTML 报告。无需安装 Midscene。\n报告包含本次测试的网页截图、步骤、输入值和结果；原生报告与截图未自动脱敏。没有包含应用的模型凭证文件、Chrome 配对信息、.env 或原始进程日志。\n配置中的明确凭证字段已隐藏。workflow.yaml 是原始测试定义；compiled-workflow.yaml 是展开共享步骤后的定义。相对引用文件未随包导出，因此本报告包不能保证独立重放。\n'),
    'index.html': strToU8(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(run.caseName)} · Testo</title><style>body{font:16px system-ui;max-width:880px;margin:48px auto;padding:0 24px;color:#172033}a{color:#2563eb}li{margin:12px 0}small{color:#64748b}</style><h1>${escapeHtml(run.caseName)}</h1><p>${escapeHtml(run.environment)} · ${escapeHtml(run.status)} · ${(run.result.durationMs / 1000).toFixed(1)} 秒</p><p><small>${escapeHtml(run.startedAt)}</small></p><h2>Midscene 报告</h2><ul>${reports.map((file, index) => `<li><a href="${file.split('/').map(encodeURIComponent).join('/')}">报告 ${index + 1}</a></li>`).join('') || '<li>此运行没有生成原生报告</li>'}</ul><h2>运行记录</h2><ul><li><a href="summary.json">运行摘要</a></li><li><a href="events.jsonl">执行事件</a></li><li><a href="run-configuration.json">运行配置</a></li>${[...files.keys()].filter(file => !reports.includes(file)).map(file => `<li><a href="${file.split('/').map(encodeURIComponent).join('/')}">${escapeHtml(file)}</a></li>`).join('')}</ul></html>`),
  };
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`);
  const output = openSync(temporary, 'wx', 0o600);
  let zipError: Error | undefined;
  let finalized = false;
  const zip = new Zip((error, chunk, final) => {
    if (error) { zipError = error; return; }
    try { let offset = 0; while (offset < chunk.length) offset += writeSync(output, chunk, offset); } catch (error) { zipError = error as Error; }
    if (final) finalized = true;
  });
  const add = (name: string) => { const entry = new ZipDeflate(name, { level: 3 }); zip.add(entry); return entry; };
  try {
    for (const [name, data] of Object.entries(generated)) { add(name).push(data, true); if (zipError) throw zipError; }
    for (const [name, file] of files) {
      safeFile(root, file);
      const input = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const entry = add(name);
      for await (const chunk of createReadStream(file, { fd: input, autoClose: true, highWaterMark: 64 * 1024 })) { entry.push(chunk as Buffer, false); if (zipError) throw zipError; }
      entry.push(new Uint8Array(), true);
    }
    zip.end();
    if (zipError) throw zipError;
    if (!finalized) throw new Error('报告压缩未完成');
    closeSync(output);
    renameSync(temporary, target);
    return target;
  } catch (error) {
    zip.terminate();
    try { closeSync(output); } catch { /* May already be closed before a failed rename. */ }
    rmSync(temporary, { force: true });
    throw error;
  }
}
