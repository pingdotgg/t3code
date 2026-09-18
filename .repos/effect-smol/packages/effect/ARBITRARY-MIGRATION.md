# Migrating to Native Arbitrary

This guide covers migration from the fast-check bridge published in `effect@4.0.0-rc.109` to the native,
Schema-first module at `effect/unstable/arbitrary`.

The new module removes fast-check from the `effect` package. Applications may still install and use fast-check
directly, but Effect Schema generation and `@effect/vitest` property tests no longer depend on it.

For the new API and its semantics, see [Arbitrary in Effect](ARBITRARY.md).

## Import Changes

The following APIs have been removed:

- `effect/testing/FastCheck`;
- `Schema.toArbitrary`;
- `Schema.Arbitrary`;
- the legacy `Schema.Annotations.ToArbitrary` contract and declaration-level `toArbitrary` annotation;
- the legacy `arbitrary` filter annotation;
- raw fast-check arbitrary inputs and `fastCheck` options in `@effect/vitest`.

Import the native module explicitly:

```ts
import { Arbitrary } from "effect/unstable/arbitrary"
```

If other tests still use fast-check-specific APIs, add fast-check as a direct development dependency and import it
from `"fast-check"`. Do not import it through Effect.

## Generating Samples

Previously, `Schema.toArbitrary` returned a factory that needed the fast-check module:

```ts
import { Schema } from "effect"
import { FastCheck } from "effect/testing"

const Person = Schema.Struct({
  name: Schema.String,
  age: Schema.Int
})

const personArbitrary = Schema.toArbitrary(Person)(FastCheck)
const samples = FastCheck.sample(personArbitrary, { numRuns: 20, seed: 42 })
```

Now derive and sample through the Effect-native module:

```ts
import { Effect, Schema } from "effect"
import { Arbitrary } from "effect/unstable/arbitrary"

const Person = Schema.Struct({
  name: Schema.String,
  age: Schema.Int
})

const personArbitrary = Arbitrary.schema(Person)
const samples = await Effect.runPromise(
  Arbitrary.sampleEffect(personArbitrary, { count: 20, seed: 42 })
)
```

`Arbitrary.sampleEffect` returns an `Effect` because sampling is interruptible, uses Effect `Random` when no seed is
provided, and reports bounded generation exhaustion as a typed `SampleError`.

The generated values still use the decoded Schema `Type`. The sequence and distribution are not compatible with
fast-check, even when the same numeric seed is used.

## Checking Properties

Previously, fast-check owned both the property and the runner:

```ts
import { Schema } from "effect"
import { FastCheck } from "effect/testing"

const integer = Schema.toArbitrary(Schema.Int)(FastCheck)

FastCheck.assert(
  FastCheck.property(integer, (value) => Number.isInteger(value)),
  { numRuns: 100, seed: 42 }
)
```

Now `Arbitrary.checkEffect` runs a pure or Effectful property and returns a structured result:

```ts
import { Effect, Schema } from "effect"
import { Arbitrary } from "effect/unstable/arbitrary"

const result = await Effect.runPromise(
  Arbitrary.checkEffect(
    Arbitrary.schema(Schema.Int),
    (value) => Number.isInteger(value),
    { runs: 100, seed: 42 }
  )
)
```

Unlike `FastCheck.assert`, `Arbitrary.checkEffect` does not throw for an ordinary falsification. Handle `Passed`,
`Falsified`, `Exhausted`, and `ReplayMismatch` explicitly, or use `@effect/vitest`, which converts non-passing results
into test failures.

Typed failures from Effectful properties are preserved in `Falsified.failure`. Defects and interruption continue
through the returned Effect.

## Option Mapping

The most common options map as follows:

| Previous fast-check option | Native option        | Migration note                                                     |
| -------------------------- | -------------------- | ------------------------------------------------------------------ |
| `numRuns`                  | `count` or `runs`    | Use `count` for `sampleEffect` and `runs` for `checkEffect`.       |
| `seed`                     | `seed`               | The type is compatible, but generated sequences are not.           |
| `path`                     | `replay`             | Existing fast-check paths cannot be converted.                     |
| `maxSkipsPerRun`           | `maxDiscards`        | Native uses one absolute discard budget, not a multiplier per run. |
| `examples`                 | No direct equivalent | Keep explicit regression cases as ordinary tests.                  |
| `endOnFailure`             | `maxShrinks`         | Use `maxShrinks: 0` to stop at the initial failure.                |
| `interruptAfterTimeLimit`  | Effect interruption  | Apply an Effect or test timeout around the check.                  |
| `skipAllAfterTimeLimit`    | No direct equivalent | Prefer explicit run and discard bounds.                            |
| `verbose`                  | No direct equivalent | Inspect `CheckResult` or use `@effect/vitest` failure output.      |

