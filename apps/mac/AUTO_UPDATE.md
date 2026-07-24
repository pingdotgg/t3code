# Auto-Update System

This document describes the auto-update system, build pipeline, and versioning for the SergeCode macOS app.

## Overview

The system consists of four main components:

1. **Versioning System**: Centralized version management via `version.json`
2. **Build Pipeline**: Automated GitHub Actions workflow for releases
3. **Auto-Update**: Sparkle framework integration for in-app updates
4. **Version Bump Tools**: Scripts to increment versions following semver

## Quick Start

### Automatic releases (default)

Every push to `main` triggers the `Release macOS App` workflow, which:

1. Bumps the prerelease version (e.g. `0.1.0-alpha.2` → `0.1.0-alpha.3`) and
   `buildNumber` in `apps/mac/version.json`, commits it as
   `chore: bump version to X [skip release]`, and tags `vX`.
2. Runs the repository checks, builds the app, signs the Sparkle appcast, and
   publishes a GitHub Release.
3. Commits the updated `appcast.xml` directly to `main` as
   `chore: publish appcast for X [skip release]`.

Because the app's `SUFeedURL` reads the appcast from `main`, installed apps
see the update as soon as that commit lands — no manual steps.

The `[skip release]` marker in bot commit messages prevents the workflow from
re-triggering itself. Keep that marker on any automation or cherry-picked
release commit you create by hand.

### Manual release (override)

To release the exact version currently in `apps/mac/version.json` without an
auto-bump (e.g. after merging a manual semver bump PR), run the
`Release macOS App` workflow manually from `main` with the matching version
input. The dispatch path validates the input against `version.json` and skips
the auto-bump.

## Architecture

### Version Management

**File**: `apps/mac/version.json`

```json
{
  "version": "0.1.0-alpha.1",
  "buildNumber": "1"
}
```

- Single source of truth for version information
- `version`: User-visible semver version (e.g., "0.1.0-alpha.1")
- `buildNumber`: Monotonically increasing build number

**Sync Script**: `apps/mac/scripts/sync-version.sh`

- Reads `version.json` and updates `Support/Info.plist`
- Sets `CFBundleShortVersionString` (version) and `CFBundleVersion` (build number)
- Called automatically by `make-app.sh` before every build
- Idempotent: safe to run multiple times

**Swift API**: `Sources/SergeCodeMac/Support/AppVersion.swift`

```swift
AppVersion.version        // "0.1.0-alpha.1"
AppVersion.buildNumber    // "1"
AppVersion.fullVersion    // "0.1.0-alpha.1 (1)"
```

Reads version from Bundle.main.infoDictionary at runtime.

### Build Pipeline

**Workflow**: `.github/workflows/release-mac.yml`

Triggered automatically on every push to `main` (commits containing
`[skip release]` are ignored to prevent release loops), or manually via
`workflow_dispatch` with a version matching `version.json`.

Steps:

1. **Version bump** (push events only): compute the next prerelease version
   via `scripts/compute-version.sh`, commit `version.json`, tag `vX`, push.
2. **Checkout & Setup**: Clone repo, install dependencies
3. **Test**: Run checks (`vp check`, `vp run typecheck`, `swift test`)
4. **Build**: Run `make-app.sh` to create release build
5. **Package DMG**: Create DMG installer using `hdiutil`
6. **Package ZIP**: Create ZIP for Sparkle updates
7. **Sign**: Generate Sparkle EdDSA signature (if key configured)
8. **Publish**: Create GitHub Release with DMG and ZIP
9. **Appcast**: Commit the signed `appcast.xml` directly to `main` with a
   `[skip release]` marker, making the update visible to installed apps
   immediately

### Auto-Update with Sparkle

**Integration Points**:

1. **Package.swift**: Sparkle added as dependency
2. **Info.plist**:
   - `SUFeedURL`: Points to appcast.xml on GitHub
   - `SUPublicEDKey`: Public key for signature verification
   - `SUEnableAutomaticChecks`: Scheduled update checks without a one-time
     permission prompt; users still confirm each install
3. **App.swift**:
   - `SPUStandardUpdaterController` initialized in init
   - "Check for Updates" menu item in app menu

