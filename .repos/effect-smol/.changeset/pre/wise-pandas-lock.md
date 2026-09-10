---
"effect": patch
---

Namespace PostgreSQL advisory shard locks by the `SqlRunnerStorage` table prefix.

This changes the advisory-lock protocol. PostgreSQL clusters using advisory locks require a full cluster stop before upgrading; a rolling deploy is unsafe because old and new runners use different lock keys and can both acquire the same shard.
