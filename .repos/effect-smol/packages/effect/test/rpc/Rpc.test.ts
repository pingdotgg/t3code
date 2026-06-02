import { assert, describe, it } from "@effect/vitest"
import { Cause, Context, Effect, Exit, Option, Schema } from "effect"
import { Headers } from "effect/unstable/http"
import { Rpc, RpcGroup } from "effect/unstable/rpc"
import { RequestId } from "effect/unstable/rpc/RpcMessage"
import * as RpcSchema from "effect/unstable/rpc/RpcSchema"

const TestGroup = RpcGroup.make(
  Rpc.make("one"),
  Rpc.make("two", {
    success: Schema.String
  })
)

describe("Rpc", () => {
  it.effect("can implement a single handler", () =>
    Effect.gen(function*() {
      const TwoHandler = TestGroup.toLayerHandler("two", () => Effect.succeed("two"))
      const handler = yield* TestGroup.accessHandler("two").pipe(
        Effect.provide(TwoHandler)
      )
      const result = yield* handler(void 0, {
        client: {
          id: 1,
          annotations: Context.empty(),
          annotate() {
            return this
          }
        },
        requestId: RequestId(1n),
        headers: Headers.empty
      })
      assert.strictEqual(result, "two")
    }))

  it("exitSchema uses custom defect schema", () => {
    const rpc = Rpc.make("customDefect", {
      success: Schema.String,
      defect: Schema.Any
    })

    const schema = Rpc.exitSchema(rpc)
    const encode = Schema.encodeSync(schema)
    const decode = Schema.decodeSync(schema)

    const error = { message: "boom", stack: "Error: boom\n  at foo.ts:1", code: 42 }
    const exit = Exit.die(error)

    const roundTripped = decode(encode(exit))

    assert(Exit.isFailure(roundTripped))
    const defect = Cause.squash(roundTripped.cause)
    assert.deepStrictEqual(defect, error)
  })

  it("RpcSchema.getStreamSchemas returns Option", () => {
    const plain = Rpc.make("plainSchemas", { success: Schema.String })
    const stream = Rpc.make("streamSchemas", {
      success: Schema.String,
      error: Schema.Number,
      stream: true
    })
    const none = RpcSchema.getStreamSchemas(plain.successSchema)
    assert(Option.isNone(none))

    const some = RpcSchema.getStreamSchemas(stream.successSchema)
    if (Option.isNone(some)) {
      assert.fail("Expected stream schema")
    }
    assert.strictEqual(some.value.success, Schema.String)
    assert.strictEqual(some.value.error, Schema.Number)
  })
})
