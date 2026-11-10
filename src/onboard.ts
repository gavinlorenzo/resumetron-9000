import { readFileSync } from "node:fs";
import { extname } from "node:path";
import type { Interface } from "node:readline/promises";
import { z } from "zod";
import { numbersIn } from "./guard.ts";
import { type Llm, completeJson } from "./llm/index.ts";
import { docToText } from "./resume/compose.ts";
import { AnswerEntry, Goal, Pool } from "./schema.ts";
import { checkBoard } from "./sources.ts";

// ---------- Interview: a short conversation that produces goal.yaml and answers.yaml ----------

const Turn = z.object({
  say: z.string(),
  done: z.boolean(),
  goal: Goal.optional(),
  answers: z.array(AnswerEntry).optional(),
});

const INTERVIEW_SYSTEM = `You are the intake interviewer for The Resumetron 9000, a tool that finds jobs and applies to them for the person you're talking with. Your conversation decides what it searches for, so get a clear, specific picture in a few minutes.

Have a natural conversation, one or two questions at a time, building on what they say. Cover:
- What they want next: role types and titles, seniority, industries or mission areas, what kind of work they'd enjoy versus tolerate.
- Where: cities, remote or hybrid, willingness to relocate.
- Constraints: salary floor, dealbreakers, companies or sectors to avoid.
- Target employers: companies or organizations they admire. Many companies list jobs on Greenhouse, Lever, or Ashby boards (e.g. boards.greenhouse.io/<token>, jobs.lever.co/<token>, jobs.ashbyhq.com/<token>); suggest likely board tokens for companies they name, and the tool will verify them.
- Keyword searches for broad sources (for example federal jobs on USAJOBS).
- Standing answers for application forms they want answered automatically: work authorization, sponsorship, how they heard about roles, demographic questions (many people choose "Decline to self-identify"). Only record what they actually tell you.

Their CV pool is below, so you can ask informed questions instead of generic ones. When you have enough (usually 5-8 exchanges), summarize the plan in "say", set done to true, and fill in "goal" and "answers". In goal: targetRoles are role names; titleInclude/titleExclude are short title words or phrases used as filters (titleInclude may stay empty to rely on scoring); keywords are terms a good posting would mention (8-20); summary is three or four sentences in the third person about who they are and what they want, which later guides tailoring. For answers, "match" is a short case-insensitive regex for the question label.`;

const GOAL_SHAPE = `{"say": "<your message to them>", "done": false}
or, when finished:
{"say": "<summary>", "done": true,
 "goal": {"summary": "", "targetRoles": [], "titleInclude": [], "titleExclude": [], "keywords": [], "locations": [], "remoteOk": true, "remoteOnly": false, "minSalary": null, "dealbreakers": [], "companies": [{"ats": "greenhouse|lever|ashby", "token": "", "name": ""}], "searches": [{"query": "", "location": ""}], "blockedCompanies": [], "notes": ""},
 "answers": [{"match": "authorized to work", "answer": "Yes"}]}`;

export async function interview(
  llm: Llm,
  pool: Pool | undefined,
  rl: Interface,
  log: (s: string) => void,
): Promise<{ goal: Goal; answers: z.infer<typeof AnswerEntry>[] }> {
  const messages: { role: "user" | "assistant"; content: string }[] = [
    { role: "user", content: "Hi! I'm ready to set up my job search." },
  ];
  for (let i = 0; i < 30; i++) {
    const turn = await completeJson(
      llm,
      {
        purpose: "interview",
        maxTokens: 8000,
        system: INTERVIEW_SYSTEM,
        stable: `CV POOL:\n${pool ? docToText(pool) : "(not imported yet)"}`,
        messages,
      },
      Turn,
      GOAL_SHAPE,
    );
    log(`\n${turn.say}\n`);
    messages.push({ role: "assistant", content: JSON.stringify(turn) });
    if (turn.done && turn.goal) {
      const goal = Goal.parse(turn.goal);
      goal.companies = await verifyBoards(goal.companies, log);
      return { goal, answers: turn.answers ?? [] };
    }
    const reply = (await rl.question("> ")).trim();
    messages.push({ role: "user", content: reply || "(no answer)" });
  }
  throw new Error("interview did not finish; run it again");
}

