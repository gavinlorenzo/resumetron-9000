import { DatabaseSync } from "node:sqlite";
import type { LlmUsage } from "./llm/index.ts";
import type { Job } from "./schema.ts";
import { canonicalUrl, normalize } from "./util.ts";

export type JobStatus =
  | "discovered" // fetched, not yet evaluated
  | "rejected" // filtered out; `reason` says why
  | "matched" // passed filters (and screening, once `reason` starts with "screened"), waiting for quota
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
  origin: string | null; // "q:<query id>" or "b:<ats>:<token>": which search surfaced it
  track_id: number | null;
  /** Screening detail as JSON: factor scores, gaps, strengths, gate notes and warning signs. */
  screen: string | null;
  /** How many times this job reappeared under a new listing. */
  reposts: number;
  outcome: Outcome | null;
  channel: string | null; // form | email | manual
  email_msg_id: string | null;
  job_json: string;
  discovered_at: string;
  prepared_at: string | null;
  submitted_at: string | null;
  updated_at: string | null;
}

/** What screening and the code-side checks found about one job. */
export interface ScreenDetail {
  factors?: Record<string, number>;
  gaps?: string[];
  strengths?: string[];
  /** Hard requirements the seeker's eligibility doesn't settle. */
  gates?: string[];
  warnings?: string[];
}

export const screenOf = (row: Pick<JobRow, "screen">): ScreenDetail => (row.screen ? JSON.parse(row.screen) : {});

export interface QueryRow {
  id: number;
  source: string;
  query: string;
  location: string;
  origin: string; // goal | agent | user
  status: "active" | "exhausted" | "retired";
  next_page: number; // next deep page to read; 0 once the result list has been read to its end
  track_id: number | null;
  runs: number;
  seen: number;
  fresh: number;
  screened: number;
  matched: number;
  empty_runs: number;
  why: string | null;
  created_at: string;
  last_run_at: string | null;
}

export interface BoardRow {
  ats: "greenhouse" | "lever" | "ashby";
  token: string;
  company: string;
  origin: string; // goal | discovered | user
  status: "active" | "dead";
  failures: number;
  seen: number;
  fresh: number;
  matched: number;
  last_swept_at: string | null;
  created_at: string;
}

export type ExclusionKind = "title" | "company" | "keyword" | "job";

/** What an employer did with an application. Silence is inferred from age, never stored. */
export type Outcome = "none" | "acknowledged" | "rejected" | "interview" | "offer";
export const OUTCOME_RANK: Record<Outcome, number> = { none: 0, acknowledged: 1, rejected: 2, interview: 3, offer: 4 };

export interface TrackRow {
  id: number;
  name: string;
  hypothesis: string;
  /** proposed: exploring on a small quota slice. active: in rotation. cemented: proven, protected share. retired: dropped. */
  status: "proposed" | "active" | "cemented" | "retired";
  roles: string[];
  created_at: string;
  updated_at: string;
  note: string | null;
}

export interface SentApplication {
  id: string;
  company: string;
  title: string;
  track_id: number | null;
  outcome: Outcome | null;
  submitted_at: string;
  email_msg_id: string | null;
  url: string;
}

export interface ExclusionRow {
  id: number;
  kind: ExclusionKind;
  pattern: string;
  origin: string; // user | agent
  reason: string | null;
  hits: number;
  created_at: string;
}

/** Which status changes are allowed. Anything else is a bug, so it throws. */
export const TRANSITIONS: Record<JobStatus, JobStatus[]> = {
  discovered: ["rejected", "matched", "skipped"],
  matched: ["rejected", "ready", "needs_human", "submitted", "unconfirmed", "failed", "skipped"],
  ready: ["needs_human", "submitted", "unconfirmed", "failed", "skipped", "rejected"],
  needs_human: ["ready", "submitted", "unconfirmed", "failed", "skipped", "rejected"],
  unconfirmed: ["submitted", "needs_human", "failed"],
  failed: ["ready", "needs_human", "submitted", "unconfirmed", "skipped"],
  submitted: [],
  skipped: ["ready", "needs_human"],
  rejected: [],
};

/** Statuses that count as an application against quotas. */
const ATTEMPTED = `('ready','needs_human','submitted','unconfirmed','failed')`;
/** Statuses that will never change on their own. Their stored postings can be slimmed. */
export const FINISHED = `('rejected','skipped','submitted','unconfirmed','failed')`;

