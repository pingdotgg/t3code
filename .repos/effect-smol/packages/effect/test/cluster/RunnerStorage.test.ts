import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { RunnerAddress, RunnerStorage, ShardId } from "effect/unstable/cluster"

describe("RunnerStorage", () => {
  it.effect("memory acquire accepts a one-shot iterable", () =>
    Effect.gen(function*() {
      const storage = yield* RunnerStorage.makeMemory
      const address = RunnerAddress.make("localhost", 1234)
      const shards = [ShardId.make("default", 1), ShardId.make("default", 2)]
      const acquired = yield* storage.acquire(
        address,
        (function*() {
          yield* shards
        })()
      )

      assert.deepStrictEqual(acquired, shards)
      assert.deepStrictEqual(yield* storage.refresh(address, []), shards)
    }))
})
