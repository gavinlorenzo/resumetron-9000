import type { Config } from "./config.ts";
import type { Job } from "./schema.ts";
import { type Liveness, checkLiveness } from "./liveness.ts";
import { cleanPosting } from "./posting.ts";
import { fetchJson, htmlToText, shortHash } from "./util.ts";

// Job sources are official public APIs only. LinkedIn and Indeed are deliberately absent:
// their terms forbid automated applying and accounts that do it get banned.

export type Ats = "greenhouse" | "lever" | "ashby" | "smartrecruiters" | "workable" | "recruitee" | "workday";
export type SearchSource = "usajobs" | "adzuna" | "himalayas" | "remotive";

/** Everything the campaign needs from the outside world. Swappable in tests. */
export interface SourceSet {
  /** Every open role on one company's board. `keep` limits boards that charge a request per posting. */
  sweep(ats: Ats, token: string, company: string, keep?: TitleFilter): Promise<Job[]>;
  /** One page of keyword results. `more` is false once the result list has been read to its end. */
  search(source: SearchSource, query: string, location: string, page: number): Promise<{ jobs: Job[]; more: boolean }>;
  /** Finds a company's job board by guessing its token on each ATS that can be probed. */
  findBoard(company: string): Promise<{ ats: Ats; token: string } | null>;
  /** Whether a posting is still open. Optional: without it, every job is assumed open. */
  alive?(job: Job): Promise<Liveness>;
}

const isRemote = (...xs: (string | undefined)[]) => xs.some((x) => x && /remote|anywhere|distributed/i.test(x));

/** Builds a job with its id, and cleans the description before anything reads it. */
const job = (j: Omit<Job, "id" | "description"> & { description?: string; html?: string }): Job => {
  const { html, description, ...rest } = j;
  const clean = cleanPosting(html ?? description ?? "", { html: html !== undefined });
  return { ...rest, description: clean.text, ...(clean.flags.length ? { flags: clean.flags } : {}), id: shortHash(`${j.source}|${j.url}`) };
};

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
      html: j.content ?? "",
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
      html: [j.description ?? j.descriptionPlain, ...(j.lists ?? []).map((l: any) => `<h3>${l.text}</h3>${l.content ?? ""}`), j.additional ?? j.additionalPlain]
        .filter(Boolean)
        .join("<br>"),
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
        ...(j.descriptionHtml ? { html: j.descriptionHtml } : { description: j.descriptionPlain ?? "" }),
        postedAt: j.publishedAt,
        ...salaryRange(j.compensation?.scrapeableCompensationSalarySummary ?? j.compensation?.compensationTierSummary),
        autoApplicable: true,
      }),
    );
}

/** "$207K - $285K" or "$95,000 – $120,000" -> annual USD bounds. Anything else is left unknown. */
export function salaryRange(summary?: string): { salaryMin?: number; salaryMax?: number } {
  const m = summary?.match(/\$\s?([\d.,]+)\s?([kK])?\s*(?:-|–|to)\s*\$?\s?([\d.,]+)\s?([kK])?/);
  if (!m) return {};
  const n = (v: string, k?: string) => Number(v.replace(/,/g, "")) * (k ? 1000 : 1);
  const lo = n(m[1], m[2] ?? m[4]);
  const hi = n(m[3], m[4]);
  return lo >= 10_000 && hi >= lo ? { salaryMin: lo, salaryMax: hi } : {};
}

// The boards below list jobs whose forms Resumetron doesn't fill on its own yet: packets are
// prepared, and `apply --handoff` fills what it can in a visible browser for you to finish.

