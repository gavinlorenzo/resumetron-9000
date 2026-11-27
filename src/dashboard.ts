import { createHash, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Config } from "./config.ts";
import { DASHBOARD_HTML, DASHBOARD_JS } from "./dashboard-page.ts";
import type { Workspace } from "./workspace.ts";

// A read-only web view of one workspace: what was submitted, what is waiting, why jobs were
// turned down, and each packet's documents. It never writes to the ledger and never starts a run.
// Every request needs the password, because the page holds the seeker's personal data and is
// meant to be reachable through a tunnel.

const ATTEMPTED = ["ready", "needs_human", "submitted", "unconfirmed", "failed", "skipped"];
const FILE_TYPES: Record<string, string> = {
  ".pdf": "application/pdf",
  ".md": "text/plain; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

export interface DashboardOptions {
  ws: Workspace;
  cfg: Config;
  password: string;
  port: number;
  host: string;
}

const digest = (s: string) => createHash("sha256").update(s).digest();

/** Basic auth with any user name; the password is compared in constant time. */
export function authorized(header: string | undefined, password: string): boolean {
  const m = /^Basic\s+(.+)$/i.exec(header ?? "");
  if (!m) return false;
  const decoded = Buffer.from(m[1], "base64").toString("utf8");
  const given = decoded.slice(decoded.indexOf(":") + 1);
  return timingSafeEqual(digest(given), digest(password));
}

/** A packet file is served only by its bare name, from that job's own packet folder inside the workspace. */
export function packetFile(applications: string, packetDir: string | null, name: string): string | null {
  if (!FILE_TYPES[extname(name).toLowerCase()]) return null;
  const dir = packetDirIn(applications, packetDir);
  if (!dir || !readdirSync(dir).includes(name)) return null;
  return join(dir, name);
}

/** The packet folder, only if it exists and sits inside the workspace's applications folder. */
function packetDirIn(applications: string, packetDir: string | null): string | null {
  if (!packetDir) return null;
  const dir = resolve(packetDir);
  const rel = relative(resolve(applications), dir);
  if (!rel || rel.startsWith("..") || rel.includes(`..${sep}`) || isAbsolute(rel)) return null;
  return existsSync(dir) ? dir : null;
}

const parse = <T>(s: string | null, fallback: T): T => {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
};

/** A queue reason without the CLI hints and local paths that only make sense in a terminal. */
export function plainReason(reason: string | null): string | null {
  if (!reason) return reason;
  return reason
    .replace(/\s*\((?:resumetron|run `resumetron)[^)]*\)/g, "")
    .replace(/;?\s*your documents are in .*$/i, "")
    .trim();
}

const dayAgo = () => new Date(Date.now() - 86_400_000).toISOString();

export class DashboardData {
  private db: DatabaseSync;
  private ws: Workspace;
  private cfg: Config;

  constructor(ws: Workspace, cfg: Config) {
    this.ws = ws;
    this.cfg = cfg;
    this.db = new DatabaseSync(ws.ledger, { readOnly: true });
  }

  close(): void {
    this.db.close();
  }

  private all(sql: string, ...args: (string | number)[]): any[] {
    return this.db.prepare(sql).all(...args) as any[];
  }

  private hasTable(name: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
  }

  summary() {
    const counts = Object.fromEntries(
      this.all("SELECT status, COUNT(*) AS n FROM jobs GROUP BY status").map((r) => [r.status, r.n]),
    ) as Record<string, number>;
    const inList = `(${ATTEMPTED.slice(0, 5).map(() => "?").join(",")})`;
    const today = (this.db
      .prepare(`SELECT COUNT(*) AS n FROM jobs WHERE status IN ${inList} AND COALESCE(submitted_at, prepared_at) >= ?`)
      .get(...ATTEMPTED.slice(0, 5), dayAgo()) as { n: number }).n;
    const outcomes = Object.fromEntries(
      this.all("SELECT outcome, COUNT(*) AS n FROM jobs WHERE outcome IS NOT NULL GROUP BY outcome").map((r) => [r.outcome, r.n]),
    ) as Record<string, number>;
    const lastRun = this.hasTable("journal")
      ? (this.db.prepare("SELECT at FROM journal ORDER BY id DESC LIMIT 1").get() as { at: string } | undefined)?.at ?? null
      : null;
    const tracks = this.hasTable("tracks")
      ? this.all(
          `SELECT t.id, t.name, t.hypothesis, t.status,
             SUM(CASE WHEN j.status IN ('submitted','unconfirmed') THEN 1 ELSE 0 END) AS sent,
             SUM(CASE WHEN j.status IN ('ready','needs_human') THEN 1 ELSE 0 END) AS waiting,
             SUM(CASE WHEN j.outcome IN ('interview','offer') THEN 1 ELSE 0 END) AS interviews
           FROM tracks t LEFT JOIN jobs j ON j.track_id = t.id
           GROUP BY t.id ORDER BY t.id`,
        )
      : [];
    return {
      name: this.contactName(),
      submitMode: this.cfg.submit,
      quota: { today, maxPerDay: this.cfg.quota.maxPerDay },
      counts,
      outcomes,
      lastRun,
      tracks,
    };
  }

  private contactName(): string | null {
    try {
      const m = /^\s*name:\s*(.+)$/m.exec(readFileSync(this.ws.pool, "utf8"));
      return m ? m[1].trim().replace(/^["']|["']$/g, "") : null;
    } catch {
      return null;
    }
  }

  applications() {
    const marks = ATTEMPTED.map(() => "?").join(",");
    return this.all(
      `SELECT j.id, j.company, j.title, j.location, j.status, j.fit, j.reason, j.outcome, j.channel,
              j.prepared_at, j.submitted_at, j.updated_at, j.url, t.name AS track
       FROM jobs j LEFT JOIN tracks t ON t.id = j.track_id
       WHERE j.status IN (${marks})
       ORDER BY COALESCE(j.submitted_at, j.prepared_at, j.updated_at, j.discovered_at) DESC`,
      ...ATTEMPTED,
    );
  }

  screenedOut(limit = 300) {
    return this.all(
      `SELECT id, company, title, location, fit, reason, COALESCE(updated_at, discovered_at) AS at
       FROM jobs WHERE status = 'rejected' ORDER BY COALESCE(updated_at, discovered_at) DESC LIMIT ?`,
      limit,
    );
  }

  activity(limit = 60) {
    const journal = this.hasTable("journal") ? this.all("SELECT at, kind, text FROM journal ORDER BY id DESC LIMIT ?", limit) : [];
    const emails = this.hasTable("emails")
      ? this.all(
          `SELECT e.at, e.kind, e.from_domain, e.subject, j.company, j.title
           FROM emails e LEFT JOIN jobs j ON j.id = e.job_id WHERE e.job_id IS NOT NULL ORDER BY e.at DESC LIMIT 40`,
        )
      : [];
    return { journal, emails };
  }

  job(id: string) {
    const row = this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as any;
    if (!row) return null;
    const job = parse<Record<string, any>>(row.job_json, {});
    const screen = parse<Record<string, any>>(row.screen, {});
    const dir = packetDirIn(this.ws.applications, row.packet_dir);
    const files = dir ? readdirSync(dir).filter((f) => FILE_TYPES[extname(f).toLowerCase()]) : [];
    let packet: Record<string, any> | null = null;
    if (dir && existsSync(join(dir, "packet.json"))) {
      const p = parse<Record<string, any>>(readFileSync(join(dir, "packet.json"), "utf8"), {});
      packet = {
        keywords: p.keywords ?? null,
        readability: p.readability ? { ok: p.readability.ok, problems: p.readability.problems ?? [] } : null,
        bullets: Array.isArray(p.provenance) ? p.provenance.length : null,
        reworded: Array.isArray(p.provenance) ? p.provenance.filter((b: any) => b.label === "reworded").length : null,
      };
    }
    return {
      id: row.id,
      company: row.company,
      title: row.title,
      location: row.location,
      url: row.url,
      applyUrl: row.apply_url,
      status: row.status,
      fit: row.fit,
      reason: plainReason(row.reason),
      outcome: row.outcome,
      channel: row.channel,
      preparedAt: row.prepared_at,
      submittedAt: row.submitted_at,
      description: typeof job.description === "string" ? job.description.slice(0, 20_000) : "",
      salary: job.salaryMin || job.salaryMax ? { min: job.salaryMin ?? null, max: job.salaryMax ?? null } : null,
      screen: {
        factors: screen.factors ?? null,
        strengths: screen.strengths ?? [],
        gaps: screen.gaps ?? [],
        gates: screen.gates ?? [],
        warnings: screen.warnings ?? [],
      },
      packet,
      files,
    };
  }

  filePath(id: string, name: string): string | null {
    const row = this.db.prepare("SELECT packet_dir FROM jobs WHERE id = ?").get(id) as { packet_dir: string | null } | undefined;
    return row ? packetFile(this.ws.applications, row.packet_dir, name) : null;
  }
}

const SECURITY_HEADERS: Record<string, string> = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow",
};

function send(res: ServerResponse, status: number, type: string, body: string | Buffer, extra: Record<string, string> = {}): void {
  res.writeHead(status, { ...SECURITY_HEADERS, "Content-Type": type, ...extra });
  res.end(body);
}

const json = (res: ServerResponse, value: unknown) => send(res, 200, "application/json; charset=utf-8", JSON.stringify(value));

export function dashboardHandler(o: Pick<DashboardOptions, "ws" | "cfg" | "password">) {
  return (req: IncomingMessage, res: ServerResponse): void => {
    if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "text/plain", "read-only");
    if (!authorized(req.headers.authorization, o.password)) {
      return send(res, 401, "text/plain", "password required", { "WWW-Authenticate": 'Basic realm="Resumetron", charset="UTF-8"' });
    }
    const url = new URL(req.url ?? "/", "http://dashboard");
    const path = url.pathname;
    if (path === "/") {
      return send(res, 200, "text/html; charset=utf-8", DASHBOARD_HTML, {
        "Content-Security-Policy":
          "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-src 'self'; object-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      });
    }
    if (path === "/app.js") return send(res, 200, "text/javascript; charset=utf-8", DASHBOARD_JS);
    if (!existsSync(o.ws.ledger)) return send(res, 503, "text/plain", "no ledger yet: the first run creates it");
    const data = new DashboardData(o.ws, o.cfg);
    try {
      if (path === "/api/summary") return json(res, data.summary());
      if (path === "/api/applications") return json(res, data.applications());
      if (path === "/api/screened") return json(res, data.screenedOut());
      if (path === "/api/activity") return json(res, data.activity());
      const jm = /^\/api\/jobs\/([A-Za-z0-9_-]+)$/.exec(path);
      if (jm) {
        const job = data.job(jm[1]);
        return job ? json(res, job) : send(res, 404, "text/plain", "no such job");
      }
      const fm = /^\/files\/([A-Za-z0-9_-]+)\/([^/]+)$/.exec(path);
      if (fm) {
        const file = data.filePath(fm[1], decodeURIComponent(fm[2]));
        if (!file) return send(res, 404, "text/plain", "no such file");
        const name = file.split(/[\\/]/).pop() ?? "file";
        return send(res, 200, FILE_TYPES[extname(file).toLowerCase()], readFileSync(file), {
          "Content-Disposition": `inline; filename="${name.replace(/[^\w.-]/g, "_")}"`,
          "X-Frame-Options": "SAMEORIGIN",
        });
      }
      return send(res, 404, "text/plain", "not found");
    } catch (e) {
      return send(res, 500, "text/plain", e instanceof Error ? e.message : String(e));
    } finally {
      data.close();
    }
  };
}

export function startDashboard(o: DashboardOptions): Promise<string> {
  const server = createServer(dashboardHandler(o));
  return new Promise((ok, fail) => {
    server.once("error", fail);
    server.listen(o.port, o.host, () => ok(`http://${o.host === "0.0.0.0" ? "localhost" : o.host}:${o.port}`));
  });
}
