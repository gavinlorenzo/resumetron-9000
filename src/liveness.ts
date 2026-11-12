import type { Job } from "./schema.ts";
import { errorMessage } from "./util.ts";

// Is a posting still open? Checked before tokens are spent screening it, before a packet is
// built, and before submitting. The ATS's own API answers when there is one; otherwise the
// posting page is read for a "no longer accepting applications" banner. Only a clear signal
// closes a job: a timeout, a bot check, or an unfamiliar page leaves it "unknown", which is
// treated as open.

export type Liveness = { state: "open" | "closed" | "unknown"; detail: string };

const CLOSED =
  /\b(no longer (accepting (applications|candidates)|available|open|active|posted)|this (job|position|posting|role|requisition|vacancy) (has been|is|was) (filled|closed|expired|removed|deleted|cancell?ed)|(position|job|role) (has been )?filled|(job|posting|listing|vacancy) (has )?expired|applications? (are |is )?(now )?closed|(we('re| are)|is) no longer hiring|job (you('re| are) looking for|you requested) (is no longer|was not found|could not be found|doesn't exist)|page you('re| are) looking for (doesn't|does not|no longer) exist)\b/i;
const CHALLENGE = /\b(verify you are (a )?human|are you a robot|attention required|checking your browser|enable javascript and cookies|captcha)\b/i;

const UA = { "User-Agent": "Mozilla/5.0 (compatible; resumetron-9000)" };

async function get(url: string): Promise<Response> {
  return fetch(url, { headers: UA, redirect: "follow", signal: AbortSignal.timeout(15_000) });
}

const boardCache = new Map<string, { at: number; ids: Set<string> }>();

/** One Ashby board's open job ids, cached for 10 minutes so a run checks each board once. */
async function ashbyIds(board: string): Promise<Set<string>> {
  const hit = boardCache.get(board);
  if (hit && Date.now() - hit.at < 600_000) return hit.ids;
  const res = await get(`https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(board)}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data: any = await res.json();
  const ids = new Set<string>((data.jobs ?? []).filter((j: any) => j.isListed !== false).map((j: any) => String(j.id)));
  boardCache.set(board, { at: Date.now(), ids });
  return ids;
}

/** Asks the ATS API about one posting, when the URL says which ATS it is. Null when there's no API route. */
async function viaApi(job: Job): Promise<Liveness | null> {
  for (const raw of [job.applyUrl, job.url]) {
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      continue;
    }
    const gh = u.searchParams.get("for") && u.searchParams.get("token");
    if (/greenhouse\.io$/.test(u.hostname) && gh) {
      const res = await get(`https://boards-api.greenhouse.io/v1/boards/${u.searchParams.get("for")}/jobs/${u.searchParams.get("token")}`);
      if (res.status === 404) return { state: "closed", detail: "Greenhouse no longer lists this job" };
      if (res.ok) return { state: "open", detail: "listed on Greenhouse" };
      return { state: "unknown", detail: `Greenhouse answered HTTP ${res.status}` };
    }
    const ghPath = /greenhouse\.io$/.test(u.hostname) && u.pathname.match(/^\/([\w-]+)\/jobs\/(\d+)/);
    if (ghPath) {
      const res = await get(`https://boards-api.greenhouse.io/v1/boards/${ghPath[1]}/jobs/${ghPath[2]}`);
      if (res.status === 404) return { state: "closed", detail: "Greenhouse no longer lists this job" };
      if (res.ok) return { state: "open", detail: "listed on Greenhouse" };
    }
    const lever = u.hostname === "jobs.lever.co" && u.pathname.match(/^\/([\w.-]+)\/([0-9a-f-]{36})/i);
    if (lever) {
      const res = await get(`https://api.lever.co/v0/postings/${lever[1]}/${lever[2]}`);
      if (res.status === 404) return { state: "closed", detail: "Lever no longer lists this job" };
      if (res.ok) return { state: "open", detail: "listed on Lever" };
      return { state: "unknown", detail: `Lever answered HTTP ${res.status}` };
    }
    const ashby = u.hostname === "jobs.ashbyhq.com" && u.pathname.match(/^\/([^/]+)\/([0-9a-f-]{36})/i);
    if (ashby) {
      const ids = await ashbyIds(decodeURIComponent(ashby[1]));
      return ids.has(ashby[2]) ? { state: "open", detail: "listed on Ashby" } : { state: "closed", detail: "no longer on the company's Ashby board" };
    }
  }
  return null;
}

/** Reads the posting page itself for a closed banner. */
async function viaPage(job: Job): Promise<Liveness> {
  const res = await get(job.url);
  if (res.status === 404 || res.status === 410) return { state: "closed", detail: `the posting page is gone (HTTP ${res.status})` };
  if (!res.ok) return { state: "unknown", detail: `posting page answered HTTP ${res.status}` };
  const body = (await res.text()).replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  if (CHALLENGE.test(body) && body.length < 4000) return { state: "unknown", detail: "the site showed a bot check" };
  const closed = body.match(CLOSED);
  if (closed) return { state: "closed", detail: `the posting page says "${closed[0]}"` };
  return { state: "open", detail: "posting page loads with no closed notice" };
}

export async function checkLiveness(job: Job): Promise<Liveness> {
  try {
    return (await viaApi(job)) ?? (await viaPage(job));
  } catch (e) {
    return { state: "unknown", detail: `couldn't check: ${errorMessage(e)}` };
  }
}

export const CLOSED_TEXT = CLOSED;
