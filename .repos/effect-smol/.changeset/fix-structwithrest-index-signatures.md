---
"effect": patch
"@effect/ai-openai": patch
---

Validate `Schema.StructWithRest` fixed fields against rest index signatures at the type level so schemas cannot be constructed with incompatible decoded, encoded, or make shapes. This keeps `StructWithRest` types sound and updates the generated OpenAI conversation-items request schema to keep accepting arbitrary additional fields under the stricter validation.
