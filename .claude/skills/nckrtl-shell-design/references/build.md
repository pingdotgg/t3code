# Build and install the nckrtl desktop app

Conn is the fork's one customizations branch: `main` of `nckrtl/conn` (renamed
from `nckrtl/t3code` and its `nckrtl` branch on 2026-10-11). It is checked out
on this MacBook (`~/apps/conn`) and tracks `origin/main`. Merge
`upstream/main` into it to take upstream changes (it carries merge commits,
so a rebase replays them), then run the sync procedure in
[SKILL.md](../SKILL.md).

## What the fork's build already does

- No update feed: every build sets `publish: null`, so the app never replaces
  itself with an upstream release (`scripts/build-desktop-artifact.ts`).
- T3 Code has no in-page annotator of its own. The browser panel's
  "Annotate preview" feature (`apps/web/src/annotations/`) is product code: it
  loads the overlay into the previewed page from an annotation server the user
  configures, and it does ship.

## Build on the mini

The mini holds the local signing identity ("Nick Local Code Signing").

```bash
ssh mini
cd /Volumes/Data/nckrtl/.cache/t3-patches-045
git pull --ff-only
vp i
node scripts/build-desktop-artifact.ts --platform mac --target dmg --arch arm64 \
  --build-version 0.0.<upstream patch>-nckrtl.<YYYYMMDD>
```

Version: the upstream desktop version it is based on, then `-nckrtl.` and the
build date (earlier builds used `-rooms.`). Artifacts land in `release/`.

## Sign and install

The app builds as **Conn** (`Conn.app`, app id `com.nckrtl.conn`, see
`apps/desktop/src/branding/forkBrand.json`). The `--signed` flag needs T3's
Apple team, so re-sign with your own team's certificate
(`scripts/sign-macos-local.ts`, hardened runtime, release entitlements minus
the team-bound passkey ones, so passkey sign-in is unavailable). Without an
identity argument the script picks the certificate of the Apple team in
`forkBrand.json` (9SVJ4SYB9B) and checks `TeamIdentifier` afterwards:

Over SSH the login keychain is locked and `codesign` fails with
`errSecInternalComponent`. Sign from a terminal on the mini itself, or unlock
the keychain in the SSH session first (the user types the password):

```bash
security unlock-keychain ~/Library/Keychains/login.keychain-db
```

```bash
tmp=$(mktemp -d)
ditto -x -k "release/Conn-<version>-arm64.zip" "$tmp"
node scripts/sign-macos-local.ts "$tmp/Conn.app"   # or add an identity name as the second argument
ditto -c -k --keepParent "$tmp/Conn.app" "release/Conn-<version>-arm64-signed.zip"
```

Copy the signed zip to the target Mac. Stage only as `Conn.app` inside a temporary
directory (for example `/Applications/.conn-install-XXXXXX/Conn.app`); never rename
the bundle to a staging label, which Spotlight can retain after installation.
Keep backups as `<backup-directory>/Conn.app` too. Verify the designated requirements
of the app and helpers against the installed build, make and verify a backup, then
quit only `/Applications/Conn.app/Contents/MacOS/Conn` and replace the bundle.
Unregister temporary and obsolete backup paths with `lsregister -u`, register
`/Applications/Conn.app` with `lsregister -f`, and check its name and path in
`lsregister -dump`. Do not reset the whole LaunchServices database. Launch only
when the user requests it. The first launch copies the old app's user data
(see FORK.md, "Conn"). User data in `~/.t3` is untouched.
