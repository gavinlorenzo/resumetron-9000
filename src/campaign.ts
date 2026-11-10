import { z } from "zod";
import type { Config } from "./config.ts";
import { type BoardRow, type ExclusionKind, type ExclusionRow, type Ledger, companyKey } from "./ledger.ts";
import { type Llm, completeJson } from "./llm/index.ts";
import { docToText } from "./resume/compose.ts";
import type { Goal, Job, Pool } from "./schema.ts";
import { type SearchSource, type SourceSet, searchSources } from "./sources.ts";
import { errorMessage, escapeRegex, normalize, sleep } from "./util.ts";

// The search side of a job hunt. Every board and query is a row with a cursor and yield
// stats, so each run re-checks page 1 for fresh postings and digs deeper where digging pays.
// Seen jobs never resurface (the ledger dedupes), exhausted searches retire, and a planner
// widens or narrows the search from what the stats show.

export interface CampaignCtx {
  cfg: Config;
  goal: Goal;
  pool: Pool;
  ledger: Ledger;
  llm: Llm;
  sources: SourceSet;
  log: (s: string) => void;
}

const POLITE_DELAY_MS = 300;

/** Puts goal.yaml's boards and searches into the campaign. Rows the campaign already knows are left alone. */
export function syncGoal(ctx: CampaignCtx): void {
  const { ledger, goal, cfg } = ctx;
  for (const c of goal.companies) ledger.addBoard(c.ats, c.token, c.name ?? c.token, "goal");
  for (const s of goal.searches)
    for (const source of searchSources(cfg, goal.remoteOk)) ledger.addQuery(source, s.query, s.location ?? "", "goal", "from goal.yaml");
}

/** Pulls new postings from boards and searches within the per-run request budget. */
export async function gather(ctx: CampaignCtx): Promise<{ requests: number; fresh: number; seen: number }> {
  const { ledger, cfg, goal, sources, log } = ctx;
  const c = cfg.campaign;
  let budget = c.maxRequestsPerRun;
  const out = { requests: 0, fresh: 0, seen: 0 };

  for (const b of ledger.boards("active")) {
    if (budget <= 0) break;
    if (b.last_swept_at && Date.now() - Date.parse(b.last_swept_at) < c.boardSweepHours * 3_600_000) continue;
    budget--;
    out.requests++;
    const r = await sweepBoard(ctx, b);
    out.fresh += r.fresh;
    out.seen += r.seen;
  }

  const usable = new Set(searchSources(cfg, goal.remoteOk));
  const queries = ledger
    .queries("active")
    .filter((q) => usable.has(q.source as SearchSource))
    // Untried searches first, then the ones whose results most often pass screening.
    .sort((a, b) => (a.runs === 0 ? -1 : 0) - (b.runs === 0 ? -1 : 0) || (b.matched + 1) / (b.fresh + 3) - (a.matched + 1) / (a.fresh + 3));

  for (const q of queries) {
    if (budget <= 0) break;
    const pages = [1];
    for (let p = Math.max(q.next_page, 2); q.next_page > 0 && pages.length < c.maxPagesPerQuery; p++) pages.push(p);
    let next = q.next_page;
    let fresh = 0;
    let seen = 0;
    for (const page of pages) {
      if (budget <= 0) break;
      budget--;
      out.requests++;
      try {
        const r = await sources.search(q.source as SearchSource, q.query, q.location, page);
        const added = ledger.addJobs(r.jobs, `q:${q.id}`);
        fresh += added.fresh;
        seen += r.jobs.length;
        if (!r.more) {
          next = 0;
          break;
        }
        if (page > 1) next = page + 1;
      } catch (e) {
        log(`  search "${q.query}" on ${q.source} failed: ${errorMessage(e)}`);
        break;
      }
      await sleep(POLITE_DELAY_MS);
    }
    const status = ledger.queryRan(q.id, { seen, fresh, next, exhaustAfter: c.exhaustAfterEmptyRuns });
    if (status === "exhausted") ledger.note("search", `retired "${q.query}" on ${q.source}: covered (${q.fresh + fresh} new jobs over ${q.runs + 1} runs)`);
    out.fresh += fresh;
    out.seen += seen;
  }
  return out;
}

async function sweepBoard(ctx: CampaignCtx, b: BoardRow): Promise<{ fresh: number; seen: number }> {
  try {
    const jobs = await ctx.sources.sweep(b.ats, b.token, b.company);
    const r = ctx.ledger.addJobs(jobs, `b:${b.ats}:${b.token}`);
    ctx.ledger.boardSwept(b, r);
    await sleep(POLITE_DELAY_MS);
    return r;
  } catch (e) {
    ctx.ledger.boardSwept(b, null);
    ctx.log(`  board ${b.ats}:${b.token} failed: ${errorMessage(e)}`);
    return { fresh: 0, seen: 0 };
  }
}

/**
 * Reads boards that have never been read. Run right after discovery, so a match found
 * through an aggregator can be upgraded to the employer's own, fillable form in the same run.
 */
