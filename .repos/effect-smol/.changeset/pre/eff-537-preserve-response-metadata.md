---
"effect": patch
---

Preserve provider metadata when converting AI response parts into prompts. OpenAI chats using `store: true` now reuse restored item IDs as item references, while conversation-mode chats omit items already present in the conversation instead of inlining them.
