import assert from "node:assert/strict";
import { test } from "node:test";
import { workedHereAnswer } from "../src/forms/resolve.ts";
import { examplePool } from "./helpers.ts";

const pool = examplePool();

test("'worked here before?' is answered from the pool's employers, by code", () => {
  assert.equal(workedHereAnswer("Have you previously worked for Corner Cafe?", "Corner Cafe", pool), "Yes");
  assert.equal(workedHereAnswer("Have you ever been employed by us?", "Corner Cafe, Inc.", pool), "Yes");
  assert.equal(workedHereAnswer("Are you currently, or have you previously, worked for Acme?", "Acme", pool), "No");
  assert.equal(workedHereAnswer("Have you worked at this company before?", "Acme Corp", pool), "No");
});

test("'currently employed here' needs a role that runs to the present", () => {
  assert.equal(workedHereAnswer("Are you currently employed by Corner Cafe?", "Corner Cafe", pool), "No");
});

test("questions about other employers or past applications are left alone", () => {
  assert.equal(workedHereAnswer("Have you ever worked for a government agency?", "Acme", pool), undefined);
  assert.equal(workedHereAnswer("Have you previously applied to Acme?", "Acme", pool), undefined);
  assert.equal(workedHereAnswer("Why do you want to work here?", "Acme", pool), undefined);
});

test("a gender answer matches the form's other common wording", async () => {
  const { matchOption } = await import("../src/forms/resolve.ts");
  assert.equal(matchOption("Female", ["Woman", "Man", "Non-Binary", "I don't wish to answer"]), "Woman");
  assert.equal(matchOption("Female", ["Female", "Male"]), "Female");
  assert.equal(matchOption("Male", ["Woman", "Man"]), "Man");
});
