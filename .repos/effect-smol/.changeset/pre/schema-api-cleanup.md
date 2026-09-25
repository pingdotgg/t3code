---
"effect": patch
---

Move the built-in schema revivers from `Schema` to `SchemaRepresentation`.
Rename the reviver constructors to `makeReviverDeclaration`,
`makeReviverFilter`, and `makeReviverFilterGroup`.

Change `Schema.toEncoderXml` to fail with `SchemaIssue.Issue` directly instead
of wrapping failures in `SchemaError`. Consumers that read `error.issue` should
now use the error value itself.
