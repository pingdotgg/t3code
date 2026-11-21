# T3 Code (personal fork)

My own fork of [T3 Code](https://github.com/pingdotgg/t3code), a minimal GUI for coding
agents. It exists so I can carry a few local modifications and build my own installers.
Nothing here is meant for anyone else.

- Upstream project: <https://github.com/pingdotgg/t3code>
- Docs: [docs/README.md](docs/README.md) — still the upstream docs
- License: [MIT](LICENSE)

## What differs from upstream

This fork keeps no CI. Every upstream workflow is deleted, and
`.github/workflows/fork-release.yml` is the only one that runs — upstream's are
disabled, so a sync cannot start one. On dispatch it reads the version from the
manifests, tags `v<version>-fork.<n>`, and attaches to a GitHub Release:

- desktop installers for linux x64 (rpm), windows x64 (nsis) and macOS arm64 (dmg)
- the `t3` CLI archives for linux x64 and macOS arm64, plus `SHA256SUMS` for `t3 update`
- an Android APK for arm64-v8a

Nothing runs on push, and no release ever writes a version number into a tracked file.

## Branches

- `main` mirrors upstream `main` and carries nothing of ours.
- `customized` (default) is where this fork lives, and where releases are cut from.

## Sync and release

```bash
git switch customized
git fetch upstream main
git merge upstream/main
```

A scheduled task does this every night at 06:00 and finishes the merge in its own
thread, then dispatches **Fork release**. To publish one yourself, run **Fork
release** in the Actions tab.
[docs/operations/fork-changes.md](docs/operations/fork-changes.md) is what a merge has
to keep, and [AGENTS.md](AGENTS.md) explains why the version is never committed here.

## Install on Fedora

```bash
sudo dnf install https://github.com/657kbps/t3code/releases/download/v0.1.11-fork.2/T3-Code-0.1.11-fork.2-x86_64.rpm
```

There is no package repository: GitHub refuses any file over 100 MB, and the rpm is
163 MB.

## Install the CLI

Each release carries a self-contained `t3` (no Node needed). `t3 install` only works
from the runtime layout, so extract there first and let it write its own launcher:

```bash
version=0.1.11-fork.3
mkdir -p ~/.t3/runtime/versions
curl -fsSL -o /tmp/t3.tar.gz \
  "https://github.com/657kbps/t3code/releases/download/v$version/t3-$version-linux-x64.tar.gz"
tar -xzf /tmp/t3.tar.gz -C ~/.t3/runtime/versions
mv ~/.t3/runtime/versions/t3-$version-linux-x64 ~/.t3/runtime/versions/$version
~/.t3/runtime/versions/$version/t3 install
```

On macOS arm64 the archive is `t3-$version-darwin-arm64.tar.gz`. That puts `t3` in
`~/.local/bin`, and `t3 update` then moves you to the next release of this fork.
