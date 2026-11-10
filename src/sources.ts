import type { Config } from "./config.ts";
import type { Job } from "./schema.ts";
import { fetchJson, htmlToText, shortHash } from "./util.ts";

// Job sources are official public APIs only. LinkedIn and Indeed are deliberately absent:
// their terms forbid automated applying and accounts that do it get banned.

export type Ats = "greenhouse" | "lever" | "ashby";
export type SearchSource = "usajobs" | "adzuna" | "himalayas" | "remotive";

/** Everything the campaign needs from the outside world. Swappable in tests. */
export interface SourceSet {
  /** Every open role on one company's board. */
  sweep(ats: Ats, token: string, company: string): Promise<Job[]>;
  /** One page of keyword results. `more` is false once the result list has been read to its end. */
  search(source: SearchSource, query: string, location: string, page: number): Promise<{ jobs: Job[]; more: boolean }>;
  /** Finds a company's Greenhouse, Lever, or Ashby board, if it has one. */
  findBoard(company: string): Promise<{ ats: Ats; token: string } | null>;
}

const isRemote = (...xs: (string | undefined)[]) => xs.some((x) => x && /remote|anywhere|distributed/i.test(x));

const job = (j: Omit<Job, "id">): Job => ({ ...j, id: shortHash(`${j.source}|${j.url}`) });

// ---------------- company boards ----------------

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

const BOARDS = { greenhouse, lever, ashby };

/** Confirms a board token exists and reports how many jobs it lists. */
export async function checkBoard(ats: Ats, token: string): Promise<number> {
  return (await BOARDS[ats](token)).length;
}

/** Likely board tokens for a company name: "Acme Robotics, Inc." -> acmerobotics, acme-robotics, acme. */
export function tokenGuesses(company: string): string[] {
  const words = company
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\b(inc|llc|ltd|corp|corporation|co|pbc|plc|gmbh)\b\.?/g, " ")
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  if (!words.length) return [];
  return [...new Set([words.join(""), words.join("-"), words[0]])].filter((t) => t.length >= 3);
}

// ---------------- keyword search ----------------

type Page = { jobs: Job[]; more: boolean };

async function usajobs(cfg: NonNullable<Config["sources"]["usajobs"]>, query: string, location: string, page: number): Promise<Page> {
  const key = process.env[cfg.apiKeyEnv];
  const email = process.env[cfg.contactEmailEnv];
  if (!key || !email) throw new Error(`set ${cfg.apiKeyEnv} and ${cfg.contactEmailEnv} to search USAJOBS`);
  const params = new URLSearchParams({ Keyword: query, ResultsPerPage: "50", Page: String(page), DatePosted: "30" });
  if (location) params.set("LocationName", location);
  const data = await fetchJson(`https://data.usajobs.gov/api/search?${params}`, {
    headers: { "User-Agent": email, "Authorization-Key": key },
  });
  const jobs = (data.SearchResult?.SearchResultItems ?? []).map((item: any) => {
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
  const pages = Number(data.SearchResult?.UserArea?.NumberOfPages ?? 1);
  return { jobs, more: page < pages };
}

async function adzuna(cfg: NonNullable<Config["sources"]["adzuna"]>, query: string, location: string, page: number): Promise<Page> {
  const id = process.env[cfg.appIdEnv];
  const key = process.env[cfg.appKeyEnv];
  if (!id || !key) throw new Error(`set ${cfg.appIdEnv} and ${cfg.appKeyEnv} to search Adzuna`);
  const params = new URLSearchParams({ app_id: id, app_key: key, results_per_page: "50", what: query, max_days_old: "30", sort_by: "date" });
  if (location) params.set("where", location);
  const data = await fetchJson(`https://api.adzuna.com/v1/api/jobs/${cfg.country}/search/${page}?${params}`);
  const results = data.results ?? [];
  const jobs = results.map((j: any) =>
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
  return { jobs, more: results.length === 50 && page * 50 < (data.count ?? 0) };
}

async function himalayas(query: string, page: number): Promise<Page> {
  const data = await fetchJson(`https://himalayas.app/jobs/api/search?${new URLSearchParams({ q: query, page: String(page) })}`);
  const jobs = (data.jobs ?? []).map((j: any) => {
    const regions: string[] = j.locationRestrictions ?? [];
    return job({
      source: "himalayas",
      company: j.companyName,
      title: j.title,
      location: regions.length ? `Remote (${regions.join(", ")})` : "Remote",
      remote: true,
      remoteRegions: regions,
      url: j.guid ?? j.applicationLink,
      applyUrl: j.applicationLink ?? j.guid,
      description: htmlToText(j.description ?? j.excerpt ?? ""),
      postedAt: j.pubDate ? new Date(j.pubDate * 1000).toISOString() : undefined,
      salaryMin: j.salaryPeriod === "annual" ? j.minSalary ?? undefined : undefined,
      salaryMax: j.salaryPeriod === "annual" ? j.maxSalary ?? undefined : undefined,
      autoApplicable: false,
    });
  });
  return { jobs, more: (data.offset ?? 0) + jobs.length < (data.totalCount ?? 0) };
}

async function remotive(query: string): Promise<Page> {
  const data = await fetchJson(`https://remotive.com/api/remote-jobs?${new URLSearchParams({ search: query, limit: "100" })}`);
  const jobs = (data.jobs ?? []).map((j: any) => {
    const where: string = j.candidate_required_location ?? "";
    const anywhere = !where || /worldwide|anywhere/i.test(where);
    return job({
      source: "remotive",
      company: j.company_name,
      title: j.title,
      location: where ? `Remote (${where})` : "Remote",
      remote: true,
      remoteRegions: anywhere ? [] : where.split(/,\s*/),
      url: j.url,
      applyUrl: j.url,
      description: htmlToText(j.description ?? ""),
      postedAt: j.publication_date,
      autoApplicable: false,
    });
  });
  return { jobs, more: false }; // one result list, no paging
}

export function liveSources(cfg: Config): SourceSet {
  return {
    sweep: (ats, token, company) => BOARDS[ats](token, company),
    search(source, query, location, page) {
      switch (source) {
        case "usajobs":
          return usajobs(cfg.sources.usajobs!, query, location, page);
        case "adzuna":
          return adzuna(cfg.sources.adzuna!, query, location, page);
        case "himalayas":
          return himalayas(query, page);
        case "remotive":
          return remotive(query);
      }
    },
    async findBoard(company) {
      for (const token of tokenGuesses(company)) {
        for (const ats of ["greenhouse", "lever", "ashby"] as const) {
          try {
            if ((await checkBoard(ats, token)) > 0) return { ats, token };
          } catch {} // 404: no such board
        }
      }
      return null;
    },
  };
}

/** The keyword sources usable with this config and goal. */
export function searchSources(cfg: Config, remoteOk: boolean): SearchSource[] {
  const out: SearchSource[] = [];
  if (cfg.sources.usajobs) out.push("usajobs");
  if (cfg.sources.adzuna) out.push("adzuna");
  if (remoteOk && cfg.sources.himalayas) out.push("himalayas");
  if (remoteOk && cfg.sources.remotive) out.push("remotive");
  return out;
}
