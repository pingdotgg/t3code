---
"effect": patch
---

Fix `HttpRunner` HTTP and WebSocket client URLs adding an extra leading slash to slash-prefixed paths. Insert the address/path separator only when it is missing, preserving intentional leading and interior slashes.

This path correction is normally masked by router normalization, but prevents route misses for non-root paths when duplicate-slash normalization is disabled. Applications that compensate for the extra slash may need to remove that compensation. Router defaults and shared trailing-slash handling are unchanged.
