---
"effect": patch
---

Skip remote event journal write callbacks when there are no uncommitted entries and return an `Option` indicating
whether the callback ran.
