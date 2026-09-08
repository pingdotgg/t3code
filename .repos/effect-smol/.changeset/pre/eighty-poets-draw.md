---
"effect": patch
"@effect/ai-anthropic": patch
"@effect/ai-openai": patch
"@effect/ai-openai-compat": patch
"@effect/ai-openrouter": patch
---

Add dedicated AiError metadata interfaces per reason so provider packages can safely augment metadata without conflicting module declarations.
