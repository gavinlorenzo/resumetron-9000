// The fabrication guard. The model may select, reorder, and reword, but it may not
// add facts. These checks are deterministic, so they hold no matter which provider
// or prompt produced the text.

export interface GuardIssue {
  where: string;
  problem: string;
  text: string;
}

const NUMBER = /\$?\d[\d,]*(?:\.\d+)?/g;

// Capitalized words that carry no factual claim.
const COMMON_CAPS = new Set(["i", "i'm", "i've", "i'd", "i'll", "dear", "hiring", "team", "manager", "committee", "recruiter", "thank", "sincerely"]);

// "one" is left out: it is far more often a pronoun ("one of") than a count.
const NUMBER_WORDS = Object.fromEntries(
  "two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty"
    .split(" ")
    .map((w, i) => [w, String(i + 2)])
    .concat([["thirty", "30"], ["forty", "40"], ["fifty", "50"], ["sixty", "60"], ["seventy", "70"], ["eighty", "80"], ["ninety", "90"], ["hundred", "100"], ["dozen", "12"]]),
);
const NUMBER_WORD = new RegExp(`\\b(${Object.keys(NUMBER_WORDS).join("|")})\\b`, "gi");

/** Digits-only forms of every number in the text ("$20,000+" -> "20000", "eight" -> "8"). */
export function numbersIn(text: string): Set<string> {
  const digits = (text.match(NUMBER) ?? []).map((n) => n.replace(/[^\d.]/g, "").replace(/\.$/, ""));
  const words = (text.match(NUMBER_WORD) ?? []).map((w) => NUMBER_WORDS[w.toLowerCase()]);
  return new Set([...digits, ...words]);
}

/**
 * Capitalized words that are not sentence openers, plus tech-shaped tokens (C++, Node.js, SQL):
 * names of organizations, tools, places, and credentials.
 */
export function namesIn(text: string): Set<string> {
  const out = new Set<string>();
  const sentences = text.split(/(?<=[.!?:;])\s+|\n+|\s+[-|]\s+/);
  for (const sentence of sentences) {
    const words = sentence.split(/\s+/).filter(Boolean);
    words.forEach((raw, i) => {
      const w = raw.replace(/['’]s\b.*$/, "").replace(/^[^\w+#.]+|[^\w+#]+$/g, "");
      if (!w || /^\d/.test(w)) return;
      const techy = /[+#]|\w\.\w/.test(w);
      const capital = /^[A-Z]/.test(w) && i > 0 && !COMMON_CAPS.has(w.toLowerCase());
      if (techy || capital) out.add(w.toLowerCase());
    });
  }
  return out;
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

/** True when every name in `text` occurs somewhere in `allowed` (as a word or phrase part). */
function unknownNames(text: string, allowed: string): string[] {
  const corpus = ` ${allowed.toLowerCase().replace(/[^a-z0-9+#.]+/g, " ")} `;
  return [...namesIn(text)].filter((n) => !corpus.includes(` ${n.replace(/[^a-z0-9+#.]+/g, " ").trim()} `));
}

function unknownNumbers(text: string, allowed: string): string[] {
  const ok = numbersIn(allowed);
  return [...numbersIn(text)].filter((n) => !ok.has(n));
}

export const MAX_NOVELTY = 0.65;

/**
 * Checks a reworded bullet against its source. `context` is the surrounding entry
 * (org, title, location) whose names a rewrite may mention.
 */
export function checkBullet(rewrite: string, source: string, context: string): string[] {
  const problems: string[] = [];
  const nums = unknownNumbers(rewrite, source);
  if (nums.length) problems.push(`adds numbers not in the source: ${nums.join(", ")}`);
  const names = unknownNames(rewrite, `${source} ${context}`);
  if (names.length) problems.push(`adds names not in the source: ${names.join(", ")}`);
  const stems = contentStems(rewrite);
  const sourceStems = contentStems(`${source} ${context}`);
  const fresh = [...stems].filter((s) => !sourceStems.has(s));
  if (stems.size >= 6 && fresh.length / stems.size > MAX_NOVELTY) {
    problems.push(`mostly new wording (${fresh.length}/${stems.size} new terms), likely new claims`);
  }
  if (rewrite.length > source.length * 1.6 + 40) problems.push("much longer than the source");
  return problems;
}

/**
 * Checks free prose (cover letters, form answers) against everything the writer may cite.
 * Returns the sentences that introduce numbers or names found nowhere in `allowed`.
 */
export function checkProse(text: string, allowed: string): { sentence: string; problem: string }[] {
  const bad: { sentence: string; problem: string }[] = [];
  for (const sentence of text.split(/(?<=[.!?])\s+/)) {
    const nums = unknownNumbers(sentence, allowed);
    const names = unknownNames(sentence, allowed);
    if (nums.length || names.length) {
      bad.push({ sentence, problem: [...nums, ...names].join(", ") });
    }
  }
  return bad;
}
