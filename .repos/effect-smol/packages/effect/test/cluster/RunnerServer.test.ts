import { assert, it } from "@effect/vitest"
import { Effect, Layer, Option, Queue, Schema, Stream } from "effect"
import { TestClock } from "effect/testing"
import {
  ClusterSchema,
  Entity,
  EntityAddress,
  EntityId,
  EntityType,
  Envelope,
  MessageStorage,
  RunnerHealth,
  Runners,
  RunnerServer,
  RunnerStorage,
  Sharding,
  ShardingConfig,
  Snowflake
} from "effect/unstable/cluster"
import { Headers } from "effect/unstable/http"
import { Rpc, type RpcSerialization, RpcServer, RpcTest } from "effect/unstable/rpc"

const ReproEntity = Entity.make("ReproRunnerServer", [
  Rpc.make("ReproStream", { success: Schema.Int, payload: { id: Schema.Number }, stream: true })
]).annotateRpcs(ClusterSchema.Persisted, false)

const HoleCodecEntity = Entity.make("HoleCodecEntity", [
  Rpc.make("Double", { success: Schema.Int, payload: { id: Schema.Number } })
]).annotateRpcs(ClusterSchema.Persisted, false)

// A hole codec that is observably different from `Schema.toCodecJson`: the
// entity payload and the replies become JSON strings on the wire.
const codecForJsonString =
  (<S extends Schema.Top>(schema: S) =>
    Schema.fromJsonString(Schema.toCodecJson(schema as any))) as RpcSerialization.CodecFor

const layerProtocol = (codecFor: RpcSerialization.CodecFor) =>
  Layer.effect(RpcServer.Protocol)(
    Effect.map(Queue.unbounded<number>(), (disconnects) =>
      RpcServer.Protocol.of({
        run: () => Effect.never,
        disconnects,
        send: () => Effect.void,
        end: () => Effect.void,
        clientIds: Effect.succeed(new Set()),
        initialMessage: Effect.succeedNone,
        supportsAck: false,
        supportsTransferables: false,
        supportsSpanPropagation: false,
        supportsNotifications: false,
        codecFor
      }))
  )

const makeHandlers = (
  entities: Layer.Layer<never, never, any>,
  codecFor: RpcSerialization.CodecFor
) =>
  RunnerServer.layerHandlers.pipe(
    Layer.provide(layerProtocol(codecFor)),
    Layer.provideMerge(entities),
    Layer.provideMerge(Sharding.layer),
    Layer.provideMerge(Snowflake.layerGenerator),
    Layer.provide(RunnerStorage.layerMemory),
    Layer.provide(RunnerHealth.layerNoop),
    Layer.provide(Runners.layerNoop),
    Layer.provideMerge(MessageStorage.layerMemory),
    Layer.provide(ShardingConfig.layer({
      entityMailboxCapacity: 10,
      entityTerminationTimeout: 0,
      entityMessagePollInterval: 5000,
      sendRetryInterval: 100,
      refreshAssignmentsInterval: 0
    }))
  )

const handlers = makeHandlers(
  ReproEntity.toLayer({ ReproStream: () => Stream.make(1) }),
  Schema.toCodecJson as RpcSerialization.CodecFor
)

const holeCodecHandlers = makeHandlers(
  HoleCodecEntity.toLayer({ Double: ({ payload }) => Effect.succeed(payload.id * 2) }),
  codecForJsonString
)

it.effect("completes a successful runner stream", () =>
  Effect.gen(function*() {
    yield* TestClock.adjust(1)
    const sharding = yield* Sharding.Sharding
    const snowflake = yield* Snowflake.Generator
    const entityId = EntityId.make("one")
    const request = {
      _tag: "Request",
      requestId: snowflake.nextUnsafe(),
      address: EntityAddress.make({
        shardId: sharding.getShardId(entityId, ReproEntity.getShardGroup(entityId)),
        entityType: EntityType.make("ReproRunnerServer"),
        entityId
      }),
      tag: "ReproStream",
      payload: { id: 1 },
      headers: Headers.empty
    } as Envelope.PartialRequest
    const client = yield* RpcTest.makeClient(Runners.Rpcs)
    const queue = yield* client.Stream({ request, persisted: false }, { asQueue: true })
    const first = yield* Queue.take(queue).pipe(
      Effect.timeout("1 second"),
      TestClock.withLive
    )
    if (first._tag !== "Chunk") {
      return assert.fail("expected the stream value before the terminal reply")
    }
    assert.deepStrictEqual(first.values, [1])

    yield* client.Envelope({
      envelope: new Envelope.AckChunk({
        id: snowflake.nextUnsafe(),
        address: request.address,
        requestId: request.requestId,
        replyId: Snowflake.Snowflake(first.id)
      }),
      persisted: false
    })

    const completion = yield* Effect.gen(function*() {
      const last = yield* Queue.take(queue)
      yield* Queue.take(queue).pipe(Effect.catchTag("Done", () => Effect.void))
      return last
    }).pipe(
      Effect.timeoutOption("1 second"),
      TestClock.withLive
    )
    if (Option.isNone(completion)) {
      return assert.fail("expected the runner stream to complete")
    }
    assert.strictEqual(completion.value._tag, "WithExit")
  }).pipe(Effect.provide(handlers)))

it.effect("fills the entity payload and reply holes with the serialization's codec", () =>
  Effect.gen(function*() {
    yield* TestClock.adjust(1)
    const sharding = yield* Sharding.Sharding
    const snowflake = yield* Snowflake.Generator
    const entityId = EntityId.make("hole")
    const request = {
      _tag: "Request",
      requestId: snowflake.nextUnsafe(),
      address: EntityAddress.make({
        shardId: sharding.getShardId(entityId, HoleCodecEntity.getShardGroup(entityId)),
        entityType: EntityType.make("HoleCodecEntity"),
        entityId
      }),
      tag: "Double",
      // already encoded by the sender with the same hole codec
      payload: JSON.stringify({ id: 21 }),
      headers: Headers.empty
    } as any as Envelope.PartialRequest

    const client = yield* RpcTest.makeClient(Runners.Rpcs)
    const reply = yield* client.Effect({ request, persisted: false }).pipe(
      Effect.timeout("1 second"),
      TestClock.withLive
    )

    assert.strictEqual(typeof reply, "string", "the reply hole must carry the codec's output")
    const decoded = JSON.parse(reply as any)
    assert.strictEqual(decoded._tag, "WithExit")
    assert.deepStrictEqual(decoded.exit, { _tag: "Success", value: 42 })
  }).pipe(Effect.provide(holeCodecHandlers)))
