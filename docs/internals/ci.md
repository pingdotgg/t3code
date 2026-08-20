# CI quality gates

> For maintainers. Using T3 Code? See [docs/user](../user/).

[`.github/workflows/ci.yml`](../../.github/workflows/ci.yml) classifies changed paths on pull
requests and pushes to `main`, then runs only the affected quality gates:

- **Classify changes**: tests and runs `.github/scripts/ci-change-classifier.cjs`. Missing or truncated
  changed-file data fails safe by enabling every gate. Changes to the classifier or `ci.yml` also
  exercise every gate.
- **Check**: for product code, runs `vp check` (format and lint; this repo sets `typeCheck: false` in
  its lint options), `vpr typecheck`, the desktop build, and preload verification. Workflow-only
  changes keep the stable `Check` status but use GitHub's successful workflow parse instead of
  installing product dependencies.
- **Test**: runs `vp run test` across the workspace when product code or CI control files change.
- **Mobile Native Static Analysis**: runs `vp run lint:mobile` on macOS only when native mobile
  sources, their lint configuration, shared shell code, or dependency inputs change.
- **Release Smoke**: exercises release-only workflow steps through `scripts/release-smoke.ts` when
  package manifests, lock/workspace files, patches, release scripts, bundled mobile dependencies,
  or the release workflow change.

Documentation, Markdown/MDX, `.github/VOUCHED.td`, PR/issue templates, PR assets, plans, and
`.repos/**` changes skip product checks. Unknown paths remain product changes. If classification
fails, every existing gate runs rather than being bypassed.

`.github/workflows/release.yml` builds macOS (`arm64` and `x64`), Linux (`x64`), and Windows (`x64`)
desktop artifacts from a single `v*.*.*` tag and publishes one GitHub release. It auto-enables
signing only when platform credentials are present. macOS passkey builds additionally require
`APPLE_TEAM_ID` and the `MACOS_PROVISIONING_PROFILE` secret; Windows uses Azure Trusted Signing.
Without the core signing credentials, it still releases unsigned artifacts.

See [Release Checklist](../operations/release.md) for the full release/signing setup checklist.
