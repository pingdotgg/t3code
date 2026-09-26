---
"effect": patch
---

Fix JSON Schema imports:

- Type-specific keywords no longer imply a type. For example, `minLength` validates strings without rejecting
  non-string values.
- Constraints next to `const`, `enum`, and `$ref` are now applied instead of being ignored.
- Disjoint and linear union intersections are imported without a Cartesian expansion. Other overlapping union
  intersections fail with an explicit error.
- References to definitions without unions no longer make otherwise linear intersections fail.
- Imported `oneOf` schemas remain `oneOf` when exported again.
- `minItems` is preserved when `prefixItems` does not fully enforce it.
