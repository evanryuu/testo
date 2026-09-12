import { useEffect, useRef, useState } from 'react';
import { ExternalLink, LoaderCircle, Plus, RefreshCw } from 'lucide-react';
import type { ChromeProfileInfo } from '../shared/browser.js';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';

const statusNames: Record<ChromeProfileInfo['status'], string> = { unconnected: '尚未连接', connecting: '正在连接', ready: '最近检查成功', disconnected: '连接已断开' };
export function ChromeTabPicker({ projectId, environmentId, disabled = false, selected, onBusy }: {
  projectId: string; environmentId: string; disabled?: boolean; selected(id: string): Promise<void>; onBusy?(busy: boolean): void;
}) {
  const [profiles, setProfiles] = useState<ChromeProfileInfo[]>([]);
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false);
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [removing, setRemoving] = useState('');
  const [connectingProfile, setConnectingProfile] = useState('');
  const [createdProfile, setCreatedProfile] = useState('');
  const picker = useRef<HTMLDivElement>(null);
  const working = useRef(false);
  useEffect(() => {
    if (!createdProfile) return;
    const section = [...(picker.current?.querySelectorAll<HTMLElement>('[data-profile-id]') ?? [])].find(element => element.dataset.profileId === createdProfile);
    section?.scrollIntoView({ block: 'start' });
  }, [createdProfile]);
  useEffect(() => {
    let active = true;
    void window.workspace.browserProfiles().then(value => { if (active) setProfiles(value); })
      .catch(cause => { if (active) setError(cause instanceof Error ? cause.message : String(cause)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);
  async function act(work: () => Promise<void>) {
    if (working.current || disabled) return;
    working.current = true; setBusy(true); onBusy?.(true); setError(''); setNotice('');
    try { await work(); }
    catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      try { setProfiles(await window.workspace.browserProfiles()); } catch { /* Keep the original action error if the catalog is unavailable. */ }
    }
    finally { working.current = false; setBusy(false); onBusy?.(false); }
  }
  function replace(profile: ChromeProfileInfo) {
    setProfiles(current => current.some(item => item.id === profile.id) ? current.map(item => item.id === profile.id ? profile : item) : [...current, profile]);
  }
  async function refreshProfile(profile: ChromeProfileInfo) {
    setConnectingProfile(profile.id);
    try { replace(await window.workspace.refreshBrowserProfile({ id: profile.id })); }
    finally { setConnectingProfile(''); }
  }
  const locked = disabled || busy || loading;
  return <Card ref={picker} data-testid="chrome-tab-picker"><CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3"><CardTitle>选择 Chrome 标签页</CardTitle><Button variant="outline" disabled={locked} onClick={() => void act(async () => { const profile = await window.workspace.addBrowserProfile(); replace(profile); setCreatedProfile(profile.id); })}><Plus />添加 Chrome Profile</Button></CardHeader><CardContent className="space-y-4">
    <p className="text-sm leading-6 text-muted-foreground">先连接 Chrome 用户配置（Profile），再选择页面。这里只显示通过 Testo Chrome Connector 配对的用户配置；仅打开 Chrome 或安装 Midscene 扩展，还不能在这里选择标签页。</p>
    <p className="text-xs leading-6 text-muted-foreground">Profile 名称是配对别名，不是自动读取的 Chrome 用户名称。同一 Profile 的窗口共享登录状态。平台只绑定你选中的标签页，登录状态仍由你确认。</p>
    {error ? <Alert variant="destructive"><AlertDescription><strong>连接未完成</strong><p className="break-words">{error}</p><p>请按下方「连接排查」检查后重试；配对成功的连接会保留。</p></AlertDescription></Alert> : null}
    {notice ? <p role="status" className="text-sm text-muted-foreground">{notice}</p> : null}
    <div className="flex flex-wrap gap-2"><Button variant="outline" size="sm" disabled={locked} onClick={() => void act(async () => { await window.workspace.openBrowserConnector(); setNotice('已打开扩展目录。请在目标 Chrome Profile 的扩展管理页开启开发者模式，并加载此目录。'); })}><ExternalLink />打开扩展目录</Button><Button variant="ghost" size="sm" disabled={locked} onClick={() => void act(async () => { setProfiles(await window.workspace.browserProfiles()); })}><RefreshCw />刷新 Profile 列表</Button></div>
    <details className="rounded-lg border p-4 text-sm leading-6" open={!profiles.length || profiles.some(profile => profile.status !== 'ready')}>
      <summary className="cursor-pointer font-medium">首次连接：安装扩展与配对</summary>
      <ol className="mt-3 list-decimal space-y-3 pl-5">
        <li><strong>选择 Chrome 用户配置。</strong>点击 Chrome 右上角头像，切换到要测试的用户配置，打开目标网站。按用例需要登录或保持未登录。</li>
        <li><strong>安装 Testo Chrome Connector。</strong>点击上方「打开扩展目录」。在目标 Chrome 地址栏输入 <code className="select-text">chrome://extensions</code>，开启右上角「开发者模式」，点击「加载已解压的扩展程序」（部分版本叫「加载未打包的扩展程序」），选择刚打开的文件夹。安装后应看到 Testo Chrome Connector。</li>
        <li><strong>创建连接并保存配对。</strong>点击「添加 Chrome Profile」，再点击该连接的「复制配对码」。在 Chrome 的扩展菜单中点击 Testo Chrome Connector，填写「连接名称」，将配对码粘贴到「Testo 连接代码」，点击「保存并连接」。每个 Chrome 用户配置分别安装、配对。</li>
        <li><strong>确认要使用的标签页。</strong>返回 Testo，点击该连接的「刷新连接与标签页」。按窗口、标题和完整网址找到页面；同网址的页面用「在 Chrome 中查看」确认，再点击「使用此标签页」。选择页面不会自动开始测试。</li>
      </ol>
    </details>
    <details className="rounded-lg border p-4 text-sm leading-6" open={!!error}>
      <summary className="cursor-pointer font-medium">连接排查</summary>
      <ul className="mt-3 list-disc space-y-2 pl-5">
        <li>没有连接记录：点击「添加 Chrome Profile」。读取列表失败时，点击「刷新 Profile 列表」重试。</li>
        <li>扩展加载失败：选择「打开扩展目录」打开的完整文件夹，在扩展管理页查看错误；更新 Testo 后，重新加载 Testo Chrome Connector。</li>
        <li>连接超时或断开：保持 Testo 和目标 Chrome 打开，确认扩展安装在正确的用户配置中且已启用；重新复制配对码，在扩展中点击「保存并连接」，再重试连接。</li>
        <li>提示调试连接被占用：先结束其他 Midscene 录制或运行，并关闭目标页面的开发者工具，再重试。</li>
        <li>没有目标页面或网址不匹配：在已配对的用户配置中打开目标网站，再刷新连接与标签页；同时检查 Testo 选择的运行环境。</li>
      </ul>
    </details>
    {loading ? <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><LoaderCircle className="size-4 animate-spin" />正在读取已配对的 Profile…</p> : !profiles.length ? <p className="text-sm text-muted-foreground">还没有已配对的 Profile。点击「添加 Chrome Profile」开始连接。</p> : null}
    {profiles.map(profile => {
      const windows = new Map<number, typeof profile.tabs>();
      if (profile.status === 'ready') for (const tab of [...profile.tabs].sort((a, b) => a.windowId - b.windowId || a.index - b.index)) windows.set(tab.windowId, [...(windows.get(tab.windowId) ?? []), tab]);
      return <section key={profile.id} data-testid="chrome-profile" data-profile-id={profile.id} className="space-y-3 rounded-lg border p-4">
        <div className="flex flex-wrap items-center justify-between gap-3"><div><strong className="text-sm">{profile.name}</strong><Badge variant="secondary" className="ml-2">{statusNames[profile.status]}</Badge><p className="mt-1 text-xs text-muted-foreground">配对别名 · {profile.checkedAt ? '检查于 ' + new Date(profile.checkedAt).toLocaleTimeString('zh-CN') : '尚未检查连接'}</p></div><div className="flex gap-2"><Button size="sm" variant="outline" disabled={locked} aria-label={`刷新 Profile ${profile.name}`} onClick={() => void act(() => refreshProfile(profile))}>{connectingProfile === profile.id ? <LoaderCircle className="animate-spin" /> : <RefreshCw />}{connectingProfile === profile.id ? '正在连接…' : profile.status === 'disconnected' ? '重试连接' : '刷新连接与标签页'}</Button><Button size="sm" variant="ghost" disabled={locked} aria-label={`解除配对 ${profile.name}`} onClick={() => setRemoving(profile.id)}>解除配对</Button></div></div>
        {connectingProfile === profile.id ? <p role="status" className="text-sm text-muted-foreground">正在检查扩展连接，最长等待 30 秒。请保持 Chrome 和 Testo 打开。</p> : null}
        {profile.error ? <p className="text-sm text-destructive">{profile.error}</p> : null}
        {profile.status !== 'ready' ? <div className="space-y-2 rounded-md bg-muted/50 p-3 text-sm leading-6"><ol className="list-decimal space-y-1 pl-5"><li>在要连接的 Chrome Profile 中打开扩展管理页，开启开发者模式，加载上方按钮打开的扩展目录。</li><li>复制此连接的配对码，在 Testo Chrome Connector 中填写「连接名称」和「Testo 连接代码」，点击「保存并连接」。</li><li>在扩展保存配对后，回到这里点击「刷新连接与标签页」。</li></ol><Button size="sm" variant="outline" disabled={locked} aria-label={`复制配对码 ${profile.name}`} onClick={() => void act(async () => { await window.workspace.copyBrowserPairingCode({ id: profile.id }); setNotice(profile.name + ' 的配对码已复制，请粘贴到目标 Profile 的扩展中并保存配对，再回到这里刷新。'); })}>复制配对码</Button></div> : null}
        {[...windows].map(([windowId, tabs]) => <div key={windowId} data-testid="chrome-window" data-window-id={windowId} className="rounded-md border"><h4 className="border-b bg-muted/30 px-3 py-2 text-sm font-medium">窗口 {windowId} · {tabs.length} 个标签页</h4><div className="divide-y">{tabs.map(tab => <div key={tab.tabId} data-testid="chrome-tab" data-tab-id={tab.tabId} className="flex flex-wrap items-center gap-3 p-3"><div className="min-w-0 flex-1"><p className="text-sm font-medium">标签页 {tab.index + 1} · {tab.title || '无标题页面'}{tab.active ? <Badge variant="outline" className="ml-2">窗口当前标签页</Badge> : null}</p><p className="mt-1 break-all text-xs text-muted-foreground">{tab.url}</p></div><Button size="sm" variant="ghost" disabled={locked} onClick={() => void act(async () => { await window.workspace.focusBrowserTab({ profileId: profile.id, tabId: tab.tabId }); })}>在 Chrome 中查看</Button><Button size="sm" variant="outline" disabled={locked || !environmentId} onClick={() => void act(async () => { const id = await window.workspace.useBrowserTab({ projectId, environmentId, profileId: profile.id, tabId: tab.tabId }); await selected(id); setNotice('已选择：' + profile.name + ' · 窗口 ' + windowId + ' · ' + (tab.title || tab.url)); })}>使用此标签页</Button></div>)}</div></div>)}
        {profile.status === 'ready' && !windows.size ? <p className="text-sm text-muted-foreground">当前没有可选择的网页。请在此 Profile 打开目标网站，再刷新标签页。</p> : null}
        {removing === profile.id ? <Alert><AlertDescription><p>解除 {profile.name} 的配对后，相关会话将无法继续使用。Chrome 页面和登录状态不会被删除。</p><div className="mt-3 flex gap-2"><Button size="sm" variant="destructive" disabled={locked} onClick={() => void act(async () => { await window.workspace.removeBrowserProfile({ id: profile.id }); setProfiles(current => current.filter(item => item.id !== profile.id)); setRemoving(''); })}>确认解除配对</Button><Button size="sm" variant="outline" disabled={locked} onClick={() => setRemoving('')}>保留配对</Button></div></AlertDescription></Alert> : null}
      </section>;
    })}
  </CardContent></Card>;
}
