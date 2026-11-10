import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { BASELINE, FLOOR, benchmarkBrief, exposure } from "./benchmarks.ts";
import type { Config } from "./config.ts";
import type { Ledger, TrackRow } from "./ledger.ts";
import { type Llm, completeJson } from "./llm/index.ts";
import { docToText } from "./resume/compose.ts";
import type { Goal, Pool } from "./schema.ts";
import { searchSources } from "./sources.ts";
import { type Posterior, probBelow, thompsonShares } from "./stats.ts";

// The strategy layer. A track is a hypothesis: "this kind of role, at these kinds of
// employers, is where this person gets interviews." Tracks share the daily quota by how
// well they're doing; a weekly review refines, pivots, or cements them.
//
// The model writes and revises hypotheses. Whether a track is failing or proven is
// decided here, by statistics against published base rates, so a quiet month in a slow
// market is read as a quiet month.

export interface StrategyCtx {
  cfg: Config;
  goal: Goal;
  pool: Pool;
  ledger: Ledger;
  llm: Llm;
  root: string; // workspace root, for strategy memos
  log: (s: string) => void;
  now?: Date;
}

export type Verdict = "too_early" | "inconclusive" | "underperforming" | "outperforming";

export interface TrackStats {
  track: TrackRow;
  sent: number;
  interviews: number;
  rejections: number;
  /** Applications counted as resolved: each weighted by how far through the typical reply window it is. */
  effective: number;
  posterior: Posterior;
  /** P(true interview rate < FLOOR) */
  pBelowFloor: number;
  /** P(true interview rate > baseline) */
  pAboveBaseline: number;
  /** How likely zero interviews would be by now at the baseline rate. */
  pZeroAtBaseline: number;
  verdict: Verdict;
}

/** Prior: centered on the benchmark, weak enough that a few weeks of real data dominate it. */
const PRIOR_STRENGTH = 20;
const MIN_EFFECTIVE = 30;

export function trackStats(ledger: Ledger, mode: Config["mode"], now = new Date()): TrackStats[] {
  const base = BASELINE[mode];
  const apps = ledger.sentApplications(400);
  return ledger.tracks().map((track) => {
    const mine = apps.filter((a) => a.track_id === track.id);
    let effective = 0;
    let interviews = 0;
    let rejections = 0;
    for (const a of mine) {
      const positive = a.outcome === "interview" || a.outcome === "offer";
      if (positive) interviews++;
      if (a.outcome === "rejected") rejections++;
      // A rejection is a resolved "no"; silence counts in proportion to how long it has had.
      const days = (now.getTime() - Date.parse(a.submitted_at)) / 86_400_000;
      effective += positive || a.outcome === "rejected" ? 1 : exposure(days);
    }
    const posterior = { a: base * PRIOR_STRENGTH + interviews, b: (1 - base) * PRIOR_STRENGTH + Math.max(0, effective - interviews) };
    const pBelowFloor = probBelow(posterior, FLOOR, 6000, track.id);
    const pAboveBaseline = 1 - probBelow(posterior, base, 6000, track.id + 1);
    let verdict: Verdict = "inconclusive";
    if (effective < MIN_EFFECTIVE && interviews < 2) verdict = "too_early";
    else if (pBelowFloor >= 0.9) verdict = "underperforming";
    else if (pAboveBaseline >= 0.8 && interviews >= 2) verdict = "outperforming";
    return {
      track,
      sent: mine.length,
      interviews,
      rejections,
      effective: Math.round(effective * 10) / 10,
      posterior,
      pBelowFloor,
      pAboveBaseline,
      pZeroAtBaseline: (1 - base) ** effective,
      verdict,
    };
  });
}

/**
 * Splits the quota across live tracks: Thompson sampling on their posteriors, then floors
 * so every active track keeps getting tried, cemented tracks keep a protected share, and
 * proposed tracks share a small exploration slice.
 */
export function allocate(stats: TrackStats[], s: Config["strategy"]): Map<number, number> {
  const live = stats.filter((x) => ["active", "cemented"].includes(x.track.status));
  const proposed = stats.filter((x) => x.track.status === "proposed");
  const out = new Map<number, number>();
  const exploreTotal = proposed.length ? (live.length ? s.explorationShare : 1) : 0;
  for (const p of proposed) out.set(p.track.id, exploreTotal / proposed.length);
  if (!live.length) return out;
  const raw = thompsonShares(live.map((x) => x.posterior), 4000, 7);
  const floors = live.map((x) => (x.track.status === "cemented" ? s.cementedMinShare : s.minShare));
  const floorSum = floors.reduce((a, b) => a + b, 0);
  const budget = 1 - exploreTotal;
  // If the floors alone exceed the budget, split it by floors; otherwise floors plus a Thompson-weighted remainder.
  live.forEach((x, i) => {
    const share = floorSum >= 1 ? floors[i] / floorSum : floors[i] + raw[i] * (1 - floorSum);
    out.set(x.track.id, share * budget);
  });
  return out;
}

