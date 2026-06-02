---
"effect": patch
---

Changed socket close handling so all close codes are treated as errors by default unless `closeCodeIsError` is overridden.
