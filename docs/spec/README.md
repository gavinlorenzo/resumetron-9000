# Specs

This directory holds the product's intent: what it must do, why, and how the system is designed to do it. It is written before implementation and changes only by the owner's decision. The code as it is today is described in `../architecture/`. What has been verified lives in `../../ai_state/QA_STATE.md`.

## The Files

| File | Holds | Who changes it |
|------|-------|----------------|
| `IDEATION.md` | The full ideation record: messy and detailed, tagged with feature IDs. It is the authority on what the owner meant. | The owner and the ideation agent. After scoping it is only appended to. |
| `FEATURES.md` | One row per feature, guarantee, and experience bar in the ideation, with its scope decision, MVP form, owning spec section, and build state. | Agents maintain the rows. Only the owner sets Scope or marks a row `accepted`. |
| `PRODUCT.md` | The north star: the outcome, the through-line that makes the features one product, and end-to-end stories. | An agent drafts it and the owner approves it. |
| `SYSTEM.md` | The master spec: how the whole system is built. | The strongest available model writes it. Changes need an approved amendment. |
| `<area>.md` | One spec per `FEATURES.md` area, covering behavior and acceptance for the rows it owns. The template is `area-slug.md`. | Written after `SYSTEM.md`. Changes need an approved amendment. |

## How a Spec Gets Made

1. **Ideation.** The owner explains the idea. The agent writes it into `IDEATION.md` and catalogs every feature in `FEATURES.md` as it comes up, with no loss: every passage is tagged with the row it belongs to. Ideation ends with two things: a sweep of `IDEATION.md` for untagged passages, and an approved `PRODUCT.md`.
2. **Scoping.** The owner gives every row a Scope. No spec work starts while any row's Scope is blank.
3. **System design.** The strongest model writes `SYSTEM.md` in one pass, holding all of `PRODUCT.md` and `FEATURES.md`. Every row that is not cut is brought into the spec.
4. **Area specs.** Each area spec is written against `SYSTEM.md`'s contracts and organized by the area's journeys or stages. They can be written in parallel.
5. **Reshaping the rows.** With the spec elaborated, the rows are brought to its level, with the owner deciding each change:
   - rows the spec created are added;
   - rows that name a mechanism are redefined as the outcome a person gets;
   - duplicates are merged;
   - detail is folded into the contract that carries it.
6. **Execution.** Goals and campaign maps are built from `PRODUCT.md` stories, `SYSTEM.md`'s build order, and the `FEATURES.md` rows as the checklist.

The `product-spec` skill runs steps 1 to 5 with the owner.

## What Goes Where

- **Intent** (what the owner wants and why) goes in `IDEATION.md`, with a one-line summary per row in `FEATURES.md`.
- **What "finished" means for a person** goes in the `PRODUCT.md` stories.
- **Anything more than one area depends on** goes in `SYSTEM.md`: components and their owners, data and control flow, shared contracts, invariants, hypotheses, room for deferred features, and build order.
- **Behavior and acceptance for one area's rows** go in that area's spec.

Keep these out of specs: status, commit SHAs, evidence, QA posture, run history, preservation lists, environment and machine rules, and descriptions of the code as it is today. They belong in `ai_state/` and `docs/architecture/`. A spec that reports progress stops being a contract.

## Rules

- **Rows are memory and a checklist, not the work.** The work is journeys. A row is met when it holds on a working journey, and the spec is organized around how the product works, not around the catalog.
- **No row is ignored.** Every row in `FEATURES.md` ends up `scoped`, `deferred`, `cut`, `merged` or `detail` by the owner's decision, with the reason recorded. A feature leaves the product only through a Scope decision, never because a spec left it out.
- **Specs raise conflicts; they do not resolve them.** Sometimes the ideation contradicts itself, collides with a technical reality, or looks unwise. When that happens, the spec author writes the question in `SYSTEM.md` under Open questions and asks the owner. It does not pick an answer and record it as canonical. An agent's "canonical resolution" is how intent silently disappears.
- **`scoped` means the MVP form, in full.** Building a scoped row below its recorded MVP form is a defect, not a simplification. If the MVP form turns out to be wrong, propose a change. Do not build less.
- **Specs are frozen during execution.** Implementers may fix spec errors that do not change behavior. Some changes are proposals to the owner: a row's Scope or MVP form, an invariant, or a hypothesis itself. Some updates are not proposals, because they are how the spec is meant to work: adding a newly discovered hypothesis with its test and fallback, recording a hypothesis's test result, and switching to the fallback `SYSTEM.md` already names. A new hypothesis's fallback becomes a proposal only if taking it would change a row's Scope or MVP form, or an invariant. Record such a proposal in `FEATURES.md` under Scoping notes (marked `Proposed:`) or in `SYSTEM.md` under Open questions, and keep building what the current spec says. Commit spec edits separately from feature work. Updating a row's State column is bookkeeping rather than a spec edit, so it goes in the same commit as the work that built the row.
- **Reading budget.** Implementing one row should take only `PRODUCT.md`, `SYSTEM.md`, and one area spec. If that set grows past roughly 40K tokens, split the area spec or move detail out of `SYSTEM.md` into the area that owns it.
- **Coverage.** Every `scoped` row names exactly one owning spec section in its Spec column, and that section's heading cites the ID. A section may own several rows. `grep` is the check.

## Feature IDs

An ID is an area prefix and a number, such as `CAP-07`. IDs are never renumbered or reused, and a cut row keeps its ID. Cite the ID in square brackets wherever the feature is described or built: `IDEATION.md` passages, spec headings, commit messages. Then `grep -rn "CAP-07"` finds the feature's whole trail, from what the owner meant to the code that does it.
