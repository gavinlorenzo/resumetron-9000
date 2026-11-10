import type { Config } from "./config.ts";
import type { Goal, Job } from "./schema.ts";
import { errorMessage, fetchJson, htmlToText, shortHash } from "./util.ts";

// Job sources are official public APIs only. LinkedIn and Indeed are deliberately absent:
// their terms forbid automated applying and accounts that do it get banned.

const isRemote = (...xs: (string | undefined)[]) => xs.some((x) => x && /remote|anywhere|distributed/i.test(x));

const job = (j: Omit<Job, "id">): Job => ({ ...j, id: shortHash(`${j.source}|${j.url}`) });

async function greenhouse(token: string, name?: string): Promise<Job[]> {
  const data = await fetchJson(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(token)}/jobs?content=true`);
  return (data.jobs ?? []).map((j: any) =>
    job({
      source: "greenhouse",
      company: name ?? j.company_name ?? token,
      title: j.title,
      location: j.location?.name ?? "",
      remote: isRemote(j.location?.name, j.title),
      url: j.absolute_url,
      // The hosted form works for every board, even when absolute_url is a company site.
      applyUrl: `https://job-boards.greenhouse.io/embed/job_app?for=${encodeURIComponent(token)}&token=${j.id}`,
      description: htmlToText(j.content ?? ""),
      postedAt: j.first_published ?? j.updated_at,
      autoApplicable: true,
    }),
  );
}

async function lever(site: string, name?: string): Promise<Job[]> {
  const data = await fetchJson(`https://api.lever.co/v0/postings/${encodeURIComponent(site)}?mode=json`);
  return (data ?? []).map((j: any) =>
    job({
      source: "lever",
      company: name ?? site,
      title: j.text,
      location: j.categories?.location ?? "",
      remote: j.workplaceType === "remote" || isRemote(j.categories?.location),
      url: j.hostedUrl,
      applyUrl: j.applyUrl ?? `${j.hostedUrl}/apply`,
      description: [j.descriptionPlain, ...(j.lists ?? []).map((l: any) => `${l.text}\n${htmlToText(l.content)}`), j.additionalPlain]
        .filter(Boolean)
        .join("\n"),
      postedAt: j.createdAt ? new Date(j.createdAt).toISOString() : undefined,
      salaryMin: j.salaryRange?.min,
      salaryMax: j.salaryRange?.max,
      autoApplicable: true,
    }),
  );
}

async function ashby(board: string, name?: string): Promise<Job[]> {
  const data = await fetchJson(`https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(board)}?includeCompensation=true`);
  return (data.jobs ?? [])
    .filter((j: any) => j.isListed !== false)
    .map((j: any) =>
      job({
        source: "ashby",
        company: name ?? board,
        title: j.title,
        location: j.location ?? "",
        remote: Boolean(j.isRemote) || isRemote(j.location),
        url: j.jobUrl,
        applyUrl: j.applyUrl ?? `${j.jobUrl}/application`,
        description: j.descriptionPlain ?? htmlToText(j.descriptionHtml ?? ""),
        postedAt: j.publishedAt,
        autoApplicable: true,
      }),
    );
}

async function usajobs(cfg: NonNullable<Config["sources"]["usajobs"]>, query: string, location?: string): Promise<Job[]> {
  const key = process.env[cfg.apiKeyEnv];
  const email = process.env[cfg.contactEmailEnv];
  if (!key || !email) throw new Error(`set ${cfg.apiKeyEnv} and ${cfg.contactEmailEnv} to search USAJOBS`);
  const params = new URLSearchParams({ Keyword: query, ResultsPerPage: "100", DatePosted: "30" });
  if (location) params.set("LocationName", location);
  const data = await fetchJson(`https://data.usajobs.gov/api/search?${params}`, {
    headers: { "User-Agent": email, "Authorization-Key": key },
  });
  return (data.SearchResult?.SearchResultItems ?? []).map((item: any) => {
    const d = item.MatchedObjectDescriptor;
    const pay = d.PositionRemuneration?.[0];
    return job({
      source: "usajobs",
      company: d.OrganizationName,
      title: d.PositionTitle,
      location: d.PositionLocationDisplay ?? "",
      remote: isRemote(d.PositionLocationDisplay) || d.UserArea?.Details?.RemoteIndicator === true,
      url: d.PositionURI,
      applyUrl: d.ApplyURI?.[0] ?? d.PositionURI,
      description: [d.UserArea?.Details?.JobSummary, ...(d.UserArea?.Details?.MajorDuties ?? []), d.QualificationSummary]
        .filter(Boolean)
        .join("\n"),
      postedAt: d.PublicationStartDate,
      salaryMin: pay?.RateIntervalCode === "PA" ? Number(pay.MinimumRange) : undefined,
      salaryMax: pay?.RateIntervalCode === "PA" ? Number(pay.MaximumRange) : undefined,
      // USAJOBS applications go through a login.gov account: prepared, then finished by you.
      autoApplicable: false,
    });
  });
}

async function adzuna(cfg: NonNullable<Config["sources"]["adzuna"]>, query: string, location?: string): Promise<Job[]> {
  const id = process.env[cfg.appIdEnv];
  const key = process.env[cfg.appKeyEnv];
  if (!id || !key) throw new Error(`set ${cfg.appIdEnv} and ${cfg.appKeyEnv} to search Adzuna`);
  const params = new URLSearchParams({ app_id: id, app_key: key, results_per_page: "50", what: query, max_days_old: "30" });
  if (location) params.set("where", location);
  const data = await fetchJson(`https://api.adzuna.com/v1/api/jobs/${cfg.country}/search/1?${params}`);
  return (data.results ?? []).map((j: any) =>
    job({
      source: "adzuna",
      company: j.company?.display_name ?? "Unknown",
      title: htmlToText(j.title ?? ""),
      location: j.location?.display_name ?? "",
      remote: isRemote(j.location?.display_name, j.title, j.description),
      url: j.redirect_url,
      applyUrl: j.redirect_url,
      description: htmlToText(j.description ?? ""), // Adzuna returns a snippet only
      postedAt: j.created,
      salaryMin: j.salary_min,
      salaryMax: j.salary_max,
      autoApplicable: false,
    }),
  );
}

export type SourceFetcher = (goal: Goal, cfg: Config, log: (s: string) => void) => Promise<Job[]>;

export const fetchAllJobs: SourceFetcher = async (goal, cfg, log) => {
  const tasks: [string, () => Promise<Job[]>][] = [];
  for (const c of goal.companies) {
    const fn = { greenhouse, lever, ashby }[c.ats];
    tasks.push([`${c.ats}:${c.token}`, () => fn(c.token, c.name)]);
  }
  for (const s of goal.searches) {
    if (cfg.sources.usajobs) tasks.push([`usajobs:${s.query}`, () => usajobs(cfg.sources.usajobs!, s.query, s.location)]);
    if (cfg.sources.adzuna) tasks.push([`adzuna:${s.query}`, () => adzuna(cfg.sources.adzuna!, s.query, s.location)]);
  }
  const results = await Promise.allSettled(tasks.map(([, fn]) => fn()));
  const jobs: Job[] = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled") jobs.push(...r.value);
    else log(`  source ${tasks[i][0]} failed: ${errorMessage(r.reason)}`);
  });
  return jobs;
};

/** Confirms a board token exists and reports how many jobs it lists. */
export async function checkBoard(ats: "greenhouse" | "lever" | "ashby", token: string): Promise<number> {
  return (await { greenhouse, lever, ashby }[ats](token)).length;
}
