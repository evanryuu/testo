import type { ChromeTarget } from '../recording/chrome-bridge.js';
import type { MidsceneRecorderEvent } from '@midscene/shared/recorder';

export function isRecordingDescriptionVerified(event: Pick<MidsceneRecorderEvent, 'semantic'>): boolean {
  return event.semantic?.status === 'ready' && event.semantic.aiDescribe?.verifyPrompt === true && event.semantic.aiDescribe.verifyPassed === true;
}

export interface RecordedTarget { tag?: string; role?: string; name?: string; testId?: string }
export interface RecordedEvent extends MidsceneRecorderEvent { screenshotError?: string; target?: RecordedTarget }
export interface RecordingDraft {
  id: string;
  projectId: string;
  caseId: string;
  workflowId: string;
  caseName: string;
  environmentId: string;
  baseUrl: string;
  revision: string;
  existingWorkflow?: boolean;
  replace?: { revision: string; start: number; deleteCount: number; originalText: string };
  browserMode?: 'isolated' | 'bridge';
  chromeTarget?: ChromeTarget;
  viewport?: { width: number; height: number };
  startUrl?: string;
  status: 'starting' | 'ready' | 'recording' | 'review' | 'interrupted' | 'saved';
  events: RecordedEvent[];
  createdAt: string;
  error?: string;
}
export interface RecordingFrame { screenshot: string; width: number; height: number; url: string; previewUrl?: string }
export interface RecordingInteraction {
  actionType: 'Tap' | 'Input' | 'KeyboardPress' | 'Scroll' | 'Navigate';
  x?: number; y?: number; value?: string; mode?: 'typeOnly' | 'replace' | 'clear';
  keyName?: string; direction?: 'up' | 'down'; distance?: number; url?: string;
}
export type RecordingRequest = { requestId: string; method: 'start' | 'begin' | 'confirm' | 'frame' | 'interact' | 'stop'; input?: any };
export type RecordingResponse = { requestId: string; ok: boolean; value?: any; error?: string } | { type: 'browser'; pid: number } | { type: 'ready' } | { type: 'events'; events: RecordedEvent[] };
