---
"effect": patch
---

Normalize error behavior for Schema and SchemaParser boundary APIs.

`SchemaError` now extends `Data.TaggedError`, so it is also a native `Error`.
SchemaParser Promise APIs now reject an `Error` whose cause is the
`SchemaIssue.Issue` for schema failures.

Schema and SchemaParser `Effect` and `Exit` adapters now preserve full causes
while mapping schema issue failures to their public error type. The `is`,
`asserts`, `Promise`, `Sync`, `Result`, `Option`, `make`, and `makeOption`
adapters now distinguish schema issues from non-schema causes. Schema-only
failures are converted to the adapter's normal representation (`false`,
rejected or thrown schema error, `Result.fail`, or `None`), while non-schema
causes throw or reject with an `Error` whose cause is the underlying `Cause`.
