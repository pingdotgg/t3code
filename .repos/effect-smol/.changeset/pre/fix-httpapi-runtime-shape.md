---
"effect": patch
---

Fix `HttpApi.make` so it stores the API identifier and starts with an empty `groups` object instead of a `Map`. This makes empty APIs match the shape they have after groups are added.
