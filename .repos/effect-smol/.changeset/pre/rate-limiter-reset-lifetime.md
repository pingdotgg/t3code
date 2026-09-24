---
"effect": patch
---

Report the exact remaining store lifetime in `RateLimiter` fixed-window `resetAfter` metadata when `onExceeded` is `"delay"`, instead of rounding up to a whole window. Admission, returned delays, and remaining-token counts are unchanged.
