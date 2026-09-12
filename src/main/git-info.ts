import { execFileSync } from 'node:child_process';
export function gitInfo(root: string, includeDiff = true) {
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024, stdio: ['ignore','pipe','ignore'] }).trim();
  try {
    git('rev-parse', '--show-toplevel');
    const branch = git('branch', '--show-current'), status = git('status', '--short');
    let commit = '', diff = '';
    try { commit = git('rev-parse', 'HEAD'); } catch { /* New repositories have no commit yet. */ }
    if (includeDiff) {
      try { diff = git('diff', ...(commit ? ['HEAD'] : []), '--', '.'); }
      catch { diff = 'diff 过大或读取超时，请在 Git 客户端查看'; }
    }
    return { branch, commit, status, diff };
  } catch { return { branch: '', commit: '', status: '当前目录没有可读取的 Git 仓库', diff: '' }; }
}
