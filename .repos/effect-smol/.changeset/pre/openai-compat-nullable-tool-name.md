---
"@effect/ai-openai-compat": patch
---

Fix dropped streamed tool-call arguments when a provider sends `function.name: null` on continuation fragments.

OpenAI-compatible providers such as Fireworks send the tool name only on the first streamed `tool_calls` fragment and `function.name: null` on the continuation fragments that carry the argument deltas. `ChatCompletionToolFunctionDelta.name` was `Schema.optionalKey(Schema.String)` (non-nullable), so chunk validation rejected every continuation and silently discarded its argument delta, leaving the assembled tool call with empty or partial params. `name` is now nullable (`Schema.NullOr(Schema.String)`).
