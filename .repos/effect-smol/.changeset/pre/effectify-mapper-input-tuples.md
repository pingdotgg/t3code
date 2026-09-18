---
"effect": patch
---

Fix the `onError` and `onSyncError` argument tuple types in `Effect.effectify` to include only caller inputs, excluding the synthesized callback. Mapper annotations that expected a callback slot must use the caller-input tuple instead. Runtime behavior is unchanged.
