---
"effect": patch
"@effect/openapi-generator": patch
---

Emit mixed struct and record schema types as intersections, preventing optional
properties in open OpenAPI objects from conflicting with their index signature.
