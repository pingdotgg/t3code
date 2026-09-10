---
"effect": patch
---

Refine the `ConfigProvider` interface so lookup absence uses `undefined` and
path transformation is provider behavior.

`ConfigProvider.load` and the lookup function accepted by
`ConfigProvider.make` now return `Node | undefined`. Use `undefined` when a path
does not exist and return the `Node` directly when it does.

`ConfigProvider` now exposes `mapInput` as a capability. The exported
`ConfigProvider.mapInput` combinator delegates to it, preserving transformation
order and composition through `orElse` without requiring provider
representation state.
