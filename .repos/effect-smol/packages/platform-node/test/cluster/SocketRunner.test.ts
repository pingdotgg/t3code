import { NodeClusterSocket } from "@effect/platform-node"
import { describe, it } from "@effect/vitest"
import { BigDecimal, Effect, Layer, Option, PrimaryKey, Schema } from "effect"
import {
  ClusterSchema,
  Entity,
  MessageStorage,
  RunnerAddress,
  RunnerHealth,
  RunnerStorage,
  ShardingConfig,
  SocketRunner
} from "effect/unstable/cluster"
import { Rpc, RpcSerialization } from "effect/unstable/rpc"

class TestPayload extends Schema.Class<TestPayload>("TestPayload")({
  id: Schema.String,
  amount: Schema.BigDecimal
}) {
  [PrimaryKey.symbol]() {
    return this.id
  }
}

const TestEntity = Entity
  .make("TestEntity", [
    Rpc.make("Process", {
      payload: TestPayload,
      success: Schema.Void
    })
  ])
  .annotateRpcs(ClusterSchema.Persisted, true)
  .annotateRpcs(ClusterSchema.Uninterruptible, true)

const TestEntityLayer = TestEntity.toLayer(
  Effect.succeed({
    Process: () => Effect.void
  })
)

const RUNNER_PORT = 50_123
// Build shared storage instances once, so runner and client see the same state.
// MessageStorage.layerMemory requires ShardingConfig, so we provide a minimal one.
const SharedStorage = Layer.mergeAll(
  RunnerStorage.layerMemory,
  MessageStorage.layerMemory
).pipe(
  Layer.provide(ShardingConfig.layerDefaults)
)

const makeRunnerLayer = (port: number) =>
  TestEntityLayer.pipe(
    Layer.provideMerge(SocketRunner.layer),
    Layer.provide(RunnerHealth.layerNoop),
    Layer.provide(NodeClusterSocket.layerSocketServer),
    Layer.provide(NodeClusterSocket.layerClientProtocol),
    Layer.provide(ShardingConfig.layer({
      runnerAddress: Option.some(RunnerAddress.make("localhost", port)),
      entityTerminationTimeout: 0,
      entityMessagePollInterval: 5000,
      sendRetryInterval: 100
    })),
    Layer.provide(RpcSerialization.layerMsgPack)
  )

const makeClientLayer = (port: number) =>
  SocketRunner.layerClientOnly.pipe(
    Layer.provide(NodeClusterSocket.layerClientProtocol),
    Layer.provide(ShardingConfig.layer({
      runnerAddress: Option.some(RunnerAddress.make("localhost", port)),
      runnerListenAddress: Option.some(RunnerAddress.make("localhost", port)),
      entityTerminationTimeout: 0,
      entityMessagePollInterval: 5000,
      sendRetryInterval: 100
    })),
    Layer.provide(RpcSerialization.layerMsgPack)
  )

// BigDecimal.normalize creates a circular `normalized` self-reference.
// When a persisted message is sent with discard: true, the notify path in Runners.makeRpc
// passes the raw envelope (with circular BigDecimal payload) to the runner via msgpack,
// causing RangeError: Maximum call stack size exceeded.
describe("SocketRunner", () => {
  it.live(
    "entity call with BigDecimal and discard should not stack overflow",
    () =>
      Effect.gen(function*() {
        // Start the runner (with socket server and entity handler)
        yield* Layer.launch(makeRunnerLayer(RUNNER_PORT)).pipe(Effect.forkScoped)

        // Give the runner time to start and acquire shards
        yield* Effect.sleep("2 seconds")
        yield* Effect.log("Before starting the client")

        // Send a message from the client with discard: true.
        // The BigDecimal is normalized to trigger the circular `normalized` self-reference.
        yield* Effect.gen(function*() {
          yield* Effect.log("Starting the client")
          yield* Effect.sleep("2 seconds")
          const makeClient = yield* TestEntity.client
          // Give the client time to discover the runner
          yield* Effect.sleep("3 seconds")
          const client = makeClient("entity-1")

          const amount = BigDecimal.fromStringUnsafe("123.45")

          yield* client.Process(
            TestPayload.make({ id: "req-1", amount }),
            { discard: true }
          )
        }).pipe(
          Effect.provide(makeClientLayer(RUNNER_PORT)),
          Effect.scoped
        )
      }).pipe(Effect.provide(
        SharedStorage
      )),
    30_000
  )
})
