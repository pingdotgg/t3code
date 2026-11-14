# conn-support

Small helpers that more than one crate needs. Each exists once, here.

- `time`: the contract's `DateTimeUtc` wire form (`2026-11-13T08:49:41.123Z`): format, and a
  strict RFC 3339 parser.
- `hex`: lowercase hex.
- `base64`: standard base64 with padding, and base64url without padding.
- `hmac`: HMAC-SHA256 and a constant-time compare.
- `fs`: a file write through a temp file and a rename.
- `uuid_v4`: a random v4 id through the `uuid` crate.

Rules: std only (plus `sha2` for the hash, and `uuid` with `getrandom` for ids), no async, no state, no I/O except `fs`. A helper
moves here when a second crate needs it; a crate-specific one stays in its crate.
