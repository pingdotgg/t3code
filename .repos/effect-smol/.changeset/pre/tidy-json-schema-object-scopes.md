---
"effect": patch
---

Preserve JSON Schema object keyword scopes when importing `allOf` intersections, including closed empty objects and required-only keys. Emit intersecting index signatures without weakening their constraints, and reject object scope intersections that cannot be represented faithfully.