/** Turns shares into whole application slots for this run; leftovers go to the largest remainders. */
export function slots(shares: Map<number, number>, room: number): Map<number, number> {
  const entries = [...shares.entries()].map(([id, s]) => ({ id, exact: s * room }));
  const out = new Map(entries.map((e) => [e.id, Math.floor(e.exact)]));
  let left = room - [...out.values()].reduce((a, b) => a + b, 0);
  for (const e of entries.sort((a, b) => (b.exact % 1) - (a.exact % 1))) {
    if (left <= 0) break;
    out.set(e.id, out.get(e.id)! + 1);
    left--;
  }
  return out;
}

// ---------------- the hypothesis loop ----------------

const NewTrack = z.object({
  name: z.string(),
  hypothesis: z.string(),
  roles: z.array(z.string()).default([]),
  queries: z.array(z.string()).default([]),
  employers: z.array(z.string()).default([]),
});

const Review = z.object({
  memo: z.string(),
  actions: z
    .array(
      z.object({
        trackId: z.number(),
        action: z.enum(["keep", "refine", "retire", "cement"]),
        hypothesis: z.string().optional(),
        queries: z.array(z.string()).default([]),
        employers: z.array(z.string()).default([]),
        reason: z.string().default(""),
      }),
    )
    .default([]),
  newTracks: z.array(NewTrack).default([]),
});
type Review = z.infer<typeof Review>;

const STRATEGIST = `You are the strategist for one person's job search. You think in hypotheses: each "track" is a bet that a particular kind of role, at a particular kind of employer, is where this person is most likely to land interviews. A good track is specific enough to search for and to tailor toward, and is grounded in something concrete in their background that makes them competitive there.

The job market is slow and noisy. Interview rates around 3-5% per application are normal, replies take weeks to months, and long silences are expected. The software computes each track's statistics and a verdict against published benchmarks: too_early, inconclusive, underperforming, or outperforming. Trust those verdicts over your impressions of the raw counts. A track can only be retired when its verdict is underperforming, and only cemented when it is outperforming; other retire or cement actions are declined.

What you can always do is refine: sharpen a hypothesis using what screening and replies reveal (which titles and employers pass screening, what rejections cite, where interviews came from), and add search queries (1-4 words, as typed into a job board) and employers to look at. You can also propose new tracks to explore alongside the current ones.

Write the memo for the job seeker: plain language, under 250 words, what the evidence says this week, what you're changing and why, and what you're watching for next. Honest about uncertainty, never alarmist about normal silence.`;

const REVIEW_SHAPE = `{"memo": "<markdown>", "actions": [{"trackId": 1, "action": "keep|refine|retire|cement", "hypothesis": "<revised, for refine>", "queries": [], "employers": [], "reason": ""}],
 "newTracks": [{"name": "", "hypothesis": "", "roles": [], "queries": [], "employers": []}]}`;

const BOOTSTRAP = `You are the strategist for one person's job search. Turn their background and goal into a small portfolio of hypotheses ("tracks") about where they are most likely to land interviews. Each track names a kind of role at a kind of employer, says concretely why this person is competitive there (cite their actual experience), and lists the role titles, search queries (1-4 words, as typed into a job board), and specific employers that fit it.

For a focused goal, one or two tracks that cover the stated roles. For a broad goal, three to five genuinely different bets, from the obvious fit to credible stretches that their transferable experience supports. Then write a short memo (under 200 words) for the job seeker explaining the bets and what the software will learn over the coming weeks.`;

const BOOTSTRAP_SHAPE = `{"memo": "<markdown>", "tracks": [{"name": "", "hypothesis": "", "roles": [], "queries": [], "employers": []}]}`;

const due = (ctx: StrategyCtx) => {
  const last = ctx.ledger.meta("lastReview");
  const now = (ctx.now ?? new Date()).getTime();
  return !last || now - Date.parse(last) >= ctx.cfg.strategy.reviewEveryDays * 86_400_000;
};

/** Runs the opening hypotheses or the weekly review when one is due. Returns the memo path, if any. */
export async function maybeReview(ctx: StrategyCtx, force = false): Promise<string | null> {
  const live = ctx.ledger.tracks("proposed", "active", "cemented");
  if (!live.length) return bootstrap(ctx);
  if (!force && !due(ctx)) return null;
  return weeklyReview(ctx);
}

