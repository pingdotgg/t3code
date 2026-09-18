---
"@effect/ai-anthropic": patch
---

Fix non-native structured output generation by always requesting the response tool and excluding accompanying prose when decoding its JSON payload.
