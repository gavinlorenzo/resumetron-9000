# The Resumetron 9000

> If employers are screening with AI, I'm submitting with AI.

An open-source job application agent that works with any model provider. You tell it what you're looking for, give it everything you've ever done, and it does the rest on a schedule:

1. Searches company job boards and job APIs for postings that fit.
2. Screens each posting against your goals.
3. Builds a resume tailored to that one posting, in a clean standard format, plus a cover letter.
4. Fills out the application form: contact details, uploads, your saved answers, and written answers to the posting's questions.
5. Submits it, or waits for your OK, depending on how much you trust it.

## It does not lie for you

A resume agent is only useful if what it sends is true. The Resumetron is built so the model can't invent anything. That's enforced in code, not left to a prompt:

- **The model picks; the pool supplies.** Tailoring returns IDs from your CV pool plus reworded bullet text. Every organization, title, date, and location on the page is copied from your pool.
- **Every rewording is checked against its source bullet.** A rewrite that adds a number, a name, a tool, or mostly new claims is reverted to your original wording, and the revert is logged in the packet.
- **Cover letters and written answers are checked against your materials.** A sentence citing a fact found nowhere in your resume, your notes, or the posting is removed.
- **Some questions are never answered by the model:** work authorization, sponsorship, salary, demographics, criminal history, relocation, start dates, and anything that asks you to agree, certify, or acknowledge. Neither are multiple-choice questions in general. Those answers come from `answers.yaml`, which only you write, or the application waits for you. Answer once and it's remembered.
- **Job postings are treated as untrusted text.** The model is told so, gets no tools, and can only return data the software validates.

## Quick start

Requires Node 22.18+.

```sh
git clone https://github.com/gavinlorenzo/resumetron-9000 && cd resumetron-9000
npm install && npm run browsers && npm run build && npm link

resumetron init                          # creates ~/.resumetron
# pick a provider in ~/.resumetron/config.yaml (see below)
resumetron import resume.pdf notes.md    # builds your CV pool
resumetron interview                     # a short chat about what you want
resumetron preview posting.txt --title "Policy Analyst" --company "Acme"   # see a tailored packet
resumetron run --dry-run                 # one full pass that never submits
resumetron queue                         # what's waiting on you
```

## Providers

Pick one in `config.yaml`. API keys come from environment variables and are never written to disk.

| `type` | Covers |
|---|---|
| `anthropic` | Claude through the official SDK (default `claude-opus-5-5`). The CV pool sits behind a prompt-cache breakpoint, so it's billed at cache rates after the first job. |
| `openai` | Anything OpenAI-compatible: OpenAI, OpenRouter, Groq, Together, Ollama, LM Studio, llama.cpp, vLLM. Set `baseUrl`. |
| `command` | Any local agent CLI, using your existing subscription. The prompt goes in on stdin and the reply comes out on stdout. Turn the agent's tools off, e.g. `claude -p --tools "" --strict-mcp-config --no-session-persistence`. |

## Your workspace

Everything personal lives in `~/.resumetron` (or `--home`, or `$RESUMETRON_HOME`), never in this repo.

| File | What it is |
|---|---|
| `pool.yaml` | Your CV pool: every role, bullet, honor, course, and skill, each with an ID, plus loose `facts` for cover letters. See [examples/pool.example.yaml](examples/pool.example.yaml). |
| `goal.yaml` | What to search for: target roles, title filters, keywords, locations, salary floor, dealbreakers, company boards, keyword searches. See [examples/goal.example.yaml](examples/goal.example.yaml). |
| `answers.yaml` | Your standing answers to form questions, matched by regex against the question label. |
| `cover-template.md` | The no-AI cover letter for efficiency mode. `{{company}}`, `{{title}}`, `{{name}}`. |
| `standards/` | Reusable resumes for efficiency mode. |
| `applications/<company>-<id>/` | One packet per application: resume and cover letter PDFs, the posting, the tailoring plan and guard log, every form answer with its source, and screenshots. |
| `ledger.db` | The campaign's memory: every job seen and what happened to it, every search and board with its yield, exclusions, the journal, and daily token usage. Nothing is applied to twice. |
| `logs/` | One log file per day of runs. |

## The resume format

One page by default: centered name and contact line, ruled uppercase section headings, `Organization | Location` over `Title | Dates` entries (or title-first for ordinary jobs), round bullets, serif type. `resumetron render` prints your whole pool in this format with no AI involved.

**Page policy: relevance first, then fill.** A half-empty page reads as thin experience, and padding with fluff reads worse. The tailor puts the strongest material for the posting first, then ranks everything else that is still honest, useful context (transferable jobs, honors, coursework) as a reserve. The renderer adds reserve items in that order while they fit, so the page ends full of the right things. Type stays at 11pt. On overflow it shrinks slightly (never below 10pt), then trims the least relevant lines. It is never enlarged to fake a full page. Education is never dropped. Each packet records how full the page is, and a page under 75% full is flagged: your pool may be thin for that kind of role. Set `resume.fill: false` to send only the core picks.

## Cover letters

