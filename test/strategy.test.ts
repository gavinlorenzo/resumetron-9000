import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { exposure } from "../src/benchmarks.ts";
import { Config } from "../src/config.ts";
import { Ledger } from "../src/ledger.ts";
import { Goal, type Job } from "../src/schema.ts";
import { allocate, applyReview, maybeReview, slots, trackStats } from "../src/strategy.ts";
import { examplePool, mockLlm } from "./helpers.ts";

const dirs: string[] = [];
const ledgers: Ledger[] = [];
after(() => {
  for (const l of ledgers) l.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function fresh() {
  const root = mkdtempSync(join(tmpdir(), "rt-strat-"));
  dirs.push(root);
  const ledger = new Ledger(join(root, "ledger.db"));
  ledgers.push(ledger);
  return { root, ledger };
}

let seq = 0;
/** Records `n` sent applications on a track, `daysAgo` old, the first `interviews` of which got interviews. */
function sent(ledger: Ledger, track: number, n: number, daysAgo: number, interviews = 0) {
  for (let i = 0; i < n; i++) {
    const id = `a${seq++}`;
    const job: Job = { id, source: "t", company: `Co ${id}`, title: "Analyst", location: "", remote: false, url: `u/${id}`, applyUrl: `u/${id}`, description: "", autoApplicable: true };
    ledger.addJobs([job], "q:1");
    ledger.setStatus(id, "submitted", { force: true });
    ledger.setTrack(id, track);
    ledger.db.prepare("UPDATE jobs SET submitted_at = ? WHERE id = ?").run(new Date(Date.now() - daysAgo * 86_400_000).toISOString(), id);
    if (i < interviews) ledger.setOutcome(id, "interview");
  }
}

const verdictOf = (ledger: Ledger, track: number) => trackStats(ledger, "efficiency").find((s) => s.track.id === track)!;

test("silence is read against the benchmarks, not panicked about", () => {
  const { ledger } = fresh();
  const t = ledger.addTrack("A", "h", [], "active");
  sent(ledger, t, 40, 90);
  const s = verdictOf(ledger, t);
  assert.notEqual(s.verdict, "underperforming", "40 unanswered applications are normal at a ~3% rate");
  assert.ok(s.pZeroAtBaseline > 0.25, `zero interviews in 40 is common (${s.pZeroAtBaseline})`);

  sent(ledger, t, 260, 90);
  assert.equal(verdictOf(ledger, t).verdict, "underperforming", "300 mature applications with no interviews is real evidence");
});

test("recent applications barely count until they've had time for a reply", () => {
  assert.ok(exposure(3) < 0.1);
  assert.equal(exposure(23), 0.5);
  assert.equal(exposure(400), 1);
  const { ledger } = fresh();
  const t = ledger.addTrack("A", "h", [], "active");
  sent(ledger, t, 200, 2);
  const s = verdictOf(ledger, t);
  assert.equal(s.verdict, "too_early");
  assert.ok(s.effective < 15);
});

test("a track clearly beating the benchmark is recognized", () => {
  const { ledger } = fresh();
  const t = ledger.addTrack("A", "h", [], "active");
  sent(ledger, t, 60, 60, 7);
  assert.equal(verdictOf(ledger, t).verdict, "outperforming");
});

test("quota shares favor what's working, keep floors, and turn into whole slots", () => {
  const { ledger } = fresh();
  const good = ledger.addTrack("good", "h", [], "active");
  const meh = ledger.addTrack("meh", "h", [], "active");
  const explore = ledger.addTrack("new", "h", [], "proposed");
  sent(ledger, good, 60, 60, 7);
  sent(ledger, meh, 60, 60, 0);
  const cfg = Config.parse({ provider: { type: "openai", model: "x" } });
  const shares = allocate(trackStats(ledger, "efficiency"), cfg.strategy);
  const total = [...shares.values()].reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(total - 1) < 1e-9);
  assert.ok(shares.get(good)! > shares.get(meh)!);
  assert.ok(shares.get(meh)! >= cfg.strategy.minShare * 0.9 - 1e-9, "a weaker track still gets tried");
  assert.equal(Math.round(shares.get(explore)! * 100), 10, "proposed tracks share the exploration slice");
  const s = slots(shares, 10);
  assert.equal([...s.values()].reduce((a, b) => a + b, 0), 10);
});

test("the strategist can refine freely, but retiring and cementing need the statistics", () => {
  const { root, ledger } = fresh();
  const young = ledger.addTrack("young", "first idea", [], "active");
  const dead = ledger.addTrack("dead", "h", [], "active");
  sent(ledger, dead, 320, 100);
  const cfg = Config.parse({ provider: { type: "openai", model: "x" } });
  const ctx = { cfg, goal: Goal.parse({}), pool: examplePool(), ledger, llm: { complete: async () => { throw new Error("unused"); } }, root, log: () => {} };
  const stats = trackStats(ledger, cfg.mode);
  const out = applyReview(ctx, {
    memo: "",
    actions: [
      { trackId: young, action: "retire", queries: [], employers: [], reason: "no replies yet" },
      { trackId: young, action: "cement", queries: [], employers: [], reason: "feels right" },
      { trackId: young, action: "refine", hypothesis: "sharper idea", queries: [], employers: ["Acme"], reason: "" },
      { trackId: dead, action: "retire", queries: [], employers: [], reason: "nothing in 320" },
    ],
    newTracks: [{ name: "fresh bet", hypothesis: "h", roles: [], queries: [], employers: [] }],
  }, stats);
  const byName = Object.fromEntries(ledger.tracks().map((t) => [t.name, t]));
  assert.equal(byName.young.status, "active");
  assert.equal(byName.young.hypothesis, "sharper idea");
  assert.equal(byName.dead.status, "retired");
  assert.equal(byName["fresh bet"].status, "proposed", "new directions explore until approved");
  assert.ok(out.some((c) => c.startsWith('declined retiring "young"')));
  assert.ok(out.some((c) => c.startsWith('declined cementing "young"')));
  assert.deepEqual(JSON.parse(ledger.meta("pendingCompanies")!), ["Acme"]);
});

test("tracks agreed in setup start as written, with no model call", async () => {
  const { root, ledger } = fresh();
  const cfg = Config.parse({ provider: { type: "command", command: "none" } });
  const pool = examplePool();
  const llm = mockLlm(pool);
  const goal = Goal.parse({
    summary: "s",
    tracks: [
      { name: "Legislative staff", hypothesis: "state capitol internship", roles: ["Legislative Aide"], queries: ["legislative aide"], employers: ["Illinois General Assembly"] },
      { name: "Policy research", hypothesis: "thesis research", queries: ["policy analyst"] },
    ],
  });
  const memo = await maybeReview({ cfg, goal, pool, ledger, llm, root, log: () => {} });
  assert.equal(llm.calls.length, 0);
  assert.deepEqual(ledger.tracks().map((t) => [t.name, t.status]), [["Legislative staff", "active"], ["Policy research", "active"]]);
  assert.ok(ledger.queries("active").some((q) => q.query === "legislative aide"));
  assert.match(String(memo), /strategy/);
  // Read once: with tracks live, a later call is a no-op until the weekly review is due.
  ledger.setMeta("lastReview", new Date().toISOString());
  assert.equal(await maybeReview({ cfg, goal, pool, ledger, llm, root, log: () => {} }), null);
  assert.equal(ledger.tracks().length, 2);
});
