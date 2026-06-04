import { assert, describe, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import {
  isWorkerError,
  WorkerError,
  WorkerErrorReason,
  WorkerReceiveError,
  WorkerSendError,
  WorkerSpawnError,
  WorkerUnknownError
} from "effect/unstable/workers/WorkerError"

describe("WorkerError", () => {
  describe("reason handling", () => {
    it("delegates message from reason", () => {
      const error = new WorkerError({
        reason: new WorkerSendError({
          message: "Failed to send message to worker"
        })
      })

      assert.strictEqual(error.message, "Failed to send message to worker")
      assert.strictEqual(error.reason._tag, "WorkerSendError")
    })

    it("WorkerError delegates message and cause from reason", () => {
      const cause = new Error("boom")
      const reason = new WorkerSpawnError({
        message: "Failed to spawn worker",
        cause
      })

      assert.strictEqual(reason.message, "Failed to spawn worker")
      assert.strictEqual(reason.cause, cause)
    })
  })

  describe("isWorkerError", () => {
    it("matches wrapper only", () => {
      const wrapper = new WorkerError({
        reason: new WorkerReceiveError({
          message: "Failed to receive message"
        })
      })

      assert.isTrue(isWorkerError(wrapper))
      assert.isFalse(isWorkerError(new WorkerReceiveError({ message: "Failed to receive message" })))
      assert.isFalse(isWorkerError(new Error("regular error")))
      assert.isFalse(isWorkerError({ _tag: "WorkerError" }))
    })
  })

  describe("schema roundtrip", () => {
    it.effect("WorkerSpawnError roundtrip", () =>
      Effect.gen(function*() {
        const reason = new WorkerSpawnError({
          message: "Failed to spawn worker"
        })
        const encoded = yield* Schema.encodeEffect(WorkerSpawnError)(reason)
        const decoded = yield* Schema.decodeEffect(WorkerSpawnError)(encoded)
        assert.strictEqual(decoded._tag, "WorkerSpawnError")
        assert.strictEqual(decoded.message, "Failed to spawn worker")
      }))

    it.effect("WorkerErrorReason union roundtrip", () =>
      Effect.gen(function*() {
        const reason: WorkerErrorReason = new WorkerUnknownError({
          message: "Worker crashed unexpectedly"
        })
        const encoded = yield* Schema.encodeEffect(WorkerErrorReason)(reason)
        const decoded = yield* Schema.decodeEffect(WorkerErrorReason)(encoded)
        assert.strictEqual(decoded._tag, "WorkerUnknownError")
        assert.strictEqual(decoded.message, "Worker crashed unexpectedly")
      }))

    it.effect("WorkerError roundtrip", () =>
      Effect.gen(function*() {
        const error = new WorkerError({
          reason: new WorkerSendError({
            message: "Failed to send message"
          })
        })
        const encoded = yield* Schema.encodeEffect(WorkerError)(error)
        const decoded = yield* Schema.decodeEffect(WorkerError)(encoded)
        assert.strictEqual(decoded._tag, "WorkerError")
        assert.strictEqual(decoded.reason._tag, "WorkerSendError")
        assert.strictEqual(decoded.message, "Failed to send message")
      }))
  })
})
