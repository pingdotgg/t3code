---
"effect": patch
---

Fix published declarations referencing symbols stripped as `@internal`, which broke consumers compiling with `skipLibCheck: false`. `Effectable.d.ts` now uses the public `Effect.TypeId`, `Match.d.ts` no longer aliases an internal `Contextual` type, `Schema.d.ts` ships the `AnnotationSchemaConstraint` alias it references, and the CLI's `toFlagDoc` helper is marked internal so it no longer leaks `Param.getParamMetadata`.
