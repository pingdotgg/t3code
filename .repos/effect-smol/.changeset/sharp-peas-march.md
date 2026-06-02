---
"effect": patch
---

Fix AI tool handler error typing so `LanguageModel.generateText` with a toolkit exposes wrapped `AiError` values rather than leaking raw `AiErrorReason` in the error channel.
