---
"effect": patch
---

Fix module-level side effects that defeated bundler tree-shaking.

Bare top-level statements cannot be `#__PURE__`-annotated by the build, so
bundlers must retain them and everything they reference, even in bundles that
never use the code:

- `Option`: the standalone `Object.defineProperty(SomeProto, "valueOrUndefined", ...)`
  statement anchored the whole `Option` proto chain into every bundle. It is
  now folded into the `SomeProto` initializer.
- `Headers`: same pattern with `Object.defineProperties(Proto, ...)`, folded
  into the initializer.
- `Logger`: module-level `process.stdout.isTTY` property reads (potential
  getters, never droppable) moved inside `consolePretty`.
- `Utils`: when `internalCall` was unused, its dropped binding left behind a
  retained initializer tail (`standard`/`forced` probe with computed property
  reads). The selection is now wrapped in a single pure-annotated call.

A minimal `Effect.succeed(123).pipe(Effect.runFork)` bundle shrinks by ~1.3%
gzipped; bundles that don't use `Option` or `Headers` no longer pay for them.
