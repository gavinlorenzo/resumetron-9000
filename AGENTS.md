# AGENTS.md - The Resumetron 9000

Open-source, provider-agnostic job application agent: a TypeScript CLI on Node 22.18+. It runs from source through Node's type stripping (`npm run dev`) and is built to `dist/` with `tsc`. README.md describes the product; this file is for working on it.

## Invariants (do not weaken)

- **No fabrication.** Resume facts come from the pool by ID (`src/resume/compose.ts`). Model text is checked by `src/guard.ts`. Reverts and removals are logged in each packet's `packet.json`, never silently dropped.
- **Personal questions are never answered by a model.** These are anything matching `SENSITIVE` in `src/forms/resolve.ts`, plus every multiple-choice field. They come from `answers.yaml` or the user. Widen `SENSITIVE` freely, but never narrow it to make a test pass.
- **No CAPTCHA solving, bot-detection evasion, or scraping of sites whose terms forbid it.** Blocked applications go to the user's queue.
- **`submitted` means the site confirmed it.** Anything less is `unconfirmed`. For an email application, it means the SMTP server accepted the message.
- **Email goes only where the posting says.** Applications are emailed only to an address that appears in the posting text (`applyByEmailAddress` in `src/email.ts`). Inbox sync downloads only bodies whose headers point at an application and stores metadata for matched messages only, never bodies. Tests use a fake `Mailbox`; never send real mail from a test.
- **The posting is about the job, not the candidate.** Prose checks (`checkProse`) take the posting as a separate argument: its numbers may be restated to the employer, never claimed in the first person, and a tool only the posting names is never claimed. Don't fold the posting back into the candidate's allowed facts.
- **Code reads hard requirements and scams, and quotes them.** `src/gates.ts` rejects only on a clear conflict with the seeker's stated `eligibility`; unknown never rejects. `src/legitimacy.ts` rejects only scam patterns. Every rejection keeps the posting sentence that caused it. A liveness check that can't decide is "unknown", never "closed".
- **Workday accounts are the user's to authorize.** `src/forms/workday.ts` signs in before it ever registers, registers only with `allowCreate` (from `--create-account` or `workday.createAccounts`), never uses Workday's resume autofill, follows only https Workday links from email, and redacts the password from every detail it returns. The walk refuses a footer button labeled Submit; only `pressSubmit` after the Review read-back may press it.
- **A choice field is only ever set to an option that matches the answer** (`matchOption`). Never fall back to "the first option" or pressing Enter in a filtered list.
- **Job status changes follow `TRANSITIONS` in `src/ledger.ts`.** Add a transition there deliberately rather than passing `force`, which is for things the user records themselves.
- **Statistics decide, the model proposes.** Verdicts on tracks (`trackStats` in `src/strategy.ts`) are computed against the cited benchmarks in `src/benchmarks.ts`. The strategist cannot retire or cement against them (`applyReview`). Change a benchmark only with a cited source.
- **Personal data stays out of the repo.** The workspace is `~/.resumetron`. Tests and examples use the fictional pool in `examples/`.

## Session start

- Read `ai_state/CURRENT.md` and `ai_state/CONSTRAINTS.md` when they exist. They are private (gitignored), so a public clone won't have them; skip them there.
- Read `docs/spec/PRODUCT.md` when choosing what to work on, if present: the goal line in `CURRENT.md` names which of its stories the work is for.
- Heading-scan `ai_state/TECH_DECISIONS.md` before changing an established design.
- For history, use git (`git log --oneline -- <path>`, `git log -S "<string>"`). Do not eagerly read full specs or docs at startup.
- The business layer, if this repo sits inside the owner's workspace, is `../../ops/`. Read `../../ops/STATUS.md` for framing; do not edit it unless asked.

## Specs

`docs/spec/README.md` defines the spec system. When building or changing a feature, read `PRODUCT.md`, `SYSTEM.md`, and the area spec section that owns the feature's `FEATURES.md` row. Build the row's recorded MVP form in full. Do not change a row's Scope or MVP form, an invariant, or a hypothesis: propose the change and keep building what the spec says. Cite feature IDs in commit messages (`feat(forms): ... [FRM-03]`). Only the owner marks a row `accepted`.

## State

The state files are specified in `ai_state/README.md`. Update them only when something a fresh session needs has changed: `CURRENT.md` when the objective, what is true now, next actions, or blockers change; `CONSTRAINTS.md` when a protected record or never-repeat rule is added or lifted; `TECH_DECISIONS.md` when a durable decision is made or superseded. Do not create other state files.

Public vs private: `ai_state/README.md`, `ai_state/TECH_DECISIONS.md`, and `docs/spec/README.md` are tracked and public. Every other file under `ai_state/` and `docs/spec/` is gitignored and stays local. Never put personal data, real employers or applications, or business plans in a tracked file.

## Working here

- Use erasable TypeScript only (no enums or parameter properties), and import local files with `.ts` extensions.
- Run `npm test` (a real headless Chromium against a local fake board) and `npm run typecheck` before committing.
- Live boards can be read for smoke checks: GET requests and form extraction are fine. Never submit a real application from a test or a smoke check.

## Git

Commit directly to `main` and push when a change is complete. Stage only your own paths, and review the staged diff for personal data before committing. Commit with the repo's configured owner identity, with no co-author or tool attribution trailers.