A letter has to be visibly written for one job. The writer first pulls short quotes from the posting: the mission in the company's words, the team, named responsibilities and programs. Each quote is confirmed to really appear in the posting. The letter is then built around them, pairing each requirement with a real accomplishment. A letter that doesn't build on at least two of those details, doesn't name the company in its body, or leans on stock phrases ("passionate", "great fit") gets one revision with that feedback. Your own reasons for wanting to work somewhere (`notes` on a company in `goal.yaml`, which the interview asks for) are fair game. Outside facts about the company are not.

## Modes

**Tailored** (default): the model screens each new posting (one small call), then writes a tailored resume and cover letter for the ones that clear `matching.minFit`, and drafts answers to required written questions.

**Efficiency**: no per-job model calls. Build a few standard resumes once, one per family of roles:

```sh
resumetron standard build policy --targets "Policy Analyst, Legislative Aide" --keywords "policy, research, government"
resumetron standard build ops --targets "Operations Coordinator, Program Coordinator"
resumetron run --mode efficiency
```

Each posting is matched to the best standard by title and keyword overlap, and gets the template cover letter. Any question your answer bank can't cover waits for you, unless you set `efficiency.answerQuestionsWithLlm: true`.

## Submitting

`submit: review` (the default) prepares everything and fills the form, takes a screenshot, and stops. Then you work the queue:

```sh
resumetron queue           # ready / needs you / submitted / unconfirmed
resumetron show <id>       # every field, its value, and where the value came from
resumetron answer <id>     # answer what it's stuck on; optionally save for next time
resumetron apply <id>      # submit
resumetron apply <id> --handoff   # opens a visible browser, filled in, for you to finish
resumetron skip <id>
```

`submit: auto` submits unattended within your quotas (`maxPerDay`, `maxPerRun`, `maxPerCompanyPer30Days`, `minDelaySeconds`, `maxTokensPerRun`). An application counts as `submitted` only when the site shows a recognizable confirmation. Otherwise it's `unconfirmed` and goes to your queue. CAPTCHAs and human-verification challenges are never solved or worked around: the application goes to your queue for a `--handoff`.

## Scheduling

```sh
resumetron schedule install --at 09:00      # daily (Windows Task Scheduler or cron)
resumetron schedule install --every 6       # every 6 hours
resumetron schedule install --print         # show the entry without installing
resumetron schedule remove
```

## Where jobs come from: the search campaign

Searching is a campaign with memory, not a fixed list. Every company board and keyword search is tracked with a page cursor and yield statistics, so each run digs deeper instead of re-reading the same results:

