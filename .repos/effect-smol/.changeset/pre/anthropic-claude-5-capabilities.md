---
"@effect/ai-anthropic": patch
---

Default new Anthropic models to modern capabilities while preserving the limits of legacy Claude models.

Unknown models now default to native structured outputs and 128K output tokens, so future model releases do not require capability-table updates. Use the new `structuredOutputs` model config option to override capability detection when needed.
