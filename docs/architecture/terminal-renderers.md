# Terminal renderers

Terminal sessions remain server-owned PTYs. Clients receive the existing raw byte stream and send
input and resize events over the existing terminal contracts; renderer choices never cross the
wire.

## Ghostty alignment

Android and web use the official `libghostty-vt` C ABI for parsing, terminal state, grapheme
boundaries, keyboard encoding, selection, and scrollback:

- Android links the native shared library and converts render state into a compact JNI snapshot.
- Web loads a separately cached WebAssembly build and reads render state into a Canvas 2D surface.
- Both artifacts are built from the revision in
  `native/libghostty-vt/VERSION`.

The platform adapters deliberately own only platform behavior. Android owns its Kotlin Canvas and
touch integration. Web owns browser font shaping, the hidden IME textarea, clipboard and DOM input,
and its Canvas renderer. The web adapter also delegates application mouse encoding, word and line
selection, and OSC 8 hyperlink metadata to the official ABI. Browser conventions remain available:
holding Shift bypasses application mouse capture, and the platform link modifier opens hyperlinks.
React does not participate in terminal frames.

The web runtime is singleton-scoped per browser tab so split terminals share one compiled module
and memory. Each visible terminal owns and frees its own terminal, render state, row iterator, cell
iterator, key and mouse encoder, and input event handles. Restoring captured scrollback temporarily
detaches the PTY callback so historical device queries cannot emit replies into the current shell.

Both C ABI adapters request 10,000 physical scrollback lines and independently cap Ghostty's page
storage at 32 MiB per terminal. Ghostty prunes complete pages, so the retained row count is an
approximation, and whichever limit is reached first wins. The explicit byte setting is required:
libghostty-vt's low-level default is only 10,000 bytes.

The 32 MiB cap is deliberate for the embedded builds. WebAssembly cannot use Ghostty's page
compression. Compression is supported by the 64-bit Android libraries but not the 32-bit libraries,
and T3 does not schedule compression through the C ABI on any Android architecture. The cap is
therefore sized for uncompressed storage: measurements with the pinned build reached the line limit
through representative widths up to 320 columns while leaving a fixed per-surface safety bound.

## Updating Ghostty

Update `native/libghostty-vt/VERSION`, the single source of truth for the upstream pin (the upstream
`LICENSE` lives beside it), and rebuild Android. The Android build script reads that file directly;
it has no fallback revision. Both builders require the Zig version declared in the pinned Ghostty
source and build from temporary detached worktrees, so local changes in a cached checkout cannot
enter the artifacts.

```sh
ANDROID_NDK_HOME=/path/to/ndk apps/mobile/modules/t3-terminal/scripts/build-libghostty-android.sh
pnpm --dir apps/web build:ghostty-wasm
```

Commit the regenerated Android headers, four shared libraries, and web `wasm` artifacts. Both builds
embed the pinned revision as semver build metadata. The Android build rejects an artifact missing the
canonical revision, while the focused web ABI test reads it through `ghostty_build_info` and compares
it with `VERSION`. There is no second revision pin to keep in sync. The same web test enforces the
artifact budget and exercises repeated create/write/free cycles with multi-codepoint graphemes.
