---
"effect": patch
---

Remove the experimental `SchemaUtils` module and its `getNativeClassSchema` helper. The helper duplicated a composition already available through the primary Schema APIs and did not justify a separate public module.
