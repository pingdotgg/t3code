---
"@effect/openapi-generator": patch
---

Fix generated schema declaration ordering when non-recursive schemas reference recursive schemas, preventing TypeScript use-before-declaration errors in generated clients and HttpApi modules.
