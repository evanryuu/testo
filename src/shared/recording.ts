import type { MidsceneRecorderEvent } from '@midscene/shared/recorder';

export interface RecordedEvent extends MidsceneRecorderEvent { screenshotError?: string }
export interface RecordingDraft {
  id: string;
  projectId: string;
  caseId: string;
  workflowId: string;
  caseName: string;
  environmentId: string;
  baseUrl: string;
  revision: string;
  status: 'starting' | 'recording' | 'review' | 'interrupted' | 'saved';
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
export type RecordingRequest = { requestId: string; method: 'start' | 'frame' | 'interact' | 'stop'; input?: any };
export type RecordingResponse = { requestId: string; ok: boolean; value?: any; error?: string } | { type: 'browser'; pid: number } | { type: 'ready' } | { type: 'events'; events: RecordedEvent[] };
