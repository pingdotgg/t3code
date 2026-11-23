import type { EntityRegistration } from "@effect/platform-cloudflare/internal/entityRegistry"
import { makeEntityRuntime } from "@effect/platform-cloudflare/internal/entityRuntime"
import { assert, describe, it } from "@effect/vitest"
import {
  type Cause,
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Metric,
  Option,
  Queue,
  Schedule,
  Schema,
  Scope,
  Stream,
  Tracer
} from "effect"
import { ClusterMetrics, Entity, EntityAddress, EntityId, EntityType, ShardId } from "effect/cluster"
import { Rpc, RpcMiddleware, RpcSchema } from "effect/rpc"

const address = new EntityAddress.EntityAddress({
  shardId: ShardId.make("default", 1),
  entityType: EntityType.make("User"),
  entityId: EntityId.make("42")
})

const request = {
  _tag: "Request" as const,
  requestId: "0198bd72-6a80-72f1-8d87-5e9b5cf1e000" as any,
  address,
  tag: "Ping" as const,
  payload: undefined,
  headers: {}
}

describe("EntityRuntime", () => {
  it.effect("records handler exits and tracks the cached entity metric", () => {
    const Telemetry = Entity.make("Telemetry", [
      Rpc.make("Ping", { success: Schema.String }),
      Rpc.make("Fail", { success: Schema.String })
    ])
    const telemetryAddress = new EntityAddress.EntityAddress({
      shardId: ShardId.make("default", 1),
      entityType: EntityType.make("Telemetry"),
      entityId: EntityId.make("observed")
    })
    const spans: Array<Tracer.NativeSpan> = []
    const tracer = Tracer.make({
      span(options) {
        const span = new Tracer.NativeSpan(options)
        spans.push(span)
        return span
      }
    })
    const context = Context.empty().pipe(Context.add(Tracer.Tracer, tracer))
    const metricContext = Context.merge(
      context,
      Metric.CurrentMetricAttributes.context({ type: Telemetry.type })
    )
    let activeDuringHandler = BigInt(0)
    const registration: EntityRegistration = {
      entity: Telemetry,
      keepAliveHeartbeat: 30_000,
      build: Effect.succeed(Telemetry.of({
        Ping: () =>
          Effect.sync(() => {
            activeDuringHandler = ClusterMetrics.entities.valueUnsafe(metricContext).value
            return "pong"
          }),
        Fail: () => Effect.die("boom")
      })),
      options: undefined,
      context
    }

    return Effect.gen(function*() {
      const runtime = yield* makeEntityRuntime(registration, telemetryAddress, () => "reply")
      yield* runtime.run({ ...request, address: telemetryAddress } as any, Option.none(), false, () => Effect.void)

      assert.strictEqual(activeDuringHandler, BigInt(1))
      assert.strictEqual(ClusterMetrics.entities.valueUnsafe(metricContext).value, BigInt(1))
      assert.strictEqual(spans[0].attributes.get("entityType"), "Telemetry")
      assert.strictEqual(spans[0].attributes.get("entityId"), "observed")
      assert.strictEqual(spans[0].attributes.get("rpc"), "Ping")
      assert(spans[0].status._tag === "Ended")
      assert.isTrue(Exit.isSuccess(spans[0].status.exit))

      yield* runtime.run(
        { ...request, address: telemetryAddress, tag: "Fail" } as any,
        Option.none(),
        false,
        () => Effect.void
      )

      assert.deepStrictEqual(spans.map((span) => span.name), [
        "CloudflareCluster.handler",
        "CloudflareCluster.handler"
      ])
      assert(spans[1].status._tag === "Ended")
      assert.isTrue(Exit.isFailure(spans[1].status.exit))
      assert.strictEqual(ClusterMetrics.entities.valueUnsafe(metricContext).value, BigInt(1))

      yield* runtime.invalidate()
      assert.strictEqual(ClusterMetrics.entities.valueUnsafe(metricContext).value, BigInt(0))
    })
  })

  it.effect("shares an asynchronous handler build between concurrent first requests", () =>
    Effect.gen(function*() {
      const Concurrent = Entity.make("Concurrent", [
        Rpc.make("Ping", { success: Schema.String })
      ])
      const concurrentAddress = new EntityAddress.EntityAddress({
        shardId: ShardId.make("default", 1),
        entityType: EntityType.make("Concurrent"),
        entityId: EntityId.make("42")
      })
      const context = Context.empty()
      const metricContext = Context.merge(
        context,
        Metric.CurrentMetricAttributes.context({ type: Concurrent.type })
      )
      const releaseBuild = Deferred.makeUnsafe<void>()
      let builds = 0
      let finalizers = 0
      const registration: EntityRegistration = {
        entity: Concurrent,
        keepAliveHeartbeat: 30_000,
        build: Effect.gen(function*() {
          const scope = Option.getOrThrow(yield* Effect.serviceOption(Scope.Scope))
          builds++
          yield* Scope.addFinalizer(
            scope,
            Effect.sync(() => {
              finalizers++
            })
          )
          yield* Deferred.await(releaseBuild)
          return Concurrent.of({ Ping: () => Effect.succeed("pong") })
        }),
        options: { concurrency: "unbounded" },
        context
      }
      const runtime = yield* makeEntityRuntime(registration, concurrentAddress, () => "reply")
      const first = yield* Effect.forkChild(
        runtime.run({ ...request, address: concurrentAddress } as any, Option.none(), false, () => Effect.void)
      )
      const second = yield* Effect.forkChild(
        runtime.run(
          {
            ...request,
            requestId: "0198bd72-6a83-72f1-8d87-5e9b5cf1e003",
            address: concurrentAddress
          } as any,
          Option.none(),
          false,
          () => Effect.void
        )
      )

      yield* Effect.yieldNow
      yield* Deferred.succeed(releaseBuild, undefined)
      yield* Fiber.join(first)
      yield* Fiber.join(second)

      assert.strictEqual(builds, 1)
      assert.strictEqual(ClusterMetrics.entities.valueUnsafe(metricContext).value, BigInt(1))
      assert.strictEqual(finalizers, 0)

      yield* runtime.invalidate()
      assert.strictEqual(ClusterMetrics.entities.valueUnsafe(metricContext).value, BigInt(0))
      assert.strictEqual(finalizers, 1)
    }))

  it.effect("retries a defective stream from the last emitted chunk", () =>
    Effect.gen(function*() {
      const Streaming = Entity.make("User", [
        Rpc.make("Values", { success: RpcSchema.Stream(Schema.Number, Schema.Never) })
      ])
      const seenLastChunks: Array<number | undefined> = []
      const registration: EntityRegistration = {
        entity: Streaming,
        keepAliveHeartbeat: 30_000,
        build: Effect.succeed(Streaming.of({
          Values: (request) => {
            const last = Option.getOrUndefined(request.lastSentChunkValue)
            seenLastChunks.push(last)
            return last === undefined
              ? Stream.concat(Stream.make(1), Stream.die("retry"))
              : Stream.make(last + 1)
          }
        })),
        options: { defectRetryPolicy: Schedule.recurs(1) },
        context: Context.empty()
      }
      let replyId = 0
      const runtime = yield* makeEntityRuntime(registration, address, () => `reply-${replyId++}`)
      const replies: Array<any> = []

      yield* runtime.run(
        { ...request, tag: "Values" } as any,
        Option.none(),
        false,
        (reply) => Effect.sync(() => replies.push(reply))
      )

      assert.deepStrictEqual(seenLastChunks, [undefined, 1])
      assert.deepStrictEqual(
        replies.filter((reply) => reply._tag === "Chunk").map((reply) => [reply.sequence, reply.values]),
        [[0, [1]], [1, [2]]]
      )
      assert.isTrue(Exit.isSuccess(replies.at(-1).exit))
    }))

  it.effect("runs server middleware before the handler", () =>
    Effect.gen(function*() {
      class Guard extends RpcMiddleware.Service<Guard>()("Guard", { error: Schema.String }) {}
      const Guarded = Entity.make("User", [
        Rpc.make("Ping", { success: Schema.String }).middleware(Guard)
      ])
      let runs = 0
      const registration: EntityRegistration = {
        entity: Guarded,
        keepAliveHeartbeat: 30_000,
        build: Effect.succeed(Guarded.of({
          Ping: () =>
            Effect.sync(() => {
              runs++
              return "secret"
            })
        })),
        options: undefined,
        context: Context.make(Guard, () => Effect.fail("denied"))
      }
      const runtime = yield* makeEntityRuntime(registration, address, () => "reply")
      const replies: Array<any> = []

      yield* runtime.run(request as any, Option.none(), false, (reply) => Effect.sync(() => replies.push(reply)))

      assert.strictEqual(runs, 0)
      assert.strictEqual(replies.length, 1)
      assert.deepStrictEqual(Exit.findErrorOption(replies[0].exit), Option.some("denied"))
    }))

  it.effect("closes the request scope before the request finishes", () =>
    Effect.gen(function*() {
      const Scoped = Entity.make("User", [
        Rpc.make("Ping", { success: Schema.String })
      ])
      let released = 0
      const registration: EntityRegistration = {
        entity: Scoped,
        keepAliveHeartbeat: 30_000,
        build: Effect.succeed(Scoped.of({
          Ping: () =>
            Effect.as(
              Effect.acquireRelease(Effect.void, () =>
                Effect.sync(() => {
                  released++
                })),
              "pong"
            )
        })),
        options: undefined,
        context: Context.empty()
      }
      const runtime = yield* makeEntityRuntime(registration, address, () => "reply")

      yield* runtime.run(request as any, Option.none(), false, () => Effect.void)

      assert.strictEqual(released, 1)
    }))

  it.effect("resolves Deferred and Queue handler results", () =>
    Effect.gen(function*() {
      const Results = Entity.make("User", [
        Rpc.make("Ping", { success: Schema.String }),
        Rpc.make("Values", { success: RpcSchema.Stream(Schema.Number, Schema.Never) })
      ])
      const registration: EntityRegistration = {
        entity: Results,
        keepAliveHeartbeat: 30_000,
        build: Effect.succeed(Results.of({
          Ping: Effect.fnUntraced(function*() {
            const deferred = yield* Deferred.make<string>()
            yield* Effect.forkDetach(Deferred.succeed(deferred, "later"))
            return deferred
          }),
          Values: Effect.fnUntraced(function*() {
            const queue = yield* Queue.make<number, Cause.Done>()
            yield* Queue.offerAll(queue, [1, 2])
            yield* Queue.end(queue)
            return queue
          })
        })),
        options: undefined,
        context: Context.empty()
      }
      let replyId = 0
      const runtime = yield* makeEntityRuntime(registration, address, () => `reply-${replyId++}`)
      const replies: Array<any> = []
      const respond = (reply: any) => Effect.sync(() => replies.push(reply))

      yield* runtime.run(request as any, Option.none(), false, respond)
      assert.deepStrictEqual(replies.map((reply) => reply.exit), [Exit.succeed("later")])

      replies.length = 0
      yield* runtime.run({ ...request, tag: "Values" } as any, Option.none(), false, respond)
      assert.deepStrictEqual(
        replies.flatMap((reply) => reply._tag === "Chunk" ? reply.values : []),
        [1, 2]
      )
      assert.isTrue(Exit.isSuccess(replies.at(-1).exit))
    }))
})
