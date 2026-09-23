---
"effect": patch
---

Fix `Worker.run` hanging uninterruptibly when a worker dies before the ready handshake.
