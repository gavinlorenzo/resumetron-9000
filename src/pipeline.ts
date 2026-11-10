import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BrowserHost } from "./browser.ts";
import type { Config } from "./config.ts";
import { extractFields } from "./forms/extract.ts";
import { fillForm, submitForm } from "./forms/fill.ts";
import { type Resolution, resolveFields } from "./forms/resolve.ts";
import type { Ledger, JobRow } from "./ledger.ts";
import { BudgetExceededError, type Llm } from "./llm/index.ts";
import { goalKeywords, goalTargets, hardFilter, pickStandard, relevance, screenJob } from "./match.ts";
import { compose, docToText } from "./resume/compose.ts";
import { type CampaignCtx, applyPlan, discoverBoards, gather, matchesExclusion, planCampaign, sweepNewBoards, syncGoal } from "./campaign.ts";
import { type AnswerBank, type Goal, type Job, type Pool, type Standard, TailorPlan } from "./schema.ts";
import { type SourceSet, liveSources } from "./sources.ts";
import { tailorPlan, templateCoverLetter, writeCoverLetter } from "./tailor.ts";
import { errorMessage, safeFileName, sleep } from "./util.ts";
import type { Workspace } from "./workspace.ts";

export interface Ctx {
  ws: Workspace;
  cfg: Config;
  pool: Pool;
  goal: Goal;
  bank: AnswerBank;
  standards: Standard[];
  ledger: Ledger;
  llm: Llm;
  browser: BrowserHost;
  log: (s: string) => void;
  sources?: SourceSet;
}

export interface RunOptions {
  dryRun?: boolean;
  mode?: Config["mode"];
}

export interface Packet {
  dir: string;
  resumePath: string;
  resumeText: string;
  coverPath?: string;
  coverText?: string;
}

