---
"effect": patch
---

Fix `Schedule.fixed` double-executing the effect due to clock jitter.

The `elapsedSincePrevious > window` check included sleep time from the
previous step, so any timer imprecision (e.g. 1001ms for a 1000ms sleep)
triggered an immediate zero-delay re-execution.
