import type { EntityAlarm } from "@effect/platform-cloudflare/internal/entityStorage"
import { armAlarm } from "@effect/platform-cloudflare/internal/entityStorage"
import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"

// The single Durable Object alarm only ever moves earlier.
const armFrom = Effect.fnUntraced(function*(current: number | null, deliverAt: number) {
  const setCalls: Array<number> = []
  const alarm = {
    getAlarm: () => Promise.resolve(current),
    setAlarm: (scheduledTime: number) => {
      setCalls.push(scheduledTime)
      return Promise.resolve()
    }
  } as unknown as EntityAlarm
  yield* armAlarm(alarm, deliverAt)
  return setCalls
})

describe("armAlarm", () => {
  it.effect("keeps an already earlier alarm", () =>
    Effect.gen(function*() {
      assert.deepStrictEqual(yield* armFrom(500, 1000), [])
    }))

  it.effect("moves a later alarm forward", () =>
    Effect.gen(function*() {
      assert.deepStrictEqual(yield* armFrom(2000, 1000), [1000])
    }))
})