async function smartrecruiters(id: string, name?: string, keep?: TitleFilter): Promise<Job[]> {
  const base = `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(id)}/postings`;
  const out: Job[] = [];
  for (let offset = 0, total = Infinity; offset < Math.min(total, 500); offset += 100) {
    const page = await fetchJson(`${base}?limit=100&offset=${offset}`);
    total = page.totalFound ?? 0;
    const content: any[] = page.content ?? [];
    if (!content.length) break;
    for (const p of content.filter((p) => p.active !== false && (!keep || keep(p.name))).slice(0, DETAIL_CAP - out.length)) {
      try {
        const d = await fetchJson(`${base}/${p.id}`);
        const loc = [d.location?.city, d.location?.region, d.location?.country].filter(Boolean).join(", ");
        const url = `https://jobs.smartrecruiters.com/${id}/${d.id}`;
        out.push(
          job({
            source: "smartrecruiters", company: name ?? d.company?.name ?? id, title: d.name, location: d.location?.fullLocation ?? loc,
            remote: Boolean(d.location?.remote) || isRemote(loc), url, applyUrl: `${url}?oga=true`,
            html: Object.values(d.jobAd?.sections ?? {}).map((s: any) => `${s.title ? `<h3>${s.title}</h3>` : ""}${s.text ?? ""}`).join(""),
            postedAt: d.releasedDate, autoApplicable: false,
          }),
        );
      } catch {} // a posting unpublished between the list and the detail call
    }
    if (out.length >= DETAIL_CAP) break;
  }
  return out;
}

async function workable(account: string, name?: string): Promise<Job[]> {
  const data = await fetchJson(`https://www.workable.com/api/accounts/${encodeURIComponent(account)}?details=true`);
  return (data.jobs ?? [])
    .filter((j: any) => j.published !== false && j.active !== false)
    .map((j: any) => {
      const loc = [j.city, j.state, j.country].filter(Boolean).join(", ") || (typeof j.location === "string" ? j.location : "");
      const url = j.shortcode ? `https://apply.workable.com/j/${j.shortcode}` : j.url;
      return job({
        source: "workable", company: name ?? data.name ?? account, title: j.title, location: loc,
        remote: j.telecommuting === true || j.workplace_type === "remote" || isRemote(loc), url, applyUrl: `${url}/apply`,
        html: [j.description, j.requirements, j.benefits].filter(Boolean).join(""), postedAt: j.published_on ?? j.created_at, autoApplicable: false,
      });
    });
}

async function recruitee(sub: string, name?: string): Promise<Job[]> {
  const data = await fetchJson(`https://${encodeURIComponent(sub)}.recruitee.com/api/offers/`);
  return (data.offers ?? [])
    .filter((o: any) => !o.status || o.status === "published")
    .map((o: any) =>
      job({
        source: "recruitee", company: name ?? o.company_name ?? sub, title: o.title, location: o.location ?? [o.city, o.country].filter(Boolean).join(", "),
        remote: Boolean(o.remote) || isRemote(o.location), url: o.careers_url, applyUrl: o.careers_apply_url ?? o.careers_url,
        html: [o.description, o.requirements].filter(Boolean).join(""), postedAt: o.published_at ?? o.created_at,
        salaryMin: o.salary?.min ? Number(o.salary.min) : undefined, salaryMax: o.salary?.max ? Number(o.salary.max) : undefined,
        autoApplicable: false,
      }),
    );
}

/**
 * Workday boards are "tenant/wdN/site", e.g. "nvidia/wd5/NVIDIAExternalCareerSite": the
 * datacenter can't be guessed, so a Workday board comes from a URL you or an aggregator supply.
 * Each posting's text costs a second request, so titles are filtered first and reads are capped.
 */
