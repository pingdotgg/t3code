import { assert, it } from "@effect/vitest"
import { Deferred, Effect, Exit, Fiber, Option, Scope } from "effect"
import { EntityAddress, EntityId, EntityType, ShardId } from "effect/unstable/cluster"
import { isActive } from "effect/unstable/cluster/internal/interruptors"
import { ResourceRef } from "effect/unstable/cluster/internal/resourceRef"

it.live("does not wedge await after a failed rebuild", () =>
  Effect.scoped(Effect.gen(function*() {
    const parentScope = yield* Effect.scope
    let fail = false
    let releases = 0
    const ref = yield* ResourceRef.from(parentScope, (scope) =>
      Scope.addFinalizer(
        scope,
        Effect.sync(() => releases++)
      ).pipe(
        Effect.andThen(fail ? Effect.fail("failed") : Effect.succeed(1))
      ))
    fail = true
    assert.deepStrictEqual(yield* Effect.exit(ref.rebuildUnsafe()), Exit.fail("failed"))
    assert.strictEqual(releases, 2)
    const completed = yield* Effect.exit(ref.await).pipe(Effect.timeoutOption(10))
    assert.deepStrictEqual(completed, Option.some(Exit.fail("failed")))
    fail = false
    yield* ref.rebuildUnsafe()
    assert.strictEqual(yield* ref.await, 1)
  })))

it.effect("does not let a stale rebuild overwrite a newer acquisition", () =>
  Effect.scoped(Effect.gen(function*() {
    const parentScope = yield* Effect.scope
    const releasing = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const newerAcquiring = yield* Deferred.make<void>()
    const newerAcquire = yield* Deferred.make<void>()
    let acquisitions = 0
    const ref = yield* ResourceRef.from(parentScope, (scope) =>
      Effect.gen(function*() {
        const acquisition = ++acquisitions
        if (acquisition === 1) {
          yield* Scope.addFinalizer(
            scope,
            Deferred.succeed(releasing, void 0).pipe(Effect.andThen(Deferred.await(release)))
          )
        } else if (acquisition === 2) {
          yield* Deferred.succeed(newerAcquiring, void 0)
          yield* Deferred.await(newerAcquire)
        } else {
          return yield* Effect.fail("stale")
        }
        return acquisition
      }))

    const staleRebuild = yield* Effect.forkChild(ref.rebuildUnsafe())
    yield* Deferred.await(releasing)
    const newerRebuild = yield* Effect.forkChild(ref.rebuildUnsafe())
    yield* Deferred.await(newerAcquiring)

    yield* Deferred.succeed(release, void 0)
    assert.deepStrictEqual(yield* Fiber.await(staleRebuild), Exit.fail("stale"))
    assert.strictEqual(ref.state.current._tag, "Acquiring")
    assert.isFalse(ref.latch.isOpen())

    yield* Deferred.succeed(newerAcquire, void 0)
    yield* Fiber.join(newerRebuild)
    assert.strictEqual(yield* ref.await, 2)
  })))

it.effect("does not leak teardown membership when a rebuild is discarded", () =>
  Effect.scoped(Effect.gen(function*() {
    const parentScope = yield* Effect.scope
    const address = EntityAddress.make({
      shardId: ShardId.make("resource-ref-discard", 1),
      entityType: EntityType.make("ResourceRefDiscard"),
      entityId: EntityId.make("1")
    })
    const ref = yield* ResourceRef.from(parentScope, () => Effect.succeed(1), address)
    const discarded = ref.rebuildUnsafe()
    assert.isDefined(discarded)
    assert.isFalse(isActive(address))
    yield* ref.rebuildUnsafe()
    assert.isFalse(isActive(address))
    assert.strictEqual(yield* ref.await, 1)
  })))

it.effect("does not leak teardown membership when a rebuild is interrupted", () =>
  Effect.scoped(Effect.gen(function*() {
    const parentScope = yield* Effect.scope
    const address = EntityAddress.make({
      shardId: ShardId.make("resource-ref-interrupt", 1),
      entityType: EntityType.make("ResourceRefInterrupt"),
      entityId: EntityId.make("1")
    })
    const release = yield* Deferred.make<void>()
    const ref = yield* ResourceRef.from(
      parentScope,
      (scope) =>
        Scope.addFinalizer(scope, Deferred.await(release)).pipe(
          Effect.andThen(Effect.succeed(1))
        ),
      address
    )
    const fiber = yield* Effect.forkChild(ref.rebuildUnsafe())
    yield* Fiber.interrupt(fiber)
    yield* Deferred.succeed(release, void 0)
    assert.isFalse(isActive(address))
  })))
