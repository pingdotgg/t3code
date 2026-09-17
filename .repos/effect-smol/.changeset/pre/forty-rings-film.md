---
"@effect/ai-openai": patch
---

Refactor `OpenAiClient` to the handwritten minimal-schema path so `client` now exposes the configured `HttpClient`, `createResponse` / `createResponseStream` / `createEmbedding` use `OpenAiSchema` request-response types, and websocket mode no longer depends on generated-client internals.

Also migrate OpenAI language and embedding model request-response typing to `OpenAiSchema` and make embedding decoding explicitly reject non-vector (string/base64) payloads with `InvalidOutputError`.
