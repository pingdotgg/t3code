---
"effect": patch
---

PubSub.publish and PubSub.publishAll now return false on shutdown instead of interrupting, matching Queue.offer semantics.
