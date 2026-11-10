#!/usr/bin/env node
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { Command } from "commander";
import { BrowserHost } from "./browser.ts";
import { Ledger } from "./ledger.ts";
import { createLlm, metered } from "./llm/index.ts";
import { importPool, interview, readSource } from "./onboard.ts";
import { type Ctx, buildStandardPlan, packetFor, preparePacket, processForm, run } from "./pipeline.ts";
import { compose, docToText, identityPlan } from "./resume/compose.ts";
import { removeSchedule, describeSchedule, installSchedule } from "./schedule.ts";
import type { Job } from "./schema.ts";
import { checkBoard } from "./sources.ts";
import { errorMessage, htmlToText, safeFileName, shortHash } from "./util.ts";
import {
  type Workspace, initWorkspace, loadAnswers, loadConfig, loadGoal, loadPool, loadStandards, workspaceAt, writeYaml,
} from "./workspace.ts";
import { AnswerBank, Goal } from "./schema.ts";

const log = (s: string) => console.log(s);
const program = new Command()
  .name("resumetron")
  .description("The Resumetron 9000. If employers are screening with AI, I'm submitting with AI.")
  .option("--home <dir>", "workspace folder (default ~/.resumetron or $RESUMETRON_HOME)");

const ws = (): Workspace => workspaceAt(program.opts().home);

function llmFor(w: Workspace, ledger: Ledger) {
  const cfg = loadConfig(w);
  return metered(createLlm(cfg.provider), cfg.quota.maxTokensPerRun, (p, u) => ledger.recordUsage(p, u));
}

/** Loads everything a pipeline command needs and tears it down afterwards. */
async function withCtx<T>(fn: (ctx: Ctx) => Promise<T>, opts: { needGoal?: boolean } = {}): Promise<T> {
  const w = ws();
  const cfg = loadConfig(w);
  const ledger = new Ledger(w.ledger);
  const browser = new BrowserHost({ headless: cfg.browser.headless, channel: cfg.browser.channel });
  try {
    const ctx: Ctx = {
      ws: w,
      cfg,
      pool: loadPool(w),
      goal: opts.needGoal === false && !existsSync(w.goal) ? Goal.parse({}) : loadGoal(w),
      bank: loadAnswers(w),
      standards: loadStandards(w),
      ledger,
      llm: llmFor(w, ledger),
      browser,
      log,
    };
    return await fn(ctx);
  } finally {
    await browser.close();
    ledger.close();
  }
}

program
  .command("init")
  .description("create the workspace with a starter config, answer bank, and cover letter template")
  .action(() => {
    const w = ws();
    const created = initWorkspace(w);
    log(`Workspace: ${w.root}`);
    for (const c of created) log(`  created ${c}`);
    log("\nNext:\n  1. Pick a provider in config.yaml\n  2. resumetron import <your resume, notes, anything>\n  3. resumetron interview");
  });

program
  .command("import")
  .description("turn resumes, notes, and brag docs (.pdf, .md, .txt) into your CV pool")
  .argument("<files...>")
  .option("--replace", "rebuild the pool from these files instead of merging into it")
  .action(async (files: string[], o) => {
    const w = ws();
    const ledger = new Ledger(w.ledger);
    try {
      const sources = [];
      for (const f of files) sources.push({ name: basename(f), text: await readSource(f) });
      const existing = !o.replace && existsSync(w.pool) ? loadPool(w) : undefined;
      log(`Structuring ${files.length} document(s)${existing ? " into your existing pool" : ""}...`);
      const { pool, dropped } = await importPool(llmFor(w, ledger), sources, existing);
      if (existsSync(w.pool)) copyFileSync(w.pool, `${w.pool}.bak`);
      writeYaml(w.pool, pool);
      const bullets = pool.sections.flatMap((s) => (s.type === "experience" ? s.entries.flatMap((e) => e.roles.flatMap((r) => r.bullets)) : []));
      log(`Wrote ${w.pool}: ${pool.sections.length} sections, ${bullets.length} bullets, ${pool.facts.length} facts.`);
      for (const d of dropped) log(`  dropped (unverifiable): ${d}`);
      log("Read it over: it's the only source of truth the tailor uses.");
    } finally {
      ledger.close();
    }
  });

