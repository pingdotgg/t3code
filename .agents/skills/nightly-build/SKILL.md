---
name: nightly-build
description: Build a local desktop artifact from the current commit, versioned so the app reads it as a nightly. Use when asked to build a nightly, cut a dmg, or produce an installable artifact after a port or a fix.
---

# Nightly build

## Version rule

`<base>-<sha12>-nightly.<YYYYMMDD>`, e.g. `0.0.34-b13b0c17ecef-nightly.20260824`.

- **base** — the version in `apps/server/package.json` with its patch bumped by one, so the artifact sorts above the release it replaces.
- **sha12** — `git rev-parse --short=12 HEAD`. The built commit rides in the version, so an installed app names its own source.
- **date** — today, `YYYYMMDD`.

`resolveDesktopUpdateChannel` in `scripts/build-desktop-artifact.ts` matches exactly this shape. Any other version builds a `latest`-channel artifact instead: product name `T3 Code`, release icon, and an installed app that collides with the developer's real one.

## Build

Commit first — the sha in the version has to be the code in the artifact.

```bash
export PATH="$PWD/node_modules/.bin:$PATH"   # the script spawns `vp`; without this it dies on `spawn vp ENOENT`
node scripts/build-desktop-artifact.ts --platform mac --target dmg --arch arm64 \
  --build-version "0.0.34-$(git rev-parse --short=12 HEAD)-nightly.$(date +%Y%m%d)"
```

Run it in the background: a full build takes several minutes, and piping it through `tail` hides progress until it ends. `--help` carries the platform, target, and signing flags; local builds stay unsigned.

## After the build

The artifact lands in `release/` as `T3-Code-<version>-<arch>.dmg`. Confirm the filename carries `-nightly.` — that is the channel check, visible without opening anything.

Hand the path to the developer and let them install it. Installing replaces the app they are running you from.
