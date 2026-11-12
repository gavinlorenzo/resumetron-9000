import { hasAiInstructions } from "./posting.ts";
import type { Job } from "./schema.ts";

// Signs that a posting is a scam, a ghost job, or not what it seems. Each signal quotes what
// triggered it. Scam signals reject the job; the rest are shown to you and to screening,
// because each has innocent explanations on its own.

export interface Signals {
  /** Reasons to never apply: the posting asks for money or looks like a known scam pattern. */
  severe: string[];
  /** Worth knowing before you apply. */
  warn: string[];
}

const quote = (text: string, re: RegExp): string | null => {
  const m = text.match(re);
  if (!m) return null;
  const start = Math.max(0, m.index! - 40);
  return `"${text.slice(start, m.index! + m[0].length + 40).replace(/\s+/g, " ").trim()}"`;
};

const SCAM: [RegExp, string][] = [
  [/\b(pay|purchase|buy|cover the cost of)\b[^.]{0,40}\b(training|starter kit|registration|certification|background check|equipment|software license|uniform)\b(?![^.]{0,40}\b(reimburs|provided|covered|paid for by))/i, "asks you to pay for something to start"],
  [/\b(application|registration|processing|onboarding|placement) fee\b/i, "charges an application or placement fee"],
  [/\b(deposit|cash)\b[^.]{0,40}\b(check|cheque)\b|\b(check|cheque)\b[^.]{0,60}\b(wire|gift cards?|(buy|purchase) (supplies|equipment)|send (back|the (rest|remainder)))\b/i, "involves depositing checks: a common fake-job scam"],
  [/\b(gift cards?|wire transfer|western union|moneygram|cryptocurrency|bitcoin)\b/i, "mentions gift cards, wire transfers, or crypto"],
  [/\b(reship(ping)?|package (forwarding|inspection)|receive packages at (your|their) home)\b/i, "package reshipping: a common fake-job scam"],
];

const WARN: [RegExp, string][] = [
  [/\b(commission[- ]only|100% commission|uncapped commission(?! plus)|unlimited earning potential|be your own boss|financial freedom)\b/i, "commission-only or income-opportunity language"],
  [/\b(recruit (others|your own team|friends)|build your (own )?team of|multi-?level|network marketing|downline)\b/i, "multi-level marketing language"],
  [/\b(our client|on behalf of (our|a|an) (client|partner)|staffing (agency|firm)|recruiting (agency|firm)|third[- ]party recruiter)\b/i, "posted by a staffing agency for an unnamed employer"],
  [/\b(bank (account|routing) (number|details|information)|social security number|\bssn\b|copy of (your )?(driver'?s license|passport))\b(?![^.]{0,60}\b(after|upon|once)\b[^.]{0,30}\b(offer|hire))/i, "asks for bank or identity details up front"],
  [/[\w.+-]+@(gmail|yahoo|hotmail|outlook|aol|icloud|proton(mail)?)\.(com|me)\b/i, "applications go to a personal email address"],
  [/\b(no (experience|interview) (necessary|needed|required)|hired on the spot|start (today|immediately) (and|with) (earn|make))\b/i, "promises hiring without the usual steps"],
];

// US places that require a pay range in job postings (as of 2026). Matched against the job's location.
const PAY_TRANSPARENCY = [
  ["california", "ca"], ["colorado", "co"], ["new york", "ny"], ["washington", "wa"], ["illinois", "il"], ["maryland", "md"],
  ["minnesota", "mn"], ["hawaii", "hi"], ["vermont", "vt"], ["massachusetts", "ma"], ["new jersey", "nj"], ["rhode island", "ri"],
  ["district of columbia", "dc"], ["jersey city", ""], ["cleveland", ""], ["columbus", ""], ["toledo", ""],
];

const PAY = /[$€£]\s?\d|\b\d{2,3},?\d{3}\s?(-|–|to)\s?\$?\d|\b(salary|pay|compensation|wage)( range)?:?\s*(\$|usd)|\b\d+(\.\d+)?\s?\/\s?(hr|hour)\b/i;

/** Whether the job's location is somewhere that requires posting a pay range. */
export function payTransparencyPlace(location: string): string | null {
  const loc = ` ${location.toLowerCase().replace(/[^a-z]+/g, " ")} `;
  for (const [name, abbr] of PAY_TRANSPARENCY) {
    if (loc.includes(` ${name} `)) return name;
    // Two-letter codes only after a comma ("Seattle, WA"), so "in" or "or" never count.
    if (abbr && new RegExp(`,\\s*${abbr}\\b`, "i").test(location)) return name;
  }
  return null;
}

/** Reads a posting for warning signs. `reposts` is how many times the same job reappeared under a new listing. */
export function postingSignals(job: Job, reposts = 0): Signals {
  const text = `${job.title}\n${job.description}`;
  const severe: string[] = [];
  const warn: string[] = [];
  for (const [re, why] of SCAM) {
    const q = quote(text, re);
    if (q) severe.push(`${why}: ${q}`);
  }
  for (const [re, why] of WARN) {
    const q = quote(text, re);
    if (q) warn.push(`${why}: ${q}`);
  }
  const place = payTransparencyPlace(job.location);
  if (place && job.salaryMin === undefined && job.salaryMax === undefined && !PAY.test(job.description) && job.description.length > 400) {
    warn.push(`no pay range, though ${place} requires one in job postings`);
  }
  if (reposts >= 2) warn.push(`reposted ${reposts} times: possibly a ghost job or a role that's hard to fill`);
  if (job.description.length < 300 && !["adzuna", "preview"].includes(job.source)) warn.push("very short posting with few details");
  if (hasAiInstructions(job.flags)) warn.push("the posting contains hidden text or instructions aimed at AI software");
  return { severe, warn };
}