Review any less common fast-check runner option manually. The native API deliberately does not reproduce the complete
`fc.Parameters` surface.

## Replay Migration

Fast-check replay used a seed plus a shrink `path`. Native replay uses one opaque token returned by a `Falsified`
result:

```ts
const replayed = Arbitrary.checkEffect(arbitrary, property, {
  replay: previousFailure.replay
})
```

There is no conversion from a fast-check seed and path to a native replay token. Re-run the property with the native
engine, then record the new token from its `Falsified` result.

Replay tokens are intended for reproducing and diagnosing a current failure. Because the module is unstable, they are
not guaranteed to survive upgrades. Preserve important failing inputs as explicit regression tests.

## Migrating Declaration Annotations

The old `toArbitrary` annotation directly constructed a fast-check arbitrary and exposed fast-check recursion and
constraint details:

```ts
import { Schema } from "effect"

class UserId {
  readonly value: number
  constructor(value: number) {
    this.value = value
  }
}

const UserIdSchema = Schema.instanceOf(UserId, {
  toArbitrary: () => (fc) => fc.integer({ min: 1, max: 1_000_000 }).map((value) => new UserId(value))
})
```

The native `toCodecArbitrary` annotation describes a generatable representation as a Schema `Link`:

```ts
import { Schema, SchemaTransformation } from "effect"

class UserId {
  readonly value: number
  constructor(value: number) {
    this.value = value
  }
}

const UserIdSchema = Schema.instanceOf(UserId, {
  toCodecArbitrary: () =>
    Schema.link<UserId>()(
      Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1_000_000 })),
      SchemaTransformation.transform({
        decode: (value) => new UserId(value),
        encode: (id) => id.value
      })
    )
})
```

Before adding `toCodecArbitrary`, check whether the declaration already has a useful `toCodecJson` or `toCodec`.
Native derivation falls back to those canonical codecs automatically. Add an arbitrary-specific Link only when the
canonical representation is opaque or generates valid values too rarely.

The migration changes where generation logic lives:

| Legacy contract                                | Native contract                                                |
| ---------------------------------------------- | -------------------------------------------------------------- |
| Returns a `fast-check.Arbitrary`               | Returns a `SchemaAST.Link` through `Schema.link`.              |
| Receives generated arbitrary type parameters   | Receives decoded Schema type parameters.                       |
| Receives fast-check constraints and recursion  | Receives normalized constraints.                               |
| Manages terminal recursive branches explicitly | Leaves recursion analysis and budgets to the native compiler.  |
| Uses arbitrary combinators                     | Uses Schema constructors, checks, and a Schema transformation. |

The original declaration remains authoritative. Values decoded by the Link are checked against it. Failed decodes and
rejected values become bounded discards.

### Custom Filter Metadata

The old `arbitrary` filter annotation has been replaced by `arbitraryConstraint`. Ordinary custom filters continue to
work as residual filters without generation metadata:

```ts
import { Schema } from "effect"

const Even = Schema.Int.check(
  Schema.makeFilter((value) => value % 2 === 0)
)
```

Residual filtering is bounded, so a very selective or impossible predicate may produce `SampleError` or `Exhausted`.

If the previous annotation supplied a recognized constructive constraint, move it to `arbitraryConstraint` and adapt
its shape. The predicate remains authoritative:

```ts
import { Order, Schema } from "effect"

const Positive = Schema.Number.check(
  Schema.makeFilter(
    (value) => value > 0,
    {
      arbitraryConstraint: {
        order: Order.Number,
        minimum: 0,
        exclusiveMinimum: true
      }
    }
  )
)
```

The main constraint-shape changes are:

