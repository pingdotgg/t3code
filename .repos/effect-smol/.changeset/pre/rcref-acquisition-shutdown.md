---
"effect": patch
---

Keep `RcRef` closed when an in-flight acquisition finishes after its owning scope has closed. Release the late-acquired resource and interrupt waiting borrowers instead of making the resource available again.
