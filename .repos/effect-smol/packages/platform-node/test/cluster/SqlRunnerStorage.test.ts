import { NodeFileSystem } from "@effect/platform-node"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { describe, expect, it } from "@effect/vitest"
import { Effect, FileSystem, Layer } from "effect"
import {
  Runner,
  RunnerAddress,
  RunnerStorage,
  ShardId,
  ShardingConfig,
  SqlRunnerStorage
} from "effect/unstable/cluster"
import { MysqlContainer } from "../fixtures/mysql2-utils.ts"
import { PgContainer } from "../fixtures/pg-utils.ts"

const StorageLive = SqlRunnerStorage.layer

describe("SqlRunnerStorage", () => {
  ;([
    ["pg", Layer.orDie(PgContainer.layerClient)],
    ["mysql", Layer.orDie(MysqlContainer.layerClient)],
    ["vitess", Layer.orDie(MysqlContainer.layerClientVitess)],
    ["sqlite", Layer.orDie(SqliteLayer)]
  ] as const).flatMap(([label, layer]) =>
    [
      [label, StorageLive.pipe(Layer.provideMerge(layer), Layer.provide(ShardingConfig.layer()))],
      [
        label + " (no advisory)",
        StorageLive.pipe(
          Layer.provideMerge(layer),
          Layer.provide(ShardingConfig.layer({
            shardLockDisableAdvisory: true
          }))
        )
      ]
    ] as const
  ).forEach(([label, layer]) => {
    it.layer(layer, {
      timeout: 60000
    })(label, (it) => {
      it.effect("getRunners", () =>
        Effect.gen(function*() {
          const storage = yield* RunnerStorage.RunnerStorage

          const runner = Runner.make({
            address: runnerAddress1,
            groups: ["default"],
            weight: 1
          })
          const machineId = yield* storage.register(runner, true)
          yield* storage.register(runner, true)
          expect(machineId).toEqual(1)
          expect(yield* storage.getRunners).toEqual([[runner, true]])

          yield* storage.setRunnerHealth(runnerAddress1, false)
          expect(yield* storage.getRunners).toEqual([[runner, false]])

          yield* storage.unregister(runnerAddress1)
          expect(yield* storage.getRunners).toEqual([])
        }), 30_000)

      it.effect("acquireShards", () =>
        Effect.gen(function*() {
          const storage = yield* RunnerStorage.RunnerStorage

          let acquired = yield* storage.acquire(runnerAddress1, [
            ShardId.make("default", 1),
            ShardId.make("default", 2),
            ShardId.make("default", 3)
          ])
          expect(acquired.map((_) => _.id)).toEqual([1, 2, 3])
          acquired = yield* storage.acquire(runnerAddress1, [
            ShardId.make("default", 1),
            ShardId.make("default", 2),
            ShardId.make("default", 3)
          ])
          expect(acquired.map((_) => _.id)).toEqual([1, 2, 3])

          const refreshed = yield* storage.refresh(runnerAddress1, [
            ShardId.make("default", 1),
            ShardId.make("default", 2),
            ShardId.make("default", 3)
          ])
          expect(refreshed.map((_) => _.id)).toEqual([1, 2, 3])

          // smoke test release
          yield* storage.release(runnerAddress1, ShardId.make("default", 2))
        }))
    })
  })
})

const runnerAddress1 = RunnerAddress.make("localhost", 1234)

const SqliteLayer = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const dir = yield* fs.makeTempDirectoryScoped()
  return SqliteClient.layer({
    filename: dir + "/test.db"
  })
}).pipe(Layer.unwrap, Layer.provide(NodeFileSystem.layer))
