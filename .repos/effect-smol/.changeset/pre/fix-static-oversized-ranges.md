---
"effect": patch
---

Parse HttpStaticServer byte range integers exactly, including values above Number.MAX_SAFE_INTEGER. Oversized starts now return 416 with Content-Range instead of falling back to 200. Oversized ends clamp to the last byte, and oversized suffixes return the whole file as 206.
