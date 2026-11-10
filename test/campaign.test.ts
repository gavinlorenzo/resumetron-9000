import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { type CampaignCtx, applyPlan, discoverBoards, gather, matchesExclusion } from "../src/campaign.ts";
import { Config } from "../src/config.ts";
import { Ledger } from "../src/ledger.ts";
import { prune } from "../src/retention.ts";
import { Goal, type Job } from "../src/schema.ts";
import type { SourceSet } from "../src/sources.ts";
import { workspaceAt } from "../src/workspace.ts";
import { examplePool } from "./helpers.ts";

const dirs: string[] = [];
const ledgers: Ledger[] = [];
after(() => {
  for (const l of ledgers) l.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const mk = (n: number, extra: Partial<Job> = {}): Job => ({
  id: `j${n}`, source: "himalayas", company: `Org ${n}`, title: `Policy Analyst ${n}`, location: "Remote", remote: true,
  url: `https://example.test/${n}`, applyUrl: `https://example.test/${n}`, description: "x".repeat(2000), autoApplicable: false, ...extra,
});

/** A fake search: 25 results over 3 pages of 10, plus one new posting on page 1 each call after the first. */
function fakeSources(): SourceSet & { requests: string[] } {
  const requests: string[] = [];
  let calls = 0;
  return {
    requests,
    sweep: async () => [],
    async search(_s, query, _l, page) {
      requests.push(`${query}#${page}`);
      if (page === 1) calls++;
      const base = Array.from({ length: 25 }, (_, i) => mk(i));
      const fresh = page === 1 && calls > 1 ? [mk(100 + calls)] : [];
      return { jobs: [...fresh, ...base.slice((page - 1) * 10, page * 10)], more: page * 10 < 25 };
    },
    findBoard: async (company) => (company === "Org 3" ? { ats: "lever", token: "org3" } : null),
  };
}

function setup(over: Partial<Config["campaign"]> = {}) {
  const root = mkdtempSync(join(tmpdir(), "rt-camp-"));
  dirs.push(root);
  const ledger = new Ledger(join(root, "ledger.db"));
  ledgers.push(ledger);
  const cfg = Config.parse({ provider: { type: "openai", model: "x" }, campaign: { maxPagesPerQuery: 2, ...over } });
  const sources = fakeSources();
  const ctx: CampaignCtx = {
    cfg, ledger, sources, pool: examplePool(), llm: { complete: async () => { throw new Error("no model in this test"); } }, log: () => {},
    goal: Goal.parse({ targetRoles: ["Policy Analyst"], remoteOk: true }),
  };
  return { root, ledger, sources, ctx };
}

test("searches dig deeper each run, surface only unseen postings, and retire when covered", async () => {
  const { ledger, sources, ctx } = setup({ exhaustAfterEmptyRuns: 1 });
  ledger.addQuery("himalayas", "policy analyst", "", "user", "");

  const r1 = await gather(ctx);
  assert.deepEqual(sources.requests, ["policy analyst#1", "policy analyst#2"]);
  assert.equal(r1.fresh, 20);

  const r2 = await gather(ctx); // page 1 again for new postings, then page 3 (the end)
  assert.deepEqual(sources.requests.slice(2), ["policy analyst#1", "policy analyst#3"]);
  assert.equal(r2.fresh, 6, "one new posting plus the 5 on the last page; nothing seen twice");
  assert.equal(ledger.queries()[0].next_page, 0, "the list has been read to its end");

  const r3 = await gather(ctx); // only page 1 is re-checked now
  assert.deepEqual(sources.requests.slice(4), ["policy analyst#1"]);
  assert.equal(r3.fresh, 1);
  assert.equal(ledger.queries()[0].status, "active");
});

test("the same posting from two sources is one job, upgraded to the fillable board form", () => {
  const { ledger } = setup();
  assert.equal(ledger.addJobs([mk(1, { company: "Acme, Inc." })], "q:1").fresh, 1);
  const fromBoard = mk(1, { id: "gh1", source: "lever", company: "Acme", autoApplicable: true, applyUrl: "https://jobs.lever.co/acme/1/apply" });
  assert.equal(ledger.addJobs([fromBoard], "b:lever:acme").fresh, 0);
  const row = ledger.get("j1")!;
  assert.equal(row.apply_url, "https://jobs.lever.co/acme/1/apply");
  assert.equal(ledger.job(row).autoApplicable, true);
});

test("exclusions: agent rules need evidence and can't block target roles", () => {
  const { ledger, ctx } = setup();
  ledger.addJobs([1, 2, 3].map((n) => mk(n, { title: `Registered Nurse ${n}` })), "q:1");
  ledger.addJobs([mk(4, { title: "Senior Policy Analyst" })], "q:1");
  for (const id of ["j1", "j2", "j3"]) ledger.setStatus(id, "rejected", { reason: "screened: clinical license required" });
  ledger.setStatus("j4", "matched", { reason: "screened: strong fit" });

  const changes = applyPlan(ctx, {
    addQueries: [], retire: [], addCompanies: [], note: "",
    addExclusions: [
      { kind: "title", pattern: "nurse", reason: "needs a license" },
      { kind: "title", pattern: "senior", reason: "too senior" },
      { kind: "title", pattern: "analyst", reason: "nope" },
    ],
  });
  assert.deepEqual(ledger.exclusions().map((e) => e.pattern), ["nurse"]);
  assert.ok(changes.some((c) => c.includes('declined exclusion "senior"')), "a pattern that would block a kept job is declined");
  assert.ok(changes.some((c) => c.includes('declined exclusion "analyst": it would block a target role')));
  assert.ok(matchesExclusion(ledger.exclusions()[0], mk(9, { title: "Travel Nurse" })));
});

test("planner additions are deduped and capped; board discovery is cached", async () => {
  const { ledger, ctx } = setup({ maxNewQueriesPerRun: 2 });
  for (const s of ["himalayas", "remotive"]) ledger.addQuery(s, "policy analyst", "", "goal", "");
  applyPlan(ctx, {
    addQueries: [{ query: "Policy  Analyst", why: "" }, { query: "program coordinator", why: "" }, { query: "legislative aide", why: "" }, { query: "grants associate", why: "" }],
    retire: [], addExclusions: [], note: "", addCompanies: [{ name: "Org 3", why: "" }, { name: "Org 7", why: "" }],
  });
  const active = ledger.queries("active").map((q) => q.query);
  assert.ok(active.includes("program coordinator") && active.includes("legislative aide"));
  assert.ok(!active.includes("grants associate"), "capped at 2 per run");

  // Retiring needs evidence: an unjudged search stays; one with 3 screened failures goes.
  const [young, judged] = ledger.queries("active").filter((q) => q.source === "himalayas");
  ledger.db.prepare("UPDATE queries SET runs = 1, fresh = 40, screened = 3, matched = 0 WHERE id = ?").run(judged.id);
  const retired = applyPlan(ctx, { addQueries: [], addExclusions: [], addCompanies: [], note: "", retire: [young.id, judged.id] });
  assert.ok(retired.some((c) => c.startsWith(`kept "${young.query}"`)));
  assert.ok(retired.includes(`-search "${judged.query}"`));

  const found = await discoverBoards(ctx, []);
  assert.deepEqual(found, ["Org 3 (lever:org3)"]);
  assert.equal(ledger.probe("Org 7"), null, "a miss is remembered");
  assert.deepEqual(await discoverBoards(ctx, ["Org 7"]), [], "and not looked up again");
});

test("retention keeps the workspace bounded", () => {
  const { root, ledger } = setup();
  const ws = workspaceAt(root);
  const cfg = Config.parse({ provider: { type: "openai", model: "x" }, retention: { backlogMax: 5, journalMax: 3, tombstoneDays: 30, packetDays: 7, screenshotsDays: 7, logDays: 7 } });

  ledger.addJobs(Array.from({ length: 12 }, (_, i) => mk(i)), "q:1");
  for (let i = 0; i < 12; i++) ledger.setStatus(`j${i}`, "matched", { fit: i });
  ledger.setStatus("j0", "rejected", { reason: "screened: no" });
  ledger.db.prepare("UPDATE jobs SET updated_at = '2020-01-01' WHERE id = 'j0'").run();
  ledger.setStatus("j1", "submitted", { reason: "ok" });
  for (let i = 0; i < 10; i++) ledger.note("run", `entry ${i}`);

  const old = (p: string) => utimesSync(p, new Date("2020-01-01"), new Date("2020-01-01"));
  mkdirSync(join(ws.applications, "preview-old"), { recursive: true });
  old(join(ws.applications, "preview-old"));
  mkdirSync(join(root, "logs"), { recursive: true });
  writeFileSync(join(root, "logs", "run-2020-01-01.log"), "x");
  old(join(root, "logs", "run-2020-01-01.log"));

  const r = prune(ws, ledger, cfg.retention);
  assert.equal(r.deletedJobs, 1, "old rejection deleted");
  assert.equal(r.backlogDropped, 5, "10 waiting, capped at 5");
  assert.equal(ledger.byStatus("matched").length, 5);
  assert.deepEqual(ledger.byStatus("matched").map((x) => x.fit), [11, 10, 9, 8, 7], "the best are kept");
  assert.equal(ledger.job(ledger.get("j1")!).description, undefined, "finished jobs drop the posting text");
  assert.ok(ledger.get("j1"), "sent applications stay as history");
  assert.equal(ledger.journal(100).length, 3);
  assert.ok(!existsSync(join(ws.applications, "preview-old")));
  assert.ok(!existsSync(join(root, "logs", "run-2020-01-01.log")));
});
