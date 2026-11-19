# Agent Board

A desktop app that runs projects through an orchestrator on the T3 Code engine. It connects to the local T3 background service as a client, like T3's mobile app does.

## The engine stays upstream

This fork tracks `pingdotgg/t3code`. Board code lives only in `apps/board/`, `.github/workflows/agent-board.yml`, and `pnpm-lock.yaml`, so merging upstream never conflicts. The check below enforces that and runs in CI on every pull request.

```sh
git remote add upstream https://github.com/pingdotgg/t3code.git  # once
git fetch upstream main
node apps/board/scripts/check-engine-untouched.mjs
```

It exits 0 when nothing outside those paths changed since the merge base with `upstream/main`, 1 with the offending paths otherwise, and 2 when the `upstream` remote is missing.

## Tests

```sh
node --test apps/board/scripts/*.test.mjs
```

## Plan

The build plan is [docs/plan.md](docs/plan.md).
