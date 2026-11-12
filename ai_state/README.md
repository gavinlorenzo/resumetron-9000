# AI State

The smallest set of files that lets a fresh session act without reconstructing history. This directory is not a log: git is the log.

## Files

| File | Holds | Changes | Limits |
|------|-------|---------|--------|
| `CURRENT.md` | The goal (the owner's line), what is true now, next actions, blockers | Rewritten in place when those change | Per-section line caps in the file |
| `CONSTRAINTS.md` | Protected records, never-repeat rules, environment invariants | When a constraint is added or lifted | Remove lifted entries |
| `TECH_DECISIONS.md` | Durable decisions currently in force | When a decision is made or superseded | Delete superseded entries past ~25 KB |
| `QA_STATE.md` | Verification and release posture, plus evidence pointers | When posture changes | Optional; only for repos with release gates. ~10 KB |
| `artifacts/` | Evidence that `QA_STATE.md` or `CURRENT.md` links to | When evidence is produced | Only evidence someone will cite |

`CURRENT.md` and `CONSTRAINTS.md` are split on purpose. Constraints are read every session but change rarely; posture changes often. Keeping them apart stops stable preservation lists from crowding out next actions.

These are the only state files. Handoff context belongs in `CURRENT.md`; decisions in `TECH_DECISIONS.md`. Per-feature build and acceptance state lives in the State column of `docs/spec/FEATURES.md`; `CURRENT.md` points there rather than restating it. Machine-readable state (gate files, flags) is allowed only when a script consumes it.

## Campaign Files

An orchestrated campaign adds `CAMPAIGN_MAP.md` and `CAMPAIGN_LEDGER.md` here. The orchestrator skill owns their template and rules (`references/campaign-map.md` and `references/campaign-map-rules.md`), so this template keeps no copy. They exist only while the campaign runs and move to `docs/history/` when its goal is met. `CURRENT.md` carries one pointer to an active map and never restates its rows.

## Limits Are About Readability, Not Bytes

A state file is over its limit when a reader with no context cannot act from it, not only when it is long. If content does not fit:

1. Move it to the file that owns it (`CONSTRAINTS.md`, `TECH_DECISIONS.md`, `QA_STATE.md`, a doc under `docs/`), or
2. Delete it; git keeps every prior version.

Never compress prose (dropping spaces, stacking identifiers, abbreviating) to fit a limit.

## When to Write

Write state when something a fresh session needs has changed, and commit it with the work that changed it. There is no end-of-session ritual beyond making sure `CURRENT.md`'s Next section is true.

## Finding History

- What changed and when: `git log --oneline -- <path>`
- When a string appeared or disappeared: `git log -S "<string>"`
- Earlier versions of posture: `git log -p -- ai_state/CURRENT.md`

## Evidence

`artifacts/` holds evidence someone will cite: a QA transcript, a screenshot set, a release checklist. Generated run output, logs, and caches belong in ignored paths, not here. When a gate closes, keep the evidence it cited and delete the rest.
