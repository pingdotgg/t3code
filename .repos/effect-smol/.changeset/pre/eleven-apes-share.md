---
"@effect/ai-openai": patch
---

Add a new `OpenAiClientGenerated` module that exposes the generated OpenAI client as a dedicated context service with `make`, `layer`, and `layerConfig` constructors. This provides a compatibility path for direct generated-client access while preserving existing auth, base URL, header, and `OpenAiConfig.transformClient` wiring.
