import { DatabaseSync } from 'node:sqlite';
import type { HistoryRun } from '../shared/workspace.js';

export class HistoryStore {
  private db: DatabaseSync;
  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, started_at TEXT NOT NULL, payload TEXT NOT NULL)');
    for (const run of this.list()) {
      if (run.status === 'running') this.save({ ...run, status: 'interrupted' });
    }
  }
  save(run: HistoryRun): void {
    this.db.prepare('INSERT INTO runs VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(run.runId, run.startedAt, JSON.stringify(run));
  }
  list(): HistoryRun[] {
    return this.db.prepare('SELECT payload FROM runs ORDER BY started_at DESC').all().map((row) => JSON.parse(String(row.payload)));
  }
}
