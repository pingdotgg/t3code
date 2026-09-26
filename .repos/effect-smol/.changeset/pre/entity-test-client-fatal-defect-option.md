---
"effect": patch
---

Honor the entity layer's `disableFatalDefects` option in `Entity.makeTestClient`. When enabled, a handler defect no longer fails other pending calls to the same entity ID. The failing call still reports its defect; omitted or false options retain fatal-defect behavior.
