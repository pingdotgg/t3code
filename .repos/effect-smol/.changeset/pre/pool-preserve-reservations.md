---
"effect": patch
---

Keep `Pool.reserve` items out of shared circulation when other borrowers return or overlapping reservations close. Restore available slots only after the last reservation closes.
