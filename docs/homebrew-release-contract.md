# Homebrew Release Contract

This document defines the release invariants required for `Homebrew/homebrew-cask` (`t3-code`) autobump compatibility.

## Required invariants

1. Release tag format is `vX.Y.Z` (for example `v0.0.4`).
2. Release workflow repository is `pingdotgg/t3code` (fork releases must not be used for official Homebrew flow).
3. Release assets include both macOS DMGs:
   - `T3-Code-<version>-arm64.dmg`
   - `T3-Code-<version>-x64.dmg`
4. Desktop app bundle product name remains `T3 Code (Alpha)` (used by cask `app` stanza).

## Validation

Use the validator script from repository root:

```bash
node scripts/validate-homebrew-release-contract.ts \
  --version 0.0.4 \
  --tag v0.0.4 \
  --repository pingdotgg/t3code \
  --expected-repository pingdotgg/t3code \
  --assets-dir release-assets
```

In CI (`.github/workflows/release.yml`), the validator runs:

1. In preflight (metadata only: version/tag/product name).
2. In release job before publishing assets (metadata + DMG presence).