export async function sweepNewBoards(ctx: CampaignCtx): Promise<number> {
  let fresh = 0;
  for (const b of ctx.ledger.boards("active").filter((x) => !x.last_swept_at)) fresh += (await sweepBoard(ctx, b)).fresh;
  return fresh;
}

// ---------------- exclusions ----------------

const phrase = (p: string) => new RegExp(`(^|[^a-z0-9])${escapeRegex(normalize(p))}($|[^a-z0-9])`);

export function matchesExclusion(e: Pick<ExclusionRow, "kind" | "pattern">, job: Pick<Job, "id" | "title" | "company" | "description">): boolean {
  switch (e.kind) {
    case "job":
      return job.id === e.pattern || job.id.startsWith(e.pattern);
    case "company":
      return companyKey(job.company) === companyKey(e.pattern);
    case "title":
      return phrase(e.pattern).test(normalize(job.title));
    case "keyword":
      return phrase(e.pattern).test(normalize(`${job.title} ${job.description ?? ""}`));
  }
}

/** Evidence for an agent-proposed exclusion: screened rejections it explains versus jobs worth applying to it would block. */
export function exclusionEvidence(ledger: Ledger, kind: ExclusionKind, pattern: string): { rejected: number; kept: number } {
  let rejected = 0;
  let kept = 0;
  for (const r of ledger.decided()) {
    if (!matchesExclusion({ kind, pattern }, { id: "", title: r.title, company: r.company, description: "" })) continue;
    if (r.status === "rejected") rejected++;
    else kept++;
  }
  return { rejected, kept };
}

// ---------------- planner ----------------

const Plan = z.object({
  addQueries: z.array(z.object({ query: z.string(), location: z.string().optional(), why: z.string().default("") })).default([]),
  retire: z.array(z.number()).default([]),
  addCompanies: z.array(z.object({ name: z.string(), why: z.string().default("") })).default([]),
  addExclusions: z
    .array(z.object({ kind: z.enum(["title", "company"]), pattern: z.string(), reason: z.string().default("") }))
    .default([]),
  note: z.string().default(""),
});
export type Plan = z.infer<typeof Plan>;

const PLANNER_SYSTEM = `You run the search side of one person's job hunt. Each run you see their background and goal, what every search so far has produced, and why screened jobs were turned down. You decide how to search next. The software executes searches, reads results page by page, never shows the same posting twice, and retires searches that stop producing anything new. Your job is to keep it pointed at productive, unexplored ground.

- Queries are what a person would type into a job board: 1-4 words, usually a role title or a skill plus a role. Spread them across the role titles the goal names, adjacent roles their background genuinely supports, and the different vocabulary sectors use for the same work (government, nonprofit, corporate, startup).
- Lean into what is working: searches whose results pass screening deserve variations. Retire an active search (by id) only once its results have been screened and keep failing; the software declines a retirement until at least three of a search's jobs have been screened with none passing, or the search has gone dry. Results wait in a backlog and are screened a few per run, so a new search with zero passes usually just hasn't been judged yet.
- Companies: name specific employers likely to hire someone with this background. The software checks whether each has a public job board and, if so, reads all of its openings.
- Exclusions remove jobs before anyone spends effort on them. Propose a title or company exclusion only for a pattern you see rejected again and again in the evidence. The software accepts one only when at least three screened jobs were rejected under it and none worth applying to would be blocked.
- A weekly strategist sets the campaign's hypotheses ("strategy tracks"). Your searches should serve those tracks: fill gaps in their coverage rather than opening unrelated directions.
- In "note", write one or two sentences on what you're seeing and why you made these changes. It is the campaign's memory for future runs.`;

const PLAN_SHAPE = `{"addQueries": [{"query": "", "location": "", "why": ""}], "retire": [<query id>], "addCompanies": [{"name": "", "why": ""}], "addExclusions": [{"kind": "title|company", "pattern": "", "reason": ""}], "note": ""}`;

export async function planCampaign(ctx: CampaignCtx): Promise<Plan> {
  const { ledger, goal, cfg } = ctx;
  const sources = searchSources(cfg, goal.remoteOk);
  const qs = ledger.queries();
  const stats = {
    searchSources: sources.length ? sources : "none configured: propose companies instead of queries",
    activeSearches: qs.filter((q) => q.status === "active").slice(-60).map((q) => ({ id: q.id, source: q.source, query: q.query, location: q.location, runs: q.runs, newJobs: q.fresh, screened: q.screened, passedScreening: q.matched })),
    coveredSearches: qs.filter((q) => q.status !== "active").slice(-40).map((q) => `${q.query} (${q.source}, ${q.status}, ${q.fresh} new, ${q.matched} passed)`),
    boards: ledger.boards().slice(-60).map((b) => `${b.company} (${b.status}, ${b.seen} open, ${b.matched} passed)`),
    strategyTracks: ledger.tracks("proposed", "active", "cemented").map((t) => `${t.name}: ${t.hypothesis}`),
    exclusions: ledger.exclusions().map((e) => `${e.kind}: ${e.pattern}`),
    recentRejections: ledger.recentRejections(40).map((r) => `${r.title}: ${r.reason.replace(/^screened: /, "")}`),
    recentNotes: ledger.journal(8).map((j) => j.text),
    pipeline: ledger.counts(),
  };
  return completeJson(
    ctx.llm,
    {
      purpose: "plan",
      maxTokens: 6000,
      system: PLANNER_SYSTEM,
      stable: `GOAL (breadth: ${goal.breadth}):\n${JSON.stringify({ summary: goal.summary, targetRoles: goal.targetRoles, locations: goal.locations, remoteOk: goal.remoteOk, dealbreakers: goal.dealbreakers })}\n\nBACKGROUND:\n${docToText(ctx.pool).slice(0, 6000)}`,
      messages: [{ role: "user", content: `CAMPAIGN STATE:\n${JSON.stringify(stats)}` }],
    },
    Plan,
    PLAN_SHAPE,
  );
}

