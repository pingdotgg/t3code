---
"effect": patch
---

Add `JsonPointer.parseUriFragment` and `JsonPointer.formatUriFragment` for converting RFC 6901 URI fragments, and use them to preserve percent-encoded definition names in exported JSON Schema references. JSON Schema compilation now rejects malformed local definition references returned by `toJsonSchema` hooks. Such hooks must percent-encode characters that URI fragments do not permit, for example `%` as `%25` and `#` as `%23`.
