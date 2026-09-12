---
"effect": patch
---

Add `Multipart.isStreamPart` to recognize only a text `Field` or streamed `File`, while preserving `Multipart.isPart` for all branded multipart parts, including `PersistedFile` values.