/** One scheduled pass: plan, search, filter, screen, prepare, (in auto mode) submit, and prune. */
export async function run(ctx: Ctx, opts: RunOptions = {}): Promise<Record<string, number>> {
  const { cfg, goal, ledger, log } = ctx;
  const mode = opts.mode ?? cfg.mode;
  const tally: Record<string, number> = {};
  const bump = (k: string) => (tally[k] = (tally[k] ?? 0) + 1);
  const camp: CampaignCtx = { cfg, goal, pool: ctx.pool, ledger, llm: ctx.llm, sources: ctx.sources ?? liveSources(cfg), log };
  const runNo = Number(ledger.meta("runs") ?? 0) + 1;
  ledger.setMeta("runs", String(runNo));

  // 0. Plan: widen or narrow the search from what earlier runs found.
  syncGoal(camp);
  const every = cfg.campaign.plannerEveryRuns;
  const planHere = every > 0 && runNo % every === 0 && (mode === "tailored" || cfg.campaign.plannerInEfficiencyMode);
  if (planHere) {
    try {
      const plan = await planCampaign(camp);
      const changes = applyPlan(camp, plan);
      ledger.note("plan", [plan.note, ...changes].filter(Boolean).join(" | "));
      if (changes.length) log(`Planner: ${changes.join("; ")}`);
    } catch (e) {
      log(`  planner skipped: ${errorMessage(e)}`);
    }
  }

  // 1. Search.
  const boards = ledger.boards("active").length;
  const queries = ledger.queries("active").length;
  log(`Searching ${boards} company board(s) and ${queries} active search(es)...`);
  const got = await gather(camp);
  tally.new = got.fresh;
  log(`  ${got.requests} request(s), ${got.seen} postings, ${got.fresh} new.`);

  // 2. Free filters on everything not yet judged. Broad campaigns rank instead of rejecting on keywords.
  const broad = goal.breadth === "broad";
  const exclusions = ledger.exclusions();
  const targets = broad ? [...goalTargets(goal), ...ledger.queries("active").map((q) => q.query)] : goalTargets(goal);
  const keywords = broad ? [...new Set([...goalKeywords(goal), ...poolTags(ctx.pool)])] : goalKeywords(goal);
  const hits = new Map<number, number>();
  for (const row of ledger.byStatus("discovered")) {
    const job = ledger.job(row);
    const ex = exclusions.find((e) => matchesExclusion(e, job));
    if (ex) hits.set(ex.id, (hits.get(ex.id) ?? 0) + 1);
    const why = ex ? `excluded (${ex.kind}: ${ex.pattern})` : hardFilter(job, goal, cfg, ctx.pool.contact.country);
    const score = relevance(job, targets, keywords);
    if (why) ledger.setStatus(row.id, "rejected", { reason: why });
    else if (!broad && score < cfg.matching.minKeywordScore) ledger.setStatus(row.id, "rejected", { reason: `low keyword match (${score.toFixed(2)})` });
    else {
      ledger.setStatus(row.id, "matched", { fit: Math.round(score * 100), reason: "keyword match" });
      continue;
    }
    bump("rejected");
  }
  for (const [id, n] of hits) ledger.hitExclusion(id, n);

  let room = Math.min(cfg.quota.maxPerRun, cfg.quota.maxPerDay - ledger.usedToday());
  if (room <= 0) {
    log("Daily quota reached; nothing more to prepare today.");
    return tally;
  }
  const matchedCompanies: string[] = [];

  // 2. Rank what's left. Tailored mode asks the model; efficiency mode matches standards.
  type Pick = { row: JobRow; job: Job; standard?: Standard };
  const picks: Pick[] = [];
  const pending = ledger.byStatus("matched");
  if (mode === "efficiency") {
    if (!ctx.standards.length) throw new Error("efficiency mode needs at least one standard resume: run `resumetron standard build`");
    for (const row of pending) {
      const job = ledger.job(row);
      const best = pickStandard(job, ctx.standards, cfg.efficiency.minStandardScore);
      if (best) picks.push({ row, job, standard: best.standard });
    }
  } else {
    const candidate = docToText(ctx.pool);
    const minFit = broad ? cfg.matching.minFitBroad : cfg.matching.minFit;
    let screened = 0;
    for (const row of pending) {
      if (row.reason?.startsWith("screened")) {
        if ((row.fit ?? 0) >= minFit) picks.push({ row, job: ledger.job(row) });
        continue;
      }
      if (screened >= cfg.matching.maxScreenPerRun) continue;
      const job = ledger.job(row);
      if (job.postedAt && Date.now() - Date.parse(job.postedAt) > cfg.matching.maxAgeDays * 86_400_000) {
        ledger.setStatus(row.id, "rejected", { reason: "expired while waiting" });
        continue;
      }
      try {
        const s = await screenJob(ctx.llm, job, goal, candidate);
        screened++;
        if (s.dealbreaker || s.fit < minFit) {
          ledger.setStatus(row.id, "rejected", { fit: s.fit, reason: `screened: ${s.reason}` });
          ledger.credit(row.origin, false);
          bump("rejected");
        } else {
          ledger.setStatus(row.id, "matched", { fit: s.fit, reason: `screened: ${s.reason}` });
          ledger.credit(row.origin, true);
          if (!job.autoApplicable) matchedCompanies.push(job.company);
          picks.push({ row: { ...row, fit: s.fit }, job });
        }
      } catch (e) {
        if (e instanceof BudgetExceededError) break;
        log(`  screening ${job.company} / ${job.title} failed: ${errorMessage(e)}`);
      }
    }
    picks.sort((a, b) => (b.row.fit ?? 0) - (a.row.fit ?? 0));
  }

  // A good match from an aggregator means the employer may have a board worth reading in full,
  // and that board's form can usually be filled automatically.
  const found = await discoverBoards(camp, matchedCompanies);
  if (found.length) {
    log(`Found job boards: ${found.join(", ")}`);
    const more = await sweepNewBoards(camp);
    log(`  read them: ${more} more new postings, screened on the next run`);
    // Matches seen on an aggregator may now point at the employer's own form.
    for (const p of picks) {
      const row = ledger.get(p.job.id);
      if (row) p.job = ledger.job(row);
    }
  }

  // 3. Prepare and apply, best first, within quota.
  for (const p of picks) {
    if (room <= 0) break;
    if (ledger.companyCount30d(p.job.company) >= cfg.quota.maxPerCompanyPer30Days) continue;
    log(`\n> ${p.job.company} | ${p.job.title}  (fit ${p.row.fit ?? "?"})`);
    try {
      const packet = await preparePacket(ctx, p.job, mode, p.standard);
      room--;
      const autoSubmit = cfg.submit === "auto" && !opts.dryRun;
      const result = await processForm(ctx, p.job, packet, { submit: autoSubmit, mode });
      ledger.setStatus(p.job.id, result.status, { reason: result.detail, packet_dir: packet.dir });
      bump(result.status);
      log(`  ${result.status}: ${result.detail}`);
      if (autoSubmit && result.status === "submitted") await sleep(cfg.quota.minDelaySeconds * 1000);
    } catch (e) {
      if (e instanceof BudgetExceededError) {
        log(`Token budget reached: ${e.message}. Stopping this run.`);
        break;
      }
      log(`  failed to prepare: ${errorMessage(e)}`);
      ledger.setStatus(p.job.id, "needs_human", { reason: `preparation error: ${errorMessage(e)}` });
      bump("needs_human");
    }
  }
  ledger.note("run", `run ${runNo}: ${Object.entries(tally).map(([k, v]) => `${k} ${v}`).join(", ") || "nothing new"}`);
  return tally;
}

