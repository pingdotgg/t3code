---
"effect": patch
---

Fix `Schema` encoding so container-level checks are validated against the decoded value instead of the encoded output.

Disallow adding checks directly to `Schema.suspend(...)`; add the checks to the suspended schema instead.

Fix `StructWithRest` so index signatures do not re-parse or overwrite fixed properties.
