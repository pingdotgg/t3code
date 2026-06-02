---
"effect": patch
---

Rename `Schema.makeUnsafe` instance method back to `Schema.make` on all schemas and schema-backed classes.

Also remove the `static readonly make` override from `ShardId` to avoid conflicting with the inherited schema `make` method. The module-level `ShardId.make(group, id)` function is still available.
