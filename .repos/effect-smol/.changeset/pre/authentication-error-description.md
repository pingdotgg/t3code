---
"effect": patch
"@effect/ai-anthropic": patch
"@effect/ai-openai": patch
"@effect/ai-openai-compat": patch
"@effect/ai-openrouter": patch
---

Add an optional `description` to `AiError.AuthenticationError`, rendered after the kind-based suggestion, and pass the provider's own error text through it on HTTP 401 and 403, so authentication failures report what actually went wrong instead of only a category.
