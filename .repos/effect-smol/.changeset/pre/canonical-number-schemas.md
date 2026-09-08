---
"effect": patch
"@effect/ai-anthropic": patch
"@effect/ai-openai": patch
"@effect/ai-openai-compat": patch
"@effect/ai-openrouter": patch
"@effect/openapi-generator": patch
---

Add `Schema.Natural` for non-negative safe integers and use canonical `Schema.Int`, `Schema.Finite`, and `Schema.Natural` schemas for numeric domain values across Effect, AI protocols, and OpenAPI patches.

Update the date, date-time, file, time-zone, cluster, event-log, persistence, socket, SQL, and DevTools schemas to reject invalid non-finite or non-integer values where appropriate. Correct the decoded schema of `Schema.NumberFromString`, and allow `Schema.DurationFromMillis` and `Schema.DurationFromNanos` to represent negative durations.
