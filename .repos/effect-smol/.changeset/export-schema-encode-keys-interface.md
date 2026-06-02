---
"effect": patch
---

Export the `Schema.encodeKeys` interface, closes #2070.

Previously the interface was internal, so exporting a value whose inferred type referenced it triggered TypeScript error `TS4023: Exported variable has or is using name 'encodeKeys' from external module ... but cannot be named`, e.g.:
