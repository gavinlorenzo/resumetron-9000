import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { type InboundMessage, type Mailbox, type OutboundMessage, applyByEmailAddress, classifyReply, syncInbox } from "../src/email.ts";
import { Ledger } from "../src/ledger.ts";
import type { Job } from "../src/schema.ts";

const dirs: string[] = [];
const ledgers: Ledger[] = [];
after(() => {
  for (const l of ledgers) l.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

test("finds the address a posting asks applications to go to, and nothing else", () => {
  assert.equal(applyByEmailAddress({ description: "To apply, send your resume and cover letter to jobs@civic.org by Friday." }), "jobs@civic.org");
  assert.equal(applyByEmailAddress({ description: "Email hiring@acme.com with your CV." }), "hiring@acme.com");
  assert.equal(applyByEmailAddress({ description: "Questions about accommodations? Contact accommodations@acme.com." }), null);
  assert.equal(applyByEmailAddress({ description: "Our press office is press@acme.com. Apply on our website." }), null);
});

test("classifies replies by their wording", () => {
  assert.equal(classifyReply("Your application", "Unfortunately, we have decided to move forward with other candidates."), "rejected");
  assert.equal(classifyReply("Next steps", "We'd love to schedule a call. Please share your availability this week."), "interview");
  assert.equal(classifyReply("Thank you for applying", "We received your application. If your experience is a match, we'll reach out to schedule an interview."), "acknowledged");
  assert.equal(classifyReply("Offer", "We are pleased to offer you the position."), "offer");
  assert.equal(classifyReply("Hello", "Quick question about your portfolio."), "unclear");
});

/** A mailbox in memory. Records which bodies were downloaded. */
function fakeMailbox(messages: InboundMessage[]): Mailbox & { sent: OutboundMessage[]; bodiesFetched: number[] } {
  const sent: OutboundMessage[] = [];
  const bodiesFetched: number[] = [];
  return {
    sent,
    bodiesFetched,
    fetchHeaders: async (after, _since, limit) => messages.filter((m) => m.uid > after).slice(0, limit).map((m) => ({ ...m, text: "" })),
    fetchText: async (uids) => {
      bodiesFetched.push(...uids);
      return new Map(messages.filter((m) => uids.includes(m.uid)).map((m) => [m.uid, m.text]));
    },
    send: async (m) => {
      sent.push(m);
      return "<sent-1@test>";
    },
    verify: async () => {},
  };
}

test("inbox sync matches replies to applications, reads only likely bodies, and never re-reads", async () => {
  const root = mkdtempSync(join(tmpdir(), "rt-mail-"));
  dirs.push(root);
  const ledger = new Ledger(join(root, "ledger.db"));
  ledgers.push(ledger);
  const job = (id: string, company: string, title: string): Job => ({ id, source: "t", company, title, location: "", remote: false, url: id, applyUrl: id, description: "", autoApplicable: true });
  ledger.addJobs([job("j1", "Civic Labs", "Policy Analyst"), job("j2", "Acme Robotics", "Program Coordinator")], "q:1");
  ledger.setStatus("j1", "submitted", { force: true });
  ledger.setStatus("j2", "submitted", { force: true });
  ledger.setChannel("j2", "email", "<app-j2@me>");

  const msgs: InboundMessage[] = [
    { uid: 1, messageId: "<m1>", inReplyTo: [], from: "no-reply@greenhouse.io", subject: "Your application to Civic Labs", date: "", text: "Unfortunately we will not be moving forward with your application for Policy Analyst." },
    { uid: 2, messageId: "<m2>", inReplyTo: ["<app-j2@me>"], from: "dana@acmerobotics.com", subject: "Re: Application: Program Coordinator", date: "", text: "Thanks! Could we schedule a 30 minute call? What's your availability?" },
    { uid: 3, messageId: "<m3>", inReplyTo: [], from: "mom@family.net", subject: "Dinner Sunday?", date: "", text: "private" },
  ];
  const box = fakeMailbox(msgs);
  const r = await syncInbox(box, ledger, { limit: 50, log: () => {} });
  assert.equal(r.read, 3);
  assert.equal(r.matched, 2);
  assert.deepEqual(box.bodiesFetched.sort(), [1, 2], "the personal message's body is never downloaded");
  assert.equal(ledger.get("j1")!.outcome, "rejected");
  assert.equal(ledger.get("j2")!.outcome, "interview");
  assert.equal(ledger.recentEmails(10).length, 2, "only matched mail is recorded");

  const again = await syncInbox(box, ledger, { limit: 50, log: () => {} });
  assert.equal(again.read, 0, "the UID cursor moved past what was read");
  assert.equal(ledger.setOutcome("j2", "rejected"), false, "an interview is never downgraded");
});
