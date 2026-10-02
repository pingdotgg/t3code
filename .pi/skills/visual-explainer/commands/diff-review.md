---
name: diff-review
description: Generate a visual diff review for code changes
---

Load the visual-explainer skill and generate a self-contained HTML diff review.

## Quick mode

Only use quick mode when `$@` contains the literal `--quick` flag. Remove the flag before scope detection. Complete the same evidence gathering and verification below, then read `./quick/README.md` and `./quick/schema.json` and express the review as a compact spec. In Pi, call `visual_explainer` with `action: "render_quick"`. In other harnesses, run the local `./quick/render.mjs` fallback. If the review does not fit the schema, validation fails, or rendering errors, generate complete HTML and use the normal render flow. Without `--quick`, preserve full HTML behavior.

## Scope detection

Interpret `$@` as a branch, commit, range, PR, or `HEAD`. If no argument is given, compare the working tree against `main`/`master`.

## Data gathering before HTML

Run the relevant git commands for: diff stats, name-status, changed files, line counts, public API/type/function changes, added/removed files, docs/changelog changes, tests touched, dependencies/config changes. Read changed files in full plus surrounding code paths needed to validate behavior. If reviewing committed work, read commit messages. If this session created the work, use available progress/plan notes for rationale.

## Source verification

Before generating, know and cite:

- exact changed files and line-count scope;
- each function/type/module name referenced;
- before/after behavior for important changes;
- likely coupling and test impact.

Use file paths, command outputs, or file:line evidence. Do not invent rationale or code paths.

## Required page sections

1. Executive summary: intuition, problem solved, factual scope.
2. File map: full tree, color-coded new/modified/deleted; compact, `<details>` if long.
3. Architecture impact: Mermaid or hybrid diagram when relationships matter.
4. Before/after behavior: side-by-side visual comparison.
5. Risk review: correctness, tests, API compatibility, security/privacy, performance, maintainability.
6. Coupling map: dependencies, hidden coupling, migration/release concerns.
7. Review recommendation: merge/readiness, blockers, follow-ups.

Use diff color language consistently: red removed/before, green added/after, amber modified/risk, blue neutral context. Use responsive section navigation for 4+ sections. Follow the skill’s Mermaid and overflow rules.

Write to `~/.agent/diagrams/` and open in browser.
