# Effect Subtyping (v3) → Yieldable (v4)

In v3, many types were structural subtypes of `Effect` — they carried the
Effect type ID at runtime and could be used anywhere an `Effect` was expected.
This included `Ref`, `Deferred`, `Fiber`, `FiberRef`, `Config`, `Option`,
`Either`, `Context.Tag`, and others.

While convenient, this created a class of subtle bugs. Because these types
_were_ Effects, they could be silently passed to Effect combinators when you
intended to pass the value itself. For example, passing a `Ref` where you meant
to pass the value inside the `Ref`, or accidentally mapping over a `Deferred`
as an Effect instead of awaiting it.

v4 replaces this with the **`Yieldable`** trait: a narrower contract that
allows `yield*` in generators but does **not** make the type assignable to
`Effect`.

## The `Yieldable` Interface

```ts
interface Yieldable<Self, A, E = never, R = never> {
  asEffect(): Effect<A, E, R>
  [Symbol.iterator](): EffectIterator<Self>
}
```

Some example types that implement `Yieldable`:

- `Effect` itself
- `Option` — yields the value or fails with `NoSuchElementError`
- `Result` — yields the success or fails with the error
- `Config` — yields the config value or fails with `ConfigError`
- `Context.Service` — yields the service from the environment

Some example types that are **no longer** Effect subtypes and do **not**
implement `Yieldable`:

- `Ref` — use `Ref.get(ref)` to read
- `Deferred` — use `Deferred.await(deferred)` to wait
- `Fiber` — use `Fiber.join(fiber)` to await

## `yield*` Still Works

`yield*` in `Effect.gen` works with any `Yieldable`. The runtime calls
`.asEffect()` internally when yielding.

```ts
import { Effect, Option } from "effect"

// The type of program is `Effect<number, NoSuchElementError>`
const program = Effect.gen(function*() {
  // yield* works with Yieldable types — same as v3
  const value = yield* Option.some(42)
  return value // 42
})
```

## Effect Combinators Require `.asEffect()`

In v3, you could pass a `Yieldable` type directly to Effect combinators because
it was a subtype of `Effect`. In v4, you must explicitly convert with
`.asEffect()`.

**v3** — Option is an Effect subtype, so this compiles:

```ts
import { Effect, Option } from "effect"

// Option<number> is assignable to Effect<number, NoSuchElementError>
const program = Effect.map(Option.some(42), (n) => n + 1)
```

**v4** — Option is not an Effect, so you must convert explicitly:

```ts
import { Effect, Option } from "effect"

// Option is Yieldable but not Effect — use .asEffect()
const program = Effect.map(Option.some(42).asEffect(), (n) => n + 1)

// Or more idiomatically, use a generator:
const program2 = Effect.gen(function*() {
  const n = yield* Option.some(42)
  return n + 1
})
```

## Types No Longer Subtypes of Effect

Several types that extended `Effect` in v3 no longer do so in v4. Use the
appropriate module functions instead.

**v3** — `Ref` extends `Effect<A>`, yielding the current value:

```ts
import { Effect, Ref } from "effect"

const program = Effect.gen(function*() {
  const ref = yield* Ref.make(0)
  const value = yield* ref // Ref is an Effect<number>
})
```

**v4** — `Ref` is a plain value, use `Ref.get`:

```ts
import { Effect, Ref } from "effect"

const program = Effect.gen(function*() {
  const ref = yield* Ref.make(0)
  const value = yield* Ref.get(ref)
})
```

**v3** — `Deferred` extends `Effect<A, E>`, resolving when completed:

```ts
import { Deferred, Effect } from "effect"

const program = Effect.gen(function*() {
  const deferred = yield* Deferred.make<string, never>()
  const value = yield* deferred // Deferred is an Effect<string>
})
```

**v4** — `Deferred` is a plain value, use `Deferred.await`:

```ts
import { Deferred, Effect } from "effect"

const program = Effect.gen(function*() {
  const deferred = yield* Deferred.make<string, never>()
  const value = yield* Deferred.await(deferred)
})
```

**v3** — `Fiber` extends `Effect<A, E>`, joining on yield:

```ts
import { Effect, Fiber } from "effect"

const program = Effect.gen(function*() {
  const fiber = yield* Effect.fork(task)
  const result = yield* fiber // Fiber is an Effect<A, E>
})
```

**v4** — `Fiber` is a plain value, use `Fiber.join`:

```ts
import { Effect, Fiber } from "effect"

const program = Effect.gen(function*() {
  const fiber = yield* Effect.forkChild(task)
  const result = yield* Fiber.join(fiber)
})
```

## Why This Changed

The v3 subtyping approach meant the type system could not distinguish between
"I have a Ref" and "I have an Effect that reads the Ref." This ambiguity led
to bugs that were difficult to diagnose:

- Passing a `Ref` to `Effect.map` would read the ref's value rather than
  transforming the ref itself — often not the intended behavior.
- A `Deferred` in a data structure could silently be treated as an Effect,
  causing unexpected awaits.
- Combinators like `Effect.all` would accept an array of `Ref` values and
  silently read all of them, instead of producing a type error.

The `Yieldable` trait preserves the ergonomic `yield*` syntax in generators
while making the conversion to `Effect` explicit everywhere else.
