# 18 — PR Readiness

Apply these rules to every pull request, review, ship, and merge task.

## Hard rules before merge

- Relevant Markdown documentation must be updated when the change affects
  behavior, setup, contributor workflow, CI, architecture, governance, or
  operations
- If no documentation update is needed, the PR must explicitly state
  **No documentation impact**
- Tests must be added or updated in the same PR for behavior-changing work
- If no test update is needed, the PR must explicitly state **No test impact**
- All required CI checks must be green before merge
- Agents must treat missing docs, missing tests, or failing CI as blocking
  release risks

## What counts as relevant docs

At minimum, evaluate these paths when code or workflow changes:

- `.github/**/*.md`
- `README*.md`
- `CONTRIBUTING*.md`
- `SECURITY*.md`
- `CODE_OF_CONDUCT*.md`
- `docs/**/*.md`
- `AGENTS.md`
- `CLAUDE.md`
- `review.md`
- `.cursor/BUGBOT.md`

## CI behavior in this template

- Docs-impact checks run as **warning-level** in CI (do not fail the PR-readiness
  job by themselves)
- Tests and CI-green checks remain blocking
- PR authors must still either update relevant docs or explicitly mark
  **No documentation impact** in the PR template
- Required CI checks are validated using `PR_READINESS_REQUIRED_CHECKS`
  (default: `validate`)
- Derived repos should set `PR_READINESS_REQUIRED_CHECKS` in
  `.github/workflows/pr-readiness.yml` to match their required checks
  (comma-separated), for example:
  `PR_READINESS_REQUIRED_CHECKS: "validate,security"`
- Do not include the `pr-readiness` job name itself in this list, or the check
  creates a circular dependency by waiting for itself.
- Path-based docs expectations are evaluated automatically (warning-level), with
  extra scrutiny for:
  - `.github/workflows/**` and automation paths
  - `.ai/rules/**`, `AGENTS.md`, `CLAUDE.md`, `.cursorrules`
  - `.cursor/**`, `review.md`
  - `scripts/**`

## Required review questions

1. Which Markdown docs changed, and do they match the implementation?
2. Which tests were added or updated in this PR?
3. Which CI checks are required, and are they green?
4. If docs or tests were not updated, is the PR explicit about why not?

## GitHub requirements for derived repos

- Include a pull request template with explicit docs, tests, and CI checklist
  items
- Keep at least one CI workflow active on pull requests
- Configure GitHub branch protection in the derived repo to require the
  validation workflow and PR-readiness workflow before merge

## Agent behavior

- `review` and `ship` tasks must call out docs drift, missing tests, and failing
  CI before style issues
- If a PR exists, verify GitHub checks rather than assuming local success is
  enough
- Do not approve or recommend merge while any hard rule above is unmet
