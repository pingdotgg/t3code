---
"@effect/ai-openai": patch
"@effect/ai-openai-compat": patch
---

Fix `OpenAiLanguageModel` leaking library-only config fields (`fileIdPrefixes`, `strictJsonSchema`) into request body, causing OpenAI 400 errors.
