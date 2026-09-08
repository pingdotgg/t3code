---
"effect": minor
---

Make RPC serialization schema-aware.

Add `codecFor` to RPC serialization and client/server protocols so RPC and cluster
network payloads use the transport's schema codec. Framing, cluster storage, and
existing built-in wire formats remain unchanged.
