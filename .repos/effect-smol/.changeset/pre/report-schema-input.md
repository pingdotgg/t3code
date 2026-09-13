---
"effect": patch
---

Add the opt-in `reportInput` parse option for retaining rejected inputs in enumerable fields on value-bearing schema issues and including them in default formatted messages. Value-bearing issue constructors accept the rejected input and parse options directly, and `Schema.Annotations.Issue` now supports `expected` for default messages.

Schema issues no longer format implicitly through `Issue#toString`. Use `SchemaIssue.makeFormatterDefault()` when a human-readable message is needed. The throwing and Promise-based adapters in `SchemaParser` now use the generic message `"Schema validation failed"` and expose the structured `SchemaIssue.Issue` as the error `cause`; consumers that previously read the formatted error message should inspect and explicitly format that cause instead.

`Schema.makeEffect` now returns `SchemaIssue.Issue` failures instead of wrapping them in `SchemaError`, and `Schema.withConstructorDefault` accepts an `Effect` that fails with `SchemaIssue.Issue`. Fallible `Optic` operations return structured `SchemaIssue.Issue` failures, while schema failures from `Schema.toIso` and `Schema.toDifferJsonPatch` use the generic error message and preserve the issue in `cause` instead of formatting it internally.
