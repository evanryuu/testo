import { PlaygroundSDK, type PlaygroundRuntimeInfo } from '@midscene/playground';
import {
  PREVIEW_TEXT_INPUT_BATCH_DELAY_MS,
  PREVIEW_WHEEL_SCROLL_BATCH_DELAY_MS,
} from '@midscene/shared/constants';
import { App as AntdApp, Alert, ConfigProvider, Spin } from 'antd';
import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { PreviewRenderer } from '../../vendor/midscene-preview/playground-app/PreviewRenderer';
import './styles.css';

const sdk = new PlaygroundSDK({ type: 'remote-execution', serverUrl: location.origin });
const interact = sdk.interact.bind(sdk);
const outstanding = new Set<Promise<unknown>>();
let interactionRevision = 0;
let interactionFailure: string | undefined;
let flushing = false;

// Observe completion only. Payload generation, batching, and ordering remain in
// the unchanged official PreviewRenderer and DeviceInteractionLayer components.
sdk.interact = (payload) => {
  interactionRevision += 1;
  const task = interact(payload).then((result) => {
    if (!result.ok) interactionFailure = result.error || '操作未成功，请检查页面后重试。';
    return result;
  }, (error: unknown) => {
    interactionFailure = error instanceof Error ? error.message : String(error);
    throw error;
  });
  outstanding.add(task);
  void task.finally(() => outstanding.delete(task)).catch(() => undefined);
  return task;
};

const delay = (duration: number) => new Promise<void>((resolve) => setTimeout(resolve, duration));
const inputEvents = ['pointerdown', 'pointerup', 'keydown', 'input', 'paste', 'wheel'] as const;
const blockInput = (event: Event) => {
  if (!flushing) return;
  event.preventDefault();
  event.stopImmediatePropagation();
};
for (const event of inputEvents) window.addEventListener(event, blockInput, { capture: true, passive: false });

async function drainOfficialInteractions() {
  // Keep the official component mounted: its wheel cleanup intentionally drops
  // a pending batch on unmount. Let its own exported batch timers run instead.
  await delay(Math.max(PREVIEW_TEXT_INPUT_BATCH_DELAY_MS, PREVIEW_WHEEL_SCROLL_BATCH_DELAY_MS) + 32);
  while (true) {
    const revision = interactionRevision;
    await Promise.allSettled([...outstanding]);
    // Official callbacks enqueue subsequent SDK calls in promise continuations.
    // A task boundary allows that complete microtask queue to advance.
    await delay(0);
    if (!outstanding.size && revision === interactionRevision) break;
  }
  if (interactionFailure) {
    const error = interactionFailure;
    interactionFailure = undefined;
    throw new Error(error);
  }
}

window.addEventListener('message', async (event: MessageEvent) => {
  if (event.source !== window.parent || window.parent === window) return;
  if (event.data?.type !== 'workspace-preview:flush' || typeof event.data.requestId !== 'string') return;
  const targetOrigin = event.origin === 'null' ? '*' : event.origin;
  const reply = (error?: string) => window.parent.postMessage({
    type: 'workspace-preview:flushed', requestId: event.data.requestId, ...(error ? { error } : {}),
  }, targetOrigin);
  if (flushing) { reply('正在等待录制操作完成，请稍候。'); return; }
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  flushing = true;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      drainOfficialInteractions(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('录制操作仍在执行，请稍后重试停止录制。')), 12_000);
      }),
    ]);
    reply();
  } catch (error) {
    flushing = false;
    reply(error instanceof Error ? error.message : String(error));
  } finally {
    if (timeout) clearTimeout(timeout);
  }
});

function OfficialPreview() {
  const [runtimeInfo, setRuntimeInfo] = useState<PlaygroundRuntimeInfo | null>(null);
  const [error, setError] = useState<string>();
  useEffect(() => {
    let cancelled = false;
    sdk.getRuntimeInfo().then((info) => {
      if (cancelled) return;
      if (!info) throw new Error('无法读取 Midscene 预览连接信息。');
      setRuntimeInfo(info);
      window.parent.postMessage({ type: 'workspace-preview:ready' }, '*');
    }).catch((reason: unknown) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
    });
    return () => { cancelled = true; };
  }, []);
  return <div className="official-preview">
    {error ? <Alert type="error" showIcon message="预览连接失败" description={error} />
      : runtimeInfo ? <PreviewRenderer playgroundSDK={sdk} runtimeInfo={runtimeInfo}
        serverUrl={location.origin} serverOnline isUserOperating screenshotViewerMode="screen-only" />
        : <Spin className="preview-loading" tip="正在连接 Midscene…"><div /></Spin>}
  </div>;
}

createRoot(document.getElementById('root')!).render(
  <ConfigProvider><AntdApp><OfficialPreview /></AntdApp></ConfigProvider>,
);
