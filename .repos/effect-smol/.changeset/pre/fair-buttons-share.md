---
"effect": patch
---

Make `AtomRpc.query` and `AtomHttpApi.query` return serializable atoms by default when query results are schema-backed.

The atom serialization key now uses each API's built-in request schemas so dehydrated state can be keyed consistently across server and client.
