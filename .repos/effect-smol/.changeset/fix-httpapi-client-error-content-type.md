---
"effect": patch
---

Fix HttpApi client error decoding.

Generated clients previously combined every error schema for a status into one union decoder. When schemas used different encodings, their declaration order could determine the decoded error instead of the response `Content-Type`; for example, a text decoder could accept a JSON response before the JSON decoder was tried.

Error responses are now grouped and selected by normalized content type, matching buffered success responses. Normalization happens before grouping, so declarations that differ only by casing or parameters such as `charset` share one union decoder instead of making later schemas unreachable.

No-content schemas are represented by a headerless alternative, allowing empty error responses without a `Content-Type` header to decode correctly. Unsupported content types preserve the existing combination of `StatusCodeError` and the response decoding failure.
