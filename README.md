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
| `ledger.db` | Every job seen and what happened to it, plus token usage. Nothing is applied to twice. |

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

## Where jobs come from

Official public APIs only:

- **Greenhouse, Lever, Ashby** company boards: list them in `goal.companies` (the interview suggests and verifies tokens; `resumetron boards` re-checks them). These forms can be filled automatically.
- **USAJOBS** (free API key) and **Adzuna** (free app ID and key) keyword searches: list them in `goal.searches` and enable them under `sources` in the config. These end on sites that need your own login, so they're prepared as packets for you to finish.

LinkedIn, Indeed, and similar sites aren't supported. Their terms forbid automated applying, and accounts that do it get banned.

## Commands

`init` `import` `interview` `render` `preview` `standard build|list` `boards` `run` `queue` `show` `answer` `apply` `skip` `status` `schedule install|remove` `doctor`. Run `resumetron <command> --help` for options.

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
