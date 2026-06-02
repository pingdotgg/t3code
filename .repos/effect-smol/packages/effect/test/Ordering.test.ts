import { Ordering } from "effect"
import { deepStrictEqual } from "node:assert"
import { describe, it } from "vitest"

describe("Ordering", () => {
  it("Reducer", () => {
    const R = Ordering.Reducer

    deepStrictEqual(R.combine(-1, 1), -1)
    deepStrictEqual(R.combine(1, -1), 1)
    deepStrictEqual(R.combine(1, 1), 1)
    deepStrictEqual(R.combine(0, 0), 0)
    deepStrictEqual(R.combine(0, 1), 1)
    deepStrictEqual(R.combine(1, 0), 1)
    deepStrictEqual(R.combine(0, -1), -1)
    deepStrictEqual(R.combine(-1, 0), -1)
  })
})
