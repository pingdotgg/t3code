---
"effect": patch
---

Use branded interfaces for `Reactivity`, `LanguageModel`, `EmbeddingModel`, and `Chat`. Refer to each service's same-name type instead of `.Service` or `["Service"]`; custom implementations must include `[TypeId]: TypeId`.