/** Bullet tags from the pool: the vocabulary a broad search scores postings against. */
function poolTags(pool: Pool): string[] {
  const tags = new Set<string>();
  for (const s of pool.sections)
    if (s.type === "experience") for (const e of s.entries) for (const r of e.roles) for (const b of r.bullets) b.tags.forEach((t) => tags.add(t));
  return [...tags].slice(0, 40);
}

/** Builds the resume, cover letter, and notes for one job in its own folder. */
export async function preparePacket(ctx: Ctx, job: Job, mode: Config["mode"], standard?: Standard): Promise<Packet> {
  const { pool, cfg } = ctx;
  const dir = join(ctx.ws.applications, `${safeFileName(job.company)}-${job.id}`);
  mkdirSync(dir, { recursive: true });
  const base = safeFileName(pool.contact.name);

  const plan = standard ? standard.plan : await tailorPlan(ctx.llm, pool, ctx.goal, job);
  const { doc, issues } = compose(pool, plan);
  const resumePath = join(dir, `${base}_Resume.pdf`);
  const rendered = await ctx.browser.renderResume(
    doc,
    resumePath,
    cfg.resume.maxPages,
    cfg.resume.fill ? { pool, reserve: plan.reserve } : undefined,
  );
  const resumeText = docToText(rendered.doc);
  if (rendered.fillRatio < 0.75) {
    ctx.log(`  note: the page is only ${Math.round(rendered.fillRatio * 100)}% full; your pool may be thin for this kind of role`);
  }

  let coverPath: string | undefined;
  let coverText: string | undefined;
  let removed: string[] = [];
  let coverCheck: { hooks: string[]; problems: string[] } | undefined;
  const coverMode = mode === "efficiency" ? cfg.coverLetter.efficiency : cfg.coverLetter.tailored;
  let paragraphs: string[] | undefined;
  if (coverMode === "generated") {
    const letter = await writeCoverLetter(ctx.llm, pool, ctx.goal, job, resumeText);
    paragraphs = letter.paragraphs;
    removed = letter.removed;
    coverCheck = { hooks: letter.hooks, problems: letter.problems };
    if (letter.problems.length) ctx.log(`  cover letter still generic after revision: ${letter.problems.join("; ")}`);
  } else if (coverMode === "template" && existsSync(ctx.ws.coverTemplate)) {
    paragraphs = templateCoverLetter(readFileSync(ctx.ws.coverTemplate, "utf8"), job, pool);
  }
  if (paragraphs) {
    coverPath = join(dir, `${base}_Cover_Letter.pdf`);
    await ctx.browser.renderCover(pool.contact, paragraphs, coverPath);
    coverText = `${paragraphs.join("\n\n")}\n\nSincerely,\n${pool.contact.name}`;
  }

  writeFileSync(join(dir, "job.md"), `# ${job.title}\n\n${job.company} | ${job.location}\n\n${job.url}\n\nApply: ${job.applyUrl}\n\n${job.description}\n`);
  writeFileSync(
    join(dir, "packet.json"),
    JSON.stringify(
      {
        job: { id: job.id, company: job.company, title: job.title, url: job.url, applyUrl: job.applyUrl },
        mode,
        standard: standard?.name,
        plan,
        guard: { revertedBullets: issues, removedCoverSentences: removed },
        cover: coverCheck,
        render: {
          fontPt: rendered.fontPt,
          fillRatio: Math.round(rendered.fillRatio * 100) / 100,
          reserveAdded: rendered.added,
          trimmedUnits: rendered.trimmed,
        },
      },
      null,
      2,
    ),
  );
  if (issues.length || removed.length) ctx.log(`  guard: reverted ${issues.length} bullet rewrite(s), removed ${removed.length} cover sentence(s)`);
  return { dir, resumePath, resumeText, coverPath, coverText };
}

export function packetFor(dir: string, contactName: string): Packet {
  const base = safeFileName(contactName);
  const coverPath = join(dir, `${base}_Cover_Letter.pdf`);
  const fieldsPath = join(dir, "fields.json");
  const saved = existsSync(fieldsPath) ? JSON.parse(readFileSync(fieldsPath, "utf8")) : {};
  return {
    dir,
    resumePath: join(dir, `${base}_Resume.pdf`),
    resumeText: saved.resumeText ?? "",
    coverPath: existsSync(coverPath) ? coverPath : undefined,
    coverText: saved.coverText,
  };
}

