---
"effect": patch
---

Preserve content schema identifiers when emitting JSON Schema for `Schema.fromJsonString`.

This keeps user-defined identifiers attached to the decoded JSON payload while giving the generated JSON string wrapper its own derived name, avoiding client codegen outputs where the payload type is renamed behind the transport wrapper.
