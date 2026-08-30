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

The platform adapters deliberately own only platform behavior. React does not participate in
terminal frames.

### Web and desktop

Web owns browser font shaping, the hidden IME textarea, clipboard and DOM input, and its Canvas
renderer. The web adapter also delegates application mouse encoding, word and line selection, and
OSC 8 hyperlink metadata to the official ABI. Browser conventions remain available: holding Shift
bypasses application mouse capture, and the platform link modifier opens hyperlinks.

The web runtime is singleton-scoped per browser tab so split terminals share one compiled module
and memory. Each visible terminal owns and frees its own terminal, render state, row iterator, cell
iterator, key and mouse encoder, and input event handles. Restoring captured scrollback temporarily
detaches the PTY callback so historical device queries cannot emit replies into the current shell.

Each web terminal requests 10,000 physical scrollback lines and independently caps Ghostty's page
storage at 32 MiB. Ghostty prunes complete pages, so the retained row count is approximate and
whichever limit is reached first wins. The explicit byte setting replaces libghostty-vt's low-level
10,000-byte default. WebAssembly cannot use Ghostty's page compression, so the cap is sized for
uncompressed pages and was verified at representative widths up to 320 columns.

### Android

Android owns its Kotlin Canvas and touch integration. Each Android terminal separately requests
10,000 physical scrollback lines and caps Ghostty's page storage at 32 MiB, with the same
page-granularity and first-reached behavior. Compression is supported by the 64-bit Android
libraries but not the 32-bit libraries, and T3 does not schedule it through the C ABI on any Android
architecture. Android therefore uses the deliberate uncompressed cap across all four ABIs instead
of inheriting libghostty-vt's 10,000-byte default.

## Updating Ghostty

Update `native/libghostty-vt/VERSION`, the single source of truth for the upstream pin (the upstream
`LICENSE` lives beside it), and rebuild Android. The Android build script reads that file directly;
it has no fallback revision. Both builders require the Zig version declared in the pinned Ghostty
source.

```sh
ANDROID_NDK_HOME=/path/to/ndk apps/mobile/modules/t3-terminal/scripts/build-libghostty-android.sh
pnpm --dir apps/web build:ghostty-wasm
```

Commit the regenerated Android headers, four shared libraries, and web `wasm` artifacts. The web
build embeds the pinned revision as semver build metadata, and the focused web ABI test reads it
through `ghostty_build_info` and compares it with `VERSION`. There is no second revision pin to keep
in sync. The same web test enforces the artifact budget and exercises repeated create/write/free
cycles with multi-codepoint graphemes.
