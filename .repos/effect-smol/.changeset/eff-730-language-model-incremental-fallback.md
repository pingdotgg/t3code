---
"effect": patch
---

Fix `LanguageModel` incremental prompt fallback to reliably retry with the full prompt when an incremental request fails with `InvalidRequestError`.
