---
"@effect/ai-openrouter": patch
---

Regenerate the `Generated` module against OpenRouter's current published specification. This preserves nullable
generation statistics and streamed usage cost metadata while incorporating the broader upstream schema changes.

Notable generated schema renames include `ChatGenerationParams` to `ChatRequest`, `ChatGenerationTokenUsage` to
`ChatUsage`, `AssistantMessage` to `ChatAssistantMessage`, `ChatStreamingResponseChunk` to `ChatStreamingResponse`,
and `ChatMessageContentItemCacheControl` to `ChatContentCacheControl`. Handwritten public aliases such as
`ChatStreamingResponseChunkData`, `ReasoningDetails`, and `FileAnnotation` retain their existing names.
