# AUR packaging

Packaging for [`t3code-bin`](https://aur.archlinux.org/packages/t3code-bin) (stable) and
[`t3code-nightly-bin`](https://aur.archlinux.org/packages/t3code-nightly-bin) (nightly), both
repackaging the official x86_64 AppImage from GitHub Releases. Icons come from the AppImage
payload, so each channel ships its own branding.

`.github/workflows/publish-aur.yml` runs `scripts/release.sh <package-dir>` for both packages when
a release is published (or via `workflow_dispatch` with optional `release_tag`/`pkgrel` inputs).
The script matches the release tag to the package's channel (other tags are a no-op), patches the
PKGBUILD, regenerates `.SRCINFO`, test-builds with `makepkg`, and pushes to the AUR over SSH.
Without the `AUR_SSH_PRIVATE_KEY` secret (an SSH key authorized on the AUR account) the push is
skipped as a dry run. Optional vars: `AUR_COMMIT_NAME`/`AUR_COMMIT_EMAIL` (committer identity),
`UPSTREAM_REPO` (release source, defaults to this repo).

Committed PKGBUILDs are templates — CI patches the version fields at publish time.

Test locally on Arch (or `archlinux:base-devel`) with `gh`, `jq`, and `curl`:

```bash
GH_TOKEN=$(gh auth token) GITHUB_REPOSITORY=pingdotgg/t3code \
  packaging/aur/scripts/release.sh packaging/aur/t3code-bin
```
