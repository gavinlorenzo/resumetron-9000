# AGENTS.md - The Resumetron 9000

Open-source, provider-agnostic job application agent: a TypeScript CLI on Node 22.18+. It runs from source through Node's type stripping (`npm run dev`) and is built to `dist/` with `tsc`. README.md describes the product; this file is for working on it.

## Invariants (do not weaken)

- **No fabrication.** Resume facts come from the pool by ID (`src/resume/compose.ts`). Model text is checked by `src/guard.ts`. Reverts and removals are logged in each packet's `packet.json`, never silently dropped.
- **Personal questions are never answered by a model.** These are anything matching `SENSITIVE` in `src/forms/resolve.ts`, plus every multiple-choice field. They come from `answers.yaml` or the user. Widen `SENSITIVE` freely, but never narrow it to make a test pass.
- **No CAPTCHA solving, bot-detection evasion, or scraping of sites whose terms forbid it.** Blocked applications go to the user's queue.
- **`submitted` means the site confirmed it.** Anything less is `unconfirmed`.
- **Personal data stays out of the repo.** The workspace is `~/.resumetron`. Tests and examples use the fictional pool in `examples/`.

## Working here

- Use erasable TypeScript only (no enums or parameter properties), and import local files with `.ts` extensions.
- Run `npm test` (a real headless Chromium against a local fake board) and `npm run typecheck` before committing.
- Live boards can be read for smoke checks: GET requests and form extraction are fine. Never submit a real application from a test or a smoke check.

## Git

Commit directly to `main` and push when a change is complete. Stage only your own paths, and review the staged diff for personal data before committing. Commit with the repo's configured owner identity, with no co-author or tool attribution trailers.
