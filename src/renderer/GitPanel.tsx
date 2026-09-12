import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { attachOverlayScrollbars } from '@/lib/scrollbars';
export function GitPanel({ projectId }: { projectId: string }) {
  const [value, setValue] = useState<{branch:string;commit:string;status:string;diff:string}>(), [error, setError] = useState('');
  const refresh = () => window.workspace.gitStatus({ projectId }).then(setValue).catch(e => setError(String(e)));
  useEffect(() => { void refresh(); }, [projectId]);
  return <Card><CardHeader className="flex-row items-center justify-between"><CardTitle>Git 资产版本</CardTitle><Button variant="outline" size="sm" onClick={() => void refresh()}>刷新 Git 状态</Button></CardHeader><CardContent className="space-y-3"><p className="text-sm">{value?.branch || '未关联分支'} · {value?.commit.slice(0, 12)}</p>{error && <p className="text-destructive">{error}</p>}<pre ref={attachOverlayScrollbars} className="max-h-40 overflow-auto whitespace-pre-wrap text-xs">{value?.status || '工作区没有修改'}</pre><details><summary className="cursor-pointer text-sm">查看未提交的修改</summary><pre ref={attachOverlayScrollbars} className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap break-all text-xs">{value?.diff || '没有可显示的 diff'}</pre></details></CardContent></Card>;
}
