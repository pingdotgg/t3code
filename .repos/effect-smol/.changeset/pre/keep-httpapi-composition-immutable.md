---
"effect": patch
---

Keep HttpApi composition immutable.

`HttpApi.addHttpApi` applied annotations from the added API by mutating its shared groups. It now creates annotated group copies, keeping the source API and independently annotated variants unchanged while preserving annotation precedence.
