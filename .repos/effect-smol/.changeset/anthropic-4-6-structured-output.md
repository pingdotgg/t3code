---
"@effect/ai-anthropic": patch
---

Mark the Claude 4-6 generation as supporting native structured output in `getModelCapabilities`. `claude-opus-4-6` and `claude-sonnet-4-6` support Anthropic's constrained-decoding structured output (verified against the live API), but were classified as `supportsStructuredOutput: false`, so `generateObject` fell back to a forced JSON tool instead of requesting `output_config.format` (`json_schema`). `claude-opus-4-7` / `claude-opus-4-8` are classified the same way for when the generated `Model` enum picks them up.
