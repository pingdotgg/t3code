---
"@effect/ai-openai": patch
---

Fix OpenAI reasoning stream state handling so out-of-order reasoning summary events do not crash when prior reasoning item state is missing.
