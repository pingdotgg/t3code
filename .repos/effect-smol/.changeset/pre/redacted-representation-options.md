---
"effect": patch
---

Preserve `Schema.Redacted` options when roundtripping through schema representations.
This keeps `label` validation and `disallowJsonEncode` behavior intact when
schemas are revived from a representation or emitted through code generation.
