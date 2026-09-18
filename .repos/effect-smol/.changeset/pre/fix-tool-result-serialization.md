---
"effect": patch
---

Fix tool result serialization to select the codec using `isFailure` and preserve `encodedResult` through `Response.AllParts` round trips.

Add `Tool.failureResultSchema(tool)` and `Tool.ExecutionFailure` to handle user failures, `AiError`, and denied or interrupted calls consistently. Also export `HttpRequestDetails` and `HttpResponseDetails` from `AiError`; the `Response` exports remain available.

### Breaking changes

- Stored results must match the selected schema. With success `Schema.Number` and failure `Schema.NumberFromString`, migrate failed results from `404` to `"404"`.
- `Response.ToolResultPart` returns `Schema.Codec` instead of `Schema.decodeTo`. Update annotations that depend on the old type.
- `Tool.FailureResult` and `Tool.Result`, including their encoded variants, now include `Tool.ExecutionFailure` in both failure modes. Handle it when narrowing failed results.
