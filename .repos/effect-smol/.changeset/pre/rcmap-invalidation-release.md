---
"effect": patch
---

Fix `RcMap` and `LayerMap` cleanup after invalidating an actively borrowed entry and reacquiring the same key.
The invalidated resource is released when its last borrower closes, even with infinite idle TTL, without removing
the replacement entry. Old idle timers also leave replacement entries untouched.
