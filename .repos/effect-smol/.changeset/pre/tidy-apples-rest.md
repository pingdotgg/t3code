---
"effect": patch
---

Round Redis persistence TTLs up to whole milliseconds before passing them to integer-only expiration commands.
