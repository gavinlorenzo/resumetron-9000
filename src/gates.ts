import type { Eligibility, Job } from "./schema.ts";

// Hard requirements read from the posting by code, not left to the model's judgment:
// sponsorship, citizenship, clearance, years of experience, degree, and language.
// A gate rejects a job only when the posting clearly requires something the job seeker's
// eligibility (goal.yaml) says they lack. When their side is unknown, the requirement is
// noted for screening instead. Every decision keeps the sentence it came from.

export interface GateHit {
  gate: "sponsorship" | "citizenship" | "clearance" | "years" | "degree" | "language";
  quote: string;
  detail: string;
}

export interface GateResult {
  reject: GateHit | null;
  /** Requirements found that the seeker's eligibility doesn't settle. */
  unknown: GateHit[];
}

/** Clauses of the posting: sentence parts split at "but", "however", and semicolons, so a negation in one doesn't cancel another. */
function clauses(text: string): string[] {
  return text
    .split(/(?<=[A-Za-z0-9]{2}[.!?])\s+|\n+/)
    .flatMap((s) => s.split(/;|\s+but\s+|\s+however,?\s+/i))
    .map((s) => s.trim())
    .filter(Boolean);
}

const EEO = /regardless of|without regard to|equal (employment )?opportunity|protected (veteran|class)|national origin|discriminat/i;
const NEGATED = /\b(no|not|without|n't|never|nor|isn't|aren't|optional)\b/i;
const SOFT = /\b(prefer(red|ably)?|nice to have|a plus|bonus|ideally|desired|desirable|helpful|advantage)\b/i;

/** First clause matching `re` that isn't negated (when `neg`) or EEO boilerplate. */
function find(cls: string[], re: RegExp, opts: { neg?: boolean; soft?: boolean } = {}): string | null {
  for (const c of cls) {
    const m = c.match(re);
    if (!m) continue;
    if (EEO.test(c)) continue;
    if (opts.neg !== false && NEGATED.test(c.slice(0, m.index! + m[0].length + 25).replace(/\b(unable|not able|cannot|can't|won't|will not)\b/gi, ""))) continue;
    if (opts.soft !== false && SOFT.test(c)) continue;
    return c.length > 240 ? `${c.slice(0, 237)}...` : c;
  }
  return null;
}

const NO_SPONSOR =
  /\b(unable|not able|cannot|can ?not|can't|won't|will not|does not|do not|doesn't|don't|is not able)\b[^.]{0,40}\b(sponsor|sponsorship)\b|\bno (visa )?sponsorship\b|\bsponsorship (is )?not (available|offered|provided)\b|\bwithout (the need for |requiring )?(current or future )?(visa )?sponsorship\b/i;
const CITIZEN = /\b(u\.?s\.? citizen(ship)?|united states citizen(ship)?|us citizens? only|citizenship (is )?required|must be a citizen)\b/i;
const CITIZEN_OR_PR = /\b(citizens? or (lawful )?(permanent residents?|green card)|permanent residents?|green card)\b/i;
const CLEARANCE = /\b(ts\/sci|top secret|secret|security|public trust|dod|government)\s+(security\s+)?clearance\b|\bclearance\b[^.]{0,30}\b(ts\/sci|top secret|secret)\b/i;
const OBTAIN = /\b(ability|able|eligib\w*|willing\w*)\b[^.]{0,30}\b(obtain|to get|receive|be granted)\b|\bobtain\b/i;
const ACTIVE = /\b(active|current|existing|hold|holds|possess)\b/i;
const YEARS = /\b(\d{1,2})\s*\+?\s*(?:-|to|–)?\s*(?:\d{1,2}\s*)?(?:\+\s*)?years?\b[^.]{0,50}\b(experience|exp\.)\b/i;
const REQUIRED = /\b(require[ds]?|requirement|minimum|at least|must|need|needs|necessary|qualifications)\b/i;
const DEGREE: [RegExp, number][] = [
  [/\b(ph\.?d|doctorate|doctoral degree)\b/i, 4],
  [/\b(master'?s|mba|mpa|mpp|graduate degree)\b|\bm\.[sa]\./i, 3],
  [/\b(bachelor'?s|undergraduate degree|four-year degree)\b|\bb\.[sa]\./i, 2],
  [/\b(associate'?s)\b/i, 1],
];
const DEGREE_LEVEL: Record<NonNullable<Eligibility["degree"]>, number> = { none: 0, associate: 1, bachelor: 2, master: 3, doctorate: 4 };
const EQUIVALENT = /\b(or equivalent|equivalent (work |professional )?experience|or (related|relevant) experience|in lieu of)\b/i;
const LANGUAGES = "spanish french german mandarin chinese cantonese japanese korean portuguese italian arabic russian hindi urdu vietnamese tagalog polish dutch hebrew farsi persian turkish greek swahili haitian creole somali ukrainian bengali punjabi gujarati tamil telugu amharic asl american sign language".split(" ");
const LANG_REQ = new RegExp(
  String.raw`\b(fluen(t|cy)|proficien(t|cy)|bilingual|native|business-level|conversational|written and (spoken|verbal))\b[^.]{0,40}\b(${LANGUAGES.join("|")})\b|\b(${LANGUAGES.join("|")})\b[^.]{0,30}\b(fluen(t|cy)|proficien(t|cy)|required|is a must)\b`,
  "i",
);

/** Reads a posting's hard requirements against what the seeker said about themselves. */
export function checkGates(job: Pick<Job, "title" | "description">, el: Eligibility): GateResult {
  const cls = clauses(job.description);
  const hits: { hit: GateHit; conflict: boolean | null }[] = [];

  const noSponsor = find(cls, NO_SPONSOR, { neg: false, soft: false });
  if (noSponsor) hits.push({ hit: { gate: "sponsorship", quote: noSponsor, detail: "the employer won't sponsor a visa" }, conflict: el.needsSponsorship });

  const citizen = find(cls, CITIZEN);
  if (citizen) {
    const prOk = CITIZEN_OR_PR.test(citizen);
    hits.push({
      hit: { gate: "citizenship", quote: citizen, detail: prOk ? "requires US citizenship or permanent residency" : "requires US citizenship" },
      conflict: el.usCitizen === null ? null : prOk ? (el.usCitizen ? false : null) : !el.usCitizen,
    });
  }

  const clearance = find(cls, CLEARANCE);
  if (clearance && !/\b(not required|no clearance)\b/i.test(clearance)) {
    const obtainable = OBTAIN.test(clearance) && !ACTIVE.test(clearance.replace(/\bactive\b(?=[^.]{0,30}\bobtain)/i, ""));
    const has = el.clearance;
    const conflict =
      has === null ? null : has === "active" ? false : obtainable ? (has === "eligible" ? false : el.usCitizen === false ? true : null) : true;
    hits.push({ hit: { gate: "clearance", quote: clearance, detail: obtainable ? "must be able to obtain a security clearance" : "requires an active security clearance" }, conflict });
  }

  const years = cls.map((c) => ({ c, m: c.match(YEARS) })).find((x) => x.m && REQUIRED.test(x.c) && !SOFT.test(x.c) && !EEO.test(x.c));
  if (years?.m) {
    const need = Number(years.m[1]);
    // Postings overstate years; two short is still worth a try, three short isn't.
    const conflict = el.yearsExperience === null ? null : need >= el.yearsExperience + 3;
    if (need >= 2) hits.push({ hit: { gate: "years", quote: years.c.slice(0, 240), detail: `asks for ${need}+ years of experience` }, conflict });
  }

  for (const c of cls) {
    if (!/\b(degree|diploma)\b|\b(ph\.?d|mba|doctorate)\b/i.test(c) || !REQUIRED.test(c) || SOFT.test(c) || EQUIVALENT.test(c)) continue;
    const level = DEGREE.find(([re]) => re.test(c));
    if (!level) continue;
    const conflict = el.degree === null ? null : DEGREE_LEVEL[el.degree] < level[1];
    hits.push({ hit: { gate: "degree", quote: c.slice(0, 240), detail: `requires a ${["", "associate", "bachelor's", "master's", "doctoral"][level[1]]} degree` }, conflict });
    break;
  }

  const lang = find(cls, LANG_REQ, { neg: true });
  if (lang) {
    const named = LANGUAGES.filter((l) => new RegExp(`\\b${l}\\b`, "i").test(lang));
    const known = el.languages.map((l) => l.toLowerCase());
    const conflict = !named.length ? null : known.length ? !named.some((l) => known.some((k) => k.includes(l) || l.includes(k))) : null;
    hits.push({ hit: { gate: "language", quote: lang, detail: `requires ${named.join(" or ") || "another language"}` }, conflict });
  }

  return {
    reject: hits.find((h) => h.conflict === true)?.hit ?? null,
    unknown: hits.filter((h) => h.conflict === null).map((h) => h.hit),
  };
}
