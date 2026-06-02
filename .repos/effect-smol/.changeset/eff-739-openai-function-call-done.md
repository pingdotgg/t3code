---
"@effect/ai-openai": patch
---

Handle streamed OpenAI function calls from `response.function_call_arguments.done` so tool calls are emitted even when `response.output_item.done` is missing.
