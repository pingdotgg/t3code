# Release operations

The fork does not currently publish desktop, CLI, mobile, hosted web, or relay releases.

## Current automation

- Pull requests and pushes to `main` run CI on standard GitHub-hosted runners.
- Mobile showcase screenshots can be started manually and do not publish an application.
- GitHub can generate draft release notes from merged pull-request labels.

## Disabled upstream automation

The inherited T3 Code release, relay deployment, and Expo delivery workflows are archived under `docs/upstream/workflows/`. Files outside `.github/workflows/` cannot execute as GitHub Actions.

Do not push a version tag expecting publication. Before restoring any publication workflow:

1. Complete every applicable item in `docs/releases/prerequisites.md`.
2. Replace inherited service identifiers with fork-owned configuration.
3. Review the workflow permissions and rollback path.
4. Prove the workflow in a non-production environment.
5. Add an explicit release approval gate.

The archived T3 Code release process remains available at `docs/upstream/operations/release.md` for upstream comparison only.
