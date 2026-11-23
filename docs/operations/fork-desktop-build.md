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

The desktop app installs the server on an SSH host from this repository's releases, choosing the
release that matches its own version, and a host's T3 server installs its own release in its
agentctl Sandboxes (`packages/ssh/src/remoteServerOverrides.ts`). So the fork's server changes
reach Sandboxes, and an app always gets the server built with it.

Nothing is signed. The apps carry no update feed, so they never replace themselves; installing a
newer release is running the install script again.

## The version

Releases use upstream's preview form, `<core>-preview.<YYYYMMDD>.<run>`, such as
`0.1.1-preview.20261017.3`, where `<core>` is the next patch after `apps/desktop/package.json`'s
version and `<run>` the workflow's run number. The desktop build gives a preview version no update
feed, which keeps the CI build from pointing the app at this repository's releases. Each release
notes the upstream stable release or nightly it is based on.

The app is named T3 Code (Beta), like upstream's preview builds. Earlier fork builds were named
T3 Code (Alpha) or T3 Code (Nightly); on macOS those apps stay beside the new app until you remove
them, which the install script reminds you of.

The client warns about a server older than itself by comparing core versions only for previews, so
it does not notice a Sandbox on an older fork release with the same core. Reinstalling the app and
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

Running it again replaces the previous install in place. It reports an upstream install it finds,
such as the AUR package or the Homebrew cask, but never removes one. Remove an upstream install if
you want only the fork's: it updates itself to upstream builds. Do not use
`brew uninstall --zap`, which deletes `~/.t3/userdata`.

Install with the script rather than from the release page: a browser marks the download, so
Gatekeeper blocks the unsigned macOS app and SmartScreen warns about the Windows installer.

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
