---
"effect": patch
---

When canonical JSON derivation adds a transformation for a schema without a direct JSON representation, keep source checks and annotations on the source side. This prevents duplicate check execution and ensures generated JSON Schema documents describe only the encoded target, closes #7192.
