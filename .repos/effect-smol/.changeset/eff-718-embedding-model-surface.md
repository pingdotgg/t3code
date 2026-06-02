---
"effect": patch
"@effect/ai-openai": patch
"@effect/ai-openai-compat": patch
---

Add unstable EmbeddingModel support across core and OpenAI providers.

- Add the unstable EmbeddingModel module API surface in `effect`, including service, request, response, and provider types.
- Implement the unstable EmbeddingModel runtime constructor in `effect`, with `RequestResolver` batching, `embed` / `embedMany` spans, provider error propagation, deterministic ordering, and empty-input `embedMany` fast-path behavior.
- Add and align EmbeddingModel behavior tests in `effect` for embedding usage, batching, ordering, and error handling.
- Add `OpenAiEmbeddingModel` in `@effect/ai-openai`, including model / make / layer constructors, config overrides, and provider output index validation with deterministic reordering.
- Add OpenAI-compatible EmbeddingModel provider support in `@effect/ai-openai-compat`, including config overrides, layer constructors, and output index validation.
