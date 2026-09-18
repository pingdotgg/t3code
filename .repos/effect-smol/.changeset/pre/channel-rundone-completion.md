---
"effect": patch
---

Remove `Channel.runDone`; use `Channel.runDrain` to consume all output and return the completion value.
