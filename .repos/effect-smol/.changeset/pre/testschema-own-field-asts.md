---
"effect": patch
---

Fix `TestSchema.Asserts.ast.fields.equals` to compare ASTs for all own struct fields, including symbol and non-enumerable keys. Equivalent field schemas now compare equally regardless of schema instance identity, while differing ASTs and distinct symbol keys remain unequal.
