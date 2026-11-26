import { callDurableObject } from "@effect/platform-cloudflare/internal/transport"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Schedule } from "effect"
import { PersistenceError } from "effect/cluster/ClusterError"

// Cloudflare rejects a failed Durable Object call with an Error carrying
// these flags.
const cloudflareError = (flags: { retryable?: boolean; overloaded?: boolean; remote?: boolean }) =>
  Object.assign(new Error("Network connection lost."), flags)

describe("callDurableObject", () => {
  it.effect("maps a rejection to a PersistenceError carrying its flags and never retries an overloaded object", () =>
    Effect.gen(function*() {
      let calls = 0
      const error = yield* callDurableObject({
        resolve: () => ({}),
        call: () => {
          calls++
          return Promise.reject(cloudflareError({ retryable: true, overloaded: true, remote: true }))
        },
        retry: Schedule.recurs(3)
      }).pipe(Effect.flip)

      assert.instanceOf(error, PersistenceError)
      const cause = error.cause as ReturnType<typeof cloudflareError>
      assert.isTrue(cause.retryable)
      assert.isTrue(cause.overloaded)
      assert.isTrue(cause.remote)
      assert.strictEqual(calls, 1)
    }))

  it.effect("retries a retryable rejection on a freshly resolved stub and stops at a non-retryable one", () =>
    Effect.gen(function*() {
      const used: Array<object> = []
      const final = cloudflareError({ retryable: false })
      const error = yield* callDurableObject({
        resolve: () => ({}),
        call: (stub) => {
          used.push(stub)
          return Promise.reject(used.length === 1 ? cloudflareError({ retryable: true }) : final)
        },
        retry: Schedule.recurs(3)
      }).pipe(Effect.flip)

      assert.strictEqual(error.cause, final)
      assert.strictEqual(used.length, 2)
      assert.notStrictEqual(used[0], used[1])
    }))
})
