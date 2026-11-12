// The fabrication guard. The model may select, reorder, and reword, but it may not
// add facts. These checks are deterministic, so they hold no matter which provider
// or prompt produced the text.

export interface GuardIssue {
  where: string;
  problem: string;
  text: string;
}

// ---------------- numbers ----------------

/**
 * A number with its meaning: money, a percentage, a multiplier ("3x"), or a plain count.
 * "$2.3M" and "2,300,000 dollars" are the same money; "$2.3M" and "$2.3B" are not;
 * "40%" and "40 accounts" are different claims.
 */
export interface Quantity {
  kind: "money" | "pct" | "mult" | "num";
  value: number;
  raw: string;
}

const SCALE: Record<string, number> = {
  k: 1e3, hundred: 100, thousand: 1e3, m: 1e6, mm: 1e6, mil: 1e6, million: 1e6, b: 1e9, bn: 1e9, billion: 1e9, t: 1e12, trillion: 1e12,
};

// "one" and "a" count only before a magnitude ("one million"): alone they are far more often pronouns or articles.
const WORD_VALUE: Record<string, number> = Object.fromEntries(
  "two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty"
    .split(" ")
    .map((w, i) => [w, i + 2])
    .concat([["thirty", 30], ["forty", 40], ["fifty", 50], ["sixty", 60], ["seventy", 70], ["eighty", 80], ["ninety", 90], ["hundred", 100], ["dozen", 12]]),
);

const CURRENCY = String.raw`(?<cur>[$€£¥]|usd\s?|eur\s?|gbp\s?)?`;
const MAGNITUDE = String.raw`(?:\s?(?<scale>k|mm|mil|bn|thousand|million|billion|trillion|m|b|t)\b)?`;
const TAIL = String.raw`(?<tail>\s?%|\s?percent\b|\s?pct\b|x\b|\s?(?:dollars|usd)\b)?`;
const DIGITS = new RegExp(`${CURRENCY}(?<n>\\d[\\d,]*(?:\\.\\d+)?)${MAGNITUDE}${TAIL}`, "gi");
const WORDS = new RegExp(
  String.raw`(?<cur>[$€£])?\b(?<w>${Object.keys(WORD_VALUE).join("|")}|one|a)\b(?:[\s-]+(?<scale>hundred|thousand|million|billion))?(?<tail>\s?%|\s+percent\b)?`,
  "gi",
);

/** Every number in the text, with its kind and full value. */
export function quantities(text: string): Quantity[] {
  const out: Quantity[] = [];
  const t = text.replace(/ /g, " ");
  for (const m of t.matchAll(DIGITS)) {
    const g = m.groups!;
    const n = Number(g.n.replace(/,/g, "").replace(/\.$/, ""));
    if (!Number.isFinite(n)) continue;
    const scale = g.scale ? SCALE[g.scale.toLowerCase()] : 1;
    const tail = (g.tail ?? "").trim().toLowerCase();
    const kind = /^(%|percent|pct)$/.test(tail) ? "pct" : tail === "x" ? "mult" : g.cur || /dollars|usd/.test(tail) ? "money" : "num";
    out.push({ kind, value: round(n * scale), raw: m[0].trim() });
  }
  for (const m of t.matchAll(WORDS)) {
    const g = m.groups!;
    const w = g.w.toLowerCase();
    if ((w === "one" || w === "a") && !g.scale) continue;
    const base = w === "one" || w === "a" ? 1 : WORD_VALUE[w];
    const scale = g.scale ? SCALE[g.scale.toLowerCase()] : 1;
    const kind = g.tail ? "pct" : g.cur ? "money" : "num";
    out.push({ kind, value: round(base * scale), raw: m[0].trim() });
  }
  return out;
}

const round = (n: number) => Math.round(n * 1e6) / 1e6;

/** Keys like "money:2300000" or "pct:40": one per number, so sets of them compare meaning, not spelling. */
export function numbersIn(text: string): Set<string> {
  return new Set(quantities(text).map((q) => `${q.kind}:${q.value}`));
}

/** Whether a source number supports a number in the rewrite. */
function supports(src: Quantity, q: Quantity): boolean {
  if (src.value !== q.value) return false;
  if (q.kind === src.kind) return true;
  // A plain count and an amount of money can be the same figure ("a 15,000 budget" / "$15,000");
  // a percentage or a multiplier is a different claim from any count.
  return (q.kind === "num" && src.kind === "money") || (q.kind === "money" && src.kind === "num");
}

/** Numbers in `text` that nothing in `source` supports. */
export function unbackedNumbers(text: string, source: string | Quantity[]): string[] {
  const ok = typeof source === "string" ? quantities(source) : source;
  return [...new Set(quantities(text).filter((q) => !ok.some((s) => supports(s, q))).map((q) => q.raw))];
}

// ---------------- names, tools, credentials ----------------

