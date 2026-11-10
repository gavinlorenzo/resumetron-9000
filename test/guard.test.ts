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
  const { doc } = compose(pool, { rationale: "", sections: [{ key: "work", entries: [{ id: "made-up-job" }, { id: "cafe" }] }] });
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
  assert.equal(checkProse("I also interned at the White House for 2 years.", allowed).length, 1);
});