| Previous field                       | Native field                                                        |
| ------------------------------------ | ------------------------------------------------------------------- |
| `ordered.order`                      | `order`                                                             |
| `ordered.minimum` / `maximum`        | `minimum` / `maximum`                                               |
| `ordered.exclusiveMinimum` / maximum | `exclusiveMinimum: true` / `exclusiveMaximum: true`                 |
| `integer: true`                      | `number: "integer"`                                                 |
| `noNaN` and `noInfinity`             | `number: "finite"` when both restrictions apply                     |
| collection `minLength` / `maxLength` | `minLength`, `minSize`, or `minProperties` and its matching maximum |
| string pattern                       | `{ source, flags }` in `patterns`                                   |
| `unique: true`                       | `uniqueBy: identity`                                                |
| `candidate`                          | No direct equivalent                                                |

Choose the cardinality field that matches the Schema domain: `minLength` and `maxLength` for strings and arrays,
`minSize` and `maxSize` for sized collections, and `minProperties` and `maxProperties` for object properties.

For an opaque declaration that needs a reusable statistically better source domain, express that source as a Schema
Link with `toCodecArbitrary`.

## Migrating `@effect/vitest`

Property inputs may be Schemas, native Arbitraries, or mixtures of both.

Schema-only properties need only an option rename:

```ts
// Before
it.prop(
  "commutative",
  [Schema.Int, Schema.Int],
  ([a, b]) => a + b === b + a,
  { fastCheck: { numRuns: 200, seed: 42 } }
)

// After
it.prop(
  "commutative",
  [Schema.Int, Schema.Int],
  ([a, b]) => a + b === b + a,
  { arbitrary: { runs: 200, seed: 42 } }
)
```

Raw or mixed fast-check inputs are no longer accepted:

```ts
// No longer supported
it.prop("raw arbitrary", [fc.integer()], ([value]) => Number.isInteger(value))
it.prop("mixed", [Schema.String, fc.integer()], ([text, value]) => true)
```

Replace those inputs with Schemas when they describe a domain supported by Schema, or compose a native Arbitrary:

```ts
import { Arbitrary } from "effect/unstable/arbitrary"

const integer = Arbitrary.schema(Schema.Int)

it.prop("native arbitrary", [integer], ([value]) => Number.isInteger(value))
it.prop("mixed", [Schema.String, integer], ([text, value]) => typeof text === "string" && Number.isInteger(value))
```

If a test genuinely needs a fast-check-specific arbitrary or runner feature, use fast-check directly with Vitest
rather than passing it through `@effect/vitest`.

`it.prop`, `it.effect.prop`, and `it.live.prop` all accept native check options under `arbitrary`.

## Behavioral Differences to Review

Migration is not only an import rename. Review the following differences:

- native generation and shrinking have different distributions and may find different shrunk inputs;
- native checking returns structured results instead of using fast-check's assertion exceptions;
- generation that cannot find enough valid samples is bounded and reports `SampleError` or `Exhausted`;
- pure and Effectful properties share one interruptible runner;
- recursive and mutually recursive Schemas are analyzed as a graph and must have a finite generation path;
- replay tokens, seeds, and shrink paths are not compatible with fast-check;
- generated values are the decoded Schema `Type`;
- properties must not mutate generated values.

## Migration Checklist

1. Replace `effect/testing/FastCheck` imports. Use the native Arbitrary module for Schema generation and import
   `"fast-check"` directly only where it is still independently required.
2. Replace `Schema.toArbitrary(schema)(FastCheck)` with `Arbitrary.schema(schema)`.
3. Replace `FastCheck.sample` with `Arbitrary.sampleEffect` and run the returned Effect.
4. Replace `FastCheck.check` or `FastCheck.assert` for Schema-derived inputs with `Arbitrary.checkEffect`, then handle its
   structured result.
5. Rename `@effect/vitest` options from `fastCheck` to `arbitrary` and convert `numRuns` to `runs`.
6. Replace raw fast-check inputs in `@effect/vitest` with Schemas or native Arbitraries.
7. Migrate declaration-level `toArbitrary` callbacks to the `toCodecArbitrary` Link-returning contract and replace old
   filter-level `arbitrary` annotations with `arbitraryConstraint`.
8. Re-run properties with the native engine and record new replay tokens or explicit regression examples.
9. Review discard limits for selective custom filters.
