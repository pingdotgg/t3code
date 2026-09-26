---
"effect": patch
---

Fix AI structured output schema generation for `Schema.Class` and `Schema.ErrorClass` by resolving top-level `$ref` entries before passing JSON Schema to providers and default codec transformers.
