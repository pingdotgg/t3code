# Forking: Renamed Combinators and New Options

The `fork*` family of combinators has been renamed in v4 for clarity, and all
variants now accept an options object for controlling fiber startup behavior.

## Renamings

| v3                            | v4                  | Description                                  |
| ----------------------------- | ------------------- | -------------------------------------------- |
| `Effect.fork`                 | `Effect.forkChild`  | Fork as a child of the current fiber         |
| `Effect.forkDaemon`           | `Effect.forkDetach` | Fork detached from parent lifecycle          |
| `Effect.forkScoped`           | `Effect.forkScoped` | Fork tied to the current `Scope` (unchanged) |
| `Effect.forkIn`               | `Effect.forkIn`     | Fork in a specific `Scope` (unchanged)       |
| `Effect.forkAll`              | —                   | Removed                                      |
| `Effect.forkWithErrorHandler` | —                   | Removed                                      |

## `Effect.fork` → `Effect.forkChild`

**v3**

```ts
import { Effect } from "effect"

const fiber = Effect.fork(myEffect)
```

**v4**

```ts
import { Effect } from "effect"

const fiber = Effect.forkChild(myEffect)
```

## `Effect.forkDaemon` → `Effect.forkDetach`

**v3**

```ts
import { Effect } from "effect"

const fiber = Effect.forkDaemon(myEffect)
```

**v4**

```ts
import { Effect } from "effect"

const fiber = Effect.forkDetach(myEffect)
```

## Fork Options

In v4, `forkChild`, `forkDetach`, `forkScoped`, and `forkIn` all accept an
optional options object with the following fields:

```ts
{
  readonly startImmediately?: boolean | undefined
  readonly uninterruptible?: boolean | "inherit" | undefined
}
```

- **`startImmediately`** — Defaults to `false` (also when omitted): the fork
  returns before the new fiber runs the effect. With `true`, it runs synchronously
  until it first suspends, yields, or completes, before the forking fiber
  continues. Deferred startup does not promise a particular scheduler turn.
- **`uninterruptible`** — Defaults to `false` (also when omitted): the new fiber is
  interruptible even when forked from an uninterruptible region. With `true`, it
  starts uninterruptible, as if the effect were wrapped in
  `Effect.uninterruptible`. `Fiber.interrupt` waits for it to finish, and the fiber
  keeps its own result. Explicit `Effect.interruptible` regions can still be
  interrupted. `"inherit"` copies the forking fiber's interruptibility at the fork.

These options do not change ownership. A `forkChild` fiber is interrupted when its
parent exits; a `forkDetach` fiber is independent of the parent's lifetime.
`forkIn` and `forkScoped` bind the fiber to a scope instead of the forking fiber.
Forking and scope registration are interruption-safe, so interrupting the forker
cannot leave the new fiber outside the scope. Closing the scope from another
fiber interrupts the scoped fiber and waits for its finalizers. Uninterruptible
work can delay closure; a fiber closing its own scope is not interrupted or
awaited by that close.

**Usage as data-last (curried)**

```ts
import { Effect } from "effect"

const fiber = myEffect.pipe(
  Effect.forkChild({ startImmediately: true })
)
```

**Usage as data-first**

```ts
import { Effect } from "effect"

const fiber = Effect.forkChild(myEffect, { startImmediately: true })
```

## Removed Combinators

**`Effect.forkAll`** and **`Effect.forkWithErrorHandler`** have been removed in
v4. For `forkAll`, fork effects individually with `forkChild` or use
higher-level concurrency combinators. For error handling on forked fibers,
observe the fiber's result via `Fiber.join` or `Fiber.await`.