program
  .command("interview")
  .description("talk through what you're looking for; writes goal.yaml and standing answers")
  .action(async () => {
    const w = ws();
    const ledger = new Ledger(w.ledger);
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const pool = existsSync(w.pool) ? loadPool(w) : undefined;
      const { goal, answers } = await interview(llmFor(w, ledger), pool, rl, log);
      if (existsSync(w.goal)) copyFileSync(w.goal, `${w.goal}.bak`);
      writeYaml(w.goal, goal);
      if (answers.length) {
        const bank = loadAnswers(w);
        const known = new Set(bank.answers.map((a) => a.match));
        bank.answers.push(...answers.filter((a) => !known.has(a.match)));
        writeYaml(w.answers, bank);
      }
      log(`\nSaved ${w.goal}${answers.length ? ` and ${answers.length} standing answer(s) in ${w.answers}` : ""}.`);
    } finally {
      rl.close();
      ledger.close();
    }
  });

program
  .command("render")
  .description("render your whole pool in the standard format (no AI)")
  .option("-o, --out <file>", "output PDF", "resume.pdf")
  .option("--pages <n>", "page limit", "2")
  .action(async (o) => {
    const w = ws();
    const pool = loadPool(w);
    const browser = new BrowserHost({ headless: true });
    try {
      const { doc } = compose(pool, identityPlan(pool));
      const r = await browser.renderResume(doc, resolve(o.out), Number(o.pages));
      log(`Wrote ${resolve(o.out)} at ${r.fontPt}pt${r.trimmed ? `, trimmed ${r.trimmed} line(s) to fit` : ""}.`);
    } finally {
      await browser.close();
    }
  });

program
  .command("preview")
  .description("tailor a resume and cover letter for one posting (URL or text file) without applying")
  .argument("<posting>", "job posting URL or a .txt/.md file with its text")
  .option("--title <title>", "job title", "the role")
  .option("--company <company>", "company name", "the company")
  .action(async (posting: string, o) =>
    withCtx(async (ctx) => {
      const description = /^https?:\/\//.test(posting)
        ? htmlToText(await (await fetch(posting, { headers: { "User-Agent": "resumetron-9000" } })).text())
        : readFileSync(posting, "utf8");
      const job: Job = {
        id: `preview-${shortHash(posting)}`, source: "preview", company: o.company, title: o.title, location: "", remote: false,
        url: posting, applyUrl: posting, description, autoApplicable: false,
      };
      const packet = await preparePacket(ctx, job, "tailored");
      log(`Wrote ${packet.dir}`);
    }, { needGoal: false }),
  );

const standard = program.command("standard").description("reusable resumes for efficiency mode");
standard
  .command("build")
  .description("build a standard resume for a family of roles (one model call, reused for every match)")
  .argument("<name>")
  .requiredOption("--targets <roles>", "comma-separated role titles this resume serves")
  .option("--keywords <terms>", "comma-separated terms postings for these roles mention")
  .action(async (name: string, o) =>
    withCtx(async (ctx) => {
      const targets = o.targets.split(",").map((s: string) => s.trim()).filter(Boolean);
      const keywords = (o.keywords ?? ctx.goal.keywords.join(",")).split(",").map((s: string) => s.trim()).filter(Boolean);
      const plan = await buildStandardPlan(ctx, targets, keywords);
      mkdirSync(ctx.ws.standards, { recursive: true });
      const file = join(ctx.ws.standards, `${safeFileName(name)}.yaml`);
      writeYaml(file, { name, targets, keywords, plan });
      const { doc, issues } = compose(ctx.pool, plan);
      const pdf = join(ctx.ws.standards, `${safeFileName(name)}.pdf`);
      await ctx.browser.renderResume(doc, pdf, ctx.cfg.resume.maxPages);
      log(`Saved ${file}\nPreview: ${pdf}${issues.length ? `\n${issues.length} reworded bullet(s) reverted by the guard.` : ""}`);
    }),
  );
standard
  .command("list")
  .action(() => {
    for (const s of loadStandards(ws())) log(`${s.name}: ${s.targets.join(", ")}`);
  });

program
  .command("boards")
  .description("check company job-board tokens from goal.yaml")
  .action(async () => {
    for (const c of loadGoal(ws()).companies) {
      try {
        log(`ok   ${c.ats}:${c.token} (${await checkBoard(c.ats, c.token)} roles)`);
      } catch (e) {
        log(`FAIL ${c.ats}:${c.token} ${errorMessage(e)}`);
      }
    }
  });

program
  .command("run")
  .description("one pass: find jobs, screen, prepare packets, and submit (in auto mode) within quota")
  .option("--dry-run", "prepare and pre-fill, but never submit")
  .option("--mode <mode>", "tailored | efficiency (overrides config)")
  .action(async (o) =>
    withCtx(async (ctx) => {
      const tally = await run(ctx, { dryRun: o.dryRun, mode: o.mode });
      log(`\nDone. ${Object.entries(tally).map(([k, v]) => `${k}: ${v}`).join(", ") || "nothing to do"}.`);
      const waiting = ctx.ledger.byStatus("ready", "needs_human").length;
      if (waiting) log(`${waiting} application(s) waiting on you: resumetron queue`);
    }),
  );

