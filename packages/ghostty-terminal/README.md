# Ghostty browser terminal

The browser renderer uses the official `libghostty-vt` C ABI shared with Android.
It owns terminal handles, Canvas rendering, browser input, selection, links, and sizing.

Hosts load the WASM bytes from `@t3tools/ghostty-terminal/assets/*`, pass them to
`loadGhosttyRuntime`, and share the returned runtime across their surfaces. The package
never fetches or caches assets. Pass the symbols font URL to the surface to render prompt
glyphs without a locally installed Nerd Font. Terminal transport stays with the host.

Run `vp run build:ghostty-wasm` in this package to rebuild the WASM closure from the
canonical pin in `native/libghostty-vt/VERSION`; its license is in
`native/libghostty-vt/LICENSE`. Host license bundles include that notice and the symbols
font notice through `third-party-licenses.config.json`. ABI tests compare the embedded
revision with the canonical pin.

React stays out of terminal frames. Preserve the replay protection described in
[terminal runtime](../../docs/internals/terminal-runtime.md).
