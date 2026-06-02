---
"effect": patch
---

Add `Scheduler.PreventSchedulerYield` and expose it via `References` so fibers can skip scheduler `shouldYield` checks when needed.
