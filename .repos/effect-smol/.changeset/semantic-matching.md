---
"effect": patch
---

Use semantic matching for TemplateLiteral parsing and index signature keys

Replace regex-based TemplateLiteral parsing with backtracking segmentation over
template literal parts, applying part checks during matching.

Use schema membership when selecting Record index signature keys, including
checked string, number, symbol, and TemplateLiteral parameters. Tighten valid
index signature parameters on both type and encoded sides, and preserve key
parameter semantics in codec transformations.
