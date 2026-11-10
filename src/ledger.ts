import { DatabaseSync } from "node:sqlite";
import type { LlmUsage } from "./llm/index.ts";
import type { Job } from "./schema.ts";
import { normalize } from "./util.ts";

export type JobStatus =
  | "discovered" // fetched, not yet evaluated
  | "rejected" // filtered out; `reason` says why
  | "matched" // passed screening, waiting for quota
  | "ready" // packet prepared and form pre-filled, awaiting your approval
  | "needs_human" // something only you can answer or do
  | "submitted" // submitted and the site confirmed it
  | "unconfirmed" // submitted, but no confirmation page was recognized
  | "failed" // submission attempted and rejected by the site
  | "skipped"; // you passed on it

export interface JobRow {
  id: string;
  source: string;
  company: string;
  title: string;
  location: string;
  url: string;
  apply_url: string;
  status: JobStatus;
  fit: number | null;
  reason: string | null;
  packet_dir: string | null;
  job_json: string;
  discovered_at: string;
  prepared_at: string | null;
  submitted_at: string | null;
}

/** Statuses that count as an application against quotas. */
const ATTEMPTED = `('ready','needs_human','submitted','unconfirmed','failed')`;

export class Ledger {
  readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY, source TEXT, company TEXT, title TEXT, location TEXT,
        url TEXT, apply_url TEXT, fingerprint TEXT, status TEXT NOT NULL,
        fit INTEGER, reason TEXT, packet_dir TEXT, job_json TEXT NOT NULL,
        discovered_at TEXT NOT NULL, prepared_at TEXT, submitted_at TEXT
      );
      CREATE INDEX IF NOT EXISTS jobs_status ON jobs(status);
      CREATE INDEX IF NOT EXISTS jobs_fingerprint ON jobs(fingerprint);
      CREATE TABLE IF NOT EXISTS usage (
        at TEXT NOT NULL, purpose TEXT, input INTEGER, output INTEGER, cached INTEGER
      );
    `);
  }

  /** Adds unseen jobs. The same title at the same company is one job, whichever board listed it. */
  addJobs(jobs: Job[]): number {
    const exists = this.db.prepare("SELECT 1 FROM jobs WHERE id = ? OR fingerprint = ?");
    const insert = this.db.prepare(
      `INSERT INTO jobs (id, source, company, title, location, url, apply_url, fingerprint, status, job_json, discovered_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'discovered', ?, ?)`,
    );
    let added = 0;
    for (const j of jobs) {
      const fp = `${normalize(j.company)}|${normalize(j.title)}|${normalize(j.location)}`;
      if (exists.get(j.id, fp)) continue;
      insert.run(j.id, j.source, j.company, j.title, j.location, j.url, j.applyUrl, fp, JSON.stringify(j), new Date().toISOString());
      added++;
    }
    return added;
  }

  get(id: string): JobRow | undefined {
    return this.db.prepare("SELECT * FROM jobs WHERE id = ? OR id LIKE ?").get(id, `${id}%`) as JobRow | undefined;
  }

  job(row: JobRow): Job {
    return JSON.parse(row.job_json);
  }

  byStatus(...statuses: JobStatus[]): JobRow[] {
    const marks = statuses.map(() => "?").join(",");
    return this.db
      .prepare(`SELECT * FROM jobs WHERE status IN (${marks}) ORDER BY fit DESC, discovered_at DESC`)
      .all(...statuses) as unknown as JobRow[];
  }

  setStatus(id: string, status: JobStatus, fields: { fit?: number; reason?: string; packet_dir?: string } = {}): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE jobs SET status = ?, fit = COALESCE(?, fit), reason = COALESCE(?, reason),
           packet_dir = COALESCE(?, packet_dir),
           prepared_at = CASE WHEN ? IN ('ready','needs_human') AND prepared_at IS NULL THEN ? ELSE prepared_at END,
           submitted_at = CASE WHEN ? IN ('submitted','unconfirmed') THEN ? ELSE submitted_at END
         WHERE id = ?`,
      )
      .run(status, fields.fit ?? null, fields.reason ?? null, fields.packet_dir ?? null, status, now, status, now, id);
  }

  /** Applications prepared or sent in the last 24 hours. */
  usedToday(): number {
    const since = new Date(Date.now() - 86_400_000).toISOString();
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM jobs WHERE status IN ${ATTEMPTED} AND COALESCE(submitted_at, prepared_at) >= ?`)
      .get(since) as { n: number };
    return row.n;
  }

  companyCount30d(company: string): number {
    const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM jobs WHERE status IN ${ATTEMPTED} AND lower(company) = lower(?) AND COALESCE(submitted_at, prepared_at) >= ?`)
      .get(company, since) as { n: number };
    return row.n;
  }

  recordUsage(purpose: string, u: LlmUsage): void {
    this.db
      .prepare("INSERT INTO usage (at, purpose, input, output, cached) VALUES (?, ?, ?, ?, ?)")
      .run(new Date().toISOString(), purpose, u.input, u.output, u.cached);
  }

  usageSummary(days = 30): { purpose: string; calls: number; input: number; output: number; cached: number }[] {
    const since = new Date(Date.now() - days * 86_400_000).toISOString();
    return this.db
      .prepare(
        `SELECT purpose, COUNT(*) AS calls, SUM(input) AS input, SUM(output) AS output, SUM(cached) AS cached
         FROM usage WHERE at >= ? GROUP BY purpose ORDER BY input + output DESC`,
      )
      .all(since) as any[];
  }

  counts(): Record<string, number> {
    const rows = this.db.prepare("SELECT status, COUNT(*) AS n FROM jobs GROUP BY status").all() as any[];
    return Object.fromEntries(rows.map((r) => [r.status, r.n]));
  }

  close(): void {
    if (this.db.isOpen) this.db.close();
  }
}
