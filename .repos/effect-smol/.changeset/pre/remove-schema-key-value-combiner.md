---
"effect": patch
---

Remove the `keyValueCombiner` option from `Schema.Record` and the corresponding
`SchemaAST.KeyValueCombiner` and `SchemaAST.IndexSignature.merge` APIs.
For transformed key collisions, sequential parsing keeps the later selected
value, while concurrent parsing keeps the value applied last in completion
order.
