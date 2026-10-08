# Linux Cua Driver test build

`0.34.0.patch` contains the native changes used by the Linux PiP test installer
`0.0.46-preview.20261007.2757`. It applies to trycua/cua commit
`b0968e1b12834e485dda68789541a3cc57664a9f` (`cua-driver-rs-v0.34.0`).
This is a source patch, not a pnpm dependency patch. Standard T3 builds still use
upstream release binaries; this file does not silently replace those binaries.

The patch includes the Wayland host opt-in, exact-window GNOME capture and
preview downscaling (helper API 10), persistent D-Bus transport, and an opt-in
`display_only` screenshot path that does not register action captures or replace
agent snapshots. T3 discovers the Linux extension through the daemon tool schema;
older drivers and other platforms retain the typed screenshot path. Static-frame
deduplication and polling backoff apply on every platform. GNOME preview PNGs
omit the changing `Creation Time` text chunk so identical pixels produce
identical bytes without decoding and re-encoding the image. It retains
owner attestation on each call and reconnects after failed calls without
replaying mutations. The transport has a separate runtime because synchronous
helper callers can already be inside Tokio.

To reproduce the native binaries in a separate checkout:

```sh
git clone https://github.com/trycua/cua.git cua-linux-preview
cd cua-linux-preview
git checkout b0968e1b12834e485dda68789541a3cc57664a9f
git apply /absolute/path/to/t3code/patches/cua-driver-linux/0.34.0.patch
cd libs/cua-driver/rust
cargo test -p platform-linux wayland::shell_helper --lib
cargo test -p platform-linux display_only_refuses --lib
cargo build --locked -p cua-driver -p cua-driver-sdk
```

The test installer uses `target/debug/cua-driver` and
`target/debug/libcua_driver_sdk.so`, plus the patched files in
`libs/cua-driver/wayland-helper/winrects@cua`. Both the desktop driver bundle and
the SDK npm package's native library must use the matching build. Do not replace
files inside a running T3 installation. This debug build does not enable the
optional `portal-input` feature; GNOME fallback mouse/keyboard injection remains
unavailable, although supported accessibility actions and window capture work.
