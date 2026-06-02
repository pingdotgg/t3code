import * as Effect from "../../../Effect.ts"
import * as Exit from "../../../Exit.ts"
import * as Latch from "../../../Latch.ts"
import * as MutableRef from "../../../MutableRef.ts"
import * as Option from "../../../Option.ts"
import * as Scope from "../../../Scope.ts"
import { internalInterruptors } from "./interruptors.ts"

/** @internal */
export type State<A> = {
  readonly _tag: "Closed"
} | {
  readonly _tag: "Acquiring"
  readonly scope: Scope.Closeable
} | {
  readonly _tag: "Acquired"
  readonly scope: Scope.Closeable
  readonly value: A
}

/** @internal */
export class ResourceRef<A, E = never> {
  static from = Effect.fnUntraced(function*<A, E>(
    parentScope: Scope.Scope,
    acquire: (scope: Scope.Scope) => Effect.Effect<A, E>
  ) {
    const state = MutableRef.make<State<A>>({ _tag: "Closed" })

    yield* Scope.addFinalizerExit(parentScope, (exit) => {
      const s = MutableRef.get(state)
      if (s._tag === "Closed") {
        return Effect.void
      }
      const scope = s.scope
      MutableRef.set(state, { _tag: "Closed" })
      return Scope.close(scope, exit)
    })

    const scope = yield* Scope.make()
    MutableRef.set(state, { _tag: "Acquiring", scope })
    const value = yield* acquire(scope)
    MutableRef.set(state, { _tag: "Acquired", scope, value })

    return new ResourceRef(state, acquire)
  })

  readonly state: MutableRef.MutableRef<State<A>>
  readonly acquire: (scope: Scope.Scope) => Effect.Effect<A, E>
  constructor(
    state: MutableRef.MutableRef<State<A>>,
    acquire: (scope: Scope.Scope) => Effect.Effect<A, E>
  ) {
    this.state = state
    this.acquire = acquire
  }

  latch = Latch.makeUnsafe(true)

  getUnsafe(): Option.Option<A> {
    if (this.state.current._tag === "Acquired") {
      return Option.some(this.state.current.value)
    }
    return Option.none()
  }

  rebuildUnsafe(): Effect.Effect<void, E> {
    const s = this.state.current
    if (s._tag === "Closed") {
      return Effect.interrupt
    }
    const prevScope = s.scope
    const scope = Scope.makeUnsafe()
    this.latch.closeUnsafe()
    MutableRef.set(this.state, { _tag: "Acquiring", scope })
    return Effect.withFiber((fiber) => {
      internalInterruptors.add(fiber.id)
      return Scope.close(prevScope, Exit.void)
    }).pipe(
      Effect.andThen(this.acquire(scope)),
      Effect.flatMap((value) => {
        if (this.state.current._tag === "Closed") {
          return Effect.interrupt
        }
        MutableRef.set(this.state, { _tag: "Acquired", scope, value })
        return this.latch.open
      })
    )
  }

  await: Effect.Effect<A> = Effect.suspend(() => {
    const s = this.state.current
    if (s._tag === "Closed") {
      return Effect.interrupt
    } else if (s._tag === "Acquired") {
      return Effect.succeed(s.value)
    }
    return Effect.flatMap(this.latch.await, () => this.await)
  })
}