async function bootstrap(ctx: StrategyCtx): Promise<string> {
  const { ledger, goal } = ctx;
  const r = await completeJson(
    ctx.llm,
    {
      purpose: "strategy",
      maxTokens: 8000,
      system: BOOTSTRAP,
      messages: [{ role: "user", content: `GOAL (breadth: ${goal.breadth}):\n${JSON.stringify({ summary: goal.summary, targetRoles: goal.targetRoles, locations: goal.locations, remoteOk: goal.remoteOk, dealbreakers: goal.dealbreakers, notes: goal.notes })}\n\nBACKGROUND:\n${docToText(ctx.pool).slice(0, 8000)}` }],
    },
    z.object({ memo: z.string(), tracks: z.array(NewTrack).min(1) }),
    BOOTSTRAP_SHAPE,
  );
  const lines: string[] = [];
  // The opening bets are all live: there is no evidence yet to rank them.
  for (const t of r.tracks.slice(0, ctx.cfg.strategy.maxTracks)) lines.push(createTrack(ctx, t, "active"));
  return writeMemo(ctx, `# Opening strategy\n\n${r.memo}\n\n## Tracks\n\n${lines.join("\n")}\n`);
}

async function weeklyReview(ctx: StrategyCtx): Promise<string> {
  const { ledger, cfg } = ctx;
  const stats = trackStats(ledger, cfg.mode, ctx.now);
  const shares = allocate(stats, cfg.strategy);
  const apps = ledger.sentApplications(120);
  const state = stats
    .filter((s) => s.track.status !== "retired")
    .map((s) => ({
      id: s.track.id,
      name: s.track.name,
      status: s.track.status,
      hypothesis: s.track.hypothesis,
      roles: s.track.roles,
      applicationsSent: s.sent,
      resolvedEquivalent: s.effective,
      interviews: s.interviews,
      rejections: s.rejections,
      verdict: s.verdict,
      chanceOfZeroInterviewsByNowAtBenchmark: Math.round(s.pZeroAtBaseline * 100) / 100,
      quotaShare: Math.round((shares.get(s.track.id) ?? 0) * 100) / 100,
      // Supply: a track that finds few postings has a search problem, not a hypothesis problem.
      postingsScreened: (ledger.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE track_id = ? AND reason LIKE 'screened:%'").get(s.track.id) as any).n,
      searches: ledger.queries("active").filter((q) => q.track_id === s.track.id).map((q) => q.query),
      interviewsCameFrom: apps.filter((a) => a.track_id === s.track.id && (a.outcome === "interview" || a.outcome === "offer")).map((a) => `${a.title} at ${a.company}`),
      screeningPassed: ledger.db.prepare("SELECT title FROM jobs WHERE track_id = ? AND reason LIKE 'screened:%' AND status != 'rejected' ORDER BY updated_at DESC LIMIT 8").all(s.track.id).map((x: any) => x.title),
      screeningRejectedBecause: ledger.db.prepare("SELECT reason FROM jobs WHERE track_id = ? AND status = 'rejected' AND reason LIKE 'screened:%' ORDER BY updated_at DESC LIMIT 6").all(s.track.id).map((x: any) => String(x.reason).slice(10, 160)),
    }));
  const lastMemo = latestMemo(ctx.root);
  const r = await completeJson(
    ctx.llm,
    {
      purpose: "strategy",
      maxTokens: 10_000,
      system: STRATEGIST,
      stable: `BENCHMARKS:\n${benchmarkBrief(cfg.mode)}\n\nGOAL (breadth: ${ctx.goal.breadth}):\n${ctx.goal.summary}\n\nBACKGROUND:\n${docToText(ctx.pool).slice(0, 6000)}`,
      messages: [{ role: "user", content: `${lastMemo ? `LAST WEEK'S MEMO:\n${lastMemo.slice(0, 3000)}\n\n` : ""}TRACKS THIS WEEK:\n${JSON.stringify(state)}` }],
    },
    Review,
    REVIEW_SHAPE,
  );
  const changes = applyReview(ctx, r, stats);
  const table = stats
    .filter((s) => s.track.status !== "retired" || changes.some((c) => c.includes(s.track.name)))
    .map((s) => `| ${s.track.name} | ${s.track.status} | ${s.sent} | ${s.interviews} | ${s.verdict.replace("_", " ")} | ${Math.round((shares.get(s.track.id) ?? 0) * 100)}% |`)
    .join("\n");
  return writeMemo(
    ctx,
    `# Weekly strategy review\n\n${r.memo}\n\n| Track | Status | Sent | Interviews | Verdict | Quota share |\n|---|---|---|---|---|---|\n${table}\n\n## Changes\n\n${changes.map((c) => `- ${c}`).join("\n") || "- none"}\n`,
  );
}

/** Applies the strategist's decisions, declining any the statistics don't support. */
export function applyReview(ctx: StrategyCtx, r: Review, stats: TrackStats[]): string[] {
  const { ledger, cfg } = ctx;
  const out: string[] = [];
  for (const a of r.actions) {
    const s = stats.find((x) => x.track.id === a.trackId);
    if (!s || s.track.status === "retired") continue;
    const name = s.track.name;
    if (a.action === "retire") {
      if (s.verdict !== "underperforming") {
        out.push(`declined retiring "${name}": verdict is ${s.verdict.replace("_", " ")} (${s.sent} sent, ${s.interviews} interviews)`);
      } else {
        ledger.updateTrack(s.track.id, { status: "retired", note: a.reason });
        for (const q of ledger.queries("active").filter((q) => q.track_id === s.track.id)) ledger.retireQuery(q.id);
        out.push(`retired "${name}": ${a.reason}`);
      }
      continue;
    }
    if (a.action === "cement") {
      if (s.verdict !== "outperforming") out.push(`declined cementing "${name}": verdict is ${s.verdict.replace("_", " ")}`);
      else {
        ledger.updateTrack(s.track.id, { status: "cemented", note: a.reason });
        out.push(`cemented "${name}": ${a.reason}`);
      }
    }
    if (a.hypothesis && a.hypothesis !== s.track.hypothesis) {
      ledger.updateTrack(s.track.id, { hypothesis: a.hypothesis });
      out.push(`refined "${name}": ${a.hypothesis}`);
    }
    const added = addSearches(ctx, s.track.id, a.queries, a.employers);
    if (added) out.push(`"${name}": ${added}`);
  }
  // Proposed tracks graduate once they show results, or retire like any other.
  for (const s of stats.filter((x) => x.track.status === "proposed" && x.verdict === "outperforming")) {
    ledger.updateTrack(s.track.id, { status: "active" });
    out.push(`promoted "${s.track.name}" from exploration: it is outperforming`);
  }
  const liveCount = ledger.tracks("proposed", "active", "cemented").length;
  for (const t of r.newTracks.slice(0, Math.max(0, cfg.strategy.maxTracks - liveCount))) {
    out.push(createTrack(ctx, t, cfg.strategy.autoApprove ? "active" : "proposed"));
  }
  ledger.setMeta("lastReview", (ctx.now ?? new Date()).toISOString());
  return out;
}

function createTrack(ctx: StrategyCtx, t: z.infer<typeof NewTrack>, status: TrackRow["status"]): string {
  const id = ctx.ledger.addTrack(t.name, t.hypothesis, t.roles, status);
  const added = addSearches(ctx, id, t.queries, t.employers);
  return `- **${t.name}** (${status}): ${t.hypothesis}${added ? ` (${added})` : ""}`;
}

function addSearches(ctx: StrategyCtx, trackId: number, queries: string[], employers: string[]): string {
  const sources = searchSources(ctx.cfg, ctx.goal.remoteOk);
  let q = 0;
  for (const query of queries.slice(0, 8)) {
    let any = false;
    for (const s of sources) any = ctx.ledger.addQuery(s, query, "", "agent", `track ${trackId}`, trackId) || any;
    if (any) q++;
  }
  const pending: string[] = JSON.parse(ctx.ledger.meta("pendingCompanies") ?? "[]");
  const fresh = employers.map((e) => e.trim()).filter((e) => e && !pending.includes(e));
  ctx.ledger.setMeta("pendingCompanies", JSON.stringify([...pending, ...fresh].slice(-50)));
  return [q ? `${q} searches` : "", fresh.length ? `${fresh.length} employers to look up` : ""].filter(Boolean).join(", ");
}

// ---------------- memos ----------------

const memoDir = (root: string) => join(root, "strategy");
const MEMOS_KEPT = 12;

function writeMemo(ctx: StrategyCtx, body: string): string {
  const dir = memoDir(ctx.root);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${(ctx.now ?? new Date()).toISOString().slice(0, 10)}.md`);
  writeFileSync(path, body);
  // A quarter of weekly memos is plenty of history.
  const files = readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
  for (const f of files.slice(0, Math.max(0, files.length - MEMOS_KEPT))) unlinkSync(join(dir, f));
  ctx.ledger.note("strategy", `memo written: ${path}`);
  return path;
}

export function latestMemo(root: string): string | null {
  const dir = memoDir(root);
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
  return files.length ? readFileSync(join(dir, files[files.length - 1]), "utf8") : null;
}
