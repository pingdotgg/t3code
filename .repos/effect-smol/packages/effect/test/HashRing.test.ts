import { assert, describe, it } from "@effect/vitest"
import * as HashRing from "effect/HashRing"
import * as PrimaryKey from "effect/PrimaryKey"

describe("HashRing", () => {
  it("updates the stored node when adding the same primary key", () => {
    const first = {
      name: "first",
      [PrimaryKey.symbol]() {
        return "node"
      }
    }
    const updated = {
      name: "updated",
      [PrimaryKey.symbol]() {
        return "node"
      }
    }
    const ring = HashRing.make<typeof first>()

    HashRing.add(ring, first)
    HashRing.add(ring, updated)

    assert.strictEqual(HashRing.get(ring, "request"), updated)
  })

  it("updates the stored node when changing its weight", () => {
    const first = {
      name: "first",
      [PrimaryKey.symbol]() {
        return "node"
      }
    }
    const updated = {
      name: "updated",
      [PrimaryKey.symbol]() {
        return "node"
      }
    }
    const ring = HashRing.make<typeof first>()

    HashRing.add(ring, first)
    HashRing.add(ring, updated, { weight: 2 })

    assert.strictEqual(HashRing.get(ring, "request"), updated)
  })

  it("getShards normalizes the shard count", () => {
    const node = {
      name: "node",
      [PrimaryKey.symbol]() {
        return "node"
      }
    }
    const ring = HashRing.make<typeof node>()
    HashRing.add(ring, node)

    const shards = [Number.NaN, -1, 0, 0.5, 1.9, 2.9].map((count) => HashRing.getShards(ring, count))

    assert.deepStrictEqual(shards, [[], [], [], [], [node], [node, node]])
  })

  it("getShards considers the first ring entry when excluding allocated nodes", () => {
    // With one ring entry per node, these keys make every shard nearest to
    // `second`, so `first` at index 0 is reached only by the exclusion scan.
    const first = {
      [PrimaryKey.symbol]() {
        return "node-10"
      }
    }
    const second = {
      [PrimaryKey.symbol]() {
        return "node-29"
      }
    }
    const ring = HashRing.make<typeof first>({ baseWeight: 1 })
    HashRing.add(ring, first)
    HashRing.add(ring, second)

    assert.deepStrictEqual(HashRing.getShards(ring, 3)?.map(PrimaryKey.value), ["node-10", "node-29", "node-29"])
  })
})
