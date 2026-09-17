---
"effect": patch
---

Reuse HttpApi response schemas.

`HttpApiBuilder` looked up cached response schemas by their source AST but stored them by the transformed AST, so the cache normally missed. It now uses the source AST consistently.
