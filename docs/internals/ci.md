# CI quality gates

> For maintainers. Using T3 Code? See [docs/user](../user/).

[`.github/workflows/ci.yml`](../../.github/workflows/ci.yml) starts with one small **Classify
changes** job on pull requests and pushes to `main`. It resolves the complete changed-file list,
matches both sides of renames, and decides which of the following gates can observe the change:

- **Check** runs `vp check`, `vpr typecheck`, the desktop pipeline build, and preload bundle
  verification for Node product and configuration changes. Workflow-only changes keep the required
  check name but use a no-install parse marker.
- **Test** runs every package test task except `apps/server`.
- **Test Server 1/2/3** shards the serialized `apps/server` suite across three runners. Server-only
  work skips the non-server runner, while client-only work skips all three server runners. Shared
  contracts, shared runtime code, workspace configuration, and server test dependencies run both.
- **Rust** formats and tests `native/resource-monitor`, and only runs for that crate or CI-control
  changes.
- **Mobile Native Static Analysis** runs `vp run lint:mobile` on macOS for handwritten Swift/Kotlin,
  its lint configuration, and the command dependencies it imports. Generated `ios/` and `android/`
  projects remain excluded.
- **Release Smoke** exercises release-only workflow steps through `scripts/release-smoke.ts`. It runs
  for release scripts, workspace manifests, patches, mobile dependency archives, and `release.yml`.

Documentation, repository metadata, and agent/editor configuration skip every product runner. CI
workflow or classifier changes run every gate. Unknown, missing, failed, or truncated changed-file
classification fails open and runs every gate, so optimization cannot silently remove coverage.
Skipped jobs retain the existing required-check names and GitHub treats them as successful.

[`.github/workflows/windows-tests.yml`](../../.github/workflows/windows-tests.yml) is a manual
Windows lane (`workflow_dispatch` only) on a Blacksmith Windows 2025 runner. The suite does not
pass on Windows yet, so it is not a required check; it exists so the work to get there can be
iterated against a real Windows box without one on hand. Dispatch it with `gh workflow run
windows-tests.yml --ref <branch>`, optionally with `-f package=<dir>` to run one workspace package
and `-f files="<paths>"` to run specific test files inside it. Once it is green, fold it into
`ci.yml`.

`.github/workflows/release.yml` builds macOS (`arm64` and `x64`), Linux (`x64`), and Windows (`x64`)
desktop artifacts from a single `v*.*.*` tag and publishes one GitHub release. It auto-enables
signing only when platform credentials are present. macOS passkey builds additionally require
`APPLE_TEAM_ID` and the `MACOS_PROVISIONING_PROFILE` secret; Windows uses Azure Trusted Signing.
Without the core signing credentials, it still releases unsigned artifacts.

Preflight shares pnpm's lockfile verification results with the desktop build jobs through a small
artifact. This avoids repeating dependency checks, especially on Windows, without transferring the
large registry metadata cache. pnpm checks the current lockfile and policy before it reuses a result.
If the artifact is unavailable, installation runs the checks again.

See [Release Checklist](../operations/release.md) for the full release/signing setup checklist.
