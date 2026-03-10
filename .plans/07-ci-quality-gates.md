# Plan: Add CI Workflow for Core Quality Gates

## Summary

Add GitHub Actions workflow to run lint/typecheck/test (and optionally smoke-test) on pushes and PRs.

## Motivation

- Repository currently has no CI workflow files.
- Quality checks are only local/manual.

## Scope

- `.github/workflows/ci.yml`
- Bun + Turbo setup in CI.

## Proposed Changes

1. Add `ci.yml` with jobs:
   - Setup Bun and Node environment
   - Install deps
   - `bun run lint`
   - `bun run typecheck`
   - `bun run test`
2. Add separate optional job for `bun run smoke-test` (desktop/Electron).
3. Configure caching for Bun/Turbo as appropriate.

## Risks

- Smoke test may be flaky in headless CI environments.
- CI runtime can grow if caching is misconfigured.

## Validation

- Verify workflow runs on a branch PR.
- Ensure failures surface clearly by job name.

## Done Criteria

- CI blocks regressions in lint/typecheck/test.
- Workflow docs added to README.
