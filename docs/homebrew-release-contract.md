# Homebrew Release Contract

This document defines the release invariants required for `Homebrew/homebrew-cask` (`t3-code`) autobump compatibility.

## Required invariants

1. Release tag format is `vX.Y.Z` (for example `v0.0.4`).
2. Release assets include both macOS DMGs:
   - `T3-Code-<version>-arm64.dmg`
   - `T3-Code-<version>-x64.dmg`
3. Desktop app bundle product name remains `T3 Code (Alpha)` (used by cask `app` stanza).

## Validation

Use the validator script from repository root:

```bash
node scripts/validate-homebrew-release-contract.ts \
  --version 0.0.4 \
  --tag v0.0.4 \
  --assets-dir release-assets
```

In CI (`.github/workflows/release.yml`), the validator runs:

1. In preflight (metadata only: version/tag/product name).
2. In release job before publishing assets (metadata + DMG presence).
