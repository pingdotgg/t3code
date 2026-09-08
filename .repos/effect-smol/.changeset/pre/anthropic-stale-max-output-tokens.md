---
"@effect/ai-anthropic": patch
---

Correct the maximum output tokens for Claude Opus 4.6, 4.7, 4.8 and Sonnet 4.6.

These models were grouped with the 4.5 family at 64000 output tokens, half of the 128000 the API actually allows, so requests defaulted to a cap far below the model's real limit. The 4.5 models keep 64000, which is correct for them.
