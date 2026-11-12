# Technical Decisions

<!-- Public: tracked in the open-source repo. No personal data or business plans.
     Durable decisions currently in force. One compact entry per decision; heading-scan
     before loading in full. When a decision is superseded, mark it and link its
     replacement; once the file passes ~25 KB, delete superseded entries (git keeps
     them). -->

## Entry Format

### YYYY-MM-DD — Decision title

- Status: `active | superseded by [YYYY-MM-DD entry]`
- Decision: `[what was decided]`
- Rationale: `[why, including alternatives rejected]`
- Follow-up: `[remaining obligations, or None]`

## Decisions

### 2026-11-12 — State and spec files are private; rules are public

- Status: active
- Decision: In this public repo, `ai_state/CURRENT.md`, `ai_state/CONSTRAINTS.md`, any QA state or evidence, and everything in `docs/spec/` except its README are gitignored and live only on the owner's machine. `ai_state/README.md`, this file, and `docs/spec/README.md` are tracked.
- Rationale: state and evidence can name real employers and applications from the owner's own use, and the specs hold the paid hosted product's plans. This file holds only technical rationale, so it stays public.
- Follow-up: the private files have no off-machine backup. If that matters, move them to a private repo or encrypted storage. Never write personal data or business plans in this file.
