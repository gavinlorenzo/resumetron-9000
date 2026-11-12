import { createHash } from "node:crypto";

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export const shortHash = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 12);

export const collapse = (s: string) => s.replace(/\s+/g, " ").trim();

export const normalize = (s: string) =>
  collapse(s.toLowerCase().replace(/[^a-z0-9+#]+/g, " "));

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rsquo: "'", lsquo: "'",
  rdquo: '"', ldquo: '"', mdash: "-", ndash: "-", hellip: "...", bull: "-",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] !== "#") return ENTITIES[code.toLowerCase()] ?? whole;
    const n = code[1]?.toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
    return Number.isFinite(n) ? String.fromCodePoint(n) : whole;
  });
}

export function htmlToText(html: string): string {
  // Greenhouse double-encodes, so entities are decoded before tags are removed.
  return decodeEntities(
    decodeEntities(html)
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<\/(p|div|li|h[1-6]|ul|ol)>|<br\s*\/?>/gi, "\n")
      .replace(/<li[^>]*>/gi, "- ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export const safeFileName = (s: string) => s.trim().replace(/[^A-Za-z0-9]+/g, "_").replace(/^_|_$/g, "");

export async function fetchJson(url: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(url, {
    ...init,
    headers: { "User-Agent": "resumetron-9000", Accept: "application/json", ...init.headers },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
  return res.json();
}

export const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

const TRACKING = /^(utm_\w+|gh_src|source|src|ref|refs|referrer|lever-source|lever-origin|trk|trackingid|fbclid|gclid|mc_cid|mc_eid|_hs\w+|hsa_\w+|iis|iisn|campaign)$/i;

/**
 * One key per posting URL, however it was linked: tracking parameters, "www.", trailing
 * slashes and "/apply" removed. Workday and SmartRecruiters postings key on their requisition id,
 * since the same job is linked under many paths.
 */
export function canonicalUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return raw.trim().toLowerCase();
  }
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  const wd = host.match(/^([\w-]+)\.wd\d+\.myworkdayjobs\.com$/);
  if (wd) {
    const req = u.pathname.match(/_([A-Z]*-?\d[\w-]*)(?:\/|$)/i);
    if (req) return `workday:${wd[1]}:${req[1].toLowerCase()}`;
  }
  const sr = host === "jobs.smartrecruiters.com" ? u.pathname.match(/\/(\d{6,})/) : null;
  if (sr) return `smartrecruiters:${sr[1]}`;
  for (const k of [...u.searchParams.keys()]) if (TRACKING.test(k)) u.searchParams.delete(k);
  u.searchParams.sort();
  const path = u.pathname.replace(/\/(apply|application|applications)\/?$/i, "").replace(/\/+$/, "");
  const q = u.searchParams.toString();
  return `${host}${path}${q ? `?${q}` : ""}`.toLowerCase();
}
