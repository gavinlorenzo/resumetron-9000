import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { BrowserHost } from "../src/browser.ts";
import { Config } from "../src/config.ts";
import { Ledger } from "../src/ledger.ts";
import { metered } from "../src/llm/index.ts";
import { type Ctx, run } from "../src/pipeline.ts";
import type { InboundMessage, OutboundMessage } from "../src/email.ts";
import { Goal, type Job } from "../src/schema.ts";
import { workspaceAt } from "../src/workspace.ts";
import { type FakeBoard, examplePool, fakeBoard, mockLlm } from "./helpers.ts";

let board: FakeBoard;
let browser: BrowserHost;
const dirs: string[] = [];
const ledgers: Ledger[] = [];

before(async () => {
  board = await fakeBoard();
  browser = new BrowserHost({ headless: true });
});
after(async () => {
  await browser.close();
  await board.close();
  for (const l of ledgers) l.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const job = (n: number, title: string, extra: Partial<Job> = {}): Job => ({
  id: `job${n}`,
  source: "test",
  company: `Civic Org ${n}`,
  title,
  location: "Springfield, IL",
  remote: false,
  url: `${board.url}/jobs/${n}`,
  applyUrl: `${board.url}/apply/${n}`,
  description: "Research local government policy, write briefing memos, and support community engagement programs.",
  postedAt: new Date().toISOString(),
  autoApplicable: true,
  ...extra,
});

function makeCtx(over: { submit: "review" | "auto"; maxPerRun?: number; answers?: { match: string; answer: string }[] }) {
  const root = mkdtempSync(join(tmpdir(), "rt-"));
  dirs.push(root);
  const ws = workspaceAt(root);
  const pool = examplePool();
  const llm = mockLlm(pool);
  const ledger = new Ledger(join(root, "ledger.db"));
  ledgers.push(ledger);
  const cfg = Config.parse({
    provider: { type: "openai", model: "test" },
    submit: over.submit,
    quota: { maxPerRun: over.maxPerRun ?? 5, minDelaySeconds: 0 },
  });
  const jobs = [
    job(1, "Policy Analyst"),
    job(2, "Program Coordinator, Community Engagement"),
    job(3, "Senior Director of Policy"), // excluded by title
    job(4, "Software Engineer"), // excluded by title
    job(5, "Policy Analyst", { company: "Faraway Agency", location: "Juneau, AK" }), // location
  ];
  const ctx: Ctx = {
    ws,
    cfg,
    pool,
    goal: Goal.parse({
      summary: "Entry-level policy analyst",
      targetRoles: ["Policy Analyst", "Program Coordinator"],
      titleExclude: ["Senior", "Director", "Engineer"],
      keywords: ["policy", "research", "government", "community", "briefing"],
      locations: ["Springfield"],
    }),
    bank: {
      answers: over.answers ?? [
        { match: "authorized to work", answer: "Yes" },
        { match: "sponsorship", answer: "No" },
        { match: "privacy policy", answer: "Yes" },
      ],
    },
    standards: [],
    ledger,
    llm: metered(llm, 1_000_000, (p, u) => ledger.recordUsage(p, u)),
    browser,
    log: () => {},
    sources: {
      sweep: async () => jobs,
      search: async () => ({ jobs: [], more: false }),
      findBoard: async () => null,
    },
  };
  ctx.goal.companies = [{ ats: "greenhouse", token: "civic" }];
  ctx.cfg.campaign.plannerEveryRuns = 0;
  ctx.cfg.campaign.boardSweepHours = 0;
  return { ctx, llm, ledger };
}

test("auto mode: filters, tailors, fills, submits, and records the result", async () => {
  const before = board.submissions.length;
  const { ctx, llm, ledger } = makeCtx({ submit: "auto" });
  const tally = await run(ctx);
  assert.equal(tally.submitted, 2);
  assert.equal(board.submissions.length - before, 2);

  const posted = board.submissions.at(-1)!;
  assert.match(posted, /name="first_name"\r\n\r\nJordan/);
  assert.match(posted, /name="email"\r\n\r\njordan\.rivera@example\.com/);
  assert.match(posted, /name="auth"\r\n\r\nYes/);
  assert.match(posted, /name="sponsor"\r\n\r\nno/);
  assert.match(posted, /filename="Jordan_Rivera_Resume\.pdf"/);
  assert.match(posted, /filename="Jordan_Rivera_Cover_Letter\.pdf"/);
  assert.match(posted, /name="website_hp"\r\n\r\n\r\n/, "honeypot stays empty");
  assert.doesNotMatch(posted, /name="gender"\r\n\r\n\w/, "optional demographic question left blank");

  const rows = ledger.byStatus("rejected").map((r) => r.reason);
  assert.equal(rows.length, 3);

  // The model never saw the sensitive questions.
  const formPrompts = llm.calls.filter((c) => c.purpose === "form").map((c) => c.messages[0].content).join();
  assert.doesNotMatch(formPrompts, /authorized|sponsorship|Gender|privacy/i);

  // The fabricated cover letter sentence was removed before rendering.
  const sub = ledger.byStatus("submitted")[0];
  const packet = JSON.parse(readFileSync(join(sub.packet_dir!, "packet.json"), "utf8"));
  assert.equal(packet.guard.removedCoverSentences.length, 1);
  assert.match(packet.guard.removedCoverSentences[0], /Pulitzer/);

  // A second run finds nothing new and applies to nothing twice.
  const again = await run(ctx);
  assert.equal(again.new, 0);
  assert.equal(again.submitted ?? 0, 0);
  ledger.close();
});

test("review mode prepares and pre-fills but never submits", async () => {
  const before = board.submissions.length;
  const { ctx, ledger } = makeCtx({ submit: "review", maxPerRun: 1 });
  const tally = await run(ctx);
  assert.equal(tally.ready, 1, "maxPerRun caps preparation");
  assert.equal(board.submissions.length, before);
  const ready = ledger.byStatus("ready")[0];
  assert.ok(existsSync(join(ready.packet_dir!, "form-filled.png")));
  ledger.close();
});

test("email-only postings are applied to by email, and replies come back as outcomes on the right track", async () => {
  const { ctx, ledger } = makeCtx({ submit: "auto", maxPerRun: 5 });
  const sent: OutboundMessage[] = [];
  const inbox: InboundMessage[] = [];
  ctx.cfg.email = { provider: "custom", address: "jordan@example.com", passwordEnv: "X", send: true, maxPerSync: 50 };
  ctx.mailbox = {
    fetchHeaders: async (after) => inbox.filter((m) => m.uid > after).map((m) => ({ ...m, text: "" })),
    fetchText: async (uids) => new Map(inbox.filter((m) => uids.includes(m.uid)).map((m) => [m.uid, m.text])),
    send: async (m) => (sent.push(m), "<app-1@example.com>"),
    verify: async () => {},
  };
  const emailJob = job(9, "Policy Analyst", {
    company: "Town of Example",
    autoApplicable: false,
    description: "Research local government policy and write briefing memos. To apply, send your resume and cover letter to hiring@town.example.gov.",
  });
  ctx.sources!.sweep = async () => [emailJob];

  await run(ctx);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, "hiring@town.example.gov");
  assert.deepEqual(sent[0].attachments.map((a) => a.split(/[\\/]/).pop()), ["Jordan_Rivera_Resume.pdf", "Jordan_Rivera_Cover_Letter.pdf"]);
  assert.match(sent[0].text, /Town of Example/);
  const row = ledger.get("job9")!;
  assert.equal(row.status, "submitted");
  assert.equal(row.channel, "email");
  assert.equal(row.track_id, 1, "screening placed it on a strategy track");
  assert.equal(ledger.tracks().length, 2, "the opening hypotheses were created on the first run");

  inbox.push({ uid: 1, messageId: "<r1>", inReplyTo: ["<app-1@example.com>"], from: "clerk@town.example.gov", subject: "Re: Application", date: "", text: "Thanks Jordan, can we schedule an interview next week? Please send your availability." });
  await run(ctx);
  assert.equal(ledger.get("job9")!.outcome, "interview");
  ledger.close();
});

test("missing standing answers park the application for a human", async () => {
  const before = board.submissions.length;
  const { ctx, ledger } = makeCtx({ submit: "auto", maxPerRun: 1, answers: [] });
  const tally = await run(ctx);
  assert.equal(tally.needs_human, 1);
  assert.equal(board.submissions.length, before);
  const row = ledger.byStatus("needs_human")[0];
  assert.match(row.reason!, /authorized to work/);
  assert.match(row.reason!, /sponsorship/);
  ledger.close();
});

test("the rendered resume reads cleanly as text, with ASCII date ranges", async () => {
  const { compose, identityPlan } = await import("../src/resume/compose.ts");
  const { checkReadability, pdfText } = await import("../src/resume/verify.ts");
  const root = mkdtempSync(join(tmpdir(), "rt-pdf-"));
  dirs.push(root);
  const pool = examplePool();
  const out = join(root, "r.pdf");
  await browser.renderResume(compose(pool, identityPlan(pool)).doc, out, 1);
  const text = await pdfText(out);
  const r = checkReadability(text, pool.contact);
  assert.deepEqual(r.problems, []);
  assert.doesNotMatch(text, /\d{4}\s?[–—]\s?\d{4}/);
  assert.match(checkReadability("Jane Doe 2019 – 2021 ".repeat(20), { name: "Jane Doe", links: [] }).problems.join(), /typographic dash/);
});
