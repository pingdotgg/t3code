---
"effect": patch
"@effect/platform-node-shared": patch
---

Keep Node and Bun file stats usable when optional numeric metadata exceeds the safe integer range by returning `Option.none()` for those fields.