const STATUS_ORDER = ["ready", "needs_human", "unconfirmed", "submitted", "failed", "matched"] as const;

program
  .command("queue")
  .description("applications waiting on you, and recent results")
  .option("--all", "include matched and rejected jobs")
  .action((o) => {
    const ledger = new Ledger(ws().ledger);
    try {
      const statuses = o.all ? [...STATUS_ORDER, "rejected" as const] : STATUS_ORDER.slice(0, 5);
      for (const status of statuses) {
        const rows = ledger.byStatus(status);
        if (!rows.length) continue;
        log(`\n${status.toUpperCase()} (${rows.length})`);
        for (const r of rows.slice(0, 40)) {
          log(`  ${r.id.slice(0, 8)}  ${r.company} | ${r.title}${r.fit != null ? `  [${r.fit}]` : ""}`);
          if (r.reason && status !== "matched") log(`            ${r.reason.slice(0, 160)}`);
        }
      }
      log("\nresumetron show <id> | apply <id> | skip <id>");
    } finally {
      ledger.close();
    }
  });

program
  .command("show")
  .argument("<id>")
  .description("details and filled-in answers for one application")
  .action((id: string) => {
    const ledger = new Ledger(ws().ledger);
    try {
      const row = ledger.get(id);
      if (!row) throw new Error(`no job ${id}`);
      log(`${row.company} | ${row.title}\n${row.location}\n${row.url}\nstatus: ${row.status}${row.reason ? ` (${row.reason})` : ""}`);
      if (!row.packet_dir) return;
      log(`packet: ${row.packet_dir}`);
      const fields = join(row.packet_dir, "fields.json");
      if (existsSync(fields)) {
        for (const f of JSON.parse(readFileSync(fields, "utf8")).fields) {
          const v = Array.isArray(f.value) ? f.value.join(", ") : (f.value ?? "");
          log(`  [${f.status}${f.source ? `:${f.source}` : ""}] ${f.label}${f.required ? " *" : ""}: ${String(v).slice(0, 200)}${f.reason ? `  (${f.reason})` : ""}`);
        }
      }
    } finally {
      ledger.close();
    }
  });

program
  .command("apply")
  .argument("<id>")
  .description("submit an application you've reviewed")
  .option("--handoff", "open a visible browser with everything filled in; you finish and click submit")
  .action(async (id: string, o) =>
    withCtx(async (ctx) => {
      const row = ctx.ledger.get(id);
      if (!row?.packet_dir) throw new Error(`no prepared application ${id}`);
      const job = ctx.ledger.job(row);
      const packet = packetFor(row.packet_dir, ctx.pool.contact.name);
      if (o.handoff) {
        await processForm(ctx, job, packet, { submit: false, mode: ctx.cfg.mode, headless: false, keepOpen: true });
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        const answer = await rl.question("Finish in the browser window. Did you submit it? (y/n) ");
        rl.close();
        const done = /^y/i.test(answer.trim());
        ctx.ledger.setStatus(row.id, done ? "submitted" : "needs_human", { reason: done ? "submitted by you" : "handoff not completed" });
        log(done ? "Recorded as submitted." : "Left in your queue.");
        return;
      }
      const result = await processForm(ctx, job, packet, { submit: true, mode: ctx.cfg.mode });
      ctx.ledger.setStatus(row.id, result.status, { reason: result.detail });
      log(`${result.status}: ${result.detail}`);
    }),
  );

