---
"@effect/platform-bun": patch
"@effect/platform-deno": patch
"@effect/platform-node": patch
"effect": patch
---

Remove the MessagePack encoding and RPC serialization APIs together with the `msgpackr` dependency. Event-log persistence and remote messages now use SchemaBinary, and cluster transports use SchemaBinary unless NDJSON is selected explicitly.
