---
name: plan-review
description: Compare an implementation plan against the current codebase
---

Load the visual-explainer skill and generate a self-contained HTML plan review.

## Quick mode

Only use quick mode when `$@` contains the literal `--quick` flag. Remove the flag before resolving the plan input. Complete the same code research and verification below, then read `./quick/README.md` and `./quick/schema.json` and express the review as a compact spec. In Pi, call `visual_explainer` with `action: "render_quick"`. In other harnesses, run the local `./quick/render.mjs` fallback. If the review does not fit the schema, validation fails, or rendering errors, generate complete HTML and use the normal render flow. Without `--quick`, preserve full HTML behavior.

## Inputs

Use `$@` as the plan path or plan text. If no path is given, ask for the plan.

## Data gathering before HTML

Read the plan in full. Extract goals, assumptions, proposed files/functions/types, migrations, tests, rollout/release notes, and explicit risks. Read every referenced file, plus importers/dependents that may be affected. Use ripgrep for existing patterns, similar implementations, public API boundaries, config/schema files, and tests.

## Source verification

For each proposed change, verify whether referenced files/functions/types exist, whether current behavior matches the plan, what ripple effects are missing, and whether the proposed test coverage fits the current test style. Cite plan sections and file:line evidence.

## Required page sections

1. Plan summary: problem, core idea, scope.
2. Accuracy verdict: correct, stale, risky, unsupported, missing.
3. Current architecture: diagram of affected subsystem only.
4. Proposed architecture: matching visual diff against current state.
5. Gap/risk matrix: correctness, tests, API, data model, UX, security/privacy, performance, maintainability, release.
6. File-by-file review: proposed edits, current reality, recommendation.
7. Better plan: concrete corrections or simplifications.
8. Decision: approve, revise, or reject with rationale.

Use current-vs-planned visual language. Include responsive nav. Follow the skill’s Mermaid, overflow, and evidence rules.

Write to `~/.agent/diagrams/` and open in browser.
