---
"effect": patch
---

Use generic ordered constraints for schema arbitrary derivation.

Range checks such as `isGreaterThan`, `isLessThan`, and `isBetween` now populate `ctx.constraints.ordered`
instead of type-specific range fields on `number`, `date`, or `bigint` constraints. Custom `toArbitrary`
annotations that read range constraints should migrate to `ctx.constraints.ordered`.

This also fixes BigDecimal arbitrary generation by adapting decimal bounds to the generated scale, avoiding
invalid fast-check bigint ranges for narrow decimal intervals.
