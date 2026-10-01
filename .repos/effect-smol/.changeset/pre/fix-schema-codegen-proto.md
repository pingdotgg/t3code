---
"effect": patch
---

Fix `SchemaRepresentation.toCodeDocument` dropping Struct fields named `__proto__` from generated schemas. These fields now use computed keys, such as `Schema.Struct({ ["__proto__"]: Schema.String })`, so the generated schema validates them correctly.
