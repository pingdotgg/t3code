# Testing Patterns

## Testing Framework Selection

Use `it.effect` for tests that return Effects.

```typescript
import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"

it.effect("should work with Effects", () =>
  Effect.gen(function*() {
    const result = yield* someEffect
    assert.strictEqual(result, expectedValue)
  }))
```

Use regular `it` for pure synchronous TypeScript functions.

```typescript
import { assert, describe, it } from "@effect/vitest"

it("should work with pure functions", () => {
  const result = pureFunction(input)
  assert.strictEqual(result, expectedValue)
})
```

## Testing Rules

- Never use `Effect.runSync` in tests
- Never use `expect` from Vitest; use `assert` methods instead
- Always use `TestClock` for time-dependent operations
- Group related tests using `describe`

## Type-Level Tests

Type-level tests are located in `packages/*/typetest/` and use Tstyche.

Run targeted type-level tests with:

```sh
pnpm test-types <filename>
```

### Testing Displayed Types

Ordinary Tstyche assertions such as `toBe` compare types structurally. They cannot
catch regressions where a public type is semantically correct but TypeScript
displays an internal alias or an unsimplified intersection in editor quick info.

To test the displayed form, deliberately produce an assignment error and use
Tstyche's checked `@ts-expect-error` message to match a distinctive substring of
the rendered type:

```typescript
it("simplifies the displayed type", () => {
  const value = null as unknown as PublicType

  // @ts-expect-error Type '{ readonly value: string; }'
  const displayed: never = value

  void displayed
})
```

Before accepting the test, temporarily restore the broken type and confirm that
the diagnostic-message match fails. Keep the expected substring as small as
possible while still distinguishing the desired public type from the leaked
implementation type, because diagnostic wording can change between TypeScript
versions. Run the targeted test against every TypeScript version configured by
`pnpm test-types`.
