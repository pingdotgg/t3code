import { assert, describe, it } from "@effect/vitest"
import { Cause, Effect, Layer, Schema, Stream } from "effect"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
import { Rpc, RpcClient, RpcGroup, RpcMessage, RpcSchema, RpcSerialization } from "effect/unstable/rpc"
import { RpcClientError } from "effect/unstable/rpc/RpcClientError"

const TestGroup = RpcGroup.make(
  Rpc.make("Ping", { success: Schema.String }),
  Rpc.make("Events", { success: RpcSchema.Stream(Schema.String, Schema.Never) })
)

const makeHttpClient = (body: string): HttpClient.HttpClient =>
  HttpClient.make((request) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(body, { status: 200 })
      )
    )
  )

const makeProtocolLayer = (
  serializationLayer: Layer.Layer<RpcSerialization.RpcSerialization>,
  body: string
) =>
  RpcClient.layerProtocolHttp({ url: "http://localhost/rpc" }).pipe(
    Layer.provideMerge(serializationLayer),
    Layer.provideMerge(Layer.succeed(HttpClient.HttpClient, makeHttpClient(body)))
  )

const assertEmptyResponseFailsRequest = (
  serializationLayer: Layer.Layer<RpcSerialization.RpcSerialization>,
  body: string
) =>
  Effect.gen(function*() {
    const client = yield* RpcClient.make(TestGroup).pipe(
      Effect.provide(makeProtocolLayer(serializationLayer, body))
    )

    const cause = yield* client.Ping().pipe(
      Effect.timeout("1 second"),
      Effect.sandbox,
      Effect.flip
    )

    const error = Cause.squash(cause)
    assert.instanceOf(error, RpcClientError)
    assert.strictEqual(error.reason._tag, "RpcClientDefect")
    assert.strictEqual(error.reason.message, "Received empty HTTP response from RPC server")
  })

describe("RpcClient", () => {
  it.effect("fails request on empty HTTP response for unframed serialization", () =>
    assertEmptyResponseFailsRequest(RpcSerialization.layerJson, "[]"))

  it.effect("fails request on empty HTTP response for framed serialization", () =>
    assertEmptyResponseFailsRequest(RpcSerialization.layerNdjson, ""))

  it.effect("defects request when framed HTTP response closes before request completes", () =>
    Effect.gen(function*() {
      const client = yield* RpcClient.make(TestGroup, {
        generateRequestId: () => RpcMessage.RequestId("0")
      }).pipe(
        Effect.provide(makeProtocolLayer(
          RpcSerialization.layerNdjson,
          JSON.stringify({ _tag: "Chunk", requestId: "0", values: ["event"] }) + "\n"
        ))
      )

      const cause = yield* client.Events().pipe(
        Stream.runDrain,
        Effect.timeout("1 second"),
        Effect.sandbox,
        Effect.flip
      )

      const error = Cause.squash(cause)
      assert.instanceOf(error, RpcClientError)
      assert.strictEqual(error.reason._tag, "RpcClientDefect")
      assert.strictEqual(error.reason.message, "HTTP response ended before RPC request completed")
    }))
})
