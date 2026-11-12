import { readFileSync } from "node:fs";
import { toolsIn } from "../guard.ts";
import type { Contact, Job } from "../schema.ts";
import { normalize } from "../util.ts";

// Reads the finished PDF back the way applicant tracking systems do: as extracted text.
// A resume that looks right but parses badly (contact details missing from the text layer,
// broken glyphs, dates an ATS drops) loses to one that parses cleanly.

export interface Readability {
  ok: boolean;
  problems: string[];
}

/** Text an ATS would extract from a PDF. */
export async function pdfText(path: string): Promise<string> {
  const { extractText } = await import("unpdf");
  const { text } = await extractText(new Uint8Array(readFileSync(path)), { mergePages: true });
  return text as string;
}

const digits = (s: string) => s.replace(/\D/g, "");

/** Checks extracted resume text for what parsers need to find. */
export function checkReadability(text: string, contact: Contact): Readability {
  const problems: string[] = [];
  if (text.replace(/\s/g, "").length < 200) problems.push("almost no text could be extracted: the PDF may be an image");
  if (!normalize(text).includes(normalize(contact.name))) problems.push("your name isn't in the text layer");
  if (contact.email && !text.toLowerCase().includes(contact.email.toLowerCase())) problems.push("your email isn't in the text layer as plain text");
  if (contact.phone && !digits(text).includes(digits(contact.phone))) problems.push("your phone number isn't in the text layer as plain text");
  if (/\(cid:\d+\)|�/.test(text)) problems.push("some characters extract as garbage (font encoding)");
  if (/[ﬀ-ﬆ]/.test(text)) problems.push("ligatures (fi, fl) extract as single glyphs that parsers may not read");
  // Workday's parser has been seen dropping date ranges joined with an en or em dash.
  const dashed = text.match(/\b(19|20)\d{2}\s?[–—]\s?((19|20)\d{2}|present|current)\b/i);
  if (dashed) problems.push(`date range uses a typographic dash ("${dashed[0]}"); some parsers drop it`);
  return { ok: problems.length === 0, problems };
}

export interface Coverage {
  /** Terms from the posting that the resume uses. */
  covered: string[];
  /** Terms your pool has but this resume left out: worth a look. */
  inPool: string[];
  /** Terms nothing you've told Resumetron supports. Never added for you. */
  gaps: string[];
}

/**
 * Which of the posting's key terms (named tools, languages and credentials, plus your goal keywords that
 * the posting uses) appear in the resume, in your pool, or nowhere. Gaps are reported, never stuffed in.
 */
export function keywordCoverage(resumeText: string, poolText: string, job: Pick<Job, "description">, goalKeywords: string[]): Coverage {
  const post = ` ${normalize(job.description)} `;
  const named = [...toolsIn(job.description)];
  const fromGoal = goalKeywords.filter((k) => post.includes(` ${normalize(k)} `)).map((k) => k.toLowerCase());
  const terms = [...new Set([...fromGoal, ...named])].slice(0, 40);
  const has = (hay: string, t: string) => ` ${normalize(hay)} `.includes(` ${normalize(t)} `);
  const out: Coverage = { covered: [], inPool: [], gaps: [] };
  for (const t of terms) {
    if (has(resumeText, t)) out.covered.push(t);
    else if (has(poolText, t)) out.inPool.push(t);
    else out.gaps.push(t);
  }
  return out;
}
