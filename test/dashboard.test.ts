import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { authorized, packetFile, plainReason } from "../src/dashboard.ts";

const root = mkdtempSync(join(tmpdir(), "rt-dash-"));
const apps = join(root, "applications");
const packet = join(apps, "Acme-1234");
mkdirSync(packet, { recursive: true });
writeFileSync(join(packet, "Resume.pdf"), "%PDF");
writeFileSync(join(packet, "packet.json"), "{}");
writeFileSync(join(root, "secret.pdf"), "%PDF");
after(() => rmSync(root, { recursive: true, force: true }));

const basic = (pw: string) => `Basic ${Buffer.from(`anyone:${pw}`).toString("base64")}`;

test("the dashboard admits only the right password", () => {
  assert.equal(authorized(basic("correct horse"), "correct horse"), true);
  assert.equal(authorized(basic("wrong"), "correct horse"), false);
  assert.equal(authorized(undefined, "correct horse"), false);
  assert.equal(authorized("Bearer correct horse", "correct horse"), false);
});

test("packet files are served only from the job's own folder inside applications", () => {
  assert.equal(packetFile(apps, packet, "Resume.pdf"), join(packet, "Resume.pdf"));
  assert.equal(packetFile(apps, packet, "packet.json"), null, "only documents, not packet internals");
  assert.equal(packetFile(apps, packet, "../../secret.pdf"), null);
  assert.equal(packetFile(apps, root, "secret.pdf"), null, "a packet_dir outside applications is refused");
  assert.equal(packetFile(apps, apps, "Resume.pdf"), null);
  assert.equal(packetFile(apps, null, "Resume.pdf"), null);
});

test("queue reasons shown to the seeker drop terminal hints and local paths", () => {
  assert.equal(
    plainReason("finish on himalayas.app (resumetron apply f833bb22 --handoff fills what it can); your documents are in C:/Users/x/applications/CAI-1"),
    "finish on himalayas.app",
  );
  assert.equal(plainReason("2 field(s) need you: Country"), "2 field(s) need you: Country");
});
