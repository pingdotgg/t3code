---
"effect": patch
---

Preserve defined falsy Error causes (`0`, `false`, `""`, `null`, `0n`, and `NaN`) in `Formatter.format` output. Missing and explicitly `undefined` causes remain omitted.
