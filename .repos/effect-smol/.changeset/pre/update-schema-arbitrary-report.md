---
"effect": patch
---

Update Schema arbitrary derivation to use the new filter metadata, candidate generation, optional derivation reports, recursion-aware generation, and the renamed `OrderedConstraint<T>` model.

Migration from the previous v4 API:

- Replace filter annotations from `toArbitraryConstraint: constraint` to `arbitrary: { constraint }`. When a filter cannot be described as a constraint, use `arbitrary: { candidate }` to add a weighted source that is still checked by the filter.
- Replace bucketed constraints with the flat `Schema.Annotations.ToArbitrary.Constraint` shape:
  - `string.minLength`, `array.minLength`, object property counts, collection sizes -> `minLength`
  - `string.maxLength`, `array.maxLength`, object property counts, collection sizes -> `maxLength`
  - `string.patterns` -> `patterns`
  - `number.isInteger` -> `integer`
  - `number.noNaN` -> `noNaN`
  - `number.noDefaultInfinity` -> `noInfinity`
  - `date.noInvalidDate` -> `valid`
  - `array.comparator` for uniqueness -> `unique` using Effect equality
  - `ordered.min` / `minExcluded` / `max` / `maxExcluded` -> `ordered.minimum` / `exclusiveMinimum` / `maximum` / `exclusiveMaximum`
- In arbitrary hooks, read `context.constraint` instead of `context.constraints`. Replace `context.isSuspend` with `context.recursion`; when combining finite and recursive branches, pass `context.recursion` to `fc.oneof` with the finite branch first.
- Generic declaration hooks now receive type parameters as `{ arbitrary, terminal }`. Atomic declarations may still return a bare `FastCheck.Arbitrary<T>`, but generic declarations should return `{ arbitrary, terminal }` when they can preserve a finite terminal branch.
- `Schema.toArbitrary(schema, { report: true })` now returns `{ value, report }`; without `{ report: true }`, it keeps returning the arbitrary directly. `Schema.toArbitraryLazy` always returns a lazy arbitrary.
