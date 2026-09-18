---
"effect": patch
---

The default scheduler falls back to a microtask when setting a timer throws. Cloudflare Workers disallow timers in global scope, so an effect that yielded while running at module load failed with "Disallowed operation called within global scope".
