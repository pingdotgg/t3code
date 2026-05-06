---
description: Initialize a new repo created from this template before non-trivial AI work begins.
---

Initialize the project context for this repo.

Read in this order:

1. `AGENTS.md`
2. `docs/project.md`
3. `.ai/rules/00-constitution.md`
4. `.ai/rules/17-aws-well-architected.md`

Execution rules:

1. Treat this as a required bootstrap step for newly created repos from the template.
2. Inspect `docs/project.md` and identify every placeholder, unchecked choice, or missing project-specific detail.
3. Ask only the minimum clarifying questions needed to replace template placeholders with real project context.
4. Update `docs/project.md` so it is specific enough for future agents to choose the correct stack, regulatory scope, services, and Well-Architected tradeoffs.
5. Capture at minimum:
   - Product identity and one-liner
   - Stack selection
   - Domain/app naming
   - Environment tiers (`2` or `3`)
   - Primary users, language expectations, RTL need
   - Regulator scope beyond PDPL
   - External services in use
   - Project-specific constraints and architectural guardrails
6. In the key constraints section, add any project-specific Well-Architected constraints that materially affect design or review.
7. In the key constraints section, add any project-specific PR-readiness constraints if the repo needs stricter docs, tests, or CI gates than the template default.
8. If the repo plans to enable the closed-loop PR auto-fix workflow, capture the GitHub App owner, trusted review bots, executor bot login, and which token path will be used (`CLAUDE_CODE_OAUTH_TOKEN` preferred, `ANTHROPIC_API_KEY` fallback).
9. Verify GitHub task tracking:
   - `gh auth status` succeeds.
   - Required labels from `docs/agent-orchestration.md` exist or are created.
   - A GitHub Project is available with fields: `Status`, `Priority`, `Type`,
     `Stack`, `Compliance`, and `Spec Path`.
   - If Projects access is unavailable, record the gap and refuse non-trivial
     derived-repo implementation.
10. Ensure the Codex project surface exists before marking bootstrap complete:

- If `package.json` exposes `codex:sync`, run `bun codex:sync`.
- Verify `.codex/commands/` exists and contains wrappers for the repo's
  `.claude/commands/*.md` files.
- Verify `.codex/environments/environment.toml` exists and mirrors the
  current `package.json` scripts as Codex actions.
- If the repo was adopted from this template and `.codex` is missing, run
  `bash scripts/adopt-template-rules.sh --target "$PWD" --profile minimal`
  or the repo's selected adoption profile, then re-run the Codex sync/check.

11. Refuse to mark bootstrap complete if `docs/project.md` is missing `Environment tiers: 2` or `Environment tiers: 3`.
12. Run `bun preflight`. Refuse to mark bootstrap complete while any preflight
    check returns `error`; reference `.local/preflight/latest.md` in the final
    summary.
13. On success, print the bilingual banner:
    - EN: Preflight passed
    - AR: اكتمل الفحص المسبق
14. End with:

- Completed items
- Remaining gaps
- Risks if work proceeds before remaining gaps are resolved

Do not write production code in this command.
