import { describeElementAtPoint } from '@midscene/core';
import { getModelRuntime } from '@midscene/core/ai-model';
import type { PlaywrightAgent } from '@midscene/web/playwright';
import { buildMidsceneRecorderActionSummary, buildMidsceneRecorderReplayInstruction } from '@midscene/shared/recorder';
import type { RecordedEvent } from '../shared/recording.js';

export async function describeRecordedTarget(agent: Pick<PlaywrightAgent, 'service' | 'modelConfigManager'>, event: RecordedEvent, screenshot: string): Promise<RecordedEvent> {
  const x = event.elementRect?.x, y = event.elementRect?.y;
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('录制事件没有可校验的目标坐标');
  // Bind both description and verification to the saved event, never the live page.
  const result = await describeElementAtPoint({
    service: agent.service,
    describeModelRuntime: getModelRuntime(agent.modelConfigManager.getModelConfig('insight')),
    locateModelRuntime: getModelRuntime(agent.modelConfigManager.getModelConfig('default')),
  }, [x!, y!], {
    verifyPrompt: true, retryLimit: 2,
    screenshotBase64: screenshot, coordinateSpace: 'logical', logicalSize: event.pageInfo,
  });
  const verified = result.success && result.verifyResult?.pass === true;
  const description = result.prompt.trim();
  const action = { ...event, value: typeof event.rawPayload?.value === 'string' ? event.rawPayload.value : typeof event.rawPayload?.keyName === 'string' ? event.rawPayload.keyName : event.value };
  return { ...event, elementDescription: verified ? description : undefined, semantic: {
    source: 'aiDescribe', status: verified ? 'ready' : 'failed', confidence: verified ? 'high' : 'low',
    elementDescription: description || undefined,
    actionSummary: verified ? buildMidsceneRecorderActionSummary(action, description) : undefined,
    replayInstruction: verified ? buildMidsceneRecorderReplayInstruction(action, description) : undefined,
    error: verified ? undefined : '描述待确认：未能确认描述对应原录制目标，原始操作和截图已保留',
    aiDescribe: {
      verifyPrompt: true, verifyPassed: verified, deepLocate: result.deepLocate,
      expectedCenter: [x!, y!], actualCenter: result.verifyResult?.center,
      centerDistance: result.verifyResult?.centerDistance,
    },
  } };
}
