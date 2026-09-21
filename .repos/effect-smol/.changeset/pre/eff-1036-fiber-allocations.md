---
"effect": patch
"@effect/opentelemetry": patch
---

Reduce memory usage in Effect primitives and fibers.

Breaking: context-derived `Fiber` fields now live under `fiber.cache`. The
`currentScheduler`, `currentSpan`, `currentLogLevel`, `currentStackFrame`, and
`currentPreventYield` fields are now `scheduler`, `span`, `logLevel`,
`stackFrame`, and `preventYield`. Access `minimumLogLevel` and
`maxOpsBeforeYield` through `cache` as well.
