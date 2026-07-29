# Upstream relationship

This repository is a product fork of [pingdotgg/t3code](https://github.com/pingdotgg/t3code).

## Remotes

- `origin` is the product fork.
- `upstream` is the official T3 Code repository.

## Policy

Product `main` is never updated from upstream automatically. Each upstream update is evaluated on a dedicated integration branch and merged through a pull request after focused tests and the provider qualification matrix pass.

Prefer a released upstream tag or a recorded commit over an unpinned nightly. Selective cherry-picks are reserved for isolated fixes whose dependencies are understood.

## Local changes

Keep product identity, design tokens, product configuration, documentation, and feature policy as separate as practical from provider and orchestration internals. Avoid moving inherited directories or copying upstream components into parallel implementations.

## Updating

1. Fetch the official upstream remote.
2. Create an `integration/upstream-YYYY-MM-DD` branch from product `main`.
3. Merge the selected upstream tag or commit.
4. Resolve conflicts without discarding product behavior.
5. Run focused checks, client integration validation, and the provider matrix.
6. Record the new baseline and any retained local patches.
7. Merge the integration branch through a reviewed pull request.

See `docs/upstream/` for the current baseline and operating details.
