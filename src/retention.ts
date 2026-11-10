import { closeSync, existsSync, openSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config.ts";
import { FINISHED, type Ledger } from "./ledger.ts";
import type { Workspace } from "./workspace.ts";

// Everything the tool writes is bounded, so a cron job can run for months on a small VPS.

const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();
const olderThan = (path: string, days: number) => {
  try {
    return statSync(path).mtimeMs < Date.now() - days * 86_400_000;
  } catch {
    return false;
  }
};

export interface PruneReport {
  slimmed: number;
  deletedJobs: number;
  backlogDropped: number;
  packetsDeleted: number;
  screenshotsDeleted: number;
  logsDeleted: number;
}

export function prune(ws: Workspace, ledger: Ledger, r: Config["retention"]): PruneReport {
  const db = ledger.db;
  const report: PruneReport = { slimmed: 0, deletedJobs: 0, backlogDropped: 0, packetsDeleted: 0, screenshotsDeleted: 0, logsDeleted: 0 };

  // 1. Finished jobs keep only what dedupe, quotas, and history need: the posting text goes.
  report.slimmed = Number(
    db
      .prepare(`UPDATE jobs SET job_json = json_remove(job_json, '$.description') WHERE status IN ${FINISHED} AND json_extract(job_json, '$.description') IS NOT NULL`)
      .run().changes,
  );

  // 2. Old rejections and skips are deleted outright. Sent applications stay as history.
  report.deletedJobs = Number(
    db.prepare("DELETE FROM jobs WHERE status IN ('rejected','skipped') AND COALESCE(updated_at, discovered_at) < ?").run(daysAgo(r.tombstoneDays)).changes,
  );

  // 3. The waiting backlog is capped; the lowest-scored drop off and become dedupe records.
  report.backlogDropped = Number(
    db
      .prepare(
        `UPDATE jobs SET status = 'rejected', reason = 'dropped from a full backlog (low score)',
           job_json = json_remove(job_json, '$.description'), updated_at = ?
         WHERE id IN (SELECT id FROM jobs WHERE status IN ('discovered','matched') ORDER BY fit DESC, discovered_at DESC LIMIT -1 OFFSET ?)`,
      )
      .run(new Date().toISOString(), r.backlogMax).changes,
  );

  // 4. Memory tables are ring buffers.
  db.prepare("DELETE FROM journal WHERE id NOT IN (SELECT id FROM journal ORDER BY id DESC LIMIT ?)").run(r.journalMax);
  db.prepare("DELETE FROM queries WHERE status != 'active' AND id NOT IN (SELECT id FROM queries WHERE status != 'active' ORDER BY id DESC LIMIT ?)").run(r.inactiveQueriesMax);
  db.prepare("DELETE FROM probes WHERE at < ?").run(daysAgo(r.probeDays));
  db.prepare("DELETE FROM usage_daily WHERE day < ?").run(daysAgo(400).slice(0, 10));

  // 5. Packets: screenshots expire for anything not waiting on you; dead packets go entirely.
  const waiting = new Set((db.prepare("SELECT packet_dir FROM jobs WHERE status IN ('ready','needs_human') AND packet_dir IS NOT NULL").all() as any[]).map((x) => x.packet_dir));
  const deadRows = db
    .prepare("SELECT id, packet_dir FROM jobs WHERE status IN ('rejected','skipped','failed') AND packet_dir IS NOT NULL AND COALESCE(updated_at, discovered_at) < ?")
    .all(daysAgo(r.packetDays)) as any[];
  for (const row of deadRows) {
    rmSync(row.packet_dir, { recursive: true, force: true });
    db.prepare("UPDATE jobs SET packet_dir = NULL WHERE id = ?").run(row.id);
    report.packetsDeleted++;
  }
  const referenced = new Set((db.prepare("SELECT packet_dir FROM jobs WHERE packet_dir IS NOT NULL").all() as any[]).map((x) => x.packet_dir));
  if (existsSync(ws.applications)) {
    for (const name of readdirSync(ws.applications)) {
      const dir = join(ws.applications, name);
      // Previews and leftovers no job points at.
      if (!referenced.has(dir) && olderThan(dir, r.packetDays)) {
        rmSync(dir, { recursive: true, force: true });
        report.packetsDeleted++;
        continue;
      }
      if (waiting.has(dir) || !existsSync(dir)) continue;
      for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        if (f.endsWith(".png") && olderThan(p, r.screenshotsDays)) {
          unlinkSync(p);
          report.screenshotsDeleted++;
        }
      }
    }
  }

  // 6. Run logs rotate daily.
  const logs = join(ws.root, "logs");
  if (existsSync(logs)) {
    for (const f of readdirSync(logs)) {
      if (olderThan(join(logs, f), r.logDays)) {
        unlinkSync(join(logs, f));
        report.logsDeleted++;
      }
    }
  }

  // 7. Hand freed pages back to the filesystem and fold the write-ahead log in.
  db.exec("PRAGMA incremental_vacuum; PRAGMA wal_checkpoint(TRUNCATE);");
  return report;
}

export function dirSize(path: string): number {
  if (!existsSync(path)) return 0;
  const st = statSync(path);
  if (!st.isDirectory()) return st.size;
  return readdirSync(path).reduce((n, f) => n + dirSize(join(path, f)), 0);
}

export const formatBytes = (n: number) =>
  n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB` : n < 1024 ** 3 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${(n / 1024 ** 3).toFixed(2)} GB`;

/**
 * One run at a time: a second scheduled run that starts while the first is still going
 * would double the browser's memory. A lock left by a crashed run is ignored after a few hours.
 */
export function acquireRunLock(root: string, staleHours = 6): () => void {
  const path = join(root, "run.lock");
  if (existsSync(path)) {
    try {
      const { pid, at } = JSON.parse(readFileSync(path, "utf8"));
      const alive = (() => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      })();
      if (alive && Date.now() - Date.parse(at) < staleHours * 3_600_000) {
        throw new Error(`another run (pid ${pid}) is in progress since ${at}`);
      }
    } catch (e) {
      if (e instanceof Error && e.message.startsWith("another run")) throw e;
    }
    unlinkSync(path);
  }
  const fd = openSync(path, "wx"); // fails if another process won the race
  writeFileSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
  closeSync(fd);
  return () => {
    try {
      unlinkSync(path);
    } catch {}
  };
}
