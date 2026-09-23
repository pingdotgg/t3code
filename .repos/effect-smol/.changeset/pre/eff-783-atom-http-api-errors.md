---
"effect": patch
---

Fix `AtomHttpApi` query and mutation error inference to include endpoint middleware and client middleware errors, matching `HttpApiClient` behavior (including response-only mutation mode).
