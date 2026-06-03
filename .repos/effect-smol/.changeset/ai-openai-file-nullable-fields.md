---
"@effect/ai-openai": patch
---

Fix `OpenAIFile` schema decode failure on responses where `expires_at` and `status_details` are returned as literal `null`. The OpenAI files endpoint returns `null` (not omitted) for these fields when no expiration / status detail applies (e.g. uploads with `purpose: "user_data"`), but the upstream OpenAPI spec marks them only as optional. Codegen patches widen both fields to allow `null`, which now decodes cleanly via `OpenAiClient.createFile`, `retrieveFile`, `listFiles`, and any other endpoint returning the `OpenAIFile` shape.
