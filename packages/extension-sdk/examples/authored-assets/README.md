# Authored package asset example

This extension declares a WebAssembly asset through `defineExtension`'s
`assets` field. `t3-extension build` copies `assets/value.wasm` into the
package, computes its `byteLength`/`sha256`, and emits a format-4
`t3-extension.json`; `t3-extension check` re-verifies the digests. At install
and on every `host.readAsset` call the runtime re-verifies the declared hash,
so a corrupted asset fails loudly instead of executing.

Unlike `installable-package-assets`, which ships a hand-written manifest, this
example uses only the supported authoring API — the hashes are generated, not
declared. Build it like any authored extension: copy this directory into a
project that depends on `@t3tools/extension-sdk`, then `npm run build` and
`npm run check`. The built `.t3-extension` directory installs through the
normal package path; the view's Load package asset button returns 42.
