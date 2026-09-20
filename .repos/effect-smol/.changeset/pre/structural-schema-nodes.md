---
"effect": patch
---

Expose `SchemaAST` nodes, `SchemaIssue` nodes, `SchemaGetter.Getter`, and the `SchemaTransformation` models through structural instance interfaces instead of concrete class declarations. The constructors remain usable with `new` and `instanceof`, but their `prototype` is no longer part of the public TypeScript API. Replace type-level access through a constructor's `prototype` with the corresponding named instance interface, such as `SchemaGetter.Getter<T, E, R>`.

`SchemaAST.Base` is no longer exported. Use `SchemaAST.AST` when accepting any AST node, and use the `SchemaAST.is*` guards to narrow individual variants.