async function verifyBoards(companies: Goal["companies"], log: (s: string) => void): Promise<Goal["companies"]> {
  const kept: Goal["companies"] = [];
  for (const c of companies) {
    try {
      const n = await checkBoard(c.ats, c.token);
      log(`  verified ${c.ats}:${c.token} (${n} open roles)`);
      kept.push(c);
    } catch {
      log(`  could not find a ${c.ats} board for "${c.token}"; dropped it (add the right token to goal.yaml by hand)`);
    }
  }
  return kept;
}

// ---------- Import: free-form documents -> structured pool.yaml ----------

export async function readSource(path: string): Promise<string> {
  const ext = extname(path).toLowerCase();
  if (ext === ".pdf") {
    const { extractText } = await import("unpdf");
    const { text } = await extractText(new Uint8Array(readFileSync(path)), { mergePages: true });
    return text as string;
  }
  if (ext === ".docx" || ext === ".doc") throw new Error(`${path}: save Word documents as PDF or text first`);
  return readFileSync(path, "utf8");
}

const IMPORT_SYSTEM = `You convert someone's career material (resumes, brag documents, LinkedIn exports, loose notes) into a structured CV pool. The pool is the complete inventory a resume tailor picks from, so keep everything: every role, bullet, honor, course, skill, and side project, even minor ones.

Rules:
- Copy facts exactly as written: names, titles, dates, numbers. Light cleanup of grammar and bullet style is fine; adding or inflating claims is not.
- If the same role appears in several documents, merge it and keep every distinct bullet.
- Use sections with these types: "education" (degree, date, school, location, left: detail lines like majors and GPA, right: honors), "experience" (org, location, roles with title, dates, optional meta like hours, bullets), "inline" (labeled lists such as awards, skills, coursework; items may carry a short note such as a term or year). Use layout "role-first" for ordinary jobs and "org-first" for organizations where someone held several positions, when that reads better.
- Give every section a short key, every entry, role, bullet, and item a short unique kebab-case id, and 2-5 lowercase tags per bullet.
- Put loose true statements that don't fit a resume line (motivations, context, availability) in "facts".
- Contact details go in contact; links as full URLs.`;

const POOL_SHAPE = `{"contact": {"name": "", "phone": "", "email": "", "links": [], "address": "", "city": "", "state": "", "zip": "", "country": ""},
 "sections": [
   {"key": "education", "heading": "Education", "type": "education", "entries": [{"id": "", "degree": "", "date": "", "school": "", "location": "", "left": [], "right": []}]},
   {"key": "work", "heading": "Work Experience", "type": "experience", "layout": "role-first", "entries": [{"id": "", "org": "", "location": "", "roles": [{"id": "", "title": "", "dates": "", "meta": "", "bullets": [{"id": "", "text": "", "tags": []}]}]}]},
   {"key": "skills", "heading": "Skills", "type": "inline", "entries": [{"id": "", "label": "", "items": [{"id": "", "text": "", "note": ""}]}]}
 ],
 "facts": []}`;

export async function importPool(
  llm: Llm,
  sources: { name: string; text: string }[],
  existing?: Pool,
): Promise<{ pool: Pool; dropped: string[] }> {
  const docs = sources.map((s) => `<document name="${s.name}">\n${s.text}\n</document>`).join("\n\n");
  const pool = await completeJson(
    llm,
    {
      purpose: "import",
      maxTokens: 64_000,
      system: IMPORT_SYSTEM,
      messages: [
        {
          role: "user",
          content: `${existing ? `<existing_pool>\n${JSON.stringify(existing)}\n</existing_pool>\nMerge the new documents into the existing pool and return the whole merged pool.\n\n` : ""}${docs}`,
        },
      ],
    },
    Pool,
    POOL_SHAPE,
  );
  // Any number the source material never mentioned is treated as invented.
  const allowed = numbersIn(`${docs}\n${existing ? JSON.stringify(existing) : ""}`);
  const dropped: string[] = [];
  for (const s of pool.sections) {
    if (s.type !== "experience") continue;
    for (const e of s.entries)
      for (const r of e.roles)
        r.bullets = r.bullets.filter((b) => {
          const bad = [...numbersIn(b.text)].filter((n) => !allowed.has(n));
          if (bad.length) dropped.push(`${b.text} [numbers not in your documents: ${bad.join(", ")}]`);
          return bad.length === 0;
        });
  }
  return { pool, dropped };
}
