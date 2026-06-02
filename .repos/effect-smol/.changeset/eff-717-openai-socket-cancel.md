---
"@effect/ai-openai": patch
---

Ensure OpenAiSocket sends a `{"type":"response.cancel"}` websocket event when a response stream is interrupted.