const COMPANY_SUFFIX = /\b(inc|llc|ltd|limited|corp|corporation|co|company|pbc|plc|gmbh|sa|ag|the)\b/g;
export const companyKey = (c: string) => normalize(c).replace(COMPANY_SUFFIX, " ").replace(/\s+/g, " ").trim();
/** One posting, whichever board listed it: the same title at the same company. */
export const fingerprint = (j: Pick<Job, "company" | "title">) => `${companyKey(j.company)}|${normalize(j.title)}`;

const now = () => new Date().toISOString();
const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();

export class Ledger {
  readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    // Incremental auto-vacuum lets pruning hand disk space back to the OS.
    if ((this.db.prepare("PRAGMA auto_vacuum").get() as any).auto_vacuum !== 2) {
      this.db.exec("PRAGMA auto_vacuum = INCREMENTAL; VACUUM;");
    }
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL; -- safe with WAL; avoids a disk flush per write
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY, source TEXT, company TEXT, title TEXT, location TEXT,
        url TEXT, apply_url TEXT, fingerprint TEXT, status TEXT NOT NULL,
        fit INTEGER, reason TEXT, packet_dir TEXT, job_json TEXT NOT NULL,
        discovered_at TEXT NOT NULL, prepared_at TEXT, submitted_at TEXT
      );
      CREATE TABLE IF NOT EXISTS usage_daily (
        day TEXT NOT NULL, purpose TEXT NOT NULL, calls INTEGER, input INTEGER, output INTEGER, cached INTEGER,
        PRIMARY KEY (day, purpose)
      );
      CREATE TABLE IF NOT EXISTS queries (
        id INTEGER PRIMARY KEY, source TEXT NOT NULL, query TEXT NOT NULL, location TEXT NOT NULL DEFAULT '',
        norm TEXT NOT NULL UNIQUE, origin TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active',
        next_page INTEGER NOT NULL DEFAULT 2, runs INTEGER NOT NULL DEFAULT 0, seen INTEGER NOT NULL DEFAULT 0,
        fresh INTEGER NOT NULL DEFAULT 0, matched INTEGER NOT NULL DEFAULT 0, empty_runs INTEGER NOT NULL DEFAULT 0,
        why TEXT, created_at TEXT NOT NULL, last_run_at TEXT
      );
      CREATE TABLE IF NOT EXISTS boards (
        ats TEXT NOT NULL, token TEXT NOT NULL, company TEXT NOT NULL, origin TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active', failures INTEGER NOT NULL DEFAULT 0, seen INTEGER NOT NULL DEFAULT 0,
        fresh INTEGER NOT NULL DEFAULT 0, matched INTEGER NOT NULL DEFAULT 0, last_swept_at TEXT, created_at TEXT NOT NULL,
        PRIMARY KEY (ats, token)
      );
      CREATE TABLE IF NOT EXISTS probes (company TEXT PRIMARY KEY, found TEXT, at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS exclusions (
        id INTEGER PRIMARY KEY, kind TEXT NOT NULL, pattern TEXT NOT NULL, origin TEXT NOT NULL, reason TEXT,
        hits INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, UNIQUE (kind, pattern)
      );
      CREATE TABLE IF NOT EXISTS journal (id INTEGER PRIMARY KEY, at TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tracks (
        id INTEGER PRIMARY KEY, name TEXT NOT NULL, hypothesis TEXT NOT NULL, status TEXT NOT NULL,
        roles TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, note TEXT
      );
      CREATE TABLE IF NOT EXISTS emails (
        message_id TEXT PRIMARY KEY, job_id TEXT, at TEXT NOT NULL, from_domain TEXT, subject TEXT,
        kind TEXT NOT NULL, matched_by TEXT
      );
    `);
    for (const [table, col] of [
      ["jobs", "origin TEXT"], ["jobs", "updated_at TEXT"], ["jobs", "track_id INTEGER"], ["jobs", "outcome TEXT"],
      ["jobs", "outcome_at TEXT"], ["jobs", "channel TEXT"], ["jobs", "email_msg_id TEXT"],
      ["queries", "screened INTEGER NOT NULL DEFAULT 0"], ["queries", "track_id INTEGER"],
      ["boards", "screened INTEGER NOT NULL DEFAULT 0"],
      ["jobs", "canon TEXT"], ["jobs", "screen TEXT"], ["jobs", "reposts INTEGER NOT NULL DEFAULT 0"], ["jobs", "aliases TEXT"],
    ]) {
      try {
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${col}`);
      } catch {} // already present
    }
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS jobs_status ON jobs(status);
      CREATE INDEX IF NOT EXISTS jobs_fingerprint ON jobs(fingerprint);
      CREATE INDEX IF NOT EXISTS jobs_canon ON jobs(canon);
    `);
    // Older workspaces logged one row per model call; fold them into daily totals.
    if (this.db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'usage'").get()) {
      this.db.exec(`
        INSERT OR IGNORE INTO usage_daily
          SELECT substr(at, 1, 10), purpose, COUNT(*), SUM(input), SUM(output), SUM(cached) FROM usage GROUP BY 1, 2;
        DROP TABLE usage;
      `);
    }
  }

  // ---------------- jobs ----------------

  /**
   * Adds unseen jobs and reports how many were new. A posting already known through an
   * aggregator is upgraded in place when a company board offers an auto-fillable form for it.
   */
  addJobs(jobs: Job[], origin: string): { fresh: number; seen: number } {
    const find = this.db.prepare(
      "SELECT id, status, job_json, discovered_at, aliases FROM jobs WHERE id = ? OR fingerprint = ? OR canon = ? OR canon = ? LIMIT 1",
    );
    const insert = this.db.prepare(
      `INSERT INTO jobs (id, source, company, title, location, url, apply_url, fingerprint, canon, status, job_json, origin, discovered_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'discovered', ?, ?, ?, ?)`,
    );
    const upgrade = this.db.prepare("UPDATE jobs SET url = ?, apply_url = ?, job_json = ?, updated_at = ? WHERE id = ?");
    let fresh = 0;
    this.db.exec("BEGIN");
    try {
      fresh = this.addJobsInner(jobs, origin, find, insert, upgrade);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    return { fresh, seen: jobs.length };
  }

  private addJobsInner(jobs: Job[], origin: string, find: any, insert: any, upgrade: any): number {
    let fresh = 0;
    for (const j of jobs) {
      const existing = find.get(j.id, fingerprint(j), canonicalUrl(j.url), canonicalUrl(j.applyUrl)) as any;
      if (existing) {
        this.noteRepost(existing, j);
        if (["discovered", "matched"].includes(existing.status) && j.autoApplicable) {
          const old: Job = JSON.parse(existing.job_json);
          if (!old.autoApplicable) {
            const merged = { ...old, url: j.url, applyUrl: j.applyUrl, autoApplicable: true, description: j.description.length > old.description.length ? j.description : old.description };
            upgrade.run(j.url, j.applyUrl, JSON.stringify(merged), now(), existing.id);
          }
        }
        continue;
      }
      const t = now();
      insert.run(j.id, j.source, j.company, j.title, j.location, j.url, j.applyUrl, fingerprint(j), canonicalUrl(j.url), JSON.stringify(j), origin, t, t);
      fresh++;
    }
    return fresh;
  }

  /**
   * The same job under a new listing, two weeks or more after it was first seen, from the same
   * source: a repost. Several of those suggest a ghost job. Aggregators relisting a job don't count.
   */
  private noteRepost(existing: { id: string; discovered_at: string; aliases: string | null; job_json: string }, j: Job): void {
    if (existing.id === j.id) return;
    const aliases: string[] = JSON.parse(existing.aliases ?? "[]");
    if (aliases.includes(j.id)) return;
    const old: Job = JSON.parse(existing.job_json);
    const repost = old.source === j.source && Date.now() - Date.parse(existing.discovered_at) >= 14 * 86_400_000;
    this.db
      .prepare("UPDATE jobs SET aliases = ?, reposts = reposts + ? WHERE id = ?")
      .run(JSON.stringify([...aliases, j.id].slice(-20)), repost ? 1 : 0, existing.id);
  }

  /** Runs several writes as one transaction: one commit instead of one per row. */
  batch<T>(fn: () => T): T {
    this.db.exec("BEGIN");
    try {
      const r = fn();
      this.db.exec("COMMIT");
      return r;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
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

  /**
   * Moves a job to a new status. Only the moves in TRANSITIONS are allowed; `force` is for
   * things you record yourself ("I applied to this one on my own").
   */
  setStatus(id: string, status: JobStatus, fields: { fit?: number; reason?: string; packet_dir?: string; force?: boolean } = {}): void {
    const cur = (this.db.prepare("SELECT status FROM jobs WHERE id = ?").get(id) as { status: JobStatus } | undefined)?.status;
    if (cur && !fields.force && cur !== status && !TRANSITIONS[cur].includes(status)) {
      throw new Error(`a job can't go from ${cur} to ${status}`);
    }
    const t = now();
    this.db
      .prepare(
        `UPDATE jobs SET status = ?, fit = COALESCE(?, fit), reason = COALESCE(?, reason),
           packet_dir = COALESCE(?, packet_dir), updated_at = ?,
           prepared_at = CASE WHEN ? IN ('ready','needs_human') AND prepared_at IS NULL THEN ? ELSE prepared_at END,
           submitted_at = CASE WHEN ? IN ('submitted','unconfirmed') THEN ? ELSE submitted_at END
         WHERE id = ?`,
      )
      .run(status, fields.fit ?? null, fields.reason ?? null, fields.packet_dir ?? null, t, status, t, status, t, id);
  }

  /** Applications prepared or sent in the last 24 hours. */
  usedToday(): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM jobs WHERE status IN ${ATTEMPTED} AND COALESCE(submitted_at, prepared_at) >= ?`)
      .get(daysAgo(1)) as { n: number };
    return row.n;
  }

  companyCount30d(company: string): number {
    const rows = this.db
      .prepare(`SELECT company FROM jobs WHERE status IN ${ATTEMPTED} AND COALESCE(submitted_at, prepared_at) >= ?`)
      .all(daysAgo(30)) as { company: string }[];
    return rows.filter((r) => companyKey(r.company) === companyKey(company)).length;
  }

  counts(): Record<string, number> {
    const rows = this.db.prepare("SELECT status, COUNT(*) AS n FROM jobs GROUP BY status").all() as any[];
    return Object.fromEntries(rows.map((r) => [r.status, r.n]));
  }

  /** Rows for exclusion evidence: title and company survive slimming, so old decisions still count. */
  decided(): { title: string; company: string; status: JobStatus; reason: string | null }[] {
    return this.db
      .prepare(`SELECT title, company, status, reason FROM jobs WHERE reason LIKE 'screened:%' OR status IN ${ATTEMPTED}`)
      .all() as any[];
  }

  /** Recent screening rejections, for the planner to learn from. */
  recentRejections(limit: number): { title: string; reason: string }[] {
    return this.db
      .prepare("SELECT title, reason FROM jobs WHERE status = 'rejected' AND reason LIKE 'screened:%' ORDER BY updated_at DESC LIMIT ?")
      .all(limit) as any[];
  }

  /** Records a screening result against the search or board that surfaced the job. */
  credit(origin: string | null, passed: boolean): void {
    if (!origin) return;
    const m = passed ? 1 : 0;
    if (origin.startsWith("q:")) this.db.prepare("UPDATE queries SET screened = screened + 1, matched = matched + ? WHERE id = ?").run(m, Number(origin.slice(2)));
    else if (origin.startsWith("b:")) {
      const [, ats, token] = origin.split(":");
      this.db.prepare("UPDATE boards SET screened = screened + 1, matched = matched + ? WHERE ats = ? AND token = ?").run(m, ats, token);
    }
  }

  setScreen(jobId: string, detail: ScreenDetail): void {
    this.db.prepare("UPDATE jobs SET screen = ? WHERE id = ?").run(JSON.stringify(detail), jobId);
  }

  setTrack(jobId: string, trackId: number | null): void {
    this.db.prepare("UPDATE jobs SET track_id = ? WHERE id = ?").run(trackId, jobId);
  }

  setChannel(jobId: string, channel: string, emailMsgId?: string): void {
    this.db.prepare("UPDATE jobs SET channel = ?, email_msg_id = COALESCE(?, email_msg_id) WHERE id = ?").run(channel, emailMsgId ?? null, jobId);
  }

  /** Records what an employer did. Outcomes only move forward: an interview stays an interview. */
  setOutcome(jobId: string, outcome: Outcome): boolean {
    const row = this.db.prepare("SELECT outcome FROM jobs WHERE id = ?").get(jobId) as any;
    if (!row || OUTCOME_RANK[outcome] <= OUTCOME_RANK[(row.outcome as Outcome) ?? "none"]) return false;
    this.db.prepare("UPDATE jobs SET outcome = ?, outcome_at = ? WHERE id = ?").run(outcome, now(), jobId);
    return true;
  }

  /** Applications that went out, for outcome statistics and for matching replies. */
  sentApplications(sinceDays = 365): SentApplication[] {
    return this.db
      .prepare(
        `SELECT id, company, title, track_id, outcome, submitted_at, email_msg_id, url FROM jobs
         WHERE status IN ('submitted','unconfirmed') AND submitted_at >= ? ORDER BY submitted_at DESC`,
      )
      .all(daysAgo(sinceDays)) as any[];
  }

  // ---------------- tracks ----------------

  addTrack(name: string, hypothesis: string, roles: string[], status: TrackRow["status"]): number {
    const t = now();
    const r = this.db
      .prepare("INSERT INTO tracks (name, hypothesis, status, roles, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(name, hypothesis, status, JSON.stringify(roles), t, t);
    return Number(r.lastInsertRowid);
  }

  tracks(...statuses: TrackRow["status"][]): TrackRow[] {
    const where = statuses.length ? `WHERE status IN (${statuses.map(() => "?").join(",")})` : "";
    return (this.db.prepare(`SELECT * FROM tracks ${where} ORDER BY id`).all(...statuses) as any[]).map((r) => ({ ...r, roles: JSON.parse(r.roles) }));
  }

  updateTrack(id: number, fields: Partial<Pick<TrackRow, "hypothesis" | "status" | "note" | "roles">>): void {
    const cur = this.tracks().find((t) => t.id === id);
    if (!cur) return;
    const next = { ...cur, ...fields };
    this.db
      .prepare("UPDATE tracks SET hypothesis = ?, status = ?, note = ?, roles = ?, updated_at = ? WHERE id = ?")
      .run(next.hypothesis, next.status, next.note ?? null, JSON.stringify(next.roles), now(), id);
  }

  // ---------------- email ----------------

  hasEmail(messageId: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM emails WHERE message_id = ?").get(messageId));
  }

  recordEmail(e: { messageId: string; jobId: string | null; fromDomain: string; subject: string; kind: string; matchedBy: string | null }): void {
    this.db
      .prepare("INSERT OR IGNORE INTO emails (message_id, job_id, at, from_domain, subject, kind, matched_by) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(e.messageId, e.jobId, now(), e.fromDomain, e.subject.slice(0, 200), e.kind, e.matchedBy);
  }

  recentEmails(limit: number): { at: string; job_id: string | null; from_domain: string; subject: string; kind: string; matched_by: string | null }[] {
    return this.db.prepare("SELECT * FROM emails WHERE job_id IS NOT NULL ORDER BY at DESC LIMIT ?").all(limit) as any[];
  }

  // ---------------- searches ----------------

  addQuery(source: string, query: string, location: string, origin: string, why: string, trackId: number | null = null): boolean {
    const norm = `${source}|${normalize(query)}|${normalize(location)}`;
    const r = this.db
      .prepare("INSERT OR IGNORE INTO queries (source, query, location, norm, origin, why, created_at, track_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(source, query.trim(), location.trim(), norm, origin, why, now(), trackId);
    return r.changes > 0;
  }

  queries(...statuses: QueryRow["status"][]): QueryRow[] {
    const where = statuses.length ? `WHERE status IN (${statuses.map(() => "?").join(",")})` : "";
    return this.db.prepare(`SELECT * FROM queries ${where} ORDER BY id`).all(...statuses) as unknown as QueryRow[];
  }

  queryRan(id: number, r: { seen: number; fresh: number; next: number; exhaustAfter: number }): QueryRow["status"] {
    const q = this.db.prepare("SELECT empty_runs FROM queries WHERE id = ?").get(id) as any;
    const empty = r.fresh === 0 ? q.empty_runs + 1 : 0;
    // A list read to its end that keeps turning up nothing new has been covered.
    const exhausted = (r.next === 0 && empty >= r.exhaustAfter) || empty >= r.exhaustAfter * 2;
    const status = exhausted ? "exhausted" : "active";
    this.db
      .prepare(
        `UPDATE queries SET runs = runs + 1, seen = seen + ?, fresh = fresh + ?, next_page = ?, empty_runs = ?,
           status = ?, last_run_at = ? WHERE id = ?`,
      )
      .run(r.seen, r.fresh, r.next, empty, status, now(), id);
    return status;
  }

  retireQuery(id: number): boolean {
    return this.db.prepare("UPDATE queries SET status = 'retired' WHERE id = ? AND status = 'active'").run(id).changes > 0;
  }

  // ---------------- company boards ----------------

  addBoard(ats: BoardRow["ats"], token: string, company: string, origin: string): boolean {
    return (
      this.db
        .prepare("INSERT OR IGNORE INTO boards (ats, token, company, origin, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(ats, token, company, origin, now()).changes > 0
    );
  }

  boards(...statuses: BoardRow["status"][]): BoardRow[] {
    const where = statuses.length ? `WHERE status IN (${statuses.map(() => "?").join(",")})` : "";
    return this.db.prepare(`SELECT * FROM boards ${where} ORDER BY created_at`).all(...statuses) as unknown as BoardRow[];
  }

  boardSwept(b: BoardRow, r: { seen: number; fresh: number } | null): void {
    if (!r) {
      // Three failures in a row and the board is set aside.
      this.db
        .prepare("UPDATE boards SET failures = failures + 1, status = CASE WHEN failures + 1 >= 3 THEN 'dead' ELSE status END, last_swept_at = ? WHERE ats = ? AND token = ?")
        .run(now(), b.ats, b.token);
      return;
    }
    this.db
      .prepare("UPDATE boards SET failures = 0, seen = ?, fresh = fresh + ?, last_swept_at = ? WHERE ats = ? AND token = ?")
      .run(r.seen, r.fresh, now(), b.ats, b.token);
  }

  /** Cached result of looking for a company's board: undefined = never looked (or the lookup expired). */
  probe(company: string): string | null | undefined {
    const row = this.db.prepare("SELECT found FROM probes WHERE company = ?").get(companyKey(company)) as any;
    return row ? row.found : undefined;
  }

  setProbe(company: string, found: string | null): void {
    this.db.prepare("INSERT OR REPLACE INTO probes (company, found, at) VALUES (?, ?, ?)").run(companyKey(company), found, now());
  }

  // ---------------- exclusions ----------------

  addExclusion(kind: ExclusionKind, pattern: string, origin: string, reason: string): boolean {
    return (
      this.db
        .prepare("INSERT OR IGNORE INTO exclusions (kind, pattern, origin, reason, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(kind, pattern.trim(), origin, reason, now()).changes > 0
    );
  }

  exclusions(): ExclusionRow[] {
    return this.db.prepare("SELECT * FROM exclusions ORDER BY id").all() as unknown as ExclusionRow[];
  }

  removeExclusion(id: number): boolean {
    return this.db.prepare("DELETE FROM exclusions WHERE id = ?").run(id).changes > 0;
  }

  hitExclusion(id: number, n = 1): void {
    this.db.prepare("UPDATE exclusions SET hits = hits + ? WHERE id = ?").run(n, id);
  }

  // ---------------- memory ----------------

  note(kind: string, text: string): void {
    this.db.prepare("INSERT INTO journal (at, kind, text) VALUES (?, ?, ?)").run(now(), kind, text);
  }

  journal(limit: number): { at: string; kind: string; text: string }[] {
    return (this.db.prepare("SELECT at, kind, text FROM journal ORDER BY id DESC LIMIT ?").all(limit) as any[]).reverse();
  }

  meta(key: string): string | undefined {
    return (this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as any)?.value;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(key, value);
  }

  // ---------------- usage ----------------

  recordUsage(purpose: string, u: LlmUsage): void {
    this.db
      .prepare(
        `INSERT INTO usage_daily (day, purpose, calls, input, output, cached) VALUES (?, ?, 1, ?, ?, ?)
         ON CONFLICT (day, purpose) DO UPDATE SET calls = calls + 1, input = input + excluded.input,
           output = output + excluded.output, cached = cached + excluded.cached`,
      )
      .run(now().slice(0, 10), purpose, u.input, u.output, u.cached);
  }

  usageSummary(days = 30): { purpose: string; calls: number; input: number; output: number; cached: number }[] {
    return this.db
      .prepare(
        `SELECT purpose, SUM(calls) AS calls, SUM(input) AS input, SUM(output) AS output, SUM(cached) AS cached
         FROM usage_daily WHERE day >= ? GROUP BY purpose ORDER BY SUM(input) + SUM(output) DESC`,
      )
      .all(daysAgo(days).slice(0, 10)) as any[];
  }

  close(): void {
    if (!this.db.isOpen) return;
    try {
      this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch {}
    this.db.close();
  }
}
