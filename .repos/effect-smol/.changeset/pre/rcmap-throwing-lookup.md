---
"effect": patch
---

Fix `RcMap` entries getting stuck when the lookup function throws synchronously. Later borrowers now receive the defect, and unused entries are released according to their idle TTL instead of permanently consuming capacity.
