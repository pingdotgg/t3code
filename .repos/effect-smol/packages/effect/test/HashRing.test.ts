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
})
