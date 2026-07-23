---
"effect": patch
---

Fix `Command.withGlobalFlags` type inference when mixing `GlobalFlag.action` and `GlobalFlag.setting`.

`Setting` service identifiers are now correctly removed from command requirements in mixed global flag arrays.
