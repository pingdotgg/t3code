---
"effect": patch
---

Honor explicit `timeToLive: 0` and `timeToLive: 0n` in `AtomRpc` and `AtomHttpApi` queries. Zero now opts out of the registry's default idle retention, matching other zero-duration inputs, so an unmounted query can be disposed and fetched again on remount. Omitting `timeToLive` still uses the registry default.
