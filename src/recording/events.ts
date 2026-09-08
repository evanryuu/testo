import type { RecordedEvent } from '../shared/recording.js';

// The official endpoint returns raw events, including replacements with the same
// hash. Description responses are separate and must not be overwritten by polling.
export class RecorderEvents {
  private entries = new Map<string, RecordedEvent>();
  private versions = new Map<string, string>();
  private jobs: { event: RecordedEvent; version: string }[] = [];
  private running = 0;
  private closed = false;
  private timers = new Set<ReturnType<typeof setTimeout>>();
  constructor(private options: {
    persistScreenshot(event: RecordedEvent): Promise<void>;
    describe(event: RecordedEvent): Promise<RecordedEvent>;
    changed(events: RecordedEvent[]): void;
    idle(): void;
    descriptionTimeoutMs?: number;
  }) {}
  get values() { return [...this.entries.values()]; }
  get pending() { return this.running + this.jobs.length; }
  async update(events: RecordedEvent[]) {
    let changed = false;
    // Last occurrence wins, while preserving the official position in the timeline.
    for (const event of new Map(events.map((event) => [event.hashId, event])).values()) {
      const version = JSON.stringify(event);
      if (this.versions.get(event.hashId) === version) continue;
      changed = true;
      this.versions.set(event.hashId, version);
      const stored = structuredClone(event);
      try { await this.options.persistScreenshot(stored); }
      catch { stored.screenshotError = '截图未能保存到本地'; }
      this.entries.set(event.hashId, stored);
      if (!['navigation', 'setViewport'].includes(event.type) && event.actionType !== 'Navigate' && event.semantic?.status !== 'ready') {
        if (event.screenshotAsset || event.screenshotBefore || event.screenshotAfter || event.screenshotWithBox) {
          stored.semantic = { ...event.semantic, source: event.semantic?.source ?? 'aiDescribe', status: 'pending' };
          this.jobs.push({ event: structuredClone(stored), version });
        }
      }
    }
    // Navigation can be inserted after an earlier action by the official server.
    this.entries = new Map([...new Set(events.map((event) => event.hashId))].map((id) => [id, this.entries.get(id)!]));
    if (changed) this.options.changed(this.values);
    this.pump();
  }
  close() { this.closed = true; this.jobs = []; for (const timer of this.timers) clearTimeout(timer); this.timers.clear(); }
  private pump() {
    while (!this.closed && this.running < 2 && this.jobs.length) {
      const job = this.jobs.shift()!;
      if (this.versions.get(job.event.hashId) !== job.version) continue;
      this.running++;
      let timer: ReturnType<typeof setTimeout>;
      const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('描述生成超时')), this.options.descriptionTimeoutMs ?? 90_000); });
      this.timers.add(timer!);
      void Promise.race([Promise.resolve().then(() => this.options.describe(job.event)), timeout]).then((described) => {
        if (!this.closed && this.versions.get(job.event.hashId) === job.version) {
          // Only description fields may change; coordinates, merged input and
          // screenshot references continue to come from the official recording.
          this.entries.set(job.event.hashId, { ...this.entries.get(job.event.hashId)!, semantic: described.semantic, elementDescription: described.elementDescription, descriptionLoading: false });
        }
      }).catch(() => {
        if (!this.closed && this.versions.get(job.event.hashId) === job.version) {
          const event = this.entries.get(job.event.hashId)!;
          this.entries.set(event.hashId, { ...event, semantic: { source: 'aiDescribe', status: 'failed', error: '描述生成失败，原始操作和截图已保留' }, descriptionLoading: false });
        }
      }).finally(() => {
        clearTimeout(timer);
        this.timers.delete(timer);
        this.running--;
        if (this.closed) return;
        this.options.changed(this.values);
        this.pump();
        if (!this.pending) this.options.idle();
      });
    }
  }
}
