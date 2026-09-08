---
"effect": patch
---

Fix three issues in the public `Optic` API:

- Composed `Iso` and `Prism` setters no longer try to read a source value before writing.
- Calling `notUndefined` on an `Optional` now returns an `Optional`, because writing can still fail.
- The internal `node` property is no longer exposed by public optic types.
