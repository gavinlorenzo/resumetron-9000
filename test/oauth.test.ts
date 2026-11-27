import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { GMAIL_SCOPE, consentUrl, readClient } from "../src/oauth.ts";

const dir = mkdtempSync(join(tmpdir(), "rt-oauth-"));
after(() => rmSync(dir, { recursive: true, force: true }));

test("a Desktop client file reads as Google downloads it", () => {
  const f = join(dir, "client.json");
  writeFileSync(f, JSON.stringify({ installed: { client_id: "id.apps.googleusercontent.com", client_secret: "s" } }));
  assert.deepEqual(readClient(f), { clientId: "id.apps.googleusercontent.com", clientSecret: "s" });
  writeFileSync(f, JSON.stringify({ installed: {} }));
  assert.throws(() => readClient(f), /client_id/);
});

test("the consent link asks for offline mail access with PKCE", () => {
  const u = new URL(consentUrl({ clientId: "id", clientSecret: "s" }, "http://127.0.0.1:5000", "chal", "st", "a@example.com"));
  assert.equal(u.searchParams.get("scope"), GMAIL_SCOPE);
  assert.equal(u.searchParams.get("access_type"), "offline");
  assert.equal(u.searchParams.get("code_challenge_method"), "S256");
  assert.equal(u.searchParams.get("login_hint"), "a@example.com");
  assert.equal(u.searchParams.get("client_secret"), null, "the secret never goes in the browser URL");
});
