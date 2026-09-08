import { DatabaseSync } from 'node:sqlite';
import type { HistoryRun, BatchRun } from '../shared/workspace.js';

export class HistoryStore {
  private db: DatabaseSync;
  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, started_at TEXT NOT NULL, payload TEXT NOT NULL)');
    this.db.exec('CREATE TABLE IF NOT EXISTS batches (id TEXT PRIMARY KEY, started_at TEXT NOT NULL, payload TEXT NOT NULL)');
    for (const batch of this.batches()) {
      if (batch.status === 'running') {
        batch.status = 'interrupted';
        for (const item of batch.items) if (item.status === 'running' || item.status === 'queued') item.status = 'interrupted';
        this.saveBatch(batch);
      }
    }
    for (const run of this.list()) {
      if (run.status === 'running') this.save({ ...run, status: 'interrupted' });
    }
  }
  saveBatch(batch: BatchRun): void {
    this.db.prepare('INSERT INTO batches VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(batch.id, batch.startedAt, JSON.stringify(batch));
  }
  batches(): BatchRun[] {
    return this.db.prepare('SELECT payload FROM batches ORDER BY started_at DESC').all().map(row => JSON.parse(String(row.payload)));
  }
  save(run: HistoryRun): void {
    this.db.prepare('INSERT INTO runs VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(run.runId, run.startedAt, JSON.stringify(run));
  }
  list(): HistoryRun[] {
    return this.db.prepare('SELECT payload FROM runs ORDER BY started_at DESC').all().map((row) => JSON.parse(String(row.payload)));
  }
}
