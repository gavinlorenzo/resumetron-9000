import type { Ledger } from "./ledger.ts";
import { normalize } from "./util.ts";

// The campaign's numbers, for you: where applications go, what comes back, which fit scores
// actually predict interviews, why jobs get turned down, and which gaps keep coming up.
// Rates come with 95% intervals and are withheld under 5 applications; the strategy layer
// (src/strategy.ts) is what acts on results, against published benchmarks.

/** Wilson score interval for a proportion: honest about small samples. */
export function wilson(k: number, n: number, z = 1.96): [number, number] {
  if (!n) return [0, 1];
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const m = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [Math.max(0, (c - m) / d), Math.min(1, (c + m) / d)];
}

export interface RateRow {
  key: string;
  sent: number;
  interviews: number;
  rejected: number;
  rate: number | null;
  ci: [number, number] | null;
}

const MIN_N = 5;

function rates(rows: { key: string; outcome: string | null }[]): RateRow[] {
  const by = new Map<string, { sent: number; interviews: number; rejected: number }>();
  for (const r of rows) {
    const b = by.get(r.key) ?? { sent: 0, interviews: 0, rejected: 0 };
    b.sent++;
    if (r.outcome === "interview" || r.outcome === "offer") b.interviews++;
    if (r.outcome === "rejected") b.rejected++;
    by.set(r.key, b);
  }
  return [...by.entries()]
    .map(([key, b]) => ({ key, ...b, rate: b.sent >= MIN_N ? b.interviews / b.sent : null, ci: b.sent >= MIN_N ? wilson(b.interviews, b.sent) : null }))
    .sort((a, b) => b.sent - a.sent);
}

const band = (fit: number | null) => (fit == null ? "unscored" : fit >= 90 ? "90+" : fit >= 80 ? "80-89" : fit >= 70 ? "70-79" : fit >= 60 ? "60-69" : "<60");

/** Groups a rejection reason into a category you can act on. */
export function reasonCategory(reason: string | null): string {
  const r = reason ?? "";
  if (r.startsWith("gate: ")) return `gate: ${r.slice(6).split(" (")[0]}`;
  if (r.startsWith("scam signal")) return "scam signal";
  if (r.startsWith("closed")) return "posting closed";
  if (r.startsWith("excluded")) return "your exclusions";
  if (r.startsWith("screened")) return "screening: not a fit";
  if (r.startsWith("low keyword")) return "keyword prefilter";
  if (/^title (contains|matches)/.test(r)) return "title filter";
  if (/^location|^not remote|^remote only/.test(r)) return "location";
  if (/^posted|expired/.test(r)) return "too old";
  if (/^pays/.test(r)) return "pay below your floor";
  if (r === "blocked company") return "blocked company";
  return r.split(/[:(]/)[0].trim() || "other";
}

export interface Report {
  funnel: Record<string, number>;
  outcomes: Record<string, number>;
  byFit: RateRow[];
  bySource: RateRow[];
  byChannel: RateRow[];
  rejections: { category: string; n: number }[];
  gaps: { gap: string; n: number; passedScreening: number }[];
}

export function buildReport(ledger: Ledger, days = 365): Report {
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const funnel = ledger.counts();
  const sent = ledger.db
    .prepare("SELECT fit, source, COALESCE(channel, 'form') AS channel, outcome FROM jobs WHERE status IN ('submitted','unconfirmed') AND submitted_at >= ?")
    .all(since) as { fit: number | null; source: string; channel: string; outcome: string | null }[];
  const outcomes: Record<string, number> = {};
  for (const s of sent) outcomes[s.outcome ?? "no reply yet"] = (outcomes[s.outcome ?? "no reply yet"] ?? 0) + 1;

  const rej = ledger.db.prepare("SELECT reason FROM jobs WHERE status = 'rejected' AND discovered_at >= ?").all(since) as { reason: string | null }[];
  const cats = new Map<string, number>();
  for (const r of rej) cats.set(reasonCategory(r.reason), (cats.get(reasonCategory(r.reason)) ?? 0) + 1);

  // Gaps screening named, across every screened job: what the market keeps asking you for.
  const screened = ledger.db
    .prepare("SELECT screen, status FROM jobs WHERE screen IS NOT NULL AND reason LIKE 'screened:%' AND discovered_at >= ?")
    .all(since) as { screen: string; status: string }[];
  const gaps = new Map<string, { label: string; n: number; passed: number }>();
  for (const s of screened) {
    const detail = JSON.parse(s.screen);
    for (const g of (detail.gaps ?? []) as string[]) {
      const k = normalize(g);
      if (!k) continue;
      const cur = gaps.get(k) ?? { label: g, n: 0, passed: 0 };
      cur.n++;
      if (s.status !== "rejected") cur.passed++;
      gaps.set(k, cur);
    }
  }
  return {
    funnel,
    outcomes,
    byFit: rates(sent.map((s) => ({ key: band(s.fit), outcome: s.outcome }))),
    bySource: rates(sent.map((s) => ({ key: s.source, outcome: s.outcome }))),
    byChannel: rates(sent.map((s) => ({ key: s.channel, outcome: s.outcome }))),
    rejections: [...cats.entries()].map(([category, n]) => ({ category, n })).sort((a, b) => b.n - a.n),
    gaps: [...gaps.values()].map((g) => ({ gap: g.label, n: g.n, passedScreening: g.passed })).sort((a, b) => b.n - a.n).slice(0, 15),
  };
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

export function formatRates(title: string, rows: RateRow[]): string[] {
  if (!rows.length) return [];
  return [
    title,
    ...rows.map(
      (r) =>
        `  ${r.key.padEnd(16)} ${String(r.sent).padStart(4)} sent  ${String(r.interviews).padStart(3)} interviews  ` +
        (r.rate === null ? `(rate withheld under ${MIN_N})` : `${pct(r.rate)}  [95%: ${pct(r.ci![0])} to ${pct(r.ci![1])}]`),
    ),
  ];
}