// Capitalized words that carry no factual claim.
const COMMON_CAPS = new Set(["i", "i'm", "i've", "i'd", "i'll", "dear", "hiring", "team", "manager", "committee", "recruiter", "thank", "sincerely"]);

/**
 * Tools, platforms, languages, and credentials that are claims in themselves. These are checked
 * wherever they appear, lowercase or at the start of a sentence, where capitalization says nothing.
 */
const TOOLS = new Set(
  `
  powerpoint sharepoint onenote office365 visio
  salesforce hubspot marketo pardot zendesk servicenow netsuite quickbooks xero peoplesoft
  tableau looker powerbi qlik alteryx spss stata sas matlab mathematica minitab qualtrics surveymonkey arcgis qgis gis
  python java javascript typescript ruby php perl scala kotlin golang haskell elixir clojure julia fortran cobol
  c++ c# sql nosql mysql postgres postgresql sqlite mongodb redis cassandra dynamodb elasticsearch snowflake bigquery redshift databricks
  html css sass react angular vue svelte nextjs node.js django laravel .net jquery graphql
  aws azure gcp kubernetes k8s docker terraform ansible jenkins circleci gitlab github bitbucket jira confluence asana trello
  airtable figma photoshop illustrator indesign lightroom canva autocad solidworks revit
  linux unix bash powershell git hadoop kafka dbt pandas numpy pytorch tensorflow keras scikit-learn
  lexisnexis westlaw factset capitaliq pitchbook crm erp hris lms
  cpa cfa pmp csm cissp ccna comptia mcse phr shrm-cp six-sigma itil cpr emt lpn cna
  spanish french german mandarin japanese korean portuguese italian arabic russian hindi vietnamese tagalog
`
    .split(/\s+/)
    .filter(Boolean),
);

