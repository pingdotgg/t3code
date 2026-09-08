---
"effect": patch
---

Add `Channel.mkUint8Array` and reuse it from `Stream` and multipart file collection. This also fixes quadratic buffering in `File.contentEffect`, improving collection of a 16 MiB chunked upload by approximately 90x.
