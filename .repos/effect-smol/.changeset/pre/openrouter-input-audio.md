---
"@effect/ai-openrouter": patch
---

Convert audio file parts in prompts into OpenRouter `input_audio` content blocks.

Previously, every non-image file part was converted into a generic `file` content block. OpenRouter only accepts audio as base64-encoded `input_audio` content parts, so audio attachments were rejected or mishandled by the upstream provider.

Audio file parts with a recognized `mediaType` (aac, aiff, flac, m4a, mp3, ogg, pcm16, pcm24, and wav) are now converted into `input_audio` blocks. Unsupported audio media types and `URL` audio data fail with an `AiError` since OpenRouter requires base64-encoded audio data and does not fetch audio URLs.
