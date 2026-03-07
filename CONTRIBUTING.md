# Contributing

Thanks for taking the time to contribute to T3 Code.

This project is moving quickly, and the contribution process is still fairly lightweight. This document is meant to make the current workflow explicit so outside contributors know what to expect when opening issues or pull requests.

## Before You Open a PR

- Check for an existing issue or PR that already covers the same work.
- Prefer small, focused changes over broad refactors unless the change clearly needs broader scope.
- If the change affects behavior, include or update tests where possible.

## Local Setup

T3 Code uses Bun and a monorepo workspace.

Typical setup:

```bash
bun install
bun run lint
bun run typecheck
bun run test
```

Useful development commands are documented in [README.md](./README.md).

## Pull Request Expectations

When opening a PR, keep the description concrete:

- what changed
- why it changed
- how you validated it locally

For validation, prefer including exact commands, for example:

```text
- bun run lint
- bun run typecheck
- bun run test
```

## Fork PR Behavior

If you are contributing from a fork, the current PR experience may look unusual even when your code is correct.

### GitHub Actions

The repository CI workflow lives in `.github/workflows/ci.yml` and runs:

- `bun run lint`
- `bun run typecheck`
- `bun run test`

For fork-based PRs, GitHub Actions may require maintainer approval before jobs actually start. In that case, the workflow can show `action_required` and no job logs will appear yet.

If that happens, your PR is not necessarily failing because of code. It may simply be waiting for a maintainer to approve the workflow run.

### Vercel Preview Checks

Fork PRs may also show a red `Vercel` status with a message similar to:

```text
Authorization required to deploy.
```

That status is managed outside this repository. It does not come from `.github/workflows/ci.yml`, and it may fail even when the code and repository CI are otherwise fine.

If your PR is red only because of Vercel authorization, call that out clearly in the PR discussion so maintainers can evaluate the code separately from deploy authorization.

## What To Do If Checks Are Stuck

If your PR is from a fork and checks are not green:

1. Run `bun run lint`, `bun run typecheck`, and `bun run test` locally.
2. Include those results in your PR description or a comment.
3. If GitHub Actions shows `action_required`, ask a maintainer to approve the workflow run.
4. If Vercel is the only red check, note that it may be a fork authorization issue rather than a code failure.

## Issues

Bug reports and contribution-quality issues are useful. Good issues usually include:

- what happened
- what you expected
- clear reproduction steps
- screenshots or logs when relevant
- exact environment details when the problem may be platform-specific

## Questions

If you are unsure whether a contribution is a good fit, opening an issue first is a good default.
