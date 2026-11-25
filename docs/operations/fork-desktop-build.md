# Releasing and installing the fork's desktop app

## Releases

Run the **Fork release** workflow (`.github/workflows/fork-release.yml`) on `main` from the Actions
tab. It publishes one GitHub release of this repository with:

- the desktop apps: AppImages for Linux, dmgs for macOS and installers for Windows, each for x64
  and arm64. The Windows installers embed the Linux server of their arch for the WSL backend;
- the T3 server archives SSH hosts install, agentctl Sandboxes included: linux-x64, linux-arm64 and
  darwin-arm64, the hosts the SSH installer supports;
- `SHA256SUMS` over all of them.

A run on another branch, such as a `sync/<date>` branch, builds the same files but publishes
nothing: they stay on the run as artifacts, for testing before `main` moves (see
[Testing a build before it is released](#testing-a-build-before-it-is-released)). Once `main` points
at the commit that run built, run the workflow on `main` with `from_run` set to its run id: it
publishes that build as the release, under the version it was built with, without building again.
It refuses a run that did not build `main`'s commit.

A run publishes only when every build finished. GitHub sometimes cancels a build that no runner
picked up, most often macOS when hosted macOS runners are short; re-running the run's failed jobs
builds the missing apps and then publishes the release.

The desktop app installs the server on an SSH host from this repository's releases, choosing the
release that matches its own version, and a host's T3 server installs its own release in its
agentctl Sandboxes (`packages/ssh/src/remoteServerOverrides.ts`). So the fork's server changes
reach Sandboxes, and an app always gets the server built with it.

## Updates

The apps update themselves from this repository's releases: each release carries electron-updater's
manifests (`latest.yml`, `latest-linux.yml`, `latest-linux-arm64.yml`, and `latest-mac.yml` when the
macOS apps are signed), and an
installed app offers
the latest release once it is newer, then downloads it and restarts when you choose. Reconnecting
to an SSH host afterwards installs the matching server there. The release refuses a build older
than the latest release, which would hold every install back.

The first release with a feed has to be installed with the install script once; an earlier fork
build has no feed to find it. A source build gets no feed either.

macOS installs an update only when it is signed like the running app, so a macOS build carries a
feed only when it is signed (see [Signing the macOS apps](#signing-the-macos-apps)). Without the
signing secrets, the macOS apps are unsigned and updating them is running the install script again.
Nothing else is signed: Windows and Linux update unsigned.

## Signing the macOS apps

The macOS apps and the darwin-arm64 server archive are signed with a Developer ID and notarized
when the repository has these Actions secrets:

- `CSC_LINK`: a `Developer ID Application` certificate with its private key, exported from Keychain
  Access as a `.p12` and base64-encoded (`base64 -i cert.p12 | pbcopy`).
- `CSC_KEY_PASSWORD`: the `.p12`'s export password.
- `APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`: an App Store Connect team API key with
  the Developer role, for notarization: the downloaded `.p8`'s contents, its key ID and the issuer
  ID.

Leave the `APPLE_TEAM_ID` variable and `MACOS_PROVISIONING_PROFILE` secret of upstream's
[release setup](./release.md#2-apple-signing--notarization-setup-macos) unset. Upstream's profile
grants passkeys to its app ID, `com.t3tools.t3code`, which only upstream's team can hold, so the
fork's apps are signed without it, and passkeys in the in-app browser stay off as in unsigned
builds.

A Mac with an unsigned fork build installs the first signed release with the install script, and
then asks once for the keychain password, since the signed app reads the keychain item the unsigned
one created.

## A Mac as the macOS runner

GitHub's hosted macOS runners have often gone unassigned since November 2026: a job waits 15
minutes and is cancelled before any step runs, and re-running it may take hours to succeed. Setting
the repository variable `FORK_MAC_RUNNER` to a self-hosted runner's label runs both macOS builds
there instead; an Apple Silicon Mac builds the x64 app too. Unset it to go back to `macos-15`.

Each job runs in a fresh clone of a prepared [Tart](https://github.com/openai/tart) virtual machine,
registered for that job alone and deleted afterwards, as on GitHub's runners: upstream's release
workflow expects a clean machine, and no job leaves anything behind on this public repository's
runner. Only Fork release, which only people with write access can start, names its label. On a Mac
with Homebrew, signed in to `gh` as an admin of the repository:

```sh
scripts/fork/setup-mac-runner.sh
```

It prepares the VM, adding the Developer ID intermediate certificates that Xcode would otherwise
bring, runs the clones from a LaunchAgent that logs to
`~/Library/Application Support/fork-mac-runner/loop.log`, keeps the Mac from sleeping, requires
approval for every external contributor's pull request workflows, and sets `FORK_MAC_RUNNER`. The
runner works in the VM's logged-in session, where the launch check can open the app, and the
LaunchAgent needs this Mac's user logged in. The two macOS builds run one after the other.

## The version

Releases use upstream's preview form, `<core>-preview.<YYYYMMDD>.<run>`, such as
`0.1.1-preview.20261017.3`, where `<core>` is the next patch after `apps/desktop/package.json`'s
version and `<run>` the workflow's run number, so a later release always has a higher version.
Upstream gives its preview builds no update feed, since they sit beside its stable releases; a
build from this repository is the exception (`scripts/build-desktop-artifact.ts`). Each release
notes the upstream stable release or nightly it is based on.

The app is named T3 Code (Beta), like upstream's preview builds. Earlier fork builds were named
T3 Code (Alpha) or T3 Code (Nightly); on macOS those apps stay beside the new app until you remove
them, which the install script reminds you of.

The client warns about a server older than itself by comparing core versions only for previews, so
it does not notice a Sandbox on an older fork release with the same core. Updating the app and
reconnecting installs the matching server.

## Installing

```sh
node scripts/fork/install-desktop.ts
```

It needs only Node, in a checkout of this repository, on Linux, macOS or Windows, x64 or arm64. It
downloads the latest release, or the one `--version <version>` names, into the user's cache
directory (`~/.cache` on Linux) rather than the temp directory, which may be mounted noexec. It
checks the download against the release's `SHA256SUMS` and installs:

- **Linux:** the AppImage as `~/.local/bin/t3code`, with the launcher
  `~/.local/share/applications/t3code.desktop` and the icon `~/.local/share/icons/t3code.png`.
- **macOS:** the app into `~/Applications`.
- **Windows:** the app through its installer, run silently. The installer shares upstream's app ID
  and would replace a per-user upstream install, so the script refuses to run while one is
  installed.

Running it again replaces the previous install in place, though an app with a feed updates
itself. It reports an upstream install it finds,
such as the AUR package or the Homebrew cask, but never removes one. Remove an upstream install if
you want only the fork's: it updates itself to upstream builds. Do not use
`brew uninstall --zap`, which deletes `~/.t3/userdata`.

Install with the script rather than from the release page: a browser marks the download, so
Gatekeeper blocks an unsigned macOS app and SmartScreen warns about the Windows installer.

## Building from source

```sh
node scripts/fork/install-desktop.ts --from-source
```

Builds the checked-out commit and installs it the same way, to try a change, or the install itself,
before releasing it. It runs from a clean checkout. The build names any tools it is missing, such as
Rust or ImageMagick. Leave the checkout alone while it runs: afterwards it restores every tracked
file that changed, because the build rewrites some.

SSH hosts install the server release of the app's version. If a release was published from the
commit, the build takes its version, so SSH environments work. Otherwise it is stamped
`<core>-preview.<YYYYMMDD>.0`, a version no release has, and the script says so. To use SSH
environments with such a build, start it with `T3CODE_REMOTE_SERVER_VERSION` set to a published
release, or to a server installed as below.

## Testing a build before it is released

A Fork release run on a branch leaves the server archives as artifacts. To connect to an agentctl
Sandbox running that server, install it in the Sandbox:

```sh
node scripts/fork/seed-sandbox-server.ts --run <run id> --agent <name>
```

It downloads the archive for the Sandbox's platform with `gh` and unpacks it over the
`agentctl-<name>` SSH alias where the SSH installer keeps runtimes, so the host's T3 server finds
it installed and downloads nothing. Start the app, such as `vp run dev:desktop` in the branch's
checkout, with `T3CODE_REMOTE_SERVER_VERSION` set to the run's version, which `--run <run id>`
alone prints; its server inherits it. A Sandbox created from it needs the script run once it is
Ready; until then the server retries.

## Development builds

For `vp run dev:desktop` or `vp run dev`, or to try another server, set these before starting
the app or server:

- `T3CODE_REMOTE_SERVER_VERSION`: the release SSH hosts and agentctl Sandboxes install, such as
  `0.0.46-preview.20261011.3`.
- `T3CODE_REMOTE_SERVER_RELEASE_BASE_URL`: where release archives are downloaded from, such as
  `https://github.com/pingdotgg/t3code/releases/download` for upstream's.
