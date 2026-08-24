import { assert, describe, it } from "@effect/vitest"
import { strictEqual } from "@effect/vitest/utils"
import { Cause, Effect, Schema, Stream } from "effect"
import { Sse } from "effect/unstable/encoding"
import { HttpClient, HttpClientError, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { HttpApi, HttpApiClient, HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/unstable/httpapi"

describe("HttpApiClient", () => {
  describe("streaming responses", () => {
    it.effect("decodes StreamSse events incrementally", () =>
      Effect.gen(function*() {
        const client = yield* HttpApiClient.makeWith(StreamingApi, {
          baseUrl: "http://test",
          httpClient: clientFromResponse(() =>
            new Response(
              textStream([
                "event: first\ndata: one\n\n",
                "event: second\ndata: two\n\n"
              ]),
              { status: 200 }
            )
          )
        })

        const stream = yield* client.test.events({})
        const first = yield* stream.pipe(Stream.take(1), Stream.runCollect)
        assert.deepStrictEqual(first, [{ event: "first", data: "one" }])
      }))

    it.effect("keeps StreamSse parser state isolated between responses", () =>
      Effect.gen(function*() {
        const bodies = [
          "event: first\ndata: one\n\n",
          "event: second\ndata: two\n\n"
        ]
        let index = 0
        const client = yield* HttpApiClient.makeWith(StreamingApi, {
          baseUrl: "http://test",
          httpClient: clientFromResponse(() => new Response(textStream([bodies[index++]!]), { status: 200 }))
        })

        const first = yield* client.test.events({}).pipe(Effect.flatMap(Stream.runCollect))
        const second = yield* client.test.events({}).pipe(Effect.flatMap(Stream.runCollect))

        assert.deepStrictEqual(first, [{ event: "first", data: "one" }])
        assert.deepStrictEqual(second, [{ event: "second", data: "two" }])
      }))

    it.effect("decodes StreamSse reserved failure events as full causes", () =>
      Effect.gen(function*() {
        const expectedCause = Cause.fail({ reason: "boom" })
        const FailureSchema = Schema.toCodecJson(Schema.Cause(StreamError, Schema.Defect()))
        const encodeCause = Schema.encodeUnknownEffect(Schema.fromJsonString(FailureSchema))
        const encodedCause = yield* encodeCause(expectedCause)
        const failureEvent = Sse.encoder.write({
          _tag: "Event",
          event: "effect/httpapi/stream/failure",
          id: undefined,
          data: encodedCause
        })

        const client = yield* HttpApiClient.makeWith(StreamingApi, {
          baseUrl: "http://test",
          httpClient: clientFromResponse(() => new Response(textStream([failureEvent]), { status: 200 }))
        })

        const stream = yield* client.test.events({})
        const exit = yield* Effect.exit(Stream.runCollect(stream))

        assert.strictEqual(exit._tag, "Failure")
        if (exit._tag === "Failure") {
          assert.deepStrictEqual(exit.cause, expectedCause)
        }
      }))

    it.effect("emits StreamSse reserved names with non-Cause data as user events", () =>
      Effect.gen(function*() {
        const failureEvent = Sse.encoder.write({
          _tag: "Event",
          event: "effect/httpapi/stream/failure",
          id: undefined,
          data: "not-json"
        })

        const client = yield* HttpApiClient.makeWith(StreamingApi, {
          baseUrl: "http://test",
          httpClient: clientFromResponse(() => new Response(textStream([failureEvent]), { status: 200 }))
        })

        const stream = yield* client.test.events({})
        const events = yield* Stream.runCollect(stream)

        assert.deepStrictEqual(events, [{
          event: "effect/httpapi/stream/failure",
          data: "not-json"
        }])
      }))

    it.effect("returns StreamUint8Array response bytes incrementally", () =>
      Effect.gen(function*() {
        const client = yield* HttpApiClient.makeWith(StreamingApi, {
          baseUrl: "http://test",
          httpClient: clientFromResponse(() =>
            new Response(byteStream([new Uint8Array([1, 2]), new Uint8Array([3])]), { status: 200 })
          )
        })

        const stream = yield* client.test.download({})
        const first = yield* stream.pipe(Stream.take(1), Stream.runCollect)
        assert.deepStrictEqual(first.map((chunk) => Array.from(chunk)), [[1, 2]])
      }))

    it.effect("decodes StreamSse successes at the annotated status", () =>
      Effect.gen(function*() {
        const client = yield* HttpApiClient.makeWith(AnnotatedStreamingApi, {
          baseUrl: "http://test",
          httpClient: clientFromResponse(() =>
            new Response(textStream(["event: annotated\ndata: ok\n\n"]), { status: 202 })
          )
        })

        const stream = yield* client.test.events({})
        const events = yield* Stream.runCollect(stream)
        assert.deepStrictEqual(events, [{ event: "annotated", data: "ok" }])
      }))

    it.effect("decodes StreamUint8Array successes at the annotated status", () =>
      Effect.gen(function*() {
        const client = yield* HttpApiClient.makeWith(AnnotatedStreamingApi, {
          baseUrl: "http://test",
          httpClient: clientFromResponse(() => new Response(byteStream([new Uint8Array([4, 5])]), { status: 206 }))
        })

        const stream = yield* client.test.download({})
        const chunks = yield* Stream.runCollect(stream)
        assert.deepStrictEqual(chunks.map((chunk) => Array.from(chunk)), [[4, 5]])
      }))

    it.effect("decodes non-success responses through endpoint error schemas before returning a stream", () =>
      Effect.gen(function*() {
        const client = yield* HttpApiClient.makeWith(StreamingApi, {
          baseUrl: "http://test",
          httpClient: clientFromResponse(() =>
            new Response(JSON.stringify({ _tag: "EndpointError", message: "bad request" }), {
              status: 400,
              headers: { "content-type": "application/json" }
            })
          )
        })

        const error = yield* Effect.flip(client.test.events({}))
        assert.deepStrictEqual(error, new EndpointError({ message: "bad request" }))
      }))

    it.effect("preserves response-only raw response stream access", () =>
      Effect.gen(function*() {
        const client = yield* HttpApiClient.makeWith(StreamingApi, {
          baseUrl: "http://test",
          httpClient: clientFromResponse(() =>
            new Response(
              byteStream([
                new Uint8Array([1]),
                new Uint8Array([2, 3])
              ]),
              { status: 200 }
            )
          )
        })

        const response = yield* client.test.download({ responseMode: "response-only" })
        const chunks = yield* Stream.runCollect(response.stream)
        assert.deepStrictEqual(chunks.map((chunk) => Array.from(chunk)), [[1], [2, 3]])
      }))

    it.effect("selects a buffered response by content type when a stream uses the same status", () =>
      Effect.gen(function*() {
        const client = yield* HttpApiClient.makeWith(MixedSuccessApi, {
          baseUrl: "http://test",
          httpClient: clientFromResponse(() =>
            new Response(JSON.stringify({ message: "done" }), {
              status: 200,
              headers: { "content-type": "application/json" }
            })
          )
        })

        const response = yield* client.test.chat({})
        assert.deepStrictEqual(response, { message: "done" })
      }))

    it.effect("selects a stream response by content type when buffered success uses the same status", () =>
      Effect.gen(function*() {
        const client = yield* HttpApiClient.makeWith(MixedSuccessApi, {
          baseUrl: "http://test",
          httpClient: clientFromResponse(() =>
            new Response(textStream([`event: token\ndata: {"text":"hello"}\n\n`]), {
              status: 200,
              headers: { "content-type": "text/event-stream; charset=utf-8" }
            })
          )
        })

        const stream = yield* client.test.chat({})
        if (!Stream.isStream(stream)) {
          throw new Error("Expected stream response")
        }
        const events = yield* Stream.runCollect(stream)
        assert.deepStrictEqual(events, [{ text: "hello" }])
      }))
  })

  describe("error responses", () => {
    const makeClient = (response: () => Response) =>
      HttpApiClient.makeWith(ErrorContentTypeApi, {
        baseUrl: "http://test",
        httpClient: clientFromResponse(response)
      })

    it.effect("selects schemas by normalized content type regardless of declaration order", () =>
      Effect.gen(function*() {
        for (const endpoint of ["textFirst", "jsonFirst"] as const) {
          const jsonClient = yield* makeClient(() =>
            new Response(JSON.stringify({ _tag: "JsonError", message: "bad request" }), {
              status: 400,
              headers: { "content-type": "Application/JSON; charset=utf-8" }
            })
          )
          const jsonError = yield* Effect.flip(jsonClient.test[endpoint]({}))
          assert.deepStrictEqual(jsonError, { _tag: "JsonError", message: "bad request" })

          const textClient = yield* makeClient(() =>
            new Response("bad request", {
              status: 400,
              headers: { "content-type": "text/plain" }
            })
          )
          const textError = yield* Effect.flip(textClient.test[endpoint]({}))
          assert.strictEqual(textError, "bad request")
        }
      }))

    it.effect("reports unsupported error response content types", () =>
      Effect.gen(function*() {
        const client = yield* makeClient(() =>
          new Response("<error />", {
            status: 400,
            headers: { "content-type": "application/xml" }
          })
        )

        const exit = yield* Effect.exit(client.test.textFirst({}))
        assert.strictEqual(exit._tag, "Failure")
        if (exit._tag === "Failure") {
          const errors: Array<unknown> = []
          for (const reason of exit.cause.reasons) {
            if (Cause.isFailReason(reason)) {
              errors.push(reason.error)
            }
          }
          assert.ok(
            errors.some((error) => HttpClientError.isHttpClientError(error) && error.reason._tag === "StatusCodeError")
          )
          const decodeError = errors.find((error) =>
            HttpClientError.isHttpClientError(error) && error.reason._tag === "DecodeError"
          )
          assert.ok(HttpClientError.isHttpClientError(decodeError))
          assert.strictEqual(decodeError.reason._tag, "DecodeError")
          assert.ok(decodeError.reason.description?.includes("Unsupported response content-type"))
        }
      }))

    it.effect("decodes no-content errors without a content-type header", () =>
      Effect.gen(function*() {
        const client = yield* makeClient(() => new Response(null, { status: 400 }))

        const error = yield* Effect.flip(client.test.noContent({}))
        assert.strictEqual(error, "NoContentError")
      }))

    it.effect("groups schemas by normalized declared content type", () =>
      Effect.gen(function*() {
        const client = yield* makeClient(() =>
          new Response(JSON.stringify({ _tag: "SecondJsonError", message: "bad request" }), {
            status: 400,
            headers: { "content-type": "application/problem+json" }
          })
        )

        const error = yield* Effect.flip(client.test.equivalentJson({}))
        assert.deepStrictEqual(error, { _tag: "SecondJsonError", message: "bad request" })
      }))
  })

  describe("urlBuilder", () => {
    const Api = HttpApi.make("Api")
      .add(
        HttpApiGroup.make("users")
          .add(
            HttpApiEndpoint.get("getUser", "/users/:id", {
              params: {
                id: Schema.Finite
              },
              query: {
                page: Schema.Finite,
                tags: Schema.Array(Schema.Finite)
              }
            }),
            HttpApiEndpoint.get("health", "/health")
          )
      )

    it("builds urls using endpoint schemas", () => {
      const builder = HttpApiClient.urlBuilder(Api, {
        baseUrl: "https://api.example.com"
      })

      strictEqual(
        builder.users.getUser({
          params: {
            id: 123
          },
          query: {
            page: 1,
            tags: [1, 2]
          }
        }),
        "https://api.example.com/users/123?page=1&tags=1&tags=2"
      )
    })

    it("encodes path parameters", () => {
      const Api = HttpApi.make("Api")
        .add(
          HttpApiGroup.make("stacks")
            .add(
              HttpApiEndpoint.get("listResources", "/state/stacks/:stack/stages/:stage/resources", {
                params: {
                  stack: Schema.String,
                  stage: Schema.String
                }
              })
            )
        )
      const builder = HttpApiClient.urlBuilder(Api, {
        baseUrl: "https://api.example.com"
      })

      strictEqual(
        builder.stacks.listResources({
          params: {
            stack: "a/b",
            stage: "prod/blue"
          }
        }),
        "https://api.example.com/state/stacks/a%2Fb/stages/prod%2Fblue/resources"
      )
    })

    it("omits missing optional path parameters", () => {
      const Api = HttpApi.make("Api")
        .add(
          HttpApiGroup.make("files")
            .add(
              HttpApiEndpoint.get("download", "/files/:path?", {
                params: {
                  path: Schema.optional(Schema.String)
                }
              })
            )
        )
      const builder = HttpApiClient.urlBuilder(Api, {
        baseUrl: "https://api.example.com"
      })

      strictEqual(
        builder.files.download({ params: {} }),
        "https://api.example.com/files"
      )
      strictEqual(
        builder.files.download({ params: { path: "a/b" } }),
        "https://api.example.com/files/a%2Fb"
      )
    })

    it("returns relative urls when baseUrl is omitted", () => {
      const builder = HttpApiClient.urlBuilder(Api)

      strictEqual(builder.users.health(), "/health")
    })

    it("supports top-level endpoints", () => {
      const TopLevelApi = HttpApi.make("Api")
        .add(
          HttpApiGroup.make("top", { topLevel: true })
            .add(
              HttpApiEndpoint.get("health", "/health")
            )
        )
        .prefix("/v1")

      const builder = HttpApiClient.urlBuilder(TopLevelApi, {
        baseUrl: "https://api.example.com"
      })

      strictEqual(builder.health(), "https://api.example.com/v1/health")
    })

    it("stores __proto__ identifiers as own properties", () => {
      const Api = HttpApi.make("Api").add(
        HttpApiGroup.make("__proto__").add(
          HttpApiEndpoint.get("__proto__", "/proto")
        )
      )
      const builder = HttpApiClient.urlBuilder(Api)

      assert.isTrue(Object.hasOwn(builder, "__proto__"))
      assert.isTrue(Object.hasOwn(builder["__proto__"], "__proto__"))
      strictEqual(builder["__proto__"]["__proto__"](), "/proto")
    })
  })

  it.effect("stores __proto__ client identifiers as own properties", () =>
    Effect.gen(function*() {
      const Api = HttpApi.make("Api").add(
        HttpApiGroup.make("__proto__").add(
          HttpApiEndpoint.get("__proto__", "/proto")
        )
      )
      const httpClient = clientFromResponse(() => new Response(null, { status: 204 }))
      const client = yield* HttpApiClient.makeWith(Api, { httpClient })
      const groupClient = yield* HttpApiClient.group(Api, {
        group: "__proto__",
        httpClient
      })

      assert.isTrue(Object.hasOwn(client, "__proto__"))
      assert.isTrue(Object.hasOwn(client["__proto__"], "__proto__"))
      assert.strictEqual(typeof client["__proto__"]["__proto__"], "function")
      assert.isTrue(Object.hasOwn(groupClient, "__proto__"))
      assert.strictEqual(typeof groupClient["__proto__"], "function")
    }))

  it.effect("applies transformClient to endpoint clients exactly once", () =>
    Effect.gen(function*() {
      const Api = HttpApi.make("Api").add(
        HttpApiGroup.make("test").add(HttpApiEndpoint.get("health", "/health"))
      )
      let transformations = 0
      const httpClient = HttpClient.make((request, url) =>
        Effect.sync(() => {
          strictEqual(url.toString(), "https://api.example.com/health")
          return HttpClientResponse.fromWeb(request, new Response(null, { status: 204 }))
        })
      )
      const health = yield* HttpApiClient.endpoint(Api, {
        group: "test",
        endpoint: "health",
        httpClient,
        transformClient: (client) => {
          transformations++
          return client.pipe(
            HttpClient.mapRequest(HttpClientRequest.prependUrl("https://api.example.com"))
          )
        }
      })

      yield* health({ responseMode: "response-only" })
      yield* health({ responseMode: "response-only" })

      strictEqual(transformations, 1)
    }))

  it.effect("encodes path parameters when executing requests", () =>
    Effect.gen(function*() {
      const Api = HttpApi.make("Api")
        .add(
          HttpApiGroup.make("stacks")
            .add(
              HttpApiEndpoint.get("listResources", "/state/stacks/:stack/stages/:stage/resources", {
                params: {
                  stack: Schema.String,
                  stage: Schema.String
                }
              })
            )
        )
      const httpClient = HttpClient.make((request, url) =>
        Effect.sync(() => {
          strictEqual(url.toString(), "https://api.example.com/state/stacks/a%2Fb/stages/prod%2Fblue/resources")
          return HttpClientResponse.fromWeb(request, new Response(null, { status: 204 }))
        })
      )
      const client = yield* HttpApiClient.makeWith(Api, {
        httpClient,
        baseUrl: "https://api.example.com"
      })

      yield* client.stacks.listResources({
        params: {
          stack: "a/b",
          stage: "prod/blue"
        },
        responseMode: "response-only"
      })
    }))

  it.effect("omits optional path parameters when executing requests", () =>
    Effect.gen(function*() {
      const Api = HttpApi.make("Api")
        .add(
          HttpApiGroup.make("files")
            .add(
              HttpApiEndpoint.get("download", "/files/:path?", {
                params: {
                  path: Schema.optional(Schema.String)
                }
              })
            )
        )
      const urls: Array<string> = []
      const httpClient = HttpClient.make((request, url) =>
        Effect.sync(() => {
          urls.push(url.toString())
          return HttpClientResponse.fromWeb(request, new Response(null, { status: 204 }))
        })
      )
      const client = yield* HttpApiClient.makeWith(Api, {
        httpClient,
        baseUrl: "https://api.example.com"
      })

      yield* client.files.download({
        params: {},
        responseMode: "response-only"
      })
      yield* client.files.download({
        params: { path: "a/b" },
        responseMode: "response-only"
      })

      strictEqual(urls[0], "https://api.example.com/files")
      strictEqual(urls[1], "https://api.example.com/files/a%2Fb")
    }))
})

const textEncoder = new TextEncoder()

const StreamError = Schema.Struct({ reason: Schema.String })

const Events = Schema.Struct({
  event: Schema.String,
  data: Schema.String
})

class EndpointError extends Schema.TaggedErrorClass<EndpointError>()("EndpointError", {
  message: Schema.String
}, { httpApiStatus: 400 }) {}

const MixedSuccess = Schema.Struct({
  message: Schema.String
})

const MixedEventData = Schema.Struct({
  text: Schema.String
})

const StreamingApi = HttpApi.make("StreamingApi").add(
  HttpApiGroup.make("test")
    .add(
      HttpApiEndpoint.get("events", "/events", {
        success: HttpApiSchema.StreamSse({ events: Events, error: StreamError }),
        error: EndpointError
      }),
      HttpApiEndpoint.get("download", "/download", {
        success: HttpApiSchema.StreamUint8Array(),
        error: EndpointError
      })
    )
)

const AnnotatedStreamingApi = HttpApi.make("AnnotatedStreamingApi").add(
  HttpApiGroup.make("test")
    .add(
      HttpApiEndpoint.get("events", "/events", {
        success: HttpApiSchema.status(202)(HttpApiSchema.StreamSse({ events: Events, error: StreamError }))
      }),
      HttpApiEndpoint.get("download", "/download", {
        success: HttpApiSchema.status(206)(HttpApiSchema.StreamUint8Array())
      })
    )
)

const MixedSuccessApi = HttpApi.make("MixedSuccessApi").add(
  HttpApiGroup.make("test")
    .add(
      HttpApiEndpoint.get("chat", "/chat", {
        success: [
          MixedSuccess,
          HttpApiSchema.StreamSse({ data: MixedEventData, error: StreamError })
        ]
      })
    )
)

const JsonResponseError = Schema.Struct({
  _tag: Schema.Literal("JsonError"),
  message: Schema.String
}).pipe(HttpApiSchema.status(400))

const TextResponseError = Schema.String.pipe(
  HttpApiSchema.asText(),
  HttpApiSchema.status(400)
)

const NoContentResponseError = Schema.Literal("NoContentError").pipe(
  HttpApiSchema.asNoContent({ decode: () => "NoContentError" as const }),
  HttpApiSchema.status(400)
)

const FirstJsonResponseError = Schema.Struct({
  _tag: Schema.Literal("FirstJsonError"),
  code: Schema.Number
}).pipe(
  HttpApiSchema.asJson({ contentType: "Application/Problem+JSON" }),
  HttpApiSchema.status(400)
)

const SecondJsonResponseError = Schema.Struct({
  _tag: Schema.Literal("SecondJsonError"),
  message: Schema.String
}).pipe(
  HttpApiSchema.asJson({ contentType: "application/problem+json; charset=utf-8" }),
  HttpApiSchema.status(400)
)

const ErrorContentTypeApi = HttpApi.make("ErrorContentTypeApi").add(
  HttpApiGroup.make("test")
    .add(
      HttpApiEndpoint.get("textFirst", "/text-first", {
        error: [TextResponseError, JsonResponseError]
      }),
      HttpApiEndpoint.get("jsonFirst", "/json-first", {
        error: [JsonResponseError, TextResponseError]
      }),
      HttpApiEndpoint.get("noContent", "/no-content", {
        error: [NoContentResponseError, TextResponseError]
      }),
      HttpApiEndpoint.get("equivalentJson", "/equivalent-json", {
        error: [FirstJsonResponseError, SecondJsonResponseError]
      })
    )
)

const clientFromResponse = (response: () => Response): HttpClient.HttpClient =>
  HttpClient.make((request): Effect.Effect<HttpClientResponse.HttpClientResponse, never, never> =>
    Effect.succeed(HttpClientResponse.fromWeb(request, response()))
  )

const textStream = (chunks: ReadonlyArray<string>): ReadableStream<Uint8Array> => {
  let index = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index === chunks.length) {
        controller.close()
      } else {
        controller.enqueue(textEncoder.encode(chunks[index++]!))
      }
    }
  })
}

const byteStream = (chunks: ReadonlyArray<Uint8Array>): ReadableStream<Uint8Array> => {
  let index = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index === chunks.length) {
        controller.close()
      } else {
        controller.enqueue(chunks[index++]!)
      }
    }
  })
}