/** Values chosen on a previous pass, so approval never re-asks the model. */
function savedAnswers(dir: string): Record<string, string | string[]> {
  const path = join(dir, "fields.json");
  if (!existsSync(path)) return {};
  const data = JSON.parse(readFileSync(path, "utf8"));
  const out: Record<string, string | string[]> = {};
  for (const f of data.fields ?? []) if (f.status === "fill" && f.source !== "file" && f.value !== undefined) out[f.label] = f.value;
  return out;
}

export interface FormResult {
  status: "ready" | "needs_human" | "submitted" | "unconfirmed" | "failed";
  detail: string;
}

/** Opens the application form, fills it, and submits only when told to. */
export async function processForm(
  ctx: Ctx,
  job: Job,
  packet: Packet,
  opts: { submit: boolean; mode: Config["mode"]; headless?: boolean; keepOpen?: boolean },
): Promise<FormResult> {
  if (!job.autoApplicable) {
    return { status: "needs_human", detail: `finish on ${new URL(job.applyUrl).host}; your documents are in ${packet.dir}` };
  }
  const page = await ctx.browser.newPage(opts.headless);
  try {
    await page.goto(job.applyUrl, { waitUntil: "domcontentloaded", timeout: ctx.cfg.browser.navigationTimeoutMs });
    await page.waitForSelector("input, textarea, select", { timeout: 20_000 }).catch(() => {});
    await page.waitForTimeout(1000);
    const fields = await extractFields(page);
    const hasIdentity = fields.some((f) => /e-?mail|name/i.test(f.label));
    if (fields.length < 2 || !hasIdentity) {
      return { status: "needs_human", detail: `no application form recognized at ${job.applyUrl}; documents in ${packet.dir}` };
    }
    const useModel = opts.mode === "tailored" || ctx.cfg.efficiency.answerQuestionsWithLlm;
    const resolutions = await resolveFields(fields, {
      pool: ctx.pool,
      bank: ctx.bank,
      job,
      resumePath: packet.resumePath,
      coverPath: packet.coverPath,
      coverText: packet.coverText,
      resumeText: packet.resumeText,
      saved: savedAnswers(packet.dir),
      llm: useModel ? ctx.llm : undefined,
    });
    writeFields(packet, resolutions);
    const unresolved = resolutions.filter((r) => r.status === "needs_human");
    const failed = await fillForm(page, resolutions);
    await page.screenshot({ path: join(packet.dir, "form-filled.png"), fullPage: true }).catch(() => {});

    if (unresolved.length || failed.length) {
      const list = [...unresolved.map((r) => `${r.field.label} (${r.reason})`), ...failed.map((l) => `${l} (could not be filled)`)];
      return { status: "needs_human", detail: `${list.length} field(s) need you: ${list.join("; ")}` };
    }
    if (!opts.submit) return { status: "ready", detail: `form pre-filled; ${resolutions.filter((r) => r.source === "llm").length} model-written answer(s) to review` };

    const sent = await submitForm(page);
    await page.screenshot({ path: join(packet.dir, "after-submit.png"), fullPage: true }).catch(() => {});
    if (sent.outcome === "blocked") return { status: "needs_human", detail: `${sent.detail}; run \`resumetron apply ${job.id} --handoff\`` };
    return { status: sent.outcome, detail: sent.detail };
  } finally {
    if (!opts.keepOpen) await page.close().catch(() => {});
  }
}

function writeFields(packet: Packet, resolutions: Resolution[]): void {
  writeFileSync(
    join(packet.dir, "fields.json"),
    JSON.stringify(
      {
        resumeText: packet.resumeText,
        coverText: packet.coverText,
        fields: resolutions.map((r) => ({
          label: r.field.label,
          kind: r.field.kind,
          required: r.field.required,
          options: r.field.options.length ? r.field.options : undefined,
          status: r.status,
          source: r.source,
          value: r.value,
          reason: r.reason,
        })),
      },
      null,
      2,
    ),
  );
}

/** Tailors a plan for a role family instead of a single posting, for efficiency mode. */
export async function buildStandardPlan(ctx: Ctx, targets: string[], keywords: string[]): Promise<TailorPlan> {
  const description = `A representative posting for: ${targets.join("; ")}.\nKey requirements: ${keywords.join(", ") || "as typical for these roles"}.\n${ctx.goal.summary}`;
  return TailorPlan.parse(await tailorPlan(ctx.llm, ctx.pool, ctx.goal, { title: targets[0], description }));
}
