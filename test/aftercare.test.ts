import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { draftFollowup, dueFollowups, followupsFor } from "../src/aftercare.ts";
import { Ledger } from "../src/ledger.ts";
import type { Llm } from "../src/llm/index.ts";
import { importConnections, knownAt, parseConnections } from "../src/network.ts";
import { buildReport, reasonCategory, wilson } from "../src/report.ts";
import type { Job } from "../src/schema.ts";
import { examplePool } from "./helpers.ts";

const dirs: string[] = [];
const ledgers: Ledger[] = [];
after(() => {
  for (const l of ledgers) l.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function fresh() {
  const root = mkdtempSync(join(tmpdir(), "rt-after-"));
  dirs.push(root);
  const ledger = new Ledger(join(root, "ledger.db"));
  ledgers.push(ledger);
  return { root, ledger };
}

const job = (id: string, extra: Partial<Job> = {}): Job => ({
  id, source: "greenhouse", company: "Acme Civic, Inc.", title: "Policy Analyst", location: "Remote", remote: true,
  url: `https://acme.example/${id}`, applyUrl: `https://acme.example/${id}`, description: "Write briefing memos.", autoApplicable: true, ...extra,
});

/** Records a sent application `daysAgo` days old, with a packet folder. */
function sent(root: string, ledger: Ledger, id: string, daysAgo: number, extra: Partial<Job> = {}) {
  ledger.addJobs([job(id, { title: `Policy Analyst ${id}`, ...extra })], "x");
  const dir = join(root, "applications", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "fields.json"), JSON.stringify({ resumeText: "Policy Intern, City of Springfield. Researched zoning policy in 8 peer cities.", coverText: "I drafted briefing memos." }));
  writeFileSync(join(dir, "job.md"), "# Policy Analyst\nWrite briefing memos for 5 council members.");
  ledger.setStatus(id, "submitted", { force: true, packet_dir: dir });
  ledger.db.prepare("UPDATE jobs SET submitted_at = ? WHERE id = ?").run(new Date(Date.now() - daysAgo * 86_400_000).toISOString(), id);
}

test("follow-ups come on a cadence, at most twice, and stop once there's a real reply", async () => {
  const { root, ledger } = fresh();
  const policy = { afterDays: 7, everyDays: 7, max: 2 };
  sent(root, ledger, "a", 3);
  sent(root, ledger, "b", 9);
  sent(root, ledger, "c", 30);
  sent(root, ledger, "d", 30);
  ledger.setOutcome("d", "rejected");
  assert.deepEqual(dueFollowups(ledger, policy).map((d) => d.row.id).sort(), ["b", "c"]);

  await draftFollowup(undefined, ledger, examplePool(), ledger.get("c")!, 1, 30);
  assert.deepEqual(dueFollowups(ledger, policy).map((d) => [d.row.id, d.n]), [["c", 2], ["b", 1]], "30 days covers the second one too");
  await draftFollowup(undefined, ledger, examplePool(), ledger.get("c")!, 2, 30);
  assert.deepEqual(dueFollowups(ledger, policy).map((d) => d.row.id), ["b"], "no third follow-up");
  assert.equal(followupsFor(ledger, "c").length, 2);
});

test("a drafted follow-up can't claim what the application didn't", async () => {
  const { root, ledger } = fresh();
  sent(root, ledger, "e", 10);
  const llm: Llm = {
    async complete() {
      return {
        text: JSON.stringify({
          subject: "Following up",
          body: "Hello,\nI applied for the Policy Analyst role and remain very interested. I researched zoning policy in 8 peer cities. I also managed 5 council members' budgets.\nThank you,\nAlex Rivera",
        }),
        usage: { input: 1, output: 1, cached: 0 },
      };
    },
  };
  const path = await draftFollowup(llm, ledger, examplePool(), ledger.get("e")!, 1, 10);
  const text = readFileSync(path, "utf8");
  assert.match(text, /8 peer cities/);
  assert.doesNotMatch(text.split("# Removed")[0], /council members' budgets/, "the posting's 5 council members can't become the candidate's");
  assert.match(text, /# Removed for citing unverified facts/);
});

test("LinkedIn's export is read past its notes, and matched by company", () => {
  const csv = `Notes:\n"When exporting your connection data, you may notice..."\n\nFirst Name,Last Name,URL,Email Address,Company,Position,Connected On\nJane,Doe,https://www.linkedin.com/in/jane,,"Acme Civic",Policy Director,01 Jan 2025\n"Sam, Jr.",Lee,https://www.linkedin.com/in/sam,,Other Org,Analyst,02 Feb 2025\n`;
  const c = parseConnections(csv);
  assert.equal(c.length, 2);
  assert.equal(c[1].name, "Sam, Jr. Lee");
  const { root, ledger } = fresh();
  const path = join(root, "Connections.csv");
  writeFileSync(path, csv);
  assert.equal(importConnections(ledger, path), 2);
  assert.deepEqual(knownAt(ledger, "Acme Civic, Inc.").map((x) => x.name), ["Jane Doe"], "company suffixes don't matter");
});

test("the report groups reasons and keeps small samples honest", () => {
  const [lo, hi] = wilson(1, 20);
  assert.ok(lo > 0 && lo < 0.01 && hi > 0.2 && hi < 0.27, `${lo} ${hi}`);
  assert.equal(reasonCategory('gate: the employer won\'t sponsor a visa ("We are unable to sponsor")'), "gate: the employer won't sponsor a visa");
  assert.equal(reasonCategory("closed: Greenhouse no longer lists this job"), "posting closed");
  assert.equal(reasonCategory('title contains "Senior"'), "title filter");
  const { root, ledger } = fresh();
  for (let i = 0; i < 6; i++) sent(root, ledger, `s${i}`, 40);
  ledger.setOutcome("s0", "interview");
  const r = buildReport(ledger);
  assert.equal(r.bySource[0].sent, 6);
  assert.ok(r.bySource[0].rate !== null && Math.abs(r.bySource[0].rate - 1 / 6) < 1e-9);
  assert.ok(existsSync(root));
});
