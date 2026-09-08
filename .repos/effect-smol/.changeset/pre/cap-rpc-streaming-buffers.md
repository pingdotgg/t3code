---
"effect": patch
---

Cap incomplete RPC frames buffered by the NDJSON and MessagePack streaming decoders, and close socket transports when the limit is exceeded.
