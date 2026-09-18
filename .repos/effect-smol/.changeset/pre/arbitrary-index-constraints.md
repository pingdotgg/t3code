---
"effect": patch
---

Fix `Arbitrary.schema` to respect applicable index signatures when generating and shrinking object properties, including fixed fields in `Schema.StructWithRest` and overlapping records.

Combine compatible string, number, and bigint constraints during generation so cases such as a `String` field constrained by a `NonEmptyString` record remain productive at size zero. Other intersections are validated and may exhaust the discard budget.
