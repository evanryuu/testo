import { useEffect, useState } from 'react';
import type { UpdateState } from '../shared/workspace.js';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
export function AppUpdatePanel() {
  const [info, setInfo] = useState<{ dataDirectory: string; update: UpdateState }>(), [error, setError] = useState('');
  const refresh = () => window.workspace.appInfo().then(setInfo).catch(e => setError(String(e)));
  useEffect(() => { void refresh(); return window.workspace.onChange(() => void refresh()); }, []);
  const act = async (name: 'checkUpdate' | 'downloadUpdate' | 'installUpdate') => {
    setError('');
    try { await window.workspace[name](); await refresh(); } catch (e) { setError(String(e)); }
  };
  const update = info?.update;
  return <Card><CardHeader><CardTitle>应用与本机数据</CardTitle></CardHeader><CardContent className="space-y-3">
    <p className="text-sm">Testo {update?.version}</p><p className="break-all text-xs text-muted-foreground">数据目录：{info?.dataDirectory}</p>
    <p className="text-sm" role="status">{update?.message}{update?.status === 'downloading' ? ` · ${update.percent ?? 0}%` : ''}</p>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <div className="flex flex-wrap gap-2"><Button variant="outline" disabled={!update?.enabled || ['checking','downloading','downloaded'].includes(update.status)} onClick={() => void act('checkUpdate')}>检查更新</Button>
      {update?.status === 'available' && <Button onClick={() => void act('downloadUpdate')}>下载 {update.nextVersion}</Button>}
      {update?.status === 'downloaded' && <Button onClick={() => void act('installUpdate')}>安装并重启</Button>}
    </div>
  </CardContent></Card>;
}