program
  .command("answer")
  .argument("<id>")
  .description("answer the questions an application is stuck on; saved to answers.yaml for next time")
  .action(async (id: string) => {
    const w = ws();
    const ledger = new Ledger(w.ledger);
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const row = ledger.get(id);
      if (!row?.packet_dir) throw new Error(`no prepared application ${id}`);
      const path = join(row.packet_dir, "fields.json");
      const data = JSON.parse(readFileSync(path, "utf8"));
      const bank = loadAnswers(w);
      for (const f of data.fields.filter((x: any) => x.status === "needs_human")) {
        const opts = f.options ? `  [${f.options.join(" / ")}]` : "";
        const a = (await rl.question(`${f.label}${opts}\n> `)).trim();
        if (!a) continue;
        Object.assign(f, { status: "fill", source: "saved", value: a, reason: undefined });
        const keep = (await rl.question("  Use this answer on future applications too? (y/n) ")).trim();
        if (/^y/i.test(keep)) bank.answers.push({ match: f.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").slice(0, 120), answer: a });
      }
      writeFileSync(path, JSON.stringify(data, null, 2));
      writeYaml(w.answers, AnswerBank.parse(bank));
      ledger.setStatus(row.id, "ready", { reason: "answers added; ready for approval" });
      log(`Saved. Submit with: resumetron apply ${row.id.slice(0, 8)}`);
    } finally {
      rl.close();
      ledger.close();
    }
  });

program
  .command("skip")
  .argument("<id>")
  .description("pass on an application")
  .action((id: string) => {
    const ledger = new Ledger(ws().ledger);
    try {
      const row = ledger.get(id);
      if (!row) throw new Error(`no job ${id}`);
      ledger.setStatus(row.id, "skipped", { reason: "skipped by you" });
      log(`Skipped ${row.company} | ${row.title}`);
    } finally {
      ledger.close();
    }
  });

program
  .command("status")
  .description("pipeline counts, today's quota, and token spend")
  .action(() => {
    const w = ws();
    const cfg = loadConfig(w);
    const ledger = new Ledger(w.ledger);
    try {
      log(`Workspace ${w.root}\nmode: ${cfg.mode}, submit: ${cfg.submit}, provider: ${cfg.provider.type}${"model" in cfg.provider ? ` (${cfg.provider.model})` : ""}`);
      log(`Quota today: ${ledger.usedToday()}/${cfg.quota.maxPerDay}`);
      log(`Jobs: ${Object.entries(ledger.counts()).map(([k, v]) => `${k} ${v}`).join(", ") || "none yet"}`);
      const usage = ledger.usageSummary();
      if (usage.length) {
        log("Tokens, last 30 days:");
        for (const u of usage) log(`  ${u.purpose.padEnd(10)} ${String(u.calls).padStart(4)} calls  ${u.input} in / ${u.output} out / ${u.cached} cached`);
      }
    } finally {
      ledger.close();
    }
  });

const sched = program.command("schedule").description("run automatically with cron or Windows Task Scheduler");
sched
  .command("install")
  .option("--every <hours>", "run every N hours")
  .option("--at <HH:MM>", "run daily at this time", "09:00")
  .option("--print", "show the scheduler entry without installing it")
  .action((o) => {
    const spec = { everyHours: o.every ? Number(o.every) : undefined, at: o.at, home: program.opts().home };
    if (o.print) return log(describeSchedule(spec));
    log(`Installed: ${installSchedule(spec)}`);
  });
sched.command("remove").action(() => {
  removeSchedule();
  log("Schedule removed.");
});

program
  .command("doctor")
  .description("check the workspace, provider credentials, and browser")
  .action(async () => {
    const w = ws();
    const check = (ok: boolean, msg: string) => log(`${ok ? "ok  " : "FIX "} ${msg}`);
    check(existsSync(w.config), `config ${w.config}`);
    if (!existsSync(w.config)) return;
    const cfg = loadConfig(w);
    const env = "apiKeyEnv" in cfg.provider ? cfg.provider.apiKeyEnv : undefined;
    check(!env || Boolean(process.env[env]) || cfg.provider.type === "anthropic", `provider ${cfg.provider.type}${env ? ` (key in $${env}${process.env[env] ? "" : ": not set"})` : ""}`);
    for (const [path, what] of [[w.pool, "pool"], [w.goal, "goal"], [w.answers, "answers"]] as const) {
      try {
        if (what === "pool") loadPool(w);
        if (what === "goal") loadGoal(w);
        if (what === "answers") loadAnswers(w);
        check(true, `${what} ${path}`);
      } catch (e) {
        check(false, errorMessage(e));
      }
    }
    if (cfg.mode === "efficiency") check(loadStandards(w).length > 0, `standard resumes for efficiency mode (${loadStandards(w).length})`);
    const browser = new BrowserHost({ headless: true, channel: cfg.browser.channel });
    try {
      await (await browser.newPage()).close();
      check(true, "browser");
    } catch (e) {
      check(false, errorMessage(e));
    } finally {
      await browser.close();
    }
    if (existsSync(w.pool) && existsSync(w.goal)) {
      const pool = loadPool(w);
      check(Boolean(pool.contact.email && pool.contact.phone), "contact email and phone present");
      log(`\nPool summary:\n${docToText(pool).split("\n").slice(0, 6).join("\n")}...`);
    }
  });

program.parseAsync().catch((e) => {
  console.error(`error: ${errorMessage(e)}`);
  process.exitCode = 1;
});
