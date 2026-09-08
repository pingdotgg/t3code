---
"@effect/sql-pg": patch
---

Add low-level PostgreSQL protocol, binary type, and authentication codecs to `@effect/sql-pg`.

`PgProtocol` encodes protocol 3.0 messages and incrementally parses backend frames. Its stateful parser throws terminal errors. `PgTypes` handles binary scalar and one-dimensional array OIDs; its public codecs return typed `Result` failures, while parser field readers use an internal throwing fast path. `PgAuth` implements MD5 and SCRAM-SHA-256 with typed `Result` failures.

Encoded frames and decoded byte fields are stable views over internal buffers. Copy data that must outlive its message. `PgClient` remains unchanged and still uses `pg` at runtime.
