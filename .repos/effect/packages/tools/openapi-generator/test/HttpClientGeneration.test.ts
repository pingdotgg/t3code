import * as OpenApiGenerator from "@effect/openapi-generator/OpenApiGenerator"
import { assert, describe, it } from "@effect/vitest"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Sse from "effect/encoding/Sse"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/http-api"
import type { OpenAPISpec } from "effect/http-api/OpenApi"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientError from "effect/http/HttpClientError"
import * as HttpClientRequest from "effect/http/HttpClientRequest"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import { rolldown } from "rolldown"

const modules = {
  "effect/Data": Data,
  "effect/Effect": Effect,
  "effect/Schema": Schema,
  "effect/Stream": Stream,
  "effect/encoding/Sse": Sse,
  "effect/http/HttpClient": HttpClient,
  "effect/http/HttpClientError": HttpClientError,
  "effect/http/HttpClientRequest": HttpClientRequest,
  "effect/http/HttpClientResponse": HttpClientResponse
}

type TransformClient = (client: HttpClient.HttpClient) => Effect.Effect<HttpClient.HttpClient>

async function loadClient<
  Client = {
    readStream: () => Stream.Stream<unknown, HttpClientError.HttpClientError>
    readSse: () => Stream.Stream<unknown, HttpClientError.HttpClientError>
  }
>(source: string) {
  const bundle = await rolldown({
    input: "client.ts",
    external: (id) => id !== "client.ts",
    plugins: [{
      name: "generated-client",
      resolveId: (id) => id === "client.ts" ? id : undefined,
      load: (id) => id === "client.ts" ? source : undefined
    }]
  })
  try {
    const { output } = await bundle.generate({ format: "cjs" })
    const compiled = output[0]
    assert.strictEqual(compiled.type, "chunk")
    const exports = {} as {
      make: (httpClient: HttpClient.HttpClient, options?: { transformClient: TransformClient }) => Client
    }
    new Function("require", "exports", compiled.code)(
      (id: keyof typeof modules) => {
        assert.property(modules, id)
        return modules[id]
      },
      exports
    )
    return exports.make
  } finally {
    await bundle.close()
  }
}

const paths = [
  { format: "httpclient", encoding: "binary" },
  { format: "httpclient", encoding: "sse-data" },
  { format: "httpclient", encoding: "sse-event" },
  { format: "httpclient-type-only", encoding: "binary" },
  { format: "httpclient-type-only", encoding: "sse-data" }
] as const

