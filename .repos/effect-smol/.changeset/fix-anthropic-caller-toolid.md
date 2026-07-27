---
"@effect/ai-anthropic": patch
---

Fix non-streaming Anthropic responses throwing when a tool call carries `caller` metadata. The mapper emitted `caller.toolId: undefined`, but `ProviderMetadata` is `Record(String, NullOr(Json))` and `undefined` is not a valid Json value, so decoding the model's own response threw `Expected JSON value`. Emit `null` instead, matching the streaming mappers.
