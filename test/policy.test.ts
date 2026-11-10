import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { BrowserHost } from "../src/browser.ts";
import { addUnit, compose } from "../src/resume/compose.ts";
import { assessLetter } from "../src/tailor.ts";
import { examplePool } from "./helpers.ts";

const pool = examplePool();
const browser = new BrowserHost({ headless: true });
const dir = mkdtempSync(join(tmpdir(), "rt-policy-"));
after(async () => {
  await browser.close();
  rmSync(dir, { recursive: true, force: true });
});

test("addUnit brings a bullet in under its role and entry headers, in pool wording", () => {
  const { doc } = compose(pool, { rationale: "", reserve: [], sections: [{ key: "education", entries: [{ id: "state-ba" }] }] });
  assert.ok(addUnit(doc, pool, "city-intern-2"));
  assert.equal(addUnit(doc, pool, "city-intern-2"), false, "no duplicates");
  const work = doc.sections.find((s) => s.key === "work") as any;
  assert.equal(work.entries[0].org, "City of Springfield, Office of the Mayor");
  assert.equal(work.entries[0].roles[0].bullets[0].text, "Organized 3 public listening sessions attended by over 200 residents");
  assert.ok(addUnit(doc, pool, "sk-spanish"));
  assert.ok(addUnit(doc, pool, "leadership"));
  assert.equal(addUnit(doc, pool, "not-a-real-id"), false);
});

test("a short page is topped up from the reserve, in rank order, without enlarging type", async () => {
  const plan = {
    rationale: "",
    sections: [{ key: "education", entries: [{ id: "state-ba" }] }],
    reserve: ["work", "leadership", "skills"],
  };
  const { doc } = compose(pool, plan);
  const bare = await browser.renderResume(doc, join(dir, "bare.pdf"), 1);
  const filled = await browser.renderResume(doc, join(dir, "filled.pdf"), 1, { pool, reserve: plan.reserve });
  assert.equal(bare.added, 0);
  assert.equal(filled.added, 3);
  assert.ok(filled.fillRatio > bare.fillRatio);
  assert.equal(filled.fontPt, 11);
  assert.deepEqual(filled.doc.sections.map((s) => s.key), ["education", "work", "leadership", "skills"]);
});

test("the specificity check rejects boilerplate and invented quotes", () => {
  const posting = "Our Civic Data team helps cities publish open budgets. You will build dashboards for council members and run resident workshops.";
  const generic = {
    hooks: [{ quote: "helps cities publish open budgets", angle: "" }, { quote: "a world-class culture", angle: "" }],
    paragraphs: ["Dear Hiring Team,", "I am writing to express that I am passionate about this unique opportunity.", "I would be a great fit."],
  };
  const g = assessLetter(generic, posting, "Example Civic Labs");
  assert.equal(g.verified.length, 1, "a quote not in the posting is not a hook");
  assert.equal(g.problems.length, 4);

  const specific = {
    hooks: [{ quote: "helps cities publish open budgets", angle: "" }, { quote: "run resident workshops", angle: "" }],
    paragraphs: [
      "Dear Example Civic Labs Hiring Team,",
      "The Civic Data team at Example Civic Labs helps cities publish open budgets, which is the work I want to do next.",
      "I have run resident workshops before: three listening sessions for the mayor's office.",
      "I'd welcome the chance to talk.",
    ],
  };
  assert.deepEqual(assessLetter(specific, posting, "Example Civic Labs").problems, []);
});