describe("HttpClient generation", () => {
  it.effect.each(["httpclient", "httpclient-type-only"] as const)(
    "types and sends the multipart alternative in %s",
    (format) =>
      Effect.gen(function*() {
        const spec = OpenApi.fromApi(
          HttpApi.make("Api").add(
            HttpApiGroup.make("forms", { topLevel: true }).add(
              HttpApiEndpoint.post("submit", "/submit", {
                payload: [
                  Schema.Struct({ note: Schema.String }).pipe(HttpApiSchema.asMultipart()),
                  Schema.Struct({ code: Schema.String }).pipe(HttpApiSchema.asFormUrlEncoded())
                ]
              })
            )
          )
        )
        const generator = yield* OpenApiGenerator.OpenApiGenerator
        const source = yield* generator.generate(spec, { name: "TestClient", format })
        const payloadType = format === "httpclient" ? "typeof SubmitRequestFormData.Encoded" : "SubmitRequestFormData"
        assert.include(source, `readonly payload: ${payloadType}`)

        const make = yield* Effect.promise(() =>
          loadClient<{ submit: (options: { payload: { note: string } }) => Effect.Effect<unknown> }>(source)
        )
        const client = make(
          HttpClient.make((request) => {
            assert(request.body._tag === "FormData")
            assert.strictEqual(request.body.formData.get("note"), "hello")
            return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status: 204 })))
          }).pipe(HttpClient.mapRequest(HttpClientRequest.prependUrl("https://example.com")))
        )
        yield* client.submit({ payload: { note: "hello" } })
      }).pipe(Effect.provide(
        format === "httpclient" ? OpenApiGenerator.layerTransformerSchema : OpenApiGenerator.layerTransformerTs
      ))
  )

  it.effect("returns only the body when a nullable response config is undefined", () =>
    Effect.gen(function*() {
      const spec: OpenAPISpec = {
        openapi: "3.1.0",
        info: { title: "Nullable include response", version: "1.0.0" },
        components: { schemas: {}, securitySchemes: {} },
        security: [],
        tags: [],
        paths: {
          "/value": {
            get: {
              operationId: "getValue",
              parameters: [],
              tags: ["Value"],
              security: [],
              responses: {
                "200": {
                  description: "Value",
                  content: { "application/json": { schema: { type: "string" } } }
                }
              }
            }
          }
        }
      }
      for (const format of ["httpclient", "httpclient-type-only"] as const) {
        const source = yield* Effect.gen(function*() {
          const generator = yield* OpenApiGenerator.OpenApiGenerator
          return yield* generator.generate(spec, { name: "TestClient", format })
        }).pipe(Effect.provide(
          format === "httpclient"
            ? OpenApiGenerator.layerTransformerSchema
            : OpenApiGenerator.layerTransformerTs
        ))
        const make = yield* Effect.promise(() =>
          loadClient<{
            getValue: (options?: { config?: { includeResponse?: boolean } | undefined }) => Effect.Effect<unknown>
          }>(source)
        )
        const client = make(
          HttpClient.make((request) =>
            Effect.succeed(HttpClientResponse.fromWeb(request, new Response(JSON.stringify("hello"))))
          ).pipe(HttpClient.mapRequest(HttpClientRequest.prependUrl("https://example.com")))
        )

        const body = yield* client.getValue({ config: undefined })
        assert.strictEqual(body, "hello")

        const withResponse = yield* client.getValue({ config: { includeResponse: true } })
        if (!Array.isArray(withResponse)) throw new Error("Expected response tuple")
        assert.strictEqual(withResponse[0], "hello")
        assert.strictEqual((withResponse[1] as HttpClientResponse.HttpClientResponse).status, 200)
      }
    }))

  it.effect("joins non-exploded form query arrays", () =>
    Effect.gen(function*() {
      const generator = yield* OpenApiGenerator.OpenApiGenerator
      const source = yield* generator.generate({
        openapi: "3.1.0",
        info: { title: "Items", version: "1.0.0" },
        paths: {
          "/items": {
            get: {
              operationId: "list",
              parameters: [
                { name: "tags", in: "query", explode: false, schema: { type: "array" } },
                { name: "ids", in: "query", schema: { type: "array" } }
              ],
              responses: { "204": { description: "No content" } }
            }
          }
        }
      } as unknown as OpenAPISpec, { name: "TestClient", format: "httpclient-type-only" })
      const make = yield* Effect.promise(() =>
        loadClient<{ list: (options: { params: object }) => Effect.Effect<unknown> }>(source)
      )
      let search = ""
      const client = make(
        HttpClient.make((request, url) => {
          search = url.search
          return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status: 204 })))
        }).pipe(HttpClient.mapRequest(HttpClientRequest.prependUrl("https://example.com")))
      )
      yield* client.list({ params: { tags: ["a", "b"], ids: [1, 2] } })
      assert.strictEqual(search, "?tags=a%2Cb&ids=1&ids=2")
    }).pipe(Effect.provide(OpenApiGenerator.layerTransformerTs)))

  describe("path parameters", () => {
    it.effect("rejects unsupported path parameter styles during generation", () =>
      Effect.gen(function*() {
        const generator = yield* OpenApiGenerator.OpenApiGenerator
        for (const format of ["httpclient", "httpclient-type-only"] as const) {
          const error = yield* generator.generate({
            openapi: "3.0.3",
            info: { title: "Unsupported style", version: "1.0.0" },
            paths: {
              "/rooms/{ids}": {
                get: {
                  parameters: [{ name: "ids", in: "path", required: true, style: "form", schema: { type: "array" } }],
                  responses: { "204": { description: "OK" } }
                }
              }
            }
          } as unknown as OpenAPISpec, { name: "TestClient", format }).pipe(
            Effect.flip,
            Effect.catchDefect(Effect.succeed)
          )
          assert.instanceOf(error, Error)
          assert.strictEqual(
            String(error),
            "Error: Unsupported path parameter style \"form\" for \"ids\" in \"/rooms/{ids}\""
          )
        }
      }).pipe(Effect.provide(OpenApiGenerator.layerTransformerTs)))

    it.effect("serializes scalars and arrays using the parameter style and explode settings", () =>
      Effect.gen(function*() {
        const cases = [
          { value: [3, 4, 5], expected: "3,4,5" },
          { style: "simple", explode: false, value: ["a,b", "c/d"], expected: "a%2Cb,c%2Fd" },
          { style: "simple", explode: true, value: ["a,b", "c/d"], expected: "a%2Cb,c%2Fd" },
          { style: "label", explode: false, value: ["a,b", "c/d"], expected: ".a%2Cb,c%2Fd" },
          { style: "label", explode: true, value: ["a,b", "c/d"], expected: ".a%2Cb.c%2Fd" },
          { style: "matrix", explode: false, value: ["a,b", "c/d"], expected: ";ids=a%2Cb,c%2Fd" },
          { style: "matrix", explode: true, value: ["a,b", "c/d"], expected: ";ids=a%2Cb;ids=c%2Fd" },
          { style: "matrix", explode: true, value: ["", "x"], expected: ";ids;ids=x" },
          { value: "!'()*", expected: "%21%27%28%29%2A" },
          { value: 42, expected: "42" },
          { style: "label", value: "a/b", expected: ".a%2Fb" },
          { style: "matrix", value: false, expected: ";ids=false" }
        ]
        const spec = {
          openapi: "3.0.3",
          info: { title: "Path parameters", version: "1.0.0" },
          paths: Object.fromEntries(cases.map(({ explode, style, value }, index) => [
            `/case${index}/{ids}`,
            {
              get: {
                operationId: `case${index}`,
                parameters: [{
                  name: "ids",
                  in: "path",
                  required: true,
                  style,
                  explode,
                  schema: Array.isArray(value)
                    ? { type: "array", items: { type: typeof value[0] === "number" ? "integer" : "string" } }
                    : { type: typeof value === "number" ? "integer" : typeof value }
                }],
                responses: {
                  "200": {
                    description: "OK",
                    content: { "application/octet-stream": { schema: { type: "string" } } }
                  }
                }
              }
            }
          ]))
        } as unknown as OpenAPISpec
        const generator = yield* OpenApiGenerator.OpenApiGenerator
        for (const format of ["httpclient", "httpclient-type-only"] as const) {
          const source = yield* generator.generate(spec, { name: "TestClient", format })
          const make = yield* Effect.promise(() =>
            loadClient<
              Record<string, (value: unknown) => Effect.Effect<unknown, HttpClientError.HttpClientError>> & {
                case0Stream: (value: unknown) => Stream.Stream<unknown, HttpClientError.HttpClientError>
              }
            >(source)
          )
          const urls: Array<string> = []
          const client = make(
            HttpClient.make((request, url) => {
              urls.push(url.pathname)
              return Effect.succeed(HttpClientResponse.fromWeb(request, new Response("")))
            }).pipe(HttpClient.mapRequest(HttpClientRequest.prependUrl("https://example.com")))
          )
          for (const [index, { expected, value }] of cases.entries()) {
            yield* client[`case${index}`](value)
            assert.strictEqual(urls.at(-1), `/case${index}/${expected}`, format)
          }
          yield* Stream.runDrain(client.case0Stream([3, 4, 5]))
          assert.strictEqual(urls.at(-1), "/case0/3,4,5")
          const sent = urls.length
          for (const value of [[], [""], [".."], [[1]], {}, null, ["\uD800"]]) {
            const error = yield* Effect.flip(client.case0(value))
            assert.instanceOf(error, HttpClientError.HttpClientError)
            assert.instanceOf(error.reason, HttpClientError.InvalidUrlError)
          }
          const streamError = yield* Effect.flip(Stream.runDrain(client.case0Stream([".."])))
          assert.instanceOf(streamError.reason, HttpClientError.InvalidUrlError)
          assert.strictEqual(urls.length, sent)
        }
      }).pipe(Effect.provide(OpenApiGenerator.layerTransformerTs)))

    const generate = Effect.gen(function*() {
      const generator = yield* OpenApiGenerator.OpenApiGenerator
      const source = yield* generator.generate({
        openapi: "3.1.0",
        info: { title: "Files", version: "1.0.0" },
        components: { schemas: {}, securitySchemes: {} },
        security: [],
        tags: [],
        paths: {
          "/files/{id}/content": {
            get: {
              operationId: "read",
              parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
              tags: ["Files"],
              security: [],
              responses: {
                "200": {
                  description: "File contents",
                  content: { "application/octet-stream": { schema: { type: "string" } } }
                }
              }
            }
          }
        }
      }, { name: "TestClient", format: "httpclient-type-only" })
      return yield* Effect.promise(() =>
        loadClient<{
          read: (id: string) => Effect.Effect<unknown, HttpClientError.HttpClientError>
          readStream: (id: string) => Stream.Stream<unknown, HttpClientError.HttpClientError>
        }>(source)
      )
    }).pipe(Effect.provide(OpenApiGenerator.layerTransformerTs))

    it.effect("percent-encodes each parameter as one path segment", () =>
      Effect.gen(function*() {
        const make = yield* generate
        const urls: Array<string> = []
        const client = make(
          HttpClient.make((request, url) => {
            urls.push(url.href)
            return Effect.succeed(HttpClientResponse.fromWeb(request, new Response("")))
          }).pipe(HttpClient.mapRequest(HttpClientRequest.prependUrl("https://example.com")))
        )
        for (
          const [value, encoded] of [
            ["alice", "alice"],
            ["../a/b?c#d\\e%20", "..%2Fa%2Fb%3Fc%23d%5Ce%2520"],
            ["hello world/é", "hello%20world%2F%C3%A9"]
          ]
        ) {
          yield* client.read(value)
          assert.strictEqual(urls.at(-1), `https://example.com/files/${encoded}/content`)
        }
        assert.strictEqual(urls.length, 3)
      }))

    it.effect("rejects empty and dot parameters with a typed error before sending", () =>
      Effect.gen(function*() {
        const make = yield* generate
        let requests = 0
        const client = make(
          HttpClient.make(() => {
            requests++
            return Effect.die("Unexpected request")
          }).pipe(HttpClient.mapRequest(HttpClientRequest.prependUrl("https://example.com")))
        )
        for (const value of ["", ".", ".."]) {
          const error = yield* Effect.flip(client.read(value))
          assert.instanceOf(error, HttpClientError.HttpClientError)
          assert.instanceOf(error.reason, HttpClientError.InvalidUrlError)
        }
        assert.strictEqual(requests, 0)
      }))

    it.effect("propagates path rejection through the stream error channel", () =>
      Effect.gen(function*() {
        const make = yield* generate
        let requests = 0
        const client = make(
          HttpClient.make(() => {
            requests++
            return Effect.die("Unexpected request")
          }).pipe(HttpClient.mapRequest(HttpClientRequest.prependUrl("https://example.com")))
        )
        const error = yield* Effect.flip(Stream.runCollect(client.readStream("..")))
        assert.instanceOf(error, HttpClientError.HttpClientError)
        assert.instanceOf(error.reason, HttpClientError.InvalidUrlError)
        assert.strictEqual(requests, 0)
      }))
  })

  for (const { encoding, format } of paths) {
    const binary = encoding === "binary"
    const body = binary
      ? "download"
      : encoding === "sse-event"
      ? "event: message\nid: 1\ndata: hello\n\n"
      : "event: message\nid: 1\ndata: \"hello\"\n\n"
    const expected = binary
      ? [new TextEncoder().encode(body)]
      : format === "httpclient-type-only"
      ? ["hello"]
      : [{ event: "message", id: "1", data: "hello" }]
    const spec: OpenAPISpec = {
      openapi: "3.1.0",
      info: { title: "Streaming API", version: "1.0.0" },
      components: { schemas: {}, securitySchemes: {} },
      security: [],
      tags: [],
      paths: {
        "/read": {
          get: {
            operationId: "read",
            parameters: [],
            tags: ["Streams"],
            security: [],
            responses: {
              "200": {
                description: "Success",
                content: {
                  [binary ? "application/octet-stream" : "text/event-stream"]: {
                    schema: encoding === "sse-event"
                      ? {
                        type: "object",
                        properties: {
                          id: { anyOf: [{ type: "string" }, { type: "null" }] },
                          event: { const: "message" },
                          data: { type: "string" }
                        },
                        required: ["id", "event", "data"],
                        additionalProperties: false
                      }
                      : { type: "string" },
                    ...(encoding === "sse-event"
                      ? {
                        "x-effect-stream": {
                          encoding: "sse",
                          errorSchema: {},
                          causeSchema: {},
                          failureEvent: "effect/http-api/stream/failure"
                        }
                      }
                      : {})
                  }
                }
              }
            }
          }
        }
      }
    }
    const generate = Effect.gen(function*() {
      const generator = yield* OpenApiGenerator.OpenApiGenerator
      const source = yield* generator.generate(spec, { name: "TestClient", format })
      return yield* Effect.promise(() => loadClient(source))
    }).pipe(Effect.provide(
      format === "httpclient" ? OpenApiGenerator.layerTransformerSchema : OpenApiGenerator.layerTransformerTs
    ))

    describe(`${format} ${encoding}`, () => {
      it.effect("defers transformation and applies fresh headers on each consumption", () =>
        Effect.gen(function*() {
          const make = yield* generate
          const requests: Array<HttpClientRequest.HttpClientRequest> = []
          let transforms = 0
          let transformEffects = 0
          const httpClient = HttpClient.make((request) => {
            requests.push(request)
            return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(body)))
          }).pipe(HttpClient.mapRequest(HttpClientRequest.prependUrl("https://example.com")))
          const client = make(httpClient, {
            transformClient: (client) => {
              transforms++
              return Effect.sync(() => {
                transformEffects++
                return HttpClient.mapRequest(client, HttpClientRequest.setHeader("x-transformed", String(transforms)))
              })
            }
          })
          const stream = binary ? client.readStream() : client.readSse()
          assert.strictEqual(transforms, 0)
          assert.strictEqual(transformEffects, 0)
          assert.deepStrictEqual(requests, [])
          for (let run = 1; run <= 2; run++) {
            assert.deepStrictEqual(yield* Stream.runCollect(stream), expected)
            assert.strictEqual(requests.length, run)
            assert.strictEqual(requests[run - 1].headers["x-transformed"], String(run))
            assert.strictEqual(transforms, run)
            assert.strictEqual(transformEffects, run)
          }
        }))

      it.effect("filters the response returned by the transformed client", () =>
        Effect.gen(function*() {
          const make = yield* generate
          const httpClient = HttpClient.make((request) =>
            Effect.succeed(HttpClientResponse.fromWeb(request, new Response(body)))
          ).pipe(HttpClient.mapRequest(HttpClientRequest.prependUrl("https://example.com")))
          const client = make(httpClient, {
            transformClient: (client) =>
              Effect.succeed(HttpClient.transformResponse(
                client,
                Effect.map((response) =>
                  HttpClientResponse.fromWeb(response.request, new Response(body, { status: 403 }))
                )
              ))
          })
          const stream = binary ? client.readStream() : client.readSse()
          const error = yield* Effect.flip(Stream.runCollect(stream))
          assert.strictEqual(error._tag, "HttpClientError")
          assert.strictEqual(error.reason._tag, "StatusCodeError")
          if (error.reason._tag === "StatusCodeError") {
            assert.strictEqual(error.reason.response.status, 403)
          }
        }))

      for (const status of [200, 403]) {
        it.effect(`preserves status ${status} handling without a transform`, () =>
          Effect.gen(function*() {
            const make = yield* generate
            let requests = 0
            const httpClient = HttpClient.make((request) => {
              requests++
              return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(body, { status })))
            }).pipe(HttpClient.mapRequest(HttpClientRequest.prependUrl("https://example.com")))
            const client = make(httpClient)
            const stream = binary ? client.readStream() : client.readSse()
            assert.strictEqual(requests, 0)
            if (status === 200) {
              assert.deepStrictEqual(yield* Stream.runCollect(stream), expected)
            } else {
              const error = yield* Effect.flip(Stream.runCollect(stream))
              assert.strictEqual(error.reason._tag, "StatusCodeError")
            }
            assert.strictEqual(requests, 1)
          }))
      }
    })
  }
})
