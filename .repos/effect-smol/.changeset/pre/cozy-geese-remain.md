---
"effect": patch
---

Fix scoped reentrant lock finalizers releasing under the wrong fiber owner.
