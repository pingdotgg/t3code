---
"effect": patch
---

Use `URL.canParse` to validate URL string schema decoding before constructing a `URL`. This avoids relying on thrown exceptions for routine validation while preserving the same invalid URL issue and successful decode output.
