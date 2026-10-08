# Patched Linux Cua Driver

Linux desktop packages and Linux CLI archives build Cua Driver from trycua/cua
commit `b0968e1b12834e485dda68789541a3cc57664a9f` (`cua-driver-rs-v0.34.0`), applying
`0.34.0.patch`. This is a source patch, not a pnpm dependency patch.

The normal packaging commands invoke `scripts/build-cua-linux.sh`. It builds the
driver, cursor helper, and SDK library together in release mode, with upstream's
`cua-driver/portal-input` feature. Packaging also ships the patched GNOME helper
(API 10) and replaces the SDK npm package's native library. Replacing only the
daemon would leave the embedded host running upstream code.

Linux CLI archives carry their own driver beside the `t3` executable. They use
that bundle before any previously downloaded version and fail if it is
incomplete, rather than silently downloading an unpatched driver. macOS and
Windows keep their upstream native binaries. Source-run development servers
retain the upstream downloader unless `T3CODE_CUA_DRIVER_PATH` selects a custom
driver; the source patch is applied during Linux release packaging.

Build on Linux matching the target architecture (`x64` or `arm64`), with Rustup,
Git, a C/C++ toolchain, pkg-config, and the development packages `libx11-dev`,
`libxi-dev`, `libxtst-dev`, `libxext-dev`, `libwayland-dev`, and `libxkbcommon-dev`.
CI installs these dependencies. The upstream checkout pins its Rust toolchain.

To build just the native bundle from the repository root:

```sh
bash scripts/build-cua-linux.sh "$PWD" x64 /tmp/t3-cua-linux
```

Builds are cached by architecture, source commit, patch, and build script; cached
bundle files are checksum-verified. Desktop and CLI packaging share that cache.
A native build or SDK staging failure stops packaging.

The patch preserves Wayland host opt-in, compositor-attested window capture,
preview downscaling, persistent D-Bus transport, and display-only screenshots
that do not replace agent snapshots or register action captures. It removes
GNOME's changing PNG `Creation Time` chunk without decoding pixels, allowing
static-frame deduplication. D-Bus calls retain owner attestation and reconnect
after failure without replaying mutations.

Build 2757's earlier local validation used debug binaries without `portal-input`.
Normal release packaging uses the optimized build described above.
