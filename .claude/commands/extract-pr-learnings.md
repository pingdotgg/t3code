---
description: Extract non-obvious learnings from a merged PR and file a structured issue.
argument-hint: [pr-number]
---

Extract learnings from PR: $ARGUMENTS

Audience: the repository owner (single maintainer). Output target: a GitHub issue in this repository. Do not tag or assign anyone else.

## Resolve PR number

If `$ARGUMENTS` is empty (invoked from CI), resolve the PR number from the workflow event payload: `jq -r '.pull_request.number // .number // empty' "$GITHUB_EVENT_PATH"`. If that yields nothing, exit with `skip: no pr context`.

Use that number for all subsequent `gh` calls in this command — treat it as `PR_NUM`.

## Gate — skip if trivial

Fetch the PR first: `gh pr view "$PR_NUM" --json number,title,body,author,additions,deletions,files,commits,reviews,comments`.

Do **not** create an issue if any of the following is true:

- Author is a bot (`dependabot`, `renovate`, `github-actions`).
- Change is docs-only with no strategy or process shift.
- Change is purely generated files, lockfile bumps, or formatting.
- Diff is < 10 lines of non-generated code and has no review comments, CI failures, or process friction.
- PR body or reviews contain no signal (no "why", no surprise, no correction, no tradeoff discussion).

If gated out, print one line — `skip: <reason>` — and exit. Do not file an issue.

## Extract — only the non-obvious

Read the PR, the diff, the review comments, and the CI outcomes. Identify material that future-you would want written down. Prefer:

- Hidden constraint or invariant discovered during implementation
- Mistaken assumption corrected by review or CI
- Workflow friction (tooling, quoting, env, CI flake) worth preventing
- Stack-specific gotcha (NestJS DI, Convex runtime, Drizzle, Better Auth)
- Gap between plan doc and reality
- Rule or convention that should be codified in `.ai/rules/` but is not

Ignore:

- What the PR did (title and diff already say that)
- Who did what and when (git log already says that)
- Generic programming advice
- Celebration, summary, or restatement of the diff

If after honest review there is nothing non-obvious, skip. One-line skip is a valid outcome.

## Map to template surface

For each learning, identify where it should land:

- `.ai/rules/<file>.md` — codify as non-negotiable or guidance
- `tasks.md` — new follow-up task
- `CLAUDE.md` / `AGENTS.md` — command or gotcha update
- `.github/workflows/` — enforcement via CI
- `scripts/` — automation
- `docs/project.md` — scope or identity change
- `none` — observation worth remembering but not codifying yet

## File the issue

Create the issue with `gh issue create`:

- Title: `[learning] <concise insight, ≤ 70 chars>`
- Labels: `learning`, `triage`
- Assignee: repository owner
- Body structure (use this exactly):

```markdown
Source: #<pr-number> — <pr-title>

## Learning

<one paragraph, non-obvious insight, no filler>

## Why it matters

<one paragraph, concrete consequence — what breaks or rots if ignored>

## Template surface

- [ ] `<path>` — <what to change>

## Follow-ups

- [ ] <concrete action>
```

Multiple independent learnings from one PR → file separate issues. Do not batch unrelated insights.

## Rules

- No PII, no secrets, no credential fragments in the issue body.
- No speculation beyond what the PR evidence supports. Cite the PR.
- AR/EN is not required — this is internal maintainer tracking, not user-facing.
- Keep the issue body under 300 words. Terse beats thorough.
- If uncertain whether a learning is real vs noise, skip. False positives rot the backlog faster than missing a real learning hurts.
