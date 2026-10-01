---
"effect": patch
---

Allow Schema constructor and decoding defaults to fail with `SchemaError`.

The `Effect` passed to `Schema.withConstructorDefault`, `Schema.withDecodingDefault`, `Schema.withDecodingDefaultKey`, `Schema.withDecodingDefaultType`, and `Schema.withDecodingDefaultTypeKey` now accepts `SchemaError` in its error channel. When a default fails, the parser unwraps the underlying `SchemaIssue.Issue` and propagates it as a parse failure with the surrounding path attached. This makes it easy to use another schema's `makeEffect` / `decode*` as the default value.
