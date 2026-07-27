---
"effect": patch
"@effect/platform-node": patch
"@effect/platform-bun": patch
---

unstable/cluster: hash over-length SQL message deduplication keys to prevent `message_id` overflow, closes #6317.

The composed request deduplication key (`entityType/entityId/tag/primaryKey`) can legally exceed the 255-character `message_id` column — the address columns alone allow 458 characters before the RPC primary key is appended. `SqlMessageStorage` now stores a SHA-256 digest (64 hex characters) of the composed key in the unique `message_id` column when the key exceeds 255 characters, so keys of any length work on PostgreSQL, MySQL, MSSQL, and SQLite. Keys that fit are stored as plaintext, byte-compatible with rows written by previous versions, so existing deployments keep deduplicating with no migration or schema change.

`SqlMessageStorage.layer`/`layerWith` (and consequently `SingleRunner.layer`) now require `Crypto.Crypto`. The Node and Bun cluster convenience layers provide the platform Crypto implementation internally, so their requirements are unchanged.
