---
"effect": patch
---

Fix `Effect.updateServiceScoped` cleanup when an inner service provider has already completed. Closing the scope now preserves the service's absence instead of failing with a missing-service defect.
