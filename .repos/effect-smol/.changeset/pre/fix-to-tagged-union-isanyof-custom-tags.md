---
"effect": patch
---

Fix `Schema.toTaggedUnion(...).isAnyOf` narrowing for custom discriminant keys, closes #2386.

Previously, the type predicate always extracted union members by `_tag`, even
when `toTaggedUnion` was created with a different discriminant key. Runtime
behavior already used the supplied key, so this aligns the type-level narrowing
with the existing runtime behavior.
