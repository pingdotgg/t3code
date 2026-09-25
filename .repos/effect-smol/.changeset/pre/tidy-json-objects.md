---
"effect": patch
---

Add `Schema.JsonObject` for readonly string-keyed records containing JSON-compatible values. This provides a canonical,
reusable schema instead of requiring callers to repeatedly compose `Schema.Record(Schema.String, Schema.Json)`.