/** Applies a plan within limits. Returns what changed, for the journal. */
export function applyPlan(ctx: CampaignCtx, plan: Plan): string[] {
  const { ledger, goal, cfg } = ctx;
  const done: string[] = [];
  const sources = searchSources(cfg, goal.remoteOk);
  let added = 0;
  for (const q of plan.addQueries) {
    if (added >= cfg.campaign.maxNewQueriesPerRun || !q.query.trim()) break;
    let any = false;
    for (const s of sources) any = ledger.addQuery(s, q.query, q.location ?? "", "agent", q.why) || any;
    if (any) {
      added++;
      done.push(`+search "${q.query}"${q.location ? ` in ${q.location}` : ""}`);
    }
  }
  const active = new Map(ledger.queries("active").map((q) => [q.id, q]));
  for (const id of plan.retire) {
    const q = active.get(id);
    if (!q) continue;
    // Retiring needs evidence: screened results that all failed, or a search that has gone dry.
    const failing = q.screened >= 3 && q.matched === 0;
    const dry = q.runs >= 2 && q.fresh === 0;
    if (!failing && !dry) {
      done.push(`kept "${q.query}" (${q.screened} screened so far; too early to judge)`);
      continue;
    }
    if (ledger.retireQuery(id)) done.push(`-search "${q.query}"`);
  }
  const pending: string[] = JSON.parse(ledger.meta("pendingCompanies") ?? "[]");
  for (const c of plan.addCompanies) if (c.name.trim() && !pending.includes(c.name)) pending.push(c.name.trim());
  ledger.setMeta("pendingCompanies", JSON.stringify(pending.slice(-50)));
  if (plan.addCompanies.length) done.push(`companies to look up: ${plan.addCompanies.map((c) => c.name).join(", ")}`);

  const protectedTitles = [...goal.targetRoles, ...goal.titleInclude];
  for (const x of plan.addExclusions) {
    const pattern = x.pattern.trim();
    if (pattern.length < 3) continue;
    if (x.kind === "title" && protectedTitles.some((t) => phrase(pattern).test(normalize(t)))) {
      done.push(`declined exclusion "${pattern}": it would block a target role`);
      continue;
    }
    const ev = exclusionEvidence(ledger, x.kind, pattern);
    if (ev.rejected >= 3 && ev.kept === 0) {
      if (ledger.addExclusion(x.kind, pattern, "agent", `${x.reason} (${ev.rejected} rejected, 0 kept)`)) done.push(`excluded ${x.kind} "${pattern}"`);
    } else {
      done.push(`declined exclusion "${pattern}": evidence ${ev.rejected} rejected, ${ev.kept} kept`);
    }
  }
  return done;
}

/** Looks up job boards for companies that produced a match, plus ones the planner named. */
export async function discoverBoards(ctx: CampaignCtx, fromMatches: string[]): Promise<string[]> {
  const { ledger, sources, cfg } = ctx;
  if (!cfg.campaign.discoverBoards) return [];
  const pending: string[] = JSON.parse(ledger.meta("pendingCompanies") ?? "[]");
  const known = new Set(ledger.boards().map((b) => companyKey(b.company)));
  const candidates = [...new Set([...fromMatches, ...pending])].filter((c) => !known.has(companyKey(c)) && ledger.probe(c) === undefined);
  const found: string[] = [];
  const tried: string[] = [];
  for (const company of candidates.slice(0, cfg.campaign.maxProbesPerRun)) {
    tried.push(company);
    try {
      const board = await sources.findBoard(company);
      ledger.setProbe(company, board ? `${board.ats}:${board.token}` : null);
      if (board && ledger.addBoard(board.ats, board.token, company, "discovered")) {
        found.push(`${company} (${board.ats}:${board.token})`);
      }
    } catch {}
  }
  ledger.setMeta("pendingCompanies", JSON.stringify(pending.filter((p) => !tried.includes(p))));
  if (found.length) ledger.note("boards", `found job boards for ${found.join(", ")}; they'll be read in full`);
  return found;
}
