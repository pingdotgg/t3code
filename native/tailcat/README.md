# Tailcat runtime

T3 Code bundles the upstream [Tailcat](https://github.com/tailscale/tailcat) CLI as the transport
behind Tailcat environments and federation. The binary is pinned by `manifest.json` in this
directory and verified by SHA-256 before it is staged into any artifact. Nothing downloads a
"latest" binary at runtime; the runtime only ever runs the executable this manifest describes.

## Provenance

- Upstream: `github.com/tailscale/tailcat`, tag `v<version>` from `manifest.json`, which also pins
  the commit that tag pointed at when the pin was taken (`source.commit`).
- Linux and Windows: the official release archives. `assets.<platform-key>.sha256` is the digest of
  the whole archive, computed from the downloaded bytes and cross-checked against the release's
  `checksums.txt` when the pin is bumped. The fetch script refuses to open an archive whose digest
  differs from the manifest.
- macOS: upstream publishes no macOS binaries. The fetch script clones the pinned tag, refuses to
  build unless `HEAD` is `source.commit`, and compiles `source.package` with `CGO_ENABLED=0`,
  `-trimpath`, `-buildvcs=false`, the upstream `build-tags.txt`, and the upstream `ldflags`. The
  output is a function of the source and the Go toolchain (`source.goVersion`) alone, so the darwin
  binaries cross-compiled by the Linux npm publisher match the ones built on the macOS runners.
- License: BSD-3-Clause. `LICENSE` in this directory is the upstream text (refreshed by `--update`),
  and every staged runtime directory carries the upstream copy as `LICENSE.txt` next to the binary,
  which satisfies the binary-redistribution clause for the desktop app and the npm package.

## Staged layout

`node scripts/fetch-tailcat.ts` writes `native/tailcat/dist/<platform-key>/` (gitignored):

| File                      | Purpose                                                                                                    |
| ------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `tailcat` / `tailcat.exe` | the executable, mode 0755                                                                                  |
| `provenance.json`         | version, platform key, binary digest, and the archive URL and digest or the source commit and Go toolchain |
| `LICENSE.txt`             | upstream BSD-3-Clause text                                                                                 |

Platform keys are `linux-x64`, `linux-arm64`, `win32-x64`, `win32-arm64`, `darwin-arm64`, and
`darwin-x64`, the same vocabulary as `packages/tailcat/src/manifest.ts`.

The manifest pins archive digests, not binary digests, so `provenance.json` is what makes a staged
binary checkable later: `--verify` confirms the provenance names the pinned version and archive
digest (or pinned commit) and that the binary still hashes to the digest recorded when it was
extracted. The packaging steps (`scripts/build-desktop-artifact.ts` and
`apps/server/scripts/cli.ts publish`) run the same check before copying a binary into an artifact,
so a stale `dist/` after a pin bump fails the build instead of shipping the previous version.

Companion files carry extensions on purpose: on macOS the signing pass codesigns every
extension-less file under `Contents/`, which is how `tailcat` gets signed alongside the resource
monitor, and a bare `LICENSE` would be handed to codesign as well.

## Local development

```sh
node scripts/fetch-tailcat.ts                           # this machine, into native/tailcat/dist/<platform-key>/
node scripts/fetch-tailcat.ts --platform linux-arm64    # another platform
node scripts/fetch-tailcat.ts --all                     # every pinned key; darwin needs Go
node scripts/fetch-tailcat.ts --verify                  # re-check what is staged; non-zero on drift
node scripts/fetch-tailcat.ts --verify --manifest-only  # validate manifest.json only (CI runs this)
```

`vp run fetch:tailcat` runs the same script. Fetching is idempotent: a directory that still verifies
is left alone, so delete it to refetch. `--build-from-source` compiles any platform from the pinned
tag instead of downloading (implied for darwin), `--out <dir>` redirects the output root, and
`--verbose` streams git and go output.

The dev server and desktop app find the binary under `native/tailcat/dist/`. A system `tailcat`
on `PATH` also works, and `T3CODE_TAILCAT_BINARY=/path/to/tailcat` overrides both.

## Where the binary ships

- Desktop: `scripts/build-desktop-artifact.ts` copies `native/tailcat/dist/<platform-key>/` for the
  build's platform keys (both darwin keys for a universal app) into
  `apps/desktop/prod-resources/tailcat/`, which electron-builder ships as
  `resources/tailcat/<platform-key>/`. Windows packaging rejects a payload without it.
- CLI (`npx t3`): `apps/server/scripts/cli.ts publish` stages every pinned platform key into
  `apps/server/dist/tailcat/<platform-key>/`, matching how the resource monitor ships in the one
  platform-independent npm package. Release CI fetches all keys first (darwin is cross-compiled).

## Upgrading

1. `node scripts/fetch-tailcat.ts --update <version>`. It downloads the new release archives and
   computes their digests, cross-checks them against upstream's `checksums.txt`, resolves the tag's
   commit with `git ls-remote`, reads the Go toolchain line from upstream's `go.mod`, refreshes
   `LICENSE`, rewrites `manifest.json`, and prints a field-by-field summary of what changed.
2. Review the upstream changelog. Tailcat makes no CLI stability promises; check
   `packages/tailcat/src/runtime.ts` for the flags and output T3 relies on (`--json`, `--key`,
   `serve --allow`, `forward <local>:<remote>`, `genkey --client`, `printpub`, `ping`).
3. Bump `TAILCAT_COMPATIBLE_RANGE` in `packages/tailcat/src/manifest.ts` if the major or minor
   changed, then run the opt-in real-binary test:
   `T3CODE_TAILCAT_E2E=1 vp test run packages/tailcat/src/runtime.e2e.test.ts`.
4. `node scripts/fetch-tailcat.ts --all` (or at least `--platform <this machine>`) to restage
   locally. Directories staged from the previous pin fail `--verify` and every packaging step until
   they are refetched.
5. Commit `manifest.json` and `LICENSE`. CI validates the manifest on every pull request and fetches
   the pinned version on every release build; no workflow edits are needed for a version bump.
