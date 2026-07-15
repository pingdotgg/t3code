# Auto-Update System

This document describes the auto-update system, build pipeline, and versioning for the SergeCode macOS app.

## Overview

The system consists of four main components:

1. **Versioning System**: Centralized version management via `version.json`
2. **Build Pipeline**: Automated GitHub Actions workflow for releases
3. **Auto-Update**: Sparkle framework integration for in-app updates
4. **Version Bump Tools**: Scripts to increment versions following semver

## Quick Start

### Bumping Version and Creating a Release

```bash
# Bump version (choose one)
pnpm run version:bump patch        # 0.1.0 -> 0.1.1
pnpm run version:bump minor        # 0.1.0 -> 0.2.0
pnpm run version:bump major        # 0.1.0 -> 1.0.0
pnpm run version:bump prerelease   # 0.1.0 -> 0.1.1-alpha.1

# Push changes and trigger release
git push && git push --tags
```

This will:
- Update `version.json` with the new version
- Commit the change and create a git tag
- Trigger the GitHub Actions release workflow when pushed
- Build the app, run tests, create DMG and ZIP
- Publish a GitHub Release with artifacts
- Update the Sparkle appcast for auto-updates

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

Triggered by: Pushing tags matching `v*` pattern

Steps:
1. **Checkout & Setup**: Clone repo, install dependencies
2. **Test**: Run Swift tests (`swift test`)
3. **Build**: Run `make-app.sh` to create release build
4. **Package DMG**: Create DMG installer using `hdiutil`
5. **Package ZIP**: Create ZIP for Sparkle updates
6. **Sign**: Generate Sparkle EdDSA signature (if key configured)
7. **Update Appcast**: Add release entry to `appcast.xml`
8. **Publish**: Create GitHub Release with DMG and ZIP
9. **Commit**: Push updated appcast back to main branch

### Auto-Update with Sparkle

**Integration Points**:

1. **Package.swift**: Sparkle added as dependency
2. **Info.plist**: 
   - `SUFeedURL`: Points to appcast.xml on GitHub
   - `SUPublicEDKey`: Public key for signature verification
3. **App.swift**: 
   - `SPUStandardUpdaterController` initialized in init
   - "Check for Updates" menu item in app menu

**Appcast**: `apps/mac/Support/appcast.xml`

RSS feed listing available releases. Updated by CI during release process.

**Update Script**: `apps/mac/scripts/update-appcast.sh`

```bash
./update-appcast.sh VERSION DOWNLOAD_URL FILE_SIZE SIGNATURE
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

1. **Bump version**:
   ```bash
   pnpm run version:bump patch
   ```

2. **Review changes**:
   ```bash
   git log -1 --stat
   git show v0.1.1  # Check tag
   ```

3. **Push to trigger release**:
   ```bash
   git push && git push --tags
   ```

4. **Monitor workflow**:
   - Go to GitHub Actions tab
   - Watch "Release macOS App" workflow
   - Check for errors in test/build/publish steps

5. **Verify release**:
   - Check GitHub Releases page for new release
   - Download and test DMG/ZIP artifacts
   - Verify appcast.xml was updated

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

2. **Add private key to GitHub**:
   - Go to repository Settings > Secrets and variables > Actions
   - Add new secret: `SPARKLE_PRIVATE_KEY`
   - Paste the private key value

3. **Add public key to Info.plist**:
   ```bash
   # Edit apps/mac/Support/Info.plist
   # Replace the SUPublicEDKey value with the public key
   ```

4. **Commit and push**:
   ```bash
   git add apps/mac/Support/Info.plist
   git commit -m "chore: add Sparkle public key"
   git push
   ```

Future releases will be automatically signed.

## Version Bump Tool

**Script**: `apps/mac/scripts/version-bump.sh`

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
