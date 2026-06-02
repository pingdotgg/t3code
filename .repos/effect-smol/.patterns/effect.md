# Effect Library Development Patterns

## NEVER: try-catch in Effect.gen

**REASON**: Effect generators handle errors through the Effect type system, not JavaScript exceptions.

```typescript
// ❌ WRONG - This will cause runtime errors
Effect.gen(function*() {
  try {
    const result = yield* someEffect
    return result
  } catch (error) {
    // This will never be reached and breaks Effect semantics
    console.error(error)
  }
})

// ✅ CORRECT - Use Effect's built-in error handling
Effect.gen(function*() {
  const result = yield* Effect.result(someEffect)
  if (result._tag === "Failure") {
    // Handle error case properly
    console.error("Effect failed:", result.cause)
    return yield* Effect.fail("Handled error")
  }
  return result.value
})
```

## return yield* Pattern for Errors

**CRITICAL**: Always use `return yield*` when yielding terminal effects.

```typescript
// ✅ CORRECT - Makes termination explicit
Effect.gen(function*() {
  if (invalidCondition) {
    return yield* Effect.fail("Validation failed")
  }

  if (shouldInterrupt) {
    return yield* Effect.interrupt
  }

  // Continue with normal flow
  const result = yield* someOtherEffect
  return result
})

// ❌ WRONG - Missing return keyword leads to unreachable code
Effect.gen(function*() {
  if (invalidCondition) {
    yield* Effect.fail("Validation failed") // Missing return!
    // Unreachable code after error!
  }
})
```

## `Effect.gen` and `Effect.fnUntraced`

Prefer `Effect.fnUntraced` over functions that only return `Effect.gen`.

```typescript
// ❌ AVOID - Function only wraps Effect.gen
const fn = (param: string) =>
  Effect.gen(function*() {
    // ...
  })

// ✅ PREFER - Reusable untraced Effect function
const fn = Effect.fnUntraced(function*(param: string) {
  // ...
})
```

## When to Use What

**Use `Effect.gen`** when:

- Writing inline effect composition
- One-off operations that don't need to be reused
- Inside other functions already being traced

**Use `Effect.fnUntraced`** when:

- Building library implementations
- Performance is critical (hot paths)
- Function is called many times per operation
- Tracing overhead is unacceptable

## `Context.Service`

Prefer the class syntax when working with `Context.Service`.

```typescript
import { Context } from "effect"

class MyService extends Context.Service<MyService, {
  readonly doSomething: (input: string) => number
}>()("MyService") {}
```
