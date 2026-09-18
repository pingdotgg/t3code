---
"effect": patch
---

Rename the built-in `Config` constructors to PascalCase and rename `Config.mapOrFail` to `Config.mapEffect`. `Config.Array` and `Config.Record` now construct configs directly, with overloads for pathless options or a path followed by options, while their specialized schemas and the other built-in schemas are kept internal.

This is a breaking naming cleanup for the Effect 4 release candidate. It makes casing consistently identify typed config constructors, aligns effectful mapping with the rest of the library, and prevents implementation schemas from expanding the public `Config` interface.
