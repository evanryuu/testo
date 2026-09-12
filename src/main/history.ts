import { DatabaseSync } from 'node:sqlite';
import type { HistoryRun, BatchRun, HistoryQuery, HistoryPage } from '../shared/workspace.js';
import type { WorkerEvent } from '../runner/messages.js';

/** Summaries and append-only events have separate storage and read paths. */
export class HistoryStore {
  private db: DatabaseSync;
  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, started_at TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS batches (id TEXT PRIMARY KEY, started_at TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS run_events (run_id TEXT NOT NULL, sequence INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(run_id, sequence));
      CREATE INDEX IF NOT EXISTS runs_project_date ON runs(json_extract(payload, '$.projectId'), started_at DESC);
      CREATE INDEX IF NOT EXISTS runs_status_date ON runs(json_extract(payload, '$.status'), started_at DESC);`);
    const unfinished = this.db.prepare("SELECT payload FROM batches WHERE json_extract(payload, '$.status') = 'running'").all();
    for (const row of unfinished) {
      const batch = JSON.parse(String(row.payload)) as BatchRun;
      batch.status = 'interrupted';
      for (const item of batch.items) if (item.status === 'running' || item.status === 'queued') item.status = 'interrupted';
      this.saveBatch(batch);
    }
    this.db.exec("UPDATE runs SET payload=json_set(payload, '$.status', 'interrupted') WHERE json_extract(payload, '$.status') = 'running'");
  }
  saveBatch(batch: BatchRun): void {
    this.db.prepare('INSERT INTO batches VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(batch.id, batch.startedAt, JSON.stringify(batch));
  }
  batch(id: string): BatchRun | undefined {
    const row = this.db.prepare('SELECT payload FROM batches WHERE id=?').get(id);
    return row ? JSON.parse(String(row.payload)) : undefined;
  }
  batches(limit = 100): BatchRun[] {
    return this.db.prepare('SELECT payload FROM batches ORDER BY started_at DESC LIMIT ?').all(limit).map(row => JSON.parse(String(row.payload)));
  }
  save(run: HistoryRun): void {
    this.db.exec('BEGIN');
    try {
      const { events, ...summary } = run;
      this.db.prepare('INSERT INTO runs VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(run.runId, run.startedAt, JSON.stringify(summary));
      const insert = this.db.prepare('INSERT INTO run_events VALUES (?, ?, ?) ON CONFLICT(run_id, sequence) DO UPDATE SET payload=excluded.payload');
      events.forEach((event, index) => insert.run(run.runId, index, JSON.stringify(event)));
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  appendEvent(runId: string, event: WorkerEvent): void {
    this.db.prepare('INSERT INTO run_events(run_id,sequence,payload) SELECT ?, COALESCE(MAX(sequence),-1)+1, ? FROM run_events WHERE run_id=?').run(runId, JSON.stringify(event), runId);
  }
  get(runId: string): HistoryRun | undefined {
    const row = this.db.prepare('SELECT payload FROM runs WHERE id=?').get(runId);
    if (!row) return;
    const run = JSON.parse(String(row.payload)) as HistoryRun;
    const stored = this.db.prepare('SELECT payload FROM run_events WHERE run_id=? ORDER BY sequence').all(runId).map(row => JSON.parse(String(row.payload)));
    return { ...run, events: stored.length ? stored : run.events ?? [] };
  }
  query(input: HistoryQuery = {}): HistoryPage {
    const clauses: string[] = [], values: (string | number)[] = [];
    for (const [field, value] of [['projectId', input.projectId], ['caseId', input.caseId], ['status', input.status], ['environment', input.environment]] as const) {
      if (value) { clauses.push(`json_extract(payload, '$.${field}') = ?`); values.push(value); }
    }
    if (input.after) { clauses.push('started_at >= ?'); values.push(input.after); }
    if (input.before) { clauses.push('started_at <= ?'); values.push(input.before); }
    const where = clauses.length ? ' WHERE ' + clauses.join(' AND ') : '';
    const total = Number(this.db.prepare('SELECT COUNT(*) AS count FROM runs' + where).get(...values)!.count);
    const limit = Math.max(1, Math.min(100, Math.trunc(input.limit ?? 50)));
    const offset = Math.max(0, Math.trunc(input.offset ?? 0));
    const rows = this.db.prepare('SELECT json_remove(payload, \'$.events\', \'$.snapshot\') AS payload FROM runs' + where + ' ORDER BY started_at DESC, id DESC LIMIT ? OFFSET ?').all(...values, limit, offset);
    return { total, runs: rows.map(row => ({ ...JSON.parse(String(row.payload)), events: [] })) };
  }
  latestByCase(): HistoryRun[] {
    return this.db.prepare(`SELECT json_remove(payload, '$.events', '$.snapshot') AS payload FROM
      (SELECT payload, ROW_NUMBER() OVER (PARTITION BY json_extract(payload, '$.projectId'), json_extract(payload, '$.caseId') ORDER BY started_at DESC, id DESC) AS rank FROM runs)
      WHERE rank = 1`).all().map(row => ({ ...JSON.parse(String(row.payload)), events: [] }));
  }
  list(): HistoryRun[] {
    return this.db.prepare('SELECT id FROM runs ORDER BY started_at DESC').all().map(row => this.get(String(row.id))!);
  }
  close(): void { this.db.close(); }
}