**Appcast**: `apps/mac/Support/appcast.xml`

RSS feed listing available releases. Updated by CI during release process.

**Update Script**: `apps/mac/scripts/update-appcast.sh`

```bash
./update-appcast.sh BUILD_VERSION DISPLAY_VERSION DOWNLOAD_URL FILE_SIZE SIGNATURE
```

Adds a new `<item>` entry to appcast.xml with release metadata.

## Usage

### Local Development

Build with version sync:

```bash
pnpm run package:mac        # Release build
pnpm run package:mac --debug # Debug build
```

The version from `version.json` is automatically synced to Info.plist before building.

### Creating a Release

Releases are automatic — merging a PR to `main` is all it takes. Each merge
produces a new prerelease (e.g. `0.1.0-alpha.3`) with its own GitHub Release
and appcast entry.

To move the semver line (e.g. from alpha to a stable `0.1.0`, or a minor
bump), prepare a release branch:

1. **Prepare a release branch**:

   ```bash
   git switch -c codex/release-0.1.0
   # Edit apps/mac/version.json manually (version + monotonically increasing
   # buildNumber), commit, and open a PR against main
   ```

2. **Review changes**:

   ```bash
   git log -1 --stat
   ```

3. **Merge the PR**: the push to `main` triggers the release workflow, which
   auto-bumps the prerelease number on top (e.g. `0.1.0` → `0.1.1-alpha.1`
   per the prerelease rules). If you need to release the exact version in
   `version.json` instead, run the `Release macOS App` workflow manually
   from `main` with that version as the input.

4. **Verify release**:
   - Check GitHub Releases page for new release
   - Download and test DMG/ZIP artifacts
   - Verify `apps/mac/Support/appcast.xml` on `main` gained the new item

### Configuring Sparkle Signing (First Time)

To enable signed updates:

1. **Generate key pair** (on your machine):

   ```bash
   # Download Sparkle tools
   curl -L -o sparkle.tar.xz https://github.com/sparkle-project/Sparkle/releases/download/2.6.4/Sparkle-2.6.4.tar.xz
   tar -xf sparkle.tar.xz

   # Generate keys
   ./bin/generate_keys
   ```

2. **Export the private key for GitHub Actions**:

   ```bash
   ./bin/generate_keys -x /tmp/surgecode-sparkle-private-key
   ```

   Add the file contents to the `SPARKLE_PRIVATE_KEY` Actions secret, then
   delete the temporary file. Never commit this key.

3. **Add public key to Info.plist**:

   ```bash
   # Set SUPublicEDKey to the value printed by generate_keys
   ```

4. **Commit through a PR**:
   ```bash
   git add apps/mac/Support/Info.plist
   git commit -m "chore: add Sparkle public key"
   gh pr create --repo SergeSerb2/SergeCode --base main
   ```

Future releases will be automatically signed.

### Version fields

`CFBundleVersion` and `sparkle:version` are the machine-readable, increasing
build number. `CFBundleShortVersionString` and
`sparkle:shortVersionString` are the human-readable semver version.

### Current packaging limitation

The native app currently resolves the Node server sidecar from a development
checkout. A production release still needs the Node runtime and server bundle
embedded in the app before the first public Sparkle release. The workflow is
therefore configured for the release process, but this packaging task must be
completed before distributing its artifacts to end users.

## Version Bump Tool

**Script**: `apps/mac/scripts/version-bump.sh`

The semver bump rules live in `apps/mac/scripts/compute-version.sh`, a
compute-only script (prints the next `version`/`buildNumber`/`tag`, no git
side effects) shared by `version-bump.sh` and the release workflow.

### Usage

```bash
./apps/mac/scripts/version-bump.sh [major|minor|patch|prerelease]
```

Or via npm:

```bash
pnpm run version:bump [major|minor|patch|prerelease]
```

### Behavior

- **patch**: Increment patch version (1.0.0 → 1.0.1)
- **minor**: Increment minor, reset patch (1.0.0 → 1.1.0)
- **major**: Increment major, reset minor/patch (1.0.0 → 2.0.0)
- **prerelease**:
  - If already prerelease: increment number (1.0.0-alpha.1 → 1.0.0-alpha.2)
  - If not: bump patch and add -alpha.1 (1.0.0 → 1.0.1-alpha.1)

