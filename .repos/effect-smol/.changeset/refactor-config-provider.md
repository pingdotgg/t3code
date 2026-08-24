---
"effect": patch
---

Fix config path composition and directory-backed lookup behavior.

`ConfigProvider.orElse` now keeps each side's own `nested` and `mapInput`
behavior. Applying `nested` or `mapInput` to a combined provider now applies the
same transformation to both sides.

`ConfigProvider` path transformations now compose as a single path function.
This makes `nested` and `mapInput` behave consistently with normal function
composition.

`Config.nested` now tracks the logical config path in `Config` itself instead of
wrapping the provider. This keeps lookup paths and schema error paths aligned.
The low-level `Config.make` constructor is no longer exported; use config
constructors and combinators, or implement custom lookup behavior with
`ConfigProvider.make`.

`ConfigProvider.fromDir` now returns `undefined` when neither a file nor a
directory exists at the requested path, so `orElse` can fall back instead of
failing with `SourceError`.
