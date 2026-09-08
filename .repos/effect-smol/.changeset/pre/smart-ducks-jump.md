---
"effect": patch
---

Fix `Schedule.andThenResult` to initialize the right schedule only after the left schedule completes.
This removes the extra immediate transition tick and correctly completes when the right schedule is finite.