Always increments build number.

Creates:

- Git commit: `chore: bump version to X.Y.Z`
- Git tag: `vX.Y.Z`

### Examples

```bash
# Start from 0.1.0-alpha.1 (build 1)
pnpm run version:bump prerelease
# → 0.1.0-alpha.2 (build 2)

pnpm run version:bump patch
# → 0.1.1 (build 3)

pnpm run version:bump minor
# → 0.2.0 (build 4)

pnpm run version:bump prerelease
# → 0.2.1-alpha.1 (build 5)
```

## Testing

### Test Version Sync

```bash
cd apps/mac
./scripts/sync-version.sh
cat Support/Info.plist | grep -A1 CFBundleVersion
```

### Test Version Bump

```bash
# Dry run (check before committing)
cat apps/mac/version.json
pnpm run version:bump patch
cat apps/mac/version.json
git log -1
git tag -l | tail -1

# Undo if needed
git reset --hard HEAD~1
git tag -d v0.1.1
```

### Test Build

```bash
pnpm run package:mac --debug
open apps/mac/dist/SurgeCode.app
# Check "About SurgeCode" shows correct version
```

### Test Appcast Update

```bash
cd apps/mac
./scripts/update-appcast.sh \
  "1" \
  "0.1.0-alpha.1" \
  "https://github.com/SergeSerb2/SergeCode/releases/download/v0.1.0-alpha.1/SurgeCode-0.1.0-alpha.1.zip" \
  "12345678" \
  "MC0CFQDtest..."

cat Support/appcast.xml
```

## Troubleshooting

### Build fails after adding Sparkle

**Error**: "No such module 'Sparkle'"

**Fix**: Resolve dependencies first:

```bash
cd apps/mac
swift package resolve
```

### Version not updating in app

**Check**:

1. `sync-version.sh` runs before build (check `make-app.sh`)
2. `version.json` has correct format
3. `AppVersion.swift` is in target sources
4. Info.plist copied to bundle (check `make-app.sh`)

### GitHub Actions release fails

**Common issues**:

- Tag already exists: Delete and recreate tag
- Tests failing: Fix tests before releasing
- DMG creation fails: Check disk space and permissions
- Appcast commit fails: Ensure GITHUB_TOKEN has write permissions

### Auto-updates not working

**Check**:

1. `SUFeedURL` in Info.plist points to correct appcast URL
2. Appcast.xml is accessible (test URL in browser)
3. Public key in Info.plist matches private key used for signing
4. App is signed (ad-hoc signature prevents Sparkle from working)

## File Structure

```
apps/mac/
├── version.json                    # Version source of truth
├── Support/
│   ├── Info.plist                  # Bundle info (CFBundleVersion)
│   └── appcast.xml                 # Sparkle release feed
├── scripts/
│   ├── sync-version.sh             # Sync version.json → Info.plist
│   ├── compute-version.sh          # Compute next version (no git side effects)
│   ├── version-bump.sh             # Increment version + git tag
│   ├── update-appcast.sh           # Update appcast.xml
│   └── make-app.sh                 # Build script (calls sync-version.sh)
└── Sources/SergeCodeMac/
    ├── Support/
    │   └── AppVersion.swift        # Swift API for version info
    └── App.swift                   # Sparkle integration

.github/workflows/
└── release-mac.yml                 # Automated release pipeline
```

## Notes

- **Signing**: Currently using ad-hoc signing. Users must bypass Gatekeeper on first launch.
- **Notarization**: Not implemented. Would require Apple Developer account and certificate.
- **Appcast hosting**: Uses GitHub raw URLs. Could move to GitHub Pages for better caching.
- **Semantic versioning**: Follows semver 2.0.0 specification.
- **Build numbers**: Increment on every version bump, never reset.

## Future Enhancements

- [ ] Automated changelog generation from commits
- [ ] Release notes template
- [ ] Delta updates (smaller downloads)
- [ ] Multiple release channels (stable, beta, alpha)
- [ ] Code signing with Developer ID
- [ ] Notarization for macOS 10.14.5+
- [ ] Homebrew cask formula
