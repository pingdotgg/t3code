---
"effect": patch
---

Fix MCP resource template parameter names resolving as `param0`, `param1` instead of actual names by checking `isParam` on the original schema before `toCodecStringTree` transformation.
