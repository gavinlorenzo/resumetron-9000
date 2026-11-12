import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BrowserHost } from "./browser.ts";
import type { Config } from "./config.ts";
import { extractFields } from "./forms/extract.ts";
import type { Page } from "playwright";
import { fillForm, readOutcome, submitForm } from "./forms/fill.ts";
import { SEL, advance, attachResume, enterWorkday, isWorkdayUrl, pressSubmit, recover, redact, requiredErrors, reviewOmissions, stepName, verificationLinkIn } from "./forms/workday.ts";
import { type Resolution, resolveFields } from "./forms/resolve.ts";
import { type Ledger, type JobRow, screenOf } from "./ledger.ts";
import { checkGates } from "./gates.ts";
import { postingSignals } from "./legitimacy.ts";
import { BudgetExceededError, type Llm } from "./llm/index.ts";
import { goalKeywords, goalTargets, hardFilter, pickStandard, relevance, screenJob } from "./match.ts";
import { compose, docToText } from "./resume/compose.ts";
import { type CampaignCtx, applyPlan, discoverBoards, gather, matchesExclusion, planCampaign, sweepNewBoards, syncGoal } from "./campaign.ts";
import { type AnswerBank, type Goal, type Job, type Pool, type ResumeDoc, type Standard, TailorPlan } from "./schema.ts";
import { checkReadability, keywordCoverage, pdfText } from "./resume/verify.ts";
import { type SourceSet, liveSources } from "./sources.ts";
import { type Mailbox, applicationEmail, applyByEmailAddress, hasSendInstructions, syncInbox } from "./email.ts";
import { allocate, maybeReview, slots, trackStats } from "./strategy.ts";
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
  mailbox?: Mailbox;
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

  // 0a. Outcomes: read employer replies so the strategy works from real results.
  if (ctx.mailbox) {
    try {
      const inbox = await syncInbox(ctx.mailbox, ledger, { llm: ctx.llm, limit: cfg.email?.maxPerSync ?? 200, log });
      if (inbox.outcomes.length) log(`Inbox: ${inbox.outcomes.join("; ")}`);
      for (const o of inbox.outcomes) ledger.note("outcome", o);
    } catch (e) {
      log(`  inbox check skipped: ${errorMessage(e)}`);
    }
  }

  // 0b. Strategy: opening hypotheses on the first run, then a weekly review.
  try {
    const memo = await maybeReview({ cfg, goal, pool: ctx.pool, ledger, llm: ctx.llm, root: ctx.ws.root, log });
    if (memo) log(`Strategy memo: ${memo}`);
  } catch (e) {
    log(`  strategy review skipped: ${errorMessage(e)}`);
  }

  // 0c. Plan: widen or narrow the search from what earlier runs found.
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
  ledger.batch(() => {
  for (const row of ledger.byStatus("discovered")) {
    const job = ledger.job(row);
    const ex = exclusions.find((e) => matchesExclusion(e, job));
    if (ex) hits.set(ex.id, (hits.get(ex.id) ?? 0) + 1);
    let why = ex ? `excluded (${ex.kind}: ${ex.pattern})` : hardFilter(job, goal, cfg, ctx.pool.contact.country);
    if (!why) {
      // Requirements and warning signs that code can read for itself, each with the sentence it came from.
      const gates = checkGates(job, goal.eligibility);
      const signals = postingSignals(job, row.reposts ?? 0);
      if (gates.reject) why = `gate: ${gates.reject.detail} ("${gates.reject.quote}")`;
      else if (signals.severe.length) why = `scam signal: ${signals.severe[0]}`;
      else if (gates.unknown.length || signals.warn.length || job.flags?.length) {
        ledger.setScreen(row.id, { gates: gates.unknown.map((h) => `${h.detail}: "${h.quote}"`), warnings: [...signals.warn, ...(job.flags ?? [])] });
      }
    }
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
  });

  let room = Math.min(cfg.quota.maxPerRun, cfg.quota.maxPerDay - ledger.usedToday());
  if (room <= 0) {
    log("Daily quota reached; nothing more to prepare today.");
    return tally;
  }
  const matchedCompanies: string[] = [];
  const matchedJobs: Job[] = [];

  // 2. Rank what's left. Tailored mode asks the model; efficiency mode matches standards.
  type Pick = { row: JobRow; job: Job; standard?: Standard };
  const picks: Pick[] = [];
  const pending = ledger.byStatus("matched");
  if (mode === "efficiency") {
    if (!ctx.standards.length) throw new Error("efficiency mode needs at least one standard resume: run `resumetron standard build`");
    for (const row of pending) {
      const job = ledger.job(row);
      const best = pickStandard(job, ctx.standards, cfg.efficiency.minStandardScore);
      if (!best) continue;
      if (row.track_id == null) {
        row.track_id = originTrack(ledger, row.origin);
        ledger.setTrack(row.id, row.track_id);
      }
      picks.push({ row, job, standard: best.standard });
    }
  } else {
    const candidate = docToText(ctx.pool);
    const minFit = broad ? cfg.matching.minFitBroad : cfg.matching.minFit;
    const liveTracks = ledger.tracks("proposed", "active", "cemented");
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
      if (cfg.matching.checkLiveness && camp.sources.alive) {
        const live = await camp.sources.alive(job);
        if (live.state === "closed") {
          ledger.setStatus(row.id, "rejected", { reason: `closed: ${live.detail}` });
          bump("closed");
          continue;
        }
      }
      try {
        const known = screenOf(row);
        const notes = [
          ...(known.gates ?? []).map((g) => `hard requirement the seeker hasn't said whether they meet: ${g}`),
          ...(known.warnings ?? []).map((w) => `warning sign: ${w}`),
        ];
        const s = await screenJob(ctx.llm, job, goal, candidate, liveTracks, { weights: cfg.matching.weights, notes });
        screened++;
        ledger.setScreen(row.id, { ...known, factors: s.factors, gaps: s.gaps, strengths: s.strengths });
        const trackId = liveTracks.some((t) => t.id === s.track) ? s.track! : originTrack(ledger, row.origin);
        ledger.setTrack(row.id, trackId);
        row.track_id = trackId;
        if (s.dealbreaker || s.fit < minFit) {
          ledger.setStatus(row.id, "rejected", { fit: s.fit, reason: `screened: ${s.reason}` });
          ledger.credit(row.origin, false);
          bump("rejected");
        } else {
          ledger.setStatus(row.id, "matched", { fit: s.fit, reason: `screened: ${s.reason}` });
          ledger.credit(row.origin, true);
          if (!job.autoApplicable) {
            matchedCompanies.push(job.company);
            matchedJobs.push(job);
          }
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
  const found = await discoverBoards(camp, matchedCompanies, matchedJobs);
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

  // 3. Prepare and apply within quota: each strategy track gets its share of today's slots,
  // best fit first within a track; slots a track can't use go to the best remaining jobs.
  const order = orderByStrategy(ctx, picks, room, mode);
  for (const p of order) {
    if (room <= 0) break;
    if (ledger.companyCount30d(p.job.company) >= cfg.quota.maxPerCompanyPer30Days) continue;
    log(`\n> ${p.job.company} | ${p.job.title}  (fit ${p.row.fit ?? "?"})`);
    if (cfg.matching.checkLiveness && camp.sources.alive) {
      const live = await camp.sources.alive(p.job);
      if (live.state === "closed") {
        ledger.setStatus(p.job.id, "rejected", { reason: `closed: ${live.detail}` });
        log(`  closed: ${live.detail}`);
        bump("closed");
        continue;
      }
    }
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

/** The track of the search that surfaced a job, if it has one. */
function originTrack(ledger: Ledger, origin: string | null): number | null {
  if (!origin?.startsWith("q:")) return null;
  const row = ledger.db.prepare("SELECT track_id FROM queries WHERE id = ?").get(Number(origin.slice(2))) as any;
  return row?.track_id ?? null;
}

/** Orders candidates so today's slots follow the strategy's quota shares. */
function orderByStrategy<P extends { row: JobRow }>(ctx: Ctx, picks: P[], room: number, mode: Config["mode"]): P[] {
  const stats = trackStats(ctx.ledger, mode);
  const live = new Set(stats.filter((s) => s.track.status !== "retired").map((s) => s.track.id));
  if (!live.size) return picks;
  const quota = slots(allocate(stats, ctx.cfg.strategy), room);
  const first: P[] = [];
  const rest: P[] = [];
  const used = new Map<number, number>();
  for (const p of picks) {
    const t = p.row.track_id;
    if (t != null && live.has(t) && (used.get(t) ?? 0) < (quota.get(t) ?? 0)) {
      used.set(t, (used.get(t) ?? 0) + 1);
      first.push(p);
    } else rest.push(p);
  }
  return [...first, ...rest];
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
  // Read the PDF back the way an ATS does, and see which of the posting's terms made it in.
  const readability = checkReadability(await pdfText(resumePath).catch(() => ""), pool.contact);
  if (!readability.ok) ctx.log(`  resume parsing: ${readability.problems.join("; ")}`);
  const coverage = keywordCoverage(resumeText, docToText(pool), job, ctx.goal.keywords);
  const provenance = bulletProvenance(rendered.doc, pool, issues.map((i) => i.where));

  let coverPath: string | undefined;
  let coverText: string | undefined;
  let removed: string[] = [];
  let coverCheck: { hooks: string[]; problems: string[] } | undefined;
  const coverMode = mode === "efficiency" ? cfg.coverLetter.efficiency : cfg.coverLetter.tailored;
  let paragraphs: string[] | undefined;
  if (coverMode === "generated") {
    const letter = await writeCoverLetter(ctx.llm, pool, ctx.goal, job, resumeText, { review: cfg.coverLetter.review });
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
        provenance,
        readability,
        keywords: coverage,
        postingFlags: job.flags,
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

/**
 * Where each bullet's wording came from: "yours" (your pool's exact text), "reworded" (changed by
 * the tailor and passed every guard check), or "reverted" (the tailor's change failed a check,
 * so your wording was used).
 */
export function bulletProvenance(doc: ResumeDoc, pool: Pool, reverted: string[]): { id: string; label: "yours" | "reworded" | "reverted"; text: string }[] {
  const original = new Map<string, string>();
  for (const s of pool.sections) if (s.type === "experience") for (const e of s.entries) for (const r of e.roles) for (const b of r.bullets) original.set(b.id, b.text);
  const out: { id: string; label: "yours" | "reworded" | "reverted"; text: string }[] = [];
  for (const s of doc.sections) {
    if (s.type !== "experience") continue;
    for (const e of s.entries)
      for (const r of e.roles)
        for (const b of r.bullets) {
          const label = reverted.includes(b.id) ? "reverted" : b.text === original.get(b.id) ? "yours" : "reworded";
          out.push({ id: b.id, label, text: b.text });
        }
  }
  return out;
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

/**
 * Applies by email when the posting asks for it: the address must come from the posting itself.
 * Drafted first (email.txt in the packet); sent only when submitting is allowed.
 */
async function emailApplication(ctx: Ctx, job: Job, packet: Packet, submit: boolean): Promise<FormResult> {
  const msg = applicationEmail(job, ctx.pool.contact.name, packet.coverText, packet.resumePath, packet.coverPath);
  writeFileSync(join(packet.dir, "email.txt"), `To: ${msg.to}\nSubject: ${msg.subject}\nAttachments: ${msg.attachments.map((a) => a.split(/[\\/]/).pop()).join(", ")}\n\n${msg.text}\n`);
  ctx.ledger.setChannel(job.id, "email");
  if (hasSendInstructions(job)) {
    return { status: "needs_human", detail: `the posting has its own instructions for email applications; check the draft in ${join(packet.dir, "email.txt")}` };
  }
  if (!submit) return { status: "ready", detail: `email application drafted to ${msg.to}` };
  if (!ctx.mailbox) return { status: "needs_human", detail: "email is not configured; the draft is in email.txt" };
  const id = await ctx.mailbox.send(msg);
  ctx.ledger.setChannel(job.id, "email", id);
  return { status: "submitted", detail: `emailed to ${msg.to}` };
}

/** Opens the application form, fills it, and submits only when told to. */
export async function processForm(
  ctx: Ctx,
  job: Job,
  packet: Packet,
  opts: { submit: boolean; mode: Config["mode"]; headless?: boolean; keepOpen?: boolean; createAccount?: boolean },
): Promise<FormResult> {
  // A handoff fills what it can on any site, since you finish and submit it yourself.
  const assisted = opts.keepOpen && opts.headless === false && !opts.submit;
  if (isWorkdayUrl(job.applyUrl)) {
    const page = await ctx.browser.newPage(opts.headless);
    try {
      await page.goto(job.applyUrl.replace(/\/apply\/?$/, ""), { waitUntil: "domcontentloaded", timeout: ctx.cfg.browser.navigationTimeoutMs });
      return await processWorkday(ctx, page, job, packet, opts.submit ? "submit" : assisted ? "walk" : "check", Boolean(opts.createAccount));
    } finally {
      if (!opts.keepOpen) await page.close().catch(() => {});
    }
  }
  if (!job.autoApplicable && !assisted) {
    if (ctx.cfg.email?.send && applyByEmailAddress(job)) return emailApplication(ctx, job, packet, opts.submit);
    return { status: "needs_human", detail: `finish on ${new URL(job.applyUrl).host} (resumetron apply ${job.id.slice(0, 8)} --handoff fills what it can); your documents are in ${packet.dir}` };
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
    await keepProof(page, packet, sent);
    if (sent.outcome === "blocked") return { status: "needs_human", detail: `${sent.detail}; run \`resumetron apply ${job.id} --handoff\`` };
    return { status: sent.outcome, detail: sent.detail };
  } finally {
    if (!opts.keepOpen) await page.close().catch(() => {});
  }
}

/**
 * A Workday application. "check" (a review-mode run) gets to the first page and resolves its
 * fields without saving anything; "walk" (a handoff) fills and saves each page up to Review and
 * leaves it to you; "submit" walks, checks the Review page says back what you answered, and
 * submits. Any question it can't answer stops it on that page.
 */
async function processWorkday(ctx: Ctx, page: Page, job: Job, packet: Packet, how: "check" | "walk" | "submit", createAccount: boolean): Promise<FormResult> {
  const w = ctx.cfg.workday;
  const password = process.env[w.passwordEnv];
  const email = w.email ?? ctx.pool.contact.email;
  const account = password && email ? { email, password } : undefined;
  const handoff = ` (\`resumetron apply ${job.id.slice(0, 8)} --handoff\` to do it in a browser)`;
  const entry = await enterWorkday(page, {
    account,
    allowCreate: createAccount || w.createAccounts,
    awaitLink: ctx.mailbox ? workdayLinkReader(ctx.mailbox, w.verifyWaitSeconds) : undefined,
    onCreated: (tenant) => ctx.ledger.note("workday", `created a Workday account on ${tenant} for ${account?.email}`),
  });
  const say = (s: string) => (password ? redact(s, password) : s);
  if (entry.reached === "closed") return { status: "failed", detail: `closed: ${entry.detail}` };
  if (entry.reached !== "form") {
    await page.screenshot({ path: join(packet.dir, "workday-entry.png") }).catch(() => {});
    return { status: "needs_human", detail: say(entry.detail) + handoff };
  }
  ctx.log(`  workday: ${say(entry.detail)}`);

  const useModel = ctx.cfg.mode === "tailored" || ctx.cfg.efficiency.answerQuestionsWithLlm;
  const all: Resolution[] = [];
  const answered: { label: string; value: string }[] = [];
  let resumeAttached = false;
  let last = "";
  let stalls = 0;
  let pages = 0;
  for (let i = 0; i < 12; i++) {
    await recover(page);
    await page.waitForTimeout(1500);
    const name = await stepName(page);
    if (name && name === last) {
      if (++stalls >= 3) {
        const missing = requiredErrors(await page.locator("body").innerText().catch(() => ""));
        writeFields(packet, all);
        return { status: "needs_human", detail: `Workday's "${name}" page won't save${missing.length ? `: it still wants ${missing.join("; ")}` : ""}${handoff}` };
      }
    } else {
      last = name;
      stalls = 0;
      pages++;
    }
    if (/\breview\b/i.test(name)) break;
    if (how !== "check" && !resumeAttached && (await page.locator(SEL.resumeInput).count())) resumeAttached = await attachResume(page, packet.resumePath);
    const fields = (await extractFields(page)).filter((f) => f.kind !== "file");
    const resolutions = await resolveFields(fields, {
      pool: ctx.pool, bank: ctx.bank, job, resumePath: packet.resumePath, coverPath: packet.coverPath, coverText: packet.coverText,
      resumeText: packet.resumeText, saved: savedAnswers(packet.dir), llm: useModel ? ctx.llm : undefined,
    });
    all.push(...resolutions.filter((r) => !all.some((a) => a.field.label === r.field.label)));
    const unresolved = resolutions.filter((r) => r.status === "needs_human");
    if (how === "check") {
      writeFields(packet, all);
      if (unresolved.length) return { status: "needs_human", detail: `Workday page "${name}": ${unresolved.map((r) => `${r.field.label} (${r.reason})`).join("; ")}` };
      return { status: "ready", detail: `Workday: ${say(entry.detail)}; page 1 ("${name}") is answerable. \`apply\` fills every page and stops at Review if anything's missing` };
    }
    const failed = await fillForm(page, resolutions);
    for (const r of resolutions) if (r.status === "fill" && r.value !== undefined) answered.push({ label: r.field.label, value: Array.isArray(r.value) ? r.value.join(", ") : String(r.value) });
    if (unresolved.length || failed.length) {
      writeFields(packet, all);
      await page.screenshot({ path: join(packet.dir, "form-filled.png"), fullPage: true }).catch(() => {});
      const list = [...unresolved.map((r) => `${r.field.label} (${r.reason})`), ...failed.map((l) => `${l} (could not be filled)`)];
      return { status: "needs_human", detail: `Workday page "${name}": ${list.length} field(s) need you: ${list.join("; ")}` };
    }
    if (!(await advance(page))) {
      if (await page.locator(SEL.next.join(",")).filter({ hasText: /submit/i }).count()) break; // on Review
      writeFields(packet, all);
      return { status: "needs_human", detail: `couldn't move past Workday's "${name}" page${handoff}` };
    }
  }
  writeFields(packet, all);
  await page.screenshot({ path: join(packet.dir, "form-filled.png"), fullPage: true }).catch(() => {});
  if (!resumeAttached) return { status: "needs_human", detail: `walked ${pages} Workday pages, but the resume upload didn't take${handoff}` };
  const review = await page.locator("body").innerText().catch(() => "");
  const omitted = reviewOmissions(review, answered);
  if (omitted.length) {
    return { status: "needs_human", detail: `Workday's Review page doesn't show what was answered for: ${omitted.map((o) => `${o.label} ("${o.value}")`).join("; ")}; check it before submitting${handoff}` };
  }
  if (how === "walk") return { status: "ready", detail: `filled ${pages} Workday pages; it's at Review for you to submit` };

  const before = page.url();
  if (!(await pressSubmit(page))) return { status: "needs_human", detail: `reached Review but found no Submit button${handoff}` };
  const sent = await readOutcome(page, before);
  await keepProof(page, packet, sent);
  if (sent.outcome === "blocked") return { status: "needs_human", detail: `${sent.detail}${handoff}` };
  return { status: sent.outcome, detail: sent.detail };
}

/** Polls the inbox for Workday's verification email; returns its link, or null when time's up. */
export function workdayLinkReader(mailbox: Mailbox, waitSeconds: number) {
  return async (since: Date): Promise<string | null> => {
    const until = Date.now() + waitSeconds * 1000;
    let after = 0;
    while (Date.now() < until) {
      await sleep(10_000);
      const heads = await mailbox.fetchHeaders(after, new Date(since.getTime() - 86_400_000), 5000).catch(() => []);
      if (heads.length) after = Math.max(after, ...heads.map((h) => h.uid));
      const fresh = heads.filter((h) => new Date(h.date).getTime() >= since.getTime() - 120_000 && (/workday/i.test(h.from) || /verif|activat|confirm/i.test(h.subject)));
      if (!fresh.length) continue;
      const bodies = await mailbox.fetchText(fresh.map((h) => h.uid)).catch(() => new Map<number, string>());
      for (const h of fresh.reverse()) {
        const link = verificationLinkIn(bodies.get(h.uid) ?? "");
        if (link) return link;
      }
    }
    return null;
  };
}

/** What the site said after submit, kept with the packet as proof. */
async function keepProof(page: Page, packet: Packet, sent: { outcome: string; detail: string }) {
  await page.screenshot({ path: join(packet.dir, "after-submit.png"), fullPage: true }).catch(() => {});
  const proof = await page.locator("body").innerText().catch(() => "");
  writeFileSync(join(packet.dir, "after-submit.txt"), `${new Date().toISOString()}\n${page.url()}\n${sent.outcome}: ${sent.detail}\n\n${proof.slice(0, 20_000)}`);
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
