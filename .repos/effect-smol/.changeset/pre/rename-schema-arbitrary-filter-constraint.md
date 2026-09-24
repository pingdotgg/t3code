---
"effect": patch
---

Rename `Schema.Annotations.ToArbitrary.Constraint` to `Schema.Annotations.ToArbitrary.FilterConstraint`.

Code that refers to the previous type name should update its type annotations to use `FilterConstraint`.
