import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { PlaywrightAgent } from '@midscene/web/playwright';
import type { AgentOverChromeBridge } from '@midscene/web/bridge-mode';
import type { Page } from 'playwright';
import { bridgeValue } from '../recording/chrome-bridge.js';
import type { WorkerEvent } from './messages.js';
import type { RecordedAction } from '../recording/workflow.js';

export async function captureActionEvidence(agent: PlaywrightAgent | AgentOverChromeBridge, getPage: (() => Page) | undefined, directory: string, action: RecordedAction, phase: string, index: number, stage: 'before' | 'after' | 'failed'): Promise<Extract<WorkerEvent, { type: 'step-evidence' }>> {
  const evidence: Extract<WorkerEvent, { type: 'step-evidence' }> = { type: 'step-evidence', phase, index, stage };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([(async () => {
      const { x, y } = action.payload;
      if (stage === 'before' && x !== undefined && y !== undefined) {
        const expression = `(() => { const el = document.elementFromPoint(${x}, ${y}); if (!el) return '坐标处没有元素'; const control = el.closest('button,input,textarea,a,[role="button"]') || el; return [control.tagName.toLowerCase(), control.getAttribute('aria-label') || control.getAttribute('placeholder') || control.textContent?.trim().slice(0, 100), control.disabled ? 'disabled' : ''].filter(Boolean).join(' · '); })()`;
        evidence.target = getPage ? await getPage().evaluate(expression) : await bridgeValue((agent as AgentOverChromeBridge).interface, expression);
      }
      evidence.url = await agent.interface.url!();
      const screenshot = await agent.interface.screenshotBase64();
      const data = Buffer.from(screenshot.replace(/^data:[^,]+,/, ''), 'base64');
      const extension = data[0] === 0xff ? 'jpg' : 'png';
      const name = `${phase}-${index}-${stage}.${extension}`;
      await mkdir(path.join(directory, 'steps'), { recursive: true, mode: 0o700 });
      await writeFile(path.join(directory, 'steps', name), data, { mode: 0o600 });
      evidence.image = name;
      return evidence;
    })(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('证据采集超时')), 3000); })]);
  } catch {
    return { type: 'step-evidence', phase, index, stage, warning: '执行截图或目标信息未能采集；请查看原始报告' };
  } finally { clearTimeout(timer); }
}