async function workday(board: string, name?: string, keep?: TitleFilter): Promise<Job[]> {
  const [tenant, dc, site] = board.split("/");
  if (!tenant || !/^wd\d+$/.test(dc ?? "") || !site) throw new Error(`a Workday board looks like tenant/wd5/site, not "${board}"`);
  const host = `https://${tenant}.${dc}.myworkdayjobs.com`;
  const api = `${host}/wday/cxs/${tenant}/${site}`;
  const paths: { path: string; title: string }[] = [];
  for (let offset = 0; offset < 200; offset += 20) {
    const page = await fetchJson(`${api}/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ appliedFacets: {}, limit: 20, offset, searchText: "" }),
    });
    const list: any[] = page.jobPostings ?? [];
    for (const p of list) if (p.externalPath && (!keep || keep(p.title ?? ""))) paths.push({ path: p.externalPath, title: p.title });
    if (list.length < 20 || paths.length >= DETAIL_CAP) break;
  }
  const out: Job[] = [];
  for (const { path } of paths.slice(0, DETAIL_CAP)) {
    try {
      const d = (await fetchJson(`${api}${path}`)).jobPostingInfo;
      if (!d || d.posted === false || d.canApply === false) continue;
      const url = d.externalUrl ?? `${host}/${site}${path}`;
      const loc = [d.location, ...(d.additionalLocations ?? [])].filter(Boolean).join("; ");
      out.push(
        job({
          source: "workday", company: name ?? tenant, title: d.title, location: loc,
          remote: /remote/i.test(`${d.remoteType ?? ""} ${loc}`), url, applyUrl: `${url.replace(/\/$/, "")}/apply`,
          html: d.jobDescription ?? "", postedAt: d.startDate, autoApplicable: false,
        }),
      );
    } catch {}
  }
  return out;
}

/** Titles worth a detail request: boards that charge one request per posting read only these. */
export type TitleFilter = (title: string) => boolean;
const DETAIL_CAP = 40;

const BOARDS: Record<Ats, (token: string, name?: string, keep?: TitleFilter) => Promise<Job[]>> = {
  greenhouse, lever, ashby, smartrecruiters, workable, recruitee, workday,
};
export const ATS_NAMES = Object.keys(BOARDS) as Ats[];
/** Boards whose application forms Resumetron fills on its own. */
export const FILLABLE: Ats[] = ["greenhouse", "lever", "ashby"];

/** Confirms a board token exists and reports how many jobs it lists. */
export async function checkBoard(ats: Ats, token: string): Promise<number> {
  // These two answer an unknown company with an empty list, not a 404, so ask for the count.
  if (ats === "smartrecruiters") {
    return (await fetchJson(`https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(token)}/postings?limit=1`)).totalFound ?? 0;
  }
  if (ats === "workday") {
    const [tenant, dc, site] = token.split("/");
    const page = await fetchJson(`https://${tenant}.${dc}.myworkdayjobs.com/wday/cxs/${tenant}/${site}/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ appliedFacets: {}, limit: 1, offset: 0, searchText: "" }),
    });
    return page.total ?? (page.jobPostings ?? []).length;
  }
  return (await BOARDS[ats](token)).length;
}

/**
 * The job board a posting URL belongs to, when it's one Resumetron reads:
 * an aggregator's link to an employer's own board turns into that whole board.
 */
export function boardFromUrl(raw: string): { ats: Ats; token: string } | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  const first = u.pathname.split("/").filter(Boolean)[0];
  if (/(^|\.)greenhouse\.io$/.test(host)) {
    const t = u.searchParams.get("for") ?? (first !== "embed" ? first : undefined);
    return t ? { ats: "greenhouse", token: t } : null;
  }
  if (host === "jobs.lever.co" && first) return { ats: "lever", token: first };
  if (host === "jobs.ashbyhq.com" && first) return { ats: "ashby", token: decodeURIComponent(first) };
  if ((host === "jobs.smartrecruiters.com" || host === "careers.smartrecruiters.com") && first) return { ats: "smartrecruiters", token: first };
  if (host === "apply.workable.com" && first && first !== "j") return { ats: "workable", token: first };
  const rec = host.match(/^([\w-]+)\.recruitee\.com$/);
  if (rec) return { ats: "recruitee", token: rec[1] };
  const wd = host.match(/^([\w-]+)\.(wd\d+)\.myworkdayjobs\.com$/);
  if (wd) {
    const parts = u.pathname.split("/").filter(Boolean);
    const site = /^[a-z]{2}-[A-Z]{2}$/.test(parts[0] ?? "") ? parts[1] : parts[0];
    if (site && site !== "wday") return { ats: "workday", token: `${wd[1]}/${wd[2]}/${site}` };
  }
  return null;
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
      html: j.description ?? "", // Adzuna returns a snippet only
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
      html: j.description ?? j.excerpt ?? "",
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
      html: j.description ?? "",
      postedAt: j.publication_date,
      autoApplicable: false,
    });
  });
  return { jobs, more: false }; // one result list, no paging
}

export function liveSources(cfg: Config): SourceSet {
  return {
    alive: checkLiveness,
    sweep: (ats, token, company, keep) => BOARDS[ats](token, company, keep),
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
        // Workday can't be guessed: its datacenter and site names are arbitrary.
        for (const ats of ["greenhouse", "lever", "ashby", "smartrecruiters", "workable", "recruitee"] as const) {
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