const clean = (raw: string) => raw.replace(/['’]s\b.*$/, "").replace(/^[^\w+#.]+|[^\w+#]+$/g, "");

/**
 * Capitalized words that are not sentence openers, tech-shaped tokens (C++, Node.js), words
 * with internal or all capitals (PowerBI, AWS), and known tools anywhere: names of
 * organizations, tools, places, and credentials.
 */
export function namesIn(text: string): Set<string> {
  const out = new Set<string>();
  const sentences = text.split(/(?<=[.!?:;])\s+|\n+|\s+[-|]\s+/);
  for (const sentence of sentences) {
    const words = sentence.split(/\s+/).filter(Boolean);
    words.forEach((raw, i) => {
      const w = clean(raw);
      if (!w) return;
      const lower = w.toLowerCase();
      // "12K" or "2019" is a number, checked as one; "3D" or "K12" style tokens are names.
      if (/^\d[\d,.]*[kmb]?\+?$/i.test(w) || /^\d+(st|nd|rd|th|s)$/i.test(w)) return;
      const techy = /[+#]|\w\.\w/.test(w) || /\d/.test(w);
      const shaped = /^[A-Z]{2,}s?$/.test(w) || /[a-z][A-Z]/.test(w);
      const tool = TOOLS.has(lower) || TOOLS.has(lower.replace(/\.$/, ""));
      const capital = /^[A-Z]/.test(w) && i > 0 && !COMMON_CAPS.has(lower);
      if (techy || shaped || tool || capital) out.add(lower);
    });
  }
  return out;
}

/** Tools and credentials in the text (a subset of names): claims about what someone can do. */
export function toolsIn(text: string): Set<string> {
  return new Set([...namesIn(text)].filter((n) => TOOLS.has(n) || /[+#]|\w\.\w/.test(n)));
}

const STOP = new Set(
  "a an and are as at be by for from has have in into is it its of on or that the their this to was were will with while including across through over under per via".split(" "),
);

const stem = (w: string) => w.replace(/(ing|ed|es|s|ly)$/, "");

export function contentStems(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9+#]+/)
      .filter((w) => w.length > 2 && !STOP.has(w))
      .map(stem),
  );
}

/** Initialisms of every run of capitalized words: "Model United Nations" -> mun, un, mu. */
function initialisms(text: string): Set<string> {
  const out = new Set<string>();
  for (const run of text.match(/(?:\b[A-Z][\w'’-]*(?:\s+(?:of|and|for|the|&)\s+|\s+)?){2,}/g) ?? []) {
    const caps = run.split(/\s+/).filter((w) => /^[A-Z]/.test(w)).map((w) => w[0].toLowerCase());
    for (let i = 0; i < caps.length; i++)
      for (let j = i + 2; j <= caps.length; j++) out.add(caps.slice(i, j).join(""));
  }
  return out;
}

const corpusOf = (s: string) => ` ${s.toLowerCase().replace(/[^a-z0-9+#.]+/g, " ").replace(/\.+(?= |$)/g, "")} `;
const inCorpus = (n: string, corpus: string) => corpus.includes(` ${n.replace(/[^a-z0-9+#.]+/g, " ").trim()} `) || corpus.includes(` ${n.replace(/\.$/, "")} `);

/** Names in `text` that occur nowhere in `allowed`, as a word, phrase part, or initialism. */
function unknownNames(text: string, allowed: string): string[] {
  const corpus = corpusOf(allowed);
  const inits = initialisms(allowed);
  return [...namesIn(text)].filter((n) => !inCorpus(n, corpus) && !inits.has(n));
}

// ---------------- scope ----------------

/**
 * Words that claim leadership or sole ownership. A rewrite may keep the scope its source
 * states but not raise it: "Assisted with the budget" must not become "Managed the budget".
 */
const SCOPE = /\b(led|leads?|leading|manag(e|ed|es|ing)|direct(ed|s|ing)|supervis(e|ed|es|ing)|oversaw|oversee(s|ing)?|headed|spearhead(s|ed|ing)?|founded|co-?founded|chair(ed|s|ing)?|mentor(ed|s|ing)?|hired|architected|owned|sole(ly)?|single-?handedly|independently)\b/gi;

function scopeWords(text: string): Set<string> {
  return new Set((text.match(SCOPE) ?? []).map((w) => w.toLowerCase()));
}

// ---------------- checks ----------------

export const MAX_NOVELTY = 0.65;

/**
 * Checks a reworded bullet against its source. `context` is the surrounding entry
 * (org, title, location) whose names a rewrite may mention. A user-recorded metric for the
 * bullet belongs in `source`: it is the user's own fact.
 */
export function checkBullet(rewrite: string, source: string, context: string): string[] {
  const problems: string[] = [];
  const nums = unbackedNumbers(rewrite, source);
  if (nums.length) problems.push(`adds numbers not in the source: ${nums.join(", ")}`);
  const names = unknownNames(rewrite, `${source} ${context}`);
  if (names.length) problems.push(`adds names not in the source: ${names.join(", ")}`);
  if (scopeWords(rewrite).size && !scopeWords(`${source} ${context}`).size) {
    problems.push(`claims more scope than the source (${[...scopeWords(rewrite)].join(", ")})`);
  }
  const stems = contentStems(rewrite);
  const sourceStems = contentStems(`${source} ${context}`);
  const fresh = [...stems].filter((s) => !sourceStems.has(s));
  if (stems.size >= 6 && fresh.length / stems.size > MAX_NOVELTY) {
    problems.push(`mostly new wording (${fresh.length}/${stems.size} new terms), likely new claims`);
  }
  if (rewrite.length > source.length * 1.6 + 40) problems.push("much longer than the source");
  return problems;
}

const sentencesOf = (text: string) => text.split(/(?<=[.!?])\s+|\n+/).filter((s) => s.trim());
const FIRST_PERSON = /\b(i|i'm|i've|i'd|my|me|myself)\b/i;
const ADDRESSES_THEM = /\b(you|your|yours|the (role|position|posting|team|job)|this (role|position|posting|job))\b/i;

/**
 * Checks free prose (cover letters, form answers) against what the writer may cite.
 * `allowed` is the candidate's own material plus anything else that is fair to repeat.
 * `posting` is the job posting, kept separate because its facts are about the job, not the candidate:
 * - a number from the posting backs a sentence only when the sentence is about the same thing
 *   (it shares a content word with the posting sentence the number came from), so "5+ years of
 *   experience" in a posting cannot back "I mentored 5 engineers";
 * - a tool or credential named only in the posting can be mentioned, but not claimed in the first person.
 * Returns the sentences that fail.
 */
export function checkProse(text: string, allowed: string, posting = ""): { sentence: string; problem: string }[] {
  const bad: { sentence: string; problem: string }[] = [];
  const own = quantities(allowed);
  const postSentences = sentencesOf(posting).map((s) => ({ q: quantities(s), stems: contentStems(s) }));
  const ownCorpus = corpusOf(allowed);
  for (const sentence of sentencesOf(text)) {
    const stems = contentStems(sentence);
    // A number only the posting has may be repeated back to the employer ("you ask for 5+ years"),
    // never claimed: a first-person sentence that doesn't address them can't use it.
    const restating = !FIRST_PERSON.test(sentence) || ADDRESSES_THEM.test(sentence);
    const nums = quantities(sentence).filter((q) => {
      if (own.some((s) => supports(s, q))) return false;
      return !(restating && postSentences.some((p) => p.q.some((s) => supports(s, q)) && [...p.stems].some((w) => w.length >= 4 && stems.has(w))));
    });
    const names = unknownNames(sentence, `${allowed}\n${posting}`);
    const claimed = FIRST_PERSON.test(sentence) ? [...toolsIn(sentence)].filter((t) => !inCorpus(t, ownCorpus) && !names.includes(t)) : [];
    if (nums.length || names.length || claimed.length) {
      bad.push({ sentence, problem: [...nums.map((q) => q.raw), ...names, ...claimed.map((t) => `${t} (only the posting names it)`)].join(", ") });
    }
  }
  return bad;
}
