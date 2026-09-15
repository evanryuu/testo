import { useEffect, useState } from 'react';
import type { DocumentImportApi } from '../shared/document-import-api.js';
export function ImportedStatus({ input, refreshKey }: { input: Parameters<DocumentImportApi['importValidation']>[0]; refreshKey: unknown }) {
  const [status, setStatus] = useState<Awaited<ReturnType<DocumentImportApi['importValidation']>>>();
  const [error, setError] = useState('');
  useEffect(() => { let live = true; setError(''); void Promise.resolve().then(() => window.workspace.importValidation(input)).then(value => { if (live) setStatus(value); }).catch(cause => { if (live) setError(String(cause)); }); return () => { live = false; }; }, [JSON.stringify(input), refreshKey]);
  if (error) return <p className="text-sm text-destructive">生成验证状态无法读取：{error}</p>;
  if (!status?.imported) return null;
  return <div data-testid="import-validation-status" className="space-y-1 rounded-md border p-3 text-sm"><strong>{{ incomplete: '待补充', pending: '待验证', passed: '当前版本与配置验证通过', failed: '当前版本验证失败' }[status.status]}</strong>{status.issues.map(issue => <p key={issue}>{issue}</p>)}<p className="text-xs text-muted-foreground">Workflow、共享流程或运行配置变化后需要重新验证。试跑失败不会自动修改断言。</p></div>;
}