- **Fresh, then deeper.** Each search re-checks page 1 for new postings, then continues from the page where the last run stopped. A posting is never shown twice, even when several boards and searches list it. When a search has been read to its end and keeps turning up nothing new, it retires.
- **A planner steers.** Once per run (one model call), it reads what every search has produced and why screened jobs were turned down. Then it adds searches (adjacent roles, other sectors' vocabulary for the same work), retires ones that keep failing, and names employers worth a look. Retiring a search takes evidence: at least 3 of its jobs screened with none passing, or no new results for two runs. Its reasoning is kept in the journal (`resumetron journal`).
- **Boards get discovered.** When a match turns up on an aggregator, or the planner names an employer, the tool checks for a Greenhouse, Lever, or Ashby board. If one exists, it reads the whole board, right away when that can upgrade a match to the employer's own fillable form.
- **Exclusions.** Excluded titles, companies, keywords, or single jobs never come up again: `resumetron exclude title "nurse"`, `resumetron exclude company "Acme"`, `resumetron exclude job <id>`. The planner can add title and company exclusions too, but only for a pattern that at least 3 screened jobs were rejected under and that would block nothing worth applying to. It can never exclude your target roles.
- **Broad mode.** Set `breadth: broad` in `goal.yaml` (or say so in the interview) for "here's my CV, find me anything I'm half-qualified for". The planner fans out into adjacent roles, postings are ranked rather than dropped for missing keywords, and screening accepts credible stretch roles (`matching.minFitBroad`, default 50).

`resumetron searches` shows every search: depth read, new jobs found, jobs screened, and how many passed. `resumetron search "<query>"` adds one, `--retire <id>` drops one, and `resumetron boards --add greenhouse:<token>` adds a board. Per-run limits live under `campaign:` in the config.

Sources are official public APIs only:

| Source | Key needed | Coverage | Applying |
|---|---|---|---|
| Greenhouse, Lever, Ashby boards | none | one employer's every opening | filled automatically |
| Himalayas, Remotive | none | remote roles, keyword search | packet prepared; often upgraded via board discovery |
| USAJOBS | free API key | US federal jobs | packet prepared; you finish on USAJOBS |
| Adzuna | free app ID and key | broad keyword search across most job sites | packet prepared; often upgraded via board discovery |

For on-site and hybrid roles, add Adzuna or USAJOBS (`sources:` in the config). Without them, keyword search covers remote roles only, and on-site roles come from company boards. LinkedIn, Indeed, and similar sites aren't supported: their terms forbid automated applying, and accounts that do it get banned.

## Strategy: hypotheses, judged against real numbers

The job market is slow and noisy, and a model left to read its own results tends to panic early. So the Resumetron runs its search as a set of hypotheses and uses statistics, not the model's impression, to decide when one is working or failing.

- **Tracks.** On the first run, the strategist turns your background and goal into a few *tracks*. Each is a bet such as "entry-level legislative staff roles, because of X and Y in your background", and each comes with its own searches and employers. A focused goal gets one or two tracks; a broad goal gets three to five different ones. Screening assigns every job to a track.
- **Quota follows evidence.** Each run's slots are split across tracks by Thompson sampling on their interview rates. Better tracks get more, every active track keeps a floor, and newly proposed tracks share a 10% exploration slice until you approve them (`resumetron track approve <id>`).
- **Weekly review.** Once a week, the strategist reads each track's numbers, its screening results and its replies. It writes a memo (`resumetron strategy`, saved under `strategy/`), sharpens hypotheses, adds searches and employers, and proposes new tracks. `resumetron review` runs one now.
- **The statistics decide.** The strategist can always refine a track. It can retire one only when the data says "underperforming", and cement one only when the data says "outperforming"; anything else is declined and logged in the memo.

The benchmarks are published hiring data: about 3% of applications become interviews (CareerPlug, 10M+ applications), about 5.8% with a tailored resume (Huntr, 1.7M tracked applications), and half of interviews arrive more than ~23 days after applying. From that:

| Verdict | When |
|---|---|
| too early | fewer than ~30 applications have had time to be answered |
| underperforming | very likely (90%) converting below 1%; with no interviews, this takes 200+ mature applications |
| outperforming | very likely (80%) beating the benchmark, with at least 2 interviews |
| inconclusive | everything else, which is most of the time |

An unanswered application counts as a "no" only in proportion to how long it has had: a one-week-old application counts for about a fifth. At a 3% rate, zero interviews from 40 applications happens about 30% of the time, and the memo says so instead of calling it a failure.

## Email: replies and applying by email

Add an `email:` section to the config with an app password in an environment variable. A Gmail app password requires 2-Step Verification: Google Account → Security → App passwords. Then check the login with `resumetron email test`, which sends nothing.

- **Outcomes from replies.** Each run reads new mail. It matches replies to applications by thread for emails it sent, otherwise by company name in a hiring context. It downloads message bodies only when the sender or subject points to one of your applications. Each reply is classified as acknowledged, rejected, interview, or offer, using wording rules first and a short model call when the wording is ambiguous. Only a one-line record of each matched message is kept (date, sender domain, subject, outcome), never the body, and unrelated mail leaves no trace. `resumetron email sync` reads replies now.
- **Applying by email.** When a posting says to email an application to an address that appears in the posting itself, the tool sends the cover letter as the body, with the resume and cover letter PDFs attached. In review mode it drafts `email.txt` in the packet. Postings with their own subject-line or reference-number rules go to your queue.
- **Manual outcomes.** For replies that came another way (a phone call, LinkedIn): `resumetron outcome <id> interview`.

Outcomes only move forward (an interview never becomes a rejection), and silence is never recorded: it's read from the application's age.

## Storage stays bounded

Everything the tool keeps has a limit, so a cron job can run for months on a small VPS without filling the disk or slowing down. Defaults, all adjustable under `retention:`:

- Finished jobs shrink to a small dedupe record (the posting text is dropped). Rejected and skipped records are deleted after 180 days. Records of applications you sent are kept.
- The waiting backlog holds at most 400 jobs; the lowest-scored drop off first.
- Email records are one line per matched reply, capped at 3,000 and dropped after 400 days. Strategy memos keep the last 12.
- The journal keeps 300 entries. Covered searches, board lookups, and token usage (one row per day) are capped or expire.
- Screenshots go after 14 days. Packets for skipped, failed, and preview applications go after 30 days. PDFs of sent applications stay.
- Each run logs to one file per day, kept for 14 days. The database hands freed space back after every cleanup.
- Only one run at a time: a lock stops an overlapping cron run from starting a second browser.

Cleanup runs after every `run`. `resumetron prune` runs it by hand, and `resumetron status` shows disk use.

## Commands

`init` `import` `interview` `render` `preview` `standard build|list` `boards` `run` `queue` `show` `answer` `apply` `skip` `searches` `search` `exclude` `strategy` `track approve|retire` `review` `outcome` `email test|sync` `journal` `status` `prune` `schedule install|remove` `doctor`. Run `resumetron <command> --help` for options.

## Use it responsibly

You are the applicant. Read what goes out under your name, at least until the packets have earned your trust. Keep quotas at a level where you could actually interview for every role you apply to. And check each employer's rules: some ask applicants not to use AI in their application, and the Resumetron leaves those questions for you to answer.

## Development

```sh
npm test          # guard, composition, and end-to-end runs against a local fake job board
npm run typecheck
npm run dev -- <command>   # run from source
```

Source map: `src/guard.ts` (fabrication checks), `src/resume/` (composition and the template), `src/forms/` (reading, resolving, and filling application forms), `src/pipeline.ts` (a run, end to end), `src/sources.ts` (job boards), `src/llm/` (providers).

MIT licensed.
