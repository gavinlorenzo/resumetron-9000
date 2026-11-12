import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import YAML from "yaml";
import { checkBullet, checkProse } from "../src/guard.ts";
import { compose, identityPlan, trimOnce } from "../src/resume/compose.ts";
import { Pool } from "../src/schema.ts";

const pool = Pool.parse(YAML.parse(readFileSync(new URL("../examples/pool.example.yaml", import.meta.url), "utf8")));
const SRC = "Led a team of 40 members to 12 tournament wins while managing a $15,000 travel budget";
const CTX = "Springfield State Debate Society Springfield, IL President";

test("an honest rewording passes", () => {
  assert.deepEqual(checkBullet("Managed a $15,000 travel budget while leading 40 members to 12 tournament wins", SRC, CTX), []);
});

test("inflated or invented numbers are caught", () => {
  assert.match(checkBullet("Led a team of 400 members to 12 tournament wins on a $15,000 budget", SRC, CTX).join(), /400/);
  assert.match(checkBullet("Led 40 members to 12 wins, cutting costs 30%", SRC, CTX).join(), /30/);
});

test("invented tools and organizations are caught", () => {
  assert.match(checkBullet("Led 40 members to 12 tournament wins, tracking the budget in Salesforce", SRC, CTX).join(), /salesforce/);
  assert.match(checkBullet("Led 40 members to 12 wins and built dashboards in Node.js", SRC, CTX).join(), /node\.js/);
});

test("a wholesale new claim is caught even without numbers or names", () => {
  const problems = checkBullet(
    "Designed statistical forecasting models predicting legislative outcomes for regional advocacy coalitions",
    "Trained new staff and handled opening shifts and cash reconciliation",
    "Corner Cafe Barista",
  );
  assert.ok(problems.length > 0);
});

test("compose copies facts from the pool and reverts a fabricated rewrite", () => {
  const plan = identityPlan(pool);
  const work = plan.sections.find((s) => s.key === "work")!;
  // Reorder: put work first, and inject one dishonest and one honest rewrite.
  plan.sections = [work, ...plan.sections.filter((s) => s !== work)];
  const city = work.entries[0].roles![0];
  city.bullets[0].text = "Researched zoning policy in 25 peer cities for the Governor";
  city.bullets[1].text = "Drew over 200 residents to 3 public listening sessions I organized";
  const { doc, issues } = compose(pool, plan);
  assert.equal(doc.sections[0].key, "work");
  const bullets = (doc.sections[0] as any).entries[0].roles[0].bullets.map((b: any) => b.text);
  assert.equal(bullets[0], pool.sections[2].type === "experience" ? (pool.sections[2] as any).entries[0].roles[0].bullets[0].text : "");
  assert.equal(bullets[1], "Drew over 200 residents to 3 public listening sessions I organized");
  assert.equal(issues.length, 1);
  assert.match(issues[0].problem, /25/);
});

test("compose ignores unknown ids and always keeps education", () => {
  const { doc } = compose(pool, { rationale: "", reserve: [], sections: [{ key: "work", entries: [{ id: "made-up-job" }, { id: "cafe" }] }] });
  assert.deepEqual(doc.sections.map((s) => s.key), ["work", "education"]);
});

test("trimming removes the least relevant lines first and never education", () => {
  const { doc } = compose(pool, identityPlan(pool));
  while (trimOnce(doc));
  assert.deepEqual(doc.sections.map((s) => s.key), ["education"]);
});

test("cover letter sentences with unknown facts are flagged", () => {
  const allowed = "Policy Intern City of Springfield 8 peer cities Example Civic Labs";
  assert.equal(checkProse("Dear Example Civic Labs Hiring Team, I researched policy in 8 peer cities.", allowed).length, 0);
  assert.equal(checkProse("As Springfield's policy intern I studied eight peer cities.", allowed).length, 0, "possessives and number words");
  assert.equal(checkProse("I studied nine peer cities.", allowed).length, 1, "spelled-out numbers are checked too");
  const mun = "Head Delegate, Springfield Model United Nations Travel Team";
  assert.equal(checkProse("I led the Springfield Model UN team and its MUN travel.", mun).length, 0, "initialisms of known names");
  assert.equal(checkProse("I briefed the NSA on it.", mun).length, 1, "unrelated acronyms are still caught");
  assert.equal(checkProse("I also interned at the White House for 2 years.", allowed).length, 1);
});

test("numbers keep their units and scale", () => {
  const src = "Grew ARR to $2.3M across the region";
  assert.match(checkBullet("Grew regional ARR to $2.3B", src, "").join(), /2\.3B/, "millions are not billions");
  assert.deepEqual(checkBullet("Grew regional ARR to $2,300,000", src, ""), [], "same money, different spelling");
  assert.match(checkBullet("Grew northeast accounts 40%", "Closed 40 accounts in the northeast", "").join(), /40%/, "a count is not a percentage");
  assert.match(checkBullet("Led 12 engineers serving 12K users", "Led 12 engineers on the payments team", "").join(), /12K/);
  assert.match(checkBullet("Shipped releases 3x faster", "Shipped 3 releases ahead of schedule", "").join(), /3x/);
  assert.deepEqual(checkBullet("Drew two hundred residents to listening sessions", "Drew 200 residents to listening sessions", ""), []);
});

test("tools are caught wherever they appear", () => {
  const src = "Cut deploy time by moving builds to a new pipeline";
  assert.match(checkBullet("Kubernetes rollout cut deploy time on a new pipeline", src, "").join(), /kubernetes/, "first word of a sentence");
  assert.match(checkBullet("Cut deploy time by moving builds to terraform", src, "").join(), /terraform/, "lowercase");
  assert.match(checkBullet("Cut deploy time by moving builds to AWS", src, "").join(), /aws/, "all caps");
  assert.deepEqual(checkBullet("Moved builds to a new pipeline, cutting deploy time", src, ""), [], "plain rewording still passes");
  assert.deepEqual(checkBullet("Excelled at moving builds to a new pipeline to cut deploy time", src, ""), [], "ordinary words that are also product names");
});

test("a rewrite cannot raise the scope of a claim", () => {
  assert.match(checkBullet("Managed the quarterly budget review", "Assisted with the quarterly budget review", "Finance Intern").join(), /scope/);
  assert.match(checkBullet("Single-handedly drafted the grant proposal", "Drafted the grant proposal", "").join(), /scope/);
  assert.deepEqual(checkBullet("Managed weekly shift schedules", "Managed the weekly shift schedule", ""), [], "the source already claims it");
  assert.deepEqual(checkBullet("Led 40 members to 12 wins", "Directed a 40-member team to 12 wins", ""), [], "same scope, different verb");
});

test("posting numbers and tools can't become the candidate's", () => {
  const own = "Policy Intern, City of Springfield. Researched zoning policy in 8 peer cities.";
  const posting = "Requires 5+ years of experience with Salesforce. You will mentor junior analysts.";
  assert.equal(checkProse("I mentored 5 engineers.", own, posting).length, 1, "a posting's 5 years can't back 5 engineers");
  assert.equal(checkProse("You ask for 5+ years of experience, and I bring 8 cities of research instead.", own, posting).length, 0, "restating the posting is fine");
  assert.equal(checkProse("I have used Salesforce daily.", own, posting).length, 1, "a tool only the posting names is not the candidate's");
  assert.equal(checkProse("Your team works in Salesforce.", own, posting).length, 0, "naming the posting's tool is fine");
});
