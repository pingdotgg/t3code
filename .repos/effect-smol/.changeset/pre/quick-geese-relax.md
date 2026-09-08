---
"effect": patch
---

Fix a regression in `PubSub.shutdown` so shutting down a pubsub interrupts suspended subscribers (including `takeAll`) by ensuring subscriptions are scoped under the pubsub shutdown scope.
