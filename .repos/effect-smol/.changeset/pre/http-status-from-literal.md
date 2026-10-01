---
"effect": patch
---

Add a `HttpStatus` module to `effect/unstable/http` that centralizes the mapping from HTTP status literal names to numeric codes and exports `HttpStatus.fromLiteral`. `HttpApiSchema.status` now consumes the new module.
