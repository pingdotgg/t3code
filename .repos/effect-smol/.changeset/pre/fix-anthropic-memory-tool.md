---
"@effect/ai-anthropic": patch
---

Fix client-executed provider tools (Memory, Text Editor, Computer Use, Bash) which were unusable on the wire.

- `makeResponse` (and the streaming equivalents) now map a provider `tool_use` wire name (e.g. `"memory"`) back to the tool's custom name (e.g. `"AnthropicMemory"`) that the toolkit is keyed by, instead of raising `ToolNotFoundError`.
- `AnthropicTool.MemoryCreateCommand` now includes the required `file_text` field, so a `create` command no longer drops the file body.
- Optional parameters on client-executed provider tools now use `Schema.optionalKey` instead of `Schema.optional`, which the Anthropic codec rejected with "Unsupported AST Undefined": `Memory`/`TextEditor` `view_range`, `ComputerUse` `coordinate`, and `Bash` `restart`.

Closes #2615.
