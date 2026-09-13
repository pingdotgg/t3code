import { assert, it, vi } from "@effect/vitest"
import {
  Cause,
  DateTime,
  Effect,
  FileSystem,
  Layer,
  Path,
  Redacted,
  Schema,
  SchemaTransformation,
  Stream
} from "effect"
import { Etag, HttpPlatform } from "effect/unstable/http"
import {
  HttpApi,
  HttpApiBuilder,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiMiddleware,
  HttpApiSchema,
  HttpApiSecurity,
  HttpApiTest
} from "effect/unstable/httpapi"

const textDecoder = new TextDecoder()

const StreamError = Schema.Struct({ reason: Schema.String })

const TestServices = Layer.mergeAll(
  Path.layer,
  Etag.layerWeak,
  HttpPlatform.layer
).pipe(Layer.provideMerge(FileSystem.layerNoop({})))

it.layer(TestServices)("HttpApiBuilder query parameters", (it) => {
  it.effect("round trips array query parameters with one or more values", () =>
    Effect.gen(function*() {
      const Api = HttpApi.make("Api").add(
        HttpApiGroup.make("test").add(
          HttpApiEndpoint.get("list", "/list", {
            query: { ids: Schema.Array(Schema.String) },
            success: Schema.Struct({ ids: Schema.Array(Schema.String) })
          })
        )
      )
      const GroupLayer = HttpApiBuilder.group(
        Api,
        "test",
        (handlers) => handlers.handle("list", ({ query }) => Effect.succeed(query))
      )

      const client = yield* HttpApiTest.groups(Api, ["test"]).pipe(Effect.provide(GroupLayer))
      const multiple = yield* client.test.list({ query: { ids: ["a", "b"] } })
      const single = yield* client.test.list({ query: { ids: ["a"] } })

      assert.deepStrictEqual(multiple, { ids: ["a", "b"] })
      assert.deepStrictEqual(single, { ids: ["a"] })
    }))
})

it.effect("reuses response schema transformations by source AST", () => {
  const SharedSuccess = Schema.String.pipe(HttpApiSchema.asText())
  const DistinctSuccess = Schema.String.pipe(HttpApiSchema.asText({ contentType: "text/custom" }))
  const Api = HttpApi.make("Api").add(
    HttpApiGroup.make("test")
      .add(HttpApiEndpoint.get("first", "/first", { success: SharedSuccess }))
      .add(HttpApiEndpoint.get("second", "/second", { success: SharedSuccess }))
      .add(HttpApiEndpoint.get("distinct", "/distinct", { success: DistinctSuccess }))
  )
  const GroupLayer = HttpApiBuilder.group(
    Api,
    "test",
    (handlers) =>
      handlers
        .handle("first", () => Effect.succeed("first"))
        .handle("second", () => Effect.succeed("second"))
        .handle("distinct", () => Effect.succeed("distinct"))
  )

  return Effect.acquireUseRelease(
    Effect.sync(() => vi.spyOn(Schema, "decodeTo")),
    (decodeTo) =>
      Effect.gen(function*() {
        yield* Effect.scoped(Layer.build(GroupLayer))
        const responseSchemaCalls = decodeTo.mock.calls.filter(
          ([schema]) => schema === SharedSuccess || schema === DistinctSuccess
        )
        assert.strictEqual(responseSchemaCalls.length, 2)
      }),
    (decodeTo) => Effect.sync(() => decodeTo.mockRestore())
  )
})

it.layer(TestServices)("HttpApiBuilder payload content types", (it) => {
  it.effect("round trips mixed-case media types with declared and received parameters", () =>
    Effect.gen(function*() {
      const Payload = Schema.Struct({ name: Schema.String }).pipe(
        HttpApiSchema.asJson({
          contentType: "Application/Vnd.Effect+JSON; profile=declared"
        })
      )
      const Api = HttpApi.make("Api").add(
        HttpApiGroup.make("test").add(
          HttpApiEndpoint.post("create", "/create", {
            headers: {
              "content-type": Schema.optional(Schema.String)
            },
            payload: Payload,
            success: Schema.Struct({ name: Schema.String })
          })
        )
      )
      const GroupLayer = HttpApiBuilder.group(
        Api,
        "test",
        (handlers) => handlers.handle("create", ({ payload }) => Effect.succeed(payload))
      )

      const client = yield* HttpApiTest.groups(Api, ["test"]).pipe(Effect.provide(GroupLayer))
      const declared = yield* client.test.create({
        headers: {},
        payload: { name: "Ada" }
      })
      const received = yield* client.test.create({
        headers: {
          "content-type": "application/vnd.effect+json; profile=received"
        },
        payload: { name: "Grace" }
      })

      assert.deepStrictEqual(declared, { name: "Ada" })
      assert.deepStrictEqual(received, { name: "Grace" })
    }))

  it.effect("round trips custom form-urlencoded media types", () =>
    Effect.gen(function*() {
      const Payload = Schema.Struct({ name: Schema.String }).pipe(
        HttpApiSchema.asFormUrlEncoded({ contentType: "application/vnd.effect.form" })
      )
      const Api = HttpApi.make("Api").add(
        HttpApiGroup.make("test").add(
          HttpApiEndpoint.post("create", "/create", {
            payload: Payload,
            success: Schema.Struct({ name: Schema.String })
          })
        )
      )
      const GroupLayer = HttpApiBuilder.group(
        Api,
        "test",
        (handlers) => handlers.handle("create", ({ payload }) => Effect.succeed(payload))
      )

      const client = yield* HttpApiTest.groups(Api, ["test"]).pipe(Effect.provide(GroupLayer))
      const result = yield* client.test.create({ payload: { name: "Ada" } })

      assert.deepStrictEqual(result, { name: "Ada" })
    }))
})

it.layer(TestServices)("HttpApiBuilder WithHeaders responses", (it) => {
  it.effect("encodes WithHeaders using the schema for the response status", () =>
    Effect.gen(function*() {
      const encodedHeader = (prefix: string) =>
        Schema.String.pipe(
          Schema.decodeTo(
            Schema.String,
            SchemaTransformation.transform({
              decode: (value) => value,
              encode: (value) => `${prefix}:${value}`
            })
          )
        )
      const Ok = HttpApiSchema.WithHeaders(
        Schema.TaggedStruct("Ok", {}),
        { "x-source": encodedHeader("ok") }
      )
      const Created = HttpApiSchema.WithHeaders(
        Schema.TaggedStruct("Created", {}).pipe(HttpApiSchema.status(201)),
        { "x-source": encodedHeader("created") }
      )
      const Api = HttpApi.make("Api").add(
        HttpApiGroup.make("test").add(
          HttpApiEndpoint.get("result", "/test", { success: [Ok, Created] })
        )
      )
      const GroupLayer = HttpApiBuilder.group(
        Api,
        "test",
        (handlers) =>
          handlers.handle("result", () =>
            Effect.succeed(HttpApiSchema.withHeaders({
              body: { _tag: "Created" as const },
              headers: { "x-source": "value" }
            })))
      )

      const client = yield* HttpApiTest.groups(Api, ["test"]).pipe(Effect.provide(GroupLayer))
      const response = yield* client.test.result({ responseMode: "response-only" })

      assert.strictEqual(response.status, 201)
      assert.strictEqual(response.headers["x-source"], "created:value")
    }))

  it.effect("encodes a branded response against the header-carrying member when body shapes overlap", () =>
    Effect.gen(function*() {
      const Api = HttpApi.make("Api").add(
        HttpApiGroup.make("test").add(
          HttpApiEndpoint.get("result", "/test", {
            success: [
              Schema.Struct({ value: Schema.String }).pipe(HttpApiSchema.status(201)),
              HttpApiSchema.WithHeaders(
                Schema.Struct({ value: Schema.String }),
                { "x-source": Schema.String }
              )
            ]
          })
        )
      )
      const GroupLayer = HttpApiBuilder.group(
        Api,
        "test",
        (handlers) =>
          handlers.handle("result", () =>
            Effect.succeed(HttpApiSchema.withHeaders({
              body: { value: "wrapped" },
              headers: { "x-source": "value" }
            })))
      )

      const client = yield* HttpApiTest.groups(Api, ["test"]).pipe(Effect.provide(GroupLayer))
      const response = yield* client.test.result({ responseMode: "response-only" })

      assert.strictEqual(response.status, 200)
      assert.strictEqual(response.headers["x-source"], "value")
    }))

  it.effect("fails with a Body schema error when a branded response body matches no header-carrying member", () =>
    Effect.gen(function*() {
      const Api = HttpApi.make("Api").add(
        HttpApiGroup.make("test").add(
          HttpApiEndpoint.get("result", "/test", {
            success: [
              HttpApiSchema.WithHeaders(
                Schema.TaggedStruct("A", {}),
                { "x-source": Schema.String }
              ),
              Schema.TaggedStruct("B", {}).pipe(HttpApiSchema.status(201))
            ]
          })
        )
      )
      const GroupLayer = HttpApiBuilder.group(
        Api,
        "test",
        (handlers) =>
          handlers.handle("result", () =>
            Effect.succeed(HttpApiSchema.withHeaders({
              body: { _tag: "B" as const },
              headers: { "x-source": "value" }
            }) as any))
      )

      const client = yield* HttpApiTest.groups(Api, ["test"]).pipe(Effect.provide(GroupLayer))
      const exit = yield* Effect.exit(client.test.result({ responseMode: "response-only" }))

      assert.strictEqual(exit._tag, "Failure")
      if (exit._tag === "Failure") {
        const error = Cause.squash(exit.cause) as any
        assert.strictEqual(error._tag, "HttpApiSchemaError")
        assert.strictEqual(error.kind, "Body")
      }
    }))

  it.effect("round trips user-managed header codecs through HttpApiTest", () =>
    Effect.gen(function*() {
      const Api = HttpApi.make("Api").add(
        HttpApiGroup.make("test").add(
          HttpApiEndpoint.get("result", "/test", {
            disableCodecs: true,
            success: HttpApiSchema.WithHeaders(
              Schema.String.pipe(HttpApiSchema.asText()),
              { "x-count": Schema.FiniteFromString }
            )
          })
        )
      )
      const GroupLayer = HttpApiBuilder.group(
        Api,
        "test",
        (handlers) =>
          handlers.handle("result", () =>
            Effect.succeed(HttpApiSchema.withHeaders({
              body: "ok",
              headers: { "x-count": 2 }
            })))
      )

      const client = yield* HttpApiTest.groups(Api, ["test"]).pipe(Effect.provide(GroupLayer))
      const result = yield* client.test.result({})

      assert.deepStrictEqual(
        result,
        HttpApiSchema.withHeaders({ body: "ok", headers: { "x-count": 2 } })
      )
    }))

  it.effect("passes through string-shaped WithHeaders when endpoint codecs are disabled", () =>
    Effect.gen(function*() {
      const Api = HttpApi.make("Api").add(
        HttpApiGroup.make("test")
          .add(
            HttpApiEndpoint.get("success", "/success", {
              disableCodecs: true,
              success: HttpApiSchema.WithHeaders(
                Schema.String.pipe(HttpApiSchema.asText()),
                { "x-count": Schema.String }
              )
            })
          )
          .add(
            HttpApiEndpoint.get("error", "/error", {
              disableCodecs: true,
              error: HttpApiSchema.WithHeaders(
                Schema.String.pipe(HttpApiSchema.status(429), HttpApiSchema.asText()),
                { "retry-after": Schema.String }
              )
            })
          )
      )
      const GroupLayer = HttpApiBuilder.group(
        Api,
        "test",
        (handlers) =>
          handlers
            .handle("success", () =>
              Effect.succeed(HttpApiSchema.withHeaders({
                body: "ok",
                headers: { "x-count": "2" }
              })))
            .handle("error", () =>
              Effect.fail(HttpApiSchema.withHeaders({
                body: "slow down",
                headers: { "retry-after": "30" }
              })))
      )

      const client = yield* HttpApiTest.groups(Api, ["test"]).pipe(Effect.provide(GroupLayer))
      const [success, successResponse] = yield* client.test.success({ responseMode: "decoded-and-response" })
      const error = yield* Effect.flip(client.test.error({}))
      const errorResponse = yield* client.test.error({ responseMode: "response-only" })
      if (!HttpApiSchema.isWithHeadersValue(error)) {
        throw new Error("Expected WithHeaders error")
      }

      assert.strictEqual(successResponse.headers["x-count"], "2")
      assert.deepStrictEqual(success.headers, { "x-count": "2" })
      assert.strictEqual(errorResponse.headers["retry-after"], "30")
      assert.deepStrictEqual(error.headers, { "retry-after": "30" })
    }))

  it.effect("encodes and decodes response headers with codecs enabled", () =>
    Effect.gen(function*() {
      const Api = HttpApi.make("Api").add(
        HttpApiGroup.make("test").add(
          HttpApiEndpoint.get("created", "/test", {
            success: HttpApiSchema.WithHeaders(
              Schema.Struct({ id: Schema.Int }).pipe(HttpApiSchema.status(201)),
              { "x-count": Schema.Int }
            )
          })
        )
      )
      const GroupLayer = HttpApiBuilder.group(
        Api,
        "test",
        (handlers) =>
          handlers.handle("created", () =>
            Effect.succeed(HttpApiSchema.withHeaders({
              body: { id: 1 },
              headers: { "x-count": 2 }
            })))
      )

      const client = yield* HttpApiTest.groups(Api, ["test"]).pipe(Effect.provide(GroupLayer))
      const [value, response] = yield* client.test.created({ responseMode: "decoded-and-response" })

      assert.strictEqual(response.headers["x-count"], "2")
      assert.deepStrictEqual(
        value,
        HttpApiSchema.withHeaders({
          body: { id: 1 },
          headers: { "x-count": 2 }
        })
      )
    }))

  it.effect("decodes a transforming buffered success body and its declared headers", () =>
    Effect.gen(function*() {
      const Api = HttpApi.make("Api").add(
        HttpApiGroup.make("test").add(
          HttpApiEndpoint.get("created", "/test", {
            success: HttpApiSchema.WithHeaders(Schema.Date, { "x-source": Schema.String })
          })
        )
      )
      const GroupLayer = HttpApiBuilder.group(
        Api,
        "test",
        (handlers) =>
          handlers.handle("created", () =>
            Effect.succeed(HttpApiSchema.withHeaders({
              body: DateTime.makeUnsafe("2024-01-02T03:04:05.000Z").pipe(DateTime.toDate),
              headers: { "x-source": "schema" }
            })))
      )

      const client = yield* HttpApiTest.groups(Api, ["test"]).pipe(Effect.provide(GroupLayer))
      const value = yield* client.test.created({})

      assert.strictEqual(value.body.toISOString(), "2024-01-02T03:04:05.000Z")
      assert.deepStrictEqual(value.headers, { "x-source": "schema" })
    }))

  it.effect("round trips a client-received branded value through another handler", () =>
    Effect.gen(function*() {
      const Success = HttpApiSchema.WithHeaders(
        Schema.Struct({ id: Schema.Int }).pipe(HttpApiSchema.status(201)),
        { "x-count": Schema.Int }
      )
      const Api = HttpApi.make("Api").add(
        HttpApiGroup.make("test")
          .add(HttpApiEndpoint.get("created", "/created", { success: Success }))
          .add(HttpApiEndpoint.get("forwarded", "/forwarded", { success: Success }))
      )
      let forwarded: typeof Success.Type | undefined
      const GroupLayer = HttpApiBuilder.group(
        Api,
        "test",
        (handlers) =>
          handlers
            .handle("created", () =>
              Effect.succeed(HttpApiSchema.withHeaders({
                body: { id: 1 },
                headers: { "x-count": 2 }
              })))
            .handle("forwarded", () => Effect.succeed(forwarded!))
      )

      const client = yield* HttpApiTest.groups(Api, ["test"]).pipe(Effect.provide(GroupLayer))
      const [value, response] = yield* client.test.created({ responseMode: "decoded-and-response" })
      forwarded = value
      const result = yield* client.test.forwarded({})

      assert.strictEqual(response.status, 201)
      assert.deepStrictEqual(result, value)
    }))

  it.effect("encodes a buffered success body and its declared headers", () =>
    Effect.gen(function*() {
      const Api = HttpApi.make("Api").add(
        HttpApiGroup.make("test").add(
          HttpApiEndpoint.get("created", "/test", {
            success: HttpApiSchema.WithHeaders(
              Schema.Struct({ id: Schema.Int }).pipe(HttpApiSchema.status(201)),
              {
                "x-count": Schema.Int,
                "x-optional": Schema.optional(Schema.String)
              }
            )
          })
        )
      )
      const GroupLayer = HttpApiBuilder.group(
        Api,
        "test",
        (handlers) =>
          handlers.handle("created", () =>
            Effect.succeed(HttpApiSchema.withHeaders({
              body: { id: 1 },
              headers: { "x-count": 2, "x-optional": undefined }
            })))
      )

      const client = yield* HttpApiTest.groups(Api, ["test"]).pipe(Effect.provide(GroupLayer))
      const response = yield* client.test.created({ responseMode: "response-only" })

      assert.strictEqual(response.status, 201)
      assert.strictEqual(response.headers["x-count"], "2")
      assert.isFalse("x-optional" in response.headers)
      assert.deepStrictEqual(yield* response.json, { id: 1 })
    }))

  it.effect("does not unwrap an unbranded value in a mixed success union", () =>
    Effect.gen(function*() {
      const Plain = Schema.Struct({
        body: Schema.String,
        headers: Schema.Struct({ "x-source": Schema.String })
      }).pipe(HttpApiSchema.asJson({ contentType: "application/vnd.plain+json" }))
      const Api = HttpApi.make("Api").add(
        HttpApiGroup.make("test").add(
          HttpApiEndpoint.get("mixed", "/test", {
            success: [
              HttpApiSchema.WithHeaders(Schema.String, { "x-source": Schema.String }),
              Plain
            ]
          })
        )
      )
      const GroupLayer = HttpApiBuilder.group(
        Api,
        "test",
        (handlers) => handlers.handle("mixed", () => Effect.succeed({ body: "plain", headers: { "x-source": "body" } }))
      )

      const client = yield* HttpApiTest.groups(Api, ["test"]).pipe(Effect.provide(GroupLayer))
      const response = yield* client.test.mixed({ responseMode: "response-only" })

      assert.strictEqual(response.headers["content-type"], "application/vnd.plain+json")
      assert.isFalse("x-source" in response.headers)
      assert.deepStrictEqual(yield* response.json, { body: "plain", headers: { "x-source": "body" } })
    }))

  it.effect("decodes a plain value in a mixed WithHeaders success union", () =>
    Effect.gen(function*() {
      const Wrapped = HttpApiSchema.WithHeaders(
        Schema.TaggedStruct("Wrapped", { value: Schema.String }),
        { "x-source": Schema.String }
      )
      const Plain = Schema.TaggedStruct("Plain", { value: Schema.String }).pipe(
        HttpApiSchema.asJson({ contentType: "application/vnd.plain+json" })
      )
      const Api = HttpApi.make("Api").add(
        HttpApiGroup.make("test").add(
          HttpApiEndpoint.get("mixed", "/test", { success: [Wrapped, Plain] })
        )
      )
      const GroupLayer = HttpApiBuilder.group(
        Api,
        "test",
        (handlers) => handlers.handle("mixed", () => Effect.succeed({ _tag: "Plain" as const, value: "plain" }))
      )

      const client = yield* HttpApiTest.groups(Api, ["test"]).pipe(Effect.provide(GroupLayer))
      const value = yield* client.test.mixed({})

      assert.deepStrictEqual(value, { _tag: "Plain", value: "plain" })
    }))

  it.effect("applies declared headers after body encoding", () =>
    Effect.gen(function*() {
      const Api = HttpApi.make("Api").add(
        HttpApiGroup.make("test").add(
          HttpApiEndpoint.get("override", "/test", {
            success: HttpApiSchema.WithHeaders(
              Schema.String.pipe(HttpApiSchema.asText({ contentType: "text/plain" })),
              { "content-type": Schema.String, "x-source": Schema.String }
            )
          })
        )
      )
      const GroupLayer = HttpApiBuilder.group(
        Api,
        "test",
        (handlers) =>
          handlers.handle("override", () =>
            Effect.succeed(HttpApiSchema.withHeaders({
              body: "ok",
              headers: { "content-type": "application/custom", "x-source": "schema" }
            })))
      )

      const client = yield* HttpApiTest.groups(Api, ["test"]).pipe(Effect.provide(GroupLayer))
      const response = yield* client.test.override({ responseMode: "response-only" })

      assert.strictEqual(response.headers["content-type"], "application/custom")
      assert.strictEqual(response.headers["x-source"], "schema")
      assert.strictEqual(yield* response.text, "ok")
    }))

  it.effect("encodes error headers through encodeToWithHeaders", () =>
    Effect.gen(function*() {
      class RateLimited extends Schema.TaggedError<RateLimited>()("RateLimited", {
        retryAfter: Schema.Int
      }) {}
      const RateLimitedResponse = RateLimited.pipe(
        HttpApiSchema.encodeToWithHeaders({
          body: Schema.String.pipe(HttpApiSchema.status(429), HttpApiSchema.asText()),
          headers: { "retry-after": Schema.Int }
        }, {
          decode: ({ headers }) => new RateLimited({ retryAfter: headers["retry-after"] }),
          encode: (error) => ({ body: "slow down", headers: { "retry-after": error.retryAfter } })
        })
      )
      const Api = HttpApi.make("Api").add(
        HttpApiGroup.make("test").add(
          HttpApiEndpoint.get("limited", "/test", { error: RateLimitedResponse })
        )
      )
      const GroupLayer = HttpApiBuilder.group(
        Api,
        "test",
        (handlers) => handlers.handle("limited", () => Effect.fail(new RateLimited({ retryAfter: 30 })))
      )

      const client = yield* HttpApiTest.groups(Api, ["test"]).pipe(Effect.provide(GroupLayer))
      const response = yield* client.test.limited({ responseMode: "response-only" })

      assert.strictEqual(response.status, 429)
      assert.strictEqual(response.headers["content-type"], "text/plain")
      assert.strictEqual(response.headers["retry-after"], "30")
      assert.strictEqual(yield* response.text, "slow down")
    }))

  it.effect("encodes annotation headers from their declared encoded shape", () =>
    Effect.gen(function*() {
      class RateLimited extends Schema.TaggedError<RateLimited>()("RateLimited", {
        expiresAt: Schema.Date
      }) {}
      const RateLimitedResponse = RateLimited.pipe(
        HttpApiSchema.encodeToWithHeaders({
          body: Schema.String.pipe(HttpApiSchema.status(429)),
          headers: { "expires-at": Schema.Date }
        }, {
          decode: ({ headers }) => new RateLimited({ expiresAt: headers["expires-at"] }),
          encode: (error) => ({ body: "slow down", headers: { "expires-at": error.expiresAt } })
        })
      )
      const Api = HttpApi.make("Api").add(
        HttpApiGroup.make("test").add(
          HttpApiEndpoint.get("limited", "/test", { error: RateLimitedResponse })
        )
      )
      const expiresAt = DateTime.makeUnsafe("2026-08-05T02:00:00.000Z").pipe(DateTime.toDate)
      const GroupLayer = HttpApiBuilder.group(
        Api,
        "test",
        (handlers) => handlers.handle("limited", () => Effect.fail(new RateLimited({ expiresAt })))
      )

      const client = yield* HttpApiTest.groups(Api, ["test"]).pipe(Effect.provide(GroupLayer))
      const response = yield* client.test.limited({ responseMode: "response-only" })
      const error = yield* Effect.flip(client.test.limited({}))

      assert.strictEqual(response.headers["expires-at"], "2026-08-05T02:00:00.000Z")
      assert.deepStrictEqual(error, new RateLimited({ expiresAt }))
    }))

  it.effect("encodes and decodes an error wrapped in WithHeaders", () =>
    Effect.gen(function*() {
      const RateLimited = HttpApiSchema.WithHeaders(
        Schema.TaggedStruct("RateLimited", { message: Schema.String }).pipe(HttpApiSchema.status(429)),
        { "retry-after": Schema.Int }
      )
      const Api = HttpApi.make("Api").add(
        HttpApiGroup.make("test").add(
          HttpApiEndpoint.get("limited", "/test", { error: RateLimited })
        )
      )
      const expected = HttpApiSchema.withHeaders({
        body: { _tag: "RateLimited" as const, message: "slow down" },
        headers: { "retry-after": 30 }
      })
      const GroupLayer = HttpApiBuilder.group(
        Api,
        "test",
        (handlers) => handlers.handle("limited", () => Effect.fail(expected))
      )

      const client = yield* HttpApiTest.groups(Api, ["test"]).pipe(Effect.provide(GroupLayer))
      const response = yield* client.test.limited({ responseMode: "response-only" })

      assert.strictEqual(response.status, 429)
      assert.strictEqual(response.headers["retry-after"], "30")
      assert.deepStrictEqual(yield* response.json, expected.body)
      assert.deepStrictEqual(yield* Effect.flip(client.test.limited({})), expected)
    }))

  it.effect("passes through string-shaped encodeToWithHeaders values when endpoint codecs are disabled", () =>
    Effect.gen(function*() {
      class RateLimited extends Schema.TaggedError<RateLimited>()("RateLimited", {
        retryAfter: Schema.String
      }) {}
      const RateLimitedResponse = RateLimited.pipe(
        HttpApiSchema.encodeToWithHeaders({
          body: Schema.String.pipe(HttpApiSchema.status(429), HttpApiSchema.asText()),
          headers: { "retry-after": Schema.String }
        }, {
          decode: ({ headers }) => new RateLimited({ retryAfter: headers["retry-after"] }),
          encode: (error) => ({ body: "slow down", headers: { "retry-after": error.retryAfter } })
        })
      )
      const Api = HttpApi.make("Api").add(
        HttpApiGroup.make("test").add(
          HttpApiEndpoint.get("limited", "/test", {
            disableCodecs: true,
            error: RateLimitedResponse
          })
        )
      )
      const GroupLayer = HttpApiBuilder.group(
        Api,
        "test",
        (handlers) => handlers.handle("limited", () => Effect.fail(new RateLimited({ retryAfter: "30" })))
      )

      const client = yield* HttpApiTest.groups(Api, ["test"]).pipe(Effect.provide(GroupLayer))
      const response = yield* client.test.limited({ responseMode: "response-only" })

      assert.strictEqual(response.status, 429)
      assert.strictEqual(response.headers["retry-after"], "30")
      assert.strictEqual(yield* response.text, "slow down")
      assert.deepStrictEqual(
        yield* Effect.flip(client.test.limited({})),
        new RateLimited({ retryAfter: "30" })
      )
    }))

  it.effect("decodes an error body and headers through encodeToWithHeaders", () =>
    Effect.gen(function*() {
      class RateLimited extends Schema.TaggedError<RateLimited>()("RateLimited", {
        message: Schema.String,
        retryAfter: Schema.Int
      }) {}
      const RateLimitedResponse = RateLimited.pipe(
        HttpApiSchema.encodeToWithHeaders({
          body: Schema.String.pipe(HttpApiSchema.status(429), HttpApiSchema.asText()),
          headers: { "retry-after": Schema.Int }
        }, {
          decode: ({ body, headers }) =>
            new RateLimited({
              message: body,
              retryAfter: headers["retry-after"]
            }),
          encode: (error) => ({
            body: error.message,
            headers: { "retry-after": error.retryAfter }
          })
        })
      )
      const Api = HttpApi.make("Api").add(
        HttpApiGroup.make("test").add(
          HttpApiEndpoint.get("limited", "/test", { error: RateLimitedResponse })
        )
      )
      const GroupLayer = HttpApiBuilder.group(
        Api,
        "test",
        (handlers) =>
          handlers.handle("limited", () => Effect.fail(new RateLimited({ message: "slow down", retryAfter: 30 })))
      )

      const client = yield* HttpApiTest.groups(Api, ["test"]).pipe(Effect.provide(GroupLayer))
      const error = yield* Effect.flip(client.test.limited({}))

      assert.deepStrictEqual(error, new RateLimited({ message: "slow down", retryAfter: 30 }))
    }))

  it.effect("defects with ResponseHeaders when success header encoding fails", () =>
    Effect.gen(function*() {
      const Api = HttpApi.make("Api").add(
        HttpApiGroup.make("test").add(
          HttpApiEndpoint.get("invalid", "/test", {
            success: HttpApiSchema.WithHeaders(Schema.String, { "x-count": Schema.Int })
          })
        )
      )
      const GroupLayer = HttpApiBuilder.group(
        Api,
        "test",
        (handlers) =>
          handlers.handle("invalid", () =>
            Effect.succeed(HttpApiSchema.withHeaders({
              body: "ok",
              headers: { "x-count": "invalid" as any }
            })))
      )

      const client = yield* HttpApiTest.groups(Api, ["test"]).pipe(Effect.provide(GroupLayer))
      const exit = yield* Effect.exit(client.test.invalid({ responseMode: "response-only" }))

      assert.strictEqual(exit._tag, "Failure")
      if (exit._tag === "Failure") {
        const error = Cause.squash(exit.cause) as any
        assert.strictEqual(error._tag, "HttpApiSchemaError")
        assert.strictEqual(error.kind, "ResponseHeaders")
      }
    }))
})

it.layer(TestServices)("HttpApiBuilder streaming success responses", (it) => {
  it.effect("emits StreamUint8Array handler responses as streamed bytes with the declared content type", () =>
    Effect.gen(function*() {
      const Api = HttpApi.make("Api").add(
        HttpApiGroup.make("test").add(
          HttpApiEndpoint.get("download", "/test", {
            success: HttpApiSchema.status(206)(
              HttpApiSchema.StreamUint8Array({ contentType: "application/custom-bytes" })
            )
          })
        )
      )

      const GroupLayer = HttpApiBuilder.group(
        Api,
        "test",
        (handlers) =>
          handlers.handle("download", () =>
            Effect.succeed(
              Stream.make(new Uint8Array([1, 2]), new Uint8Array([3]))
            ))
      )

      const client = yield* HttpApiTest.groups(Api, ["test"]).pipe(Effect.provide(GroupLayer))
      const response = yield* client.test.download({ responseMode: "response-only" })
      const chunks = yield* response.stream.pipe(Stream.runCollect)

      assert.strictEqual(response.status, 206)
      assert.strictEqual(response.headers["content-type"], "application/custom-bytes")
      assert.deepStrictEqual(Array.from(chunks, (chunk) => Array.from(chunk)), [[1, 2], [3]])
    }))

  it.effect("unwraps WithHeaders StreamUint8Array responses before stream dispatch", () =>
    Effect.gen(function*() {
      const Api = HttpApi.make("Api").add(
        HttpApiGroup.make("test").add(
          HttpApiEndpoint.get("download", "/test", {
            success: HttpApiSchema.WithHeaders(
              HttpApiSchema.status(206)(
                HttpApiSchema.StreamUint8Array({ contentType: "application/custom-bytes" })
              ),
              { "content-type": Schema.String, "x-count": Schema.Int }
            )
          })
        )
      )
      const GroupLayer = HttpApiBuilder.group(
        Api,
        "test",
        (handlers) =>
          handlers.handle("download", () =>
            Effect.succeed(HttpApiSchema.withHeaders({
              body: Stream.make(new Uint8Array([1, 2]), new Uint8Array([3])),
              headers: { "content-type": "application/overridden", "x-count": 2 }
            })))
      )

      const client = yield* HttpApiTest.groups(Api, ["test"]).pipe(Effect.provide(GroupLayer))
      const response = yield* client.test.download({ responseMode: "response-only" })
      const chunks = yield* response.stream.pipe(Stream.runCollect)

      assert.strictEqual(response.status, 206)
      assert.strictEqual(response.headers["content-type"], "application/overridden")
      assert.strictEqual(response.headers["x-count"], "2")
      assert.deepStrictEqual(Array.from(chunks, (chunk) => Array.from(chunk)), [[1, 2], [3]])
    }))

  it.effect("renders successful StreamSse events incrementally with the declared content type", () =>
    Effect.gen(function*() {
      const Events = Schema.Struct({
        event: Schema.String,
        data: Schema.String
      })

      const Api = HttpApi.make("Api").add(
        HttpApiGroup.make("test").add(
          HttpApiEndpoint.get("events", "/test", {
            success: HttpApiSchema.status(202)(
              HttpApiSchema.StreamSse({
                contentType: "text/event-stream; charset=utf-8",
                events: Events,
                error: StreamError
              })
            )
          })
        )
      )
      const GroupLayer = HttpApiBuilder.group(
        Api,
        "test",
        (handlers) =>
          handlers.handle("events", () =>
            Effect.succeed(Stream.make(
              { event: "first" as const, data: "one" },
              { event: "second" as const, data: "two" }
            )))
      )

      const client = yield* HttpApiTest.groups(Api, ["test"]).pipe(Effect.provide(GroupLayer))
      const response = yield* client.test.events({ responseMode: "response-only" })
      const chunks = yield* response.stream.pipe(Stream.runCollect)

      assert.strictEqual(response.status, 202)
      assert.strictEqual(response.headers["content-type"], "text/event-stream; charset=utf-8")
      assert.deepStrictEqual(
        Array.from(chunks, (chunk) => textDecoder.decode(chunk)),
        ["event: first\ndata: one\n\n", "event: second\ndata: two\n\n"]
      )
    }))

  it.effect("unwraps WithHeaders StreamSse responses before SSE encoding", () =>
    Effect.gen(function*() {
      const Events = Schema.Struct({
        event: Schema.String,
        data: Schema.String
      })
      const Api = HttpApi.make("Api").add(
        HttpApiGroup.make("test").add(
          HttpApiEndpoint.get("events", "/test", {
            success: HttpApiSchema.WithHeaders(
              HttpApiSchema.status(202)(
                HttpApiSchema.StreamSse({
                  contentType: "text/event-stream; charset=utf-8",
                  events: Events,
                  error: StreamError
                })
              ),
              { "x-count": Schema.Int }
            )
          })
        )
      )
      const GroupLayer = HttpApiBuilder.group(
        Api,
        "test",
        (handlers) =>
          handlers.handle("events", () =>
            Effect.succeed(HttpApiSchema.withHeaders({
              body: Stream.make({ event: "first", data: "one" }),
              headers: { "x-count": 1 }
            })))
      )

      const client = yield* HttpApiTest.groups(Api, ["test"]).pipe(Effect.provide(GroupLayer))
      const response = yield* client.test.events({ responseMode: "response-only" })
      const chunks = yield* response.stream.pipe(Stream.runCollect)

      assert.strictEqual(response.status, 202)
      assert.strictEqual(response.headers["content-type"], "text/event-stream; charset=utf-8")
      assert.strictEqual(response.headers["x-count"], "1")
      assert.deepStrictEqual(Array.from(chunks, (chunk) => textDecoder.decode(chunk)), [
        "event: first\ndata: one\n\n"
      ])
    }))

  it.effect("fails WithHeaders stream header encoding before returning a response", () =>
    Effect.gen(function*() {
      const Api = HttpApi.make("Api").add(
        HttpApiGroup.make("test").add(
          HttpApiEndpoint.get("download", "/test", {
            success: HttpApiSchema.WithHeaders(
              HttpApiSchema.StreamUint8Array(),
              { "x-count": Schema.Int }
            )
          })
        )
      )
      const GroupLayer = HttpApiBuilder.group(
        Api,
        "test",
        (handlers) =>
          handlers.handle("download", () =>
            Effect.succeed(HttpApiSchema.withHeaders({
              body: Stream.make(new Uint8Array([1])),
              headers: { "x-count": "invalid" as any }
            })))
      )

      const client = yield* HttpApiTest.groups(Api, ["test"]).pipe(Effect.provide(GroupLayer))
      const exit = yield* Effect.exit(client.test.download({ responseMode: "response-only" }))

      assert.strictEqual(exit._tag, "Failure")
      if (exit._tag === "Failure") {
        const error = Cause.squash(exit.cause) as any
        assert.strictEqual(error._tag, "HttpApiSchemaError")
        assert.strictEqual(error.kind, "ResponseHeaders")
      }
    }))

  it.effect("renders StreamSse failures as one reserved event containing an encoded full cause", () =>
    Effect.gen(function*() {
      const Events = Schema.Struct({
        event: Schema.Literal("message"),
        data: Schema.String
      })

      const Api = HttpApi.make("Api").add(
        HttpApiGroup.make("test").add(
          HttpApiEndpoint.get("events", "/test", {
            success: HttpApiSchema.StreamSse({ events: Events, error: StreamError })
          })
        )
      )

      const GroupLayer = HttpApiBuilder.group(
        Api,
        "test",
        (handlers) =>
          handlers.handle("events", () =>
            Effect.succeed(
              Stream.fail({ reason: "boom" })
            ))
      )

      const client = yield* HttpApiTest.groups(Api, ["test"]).pipe(Effect.provide(GroupLayer))
      const response = yield* client.test.events({ responseMode: "response-only" })
      const chunks = yield* response.stream.pipe(Stream.runCollect)
      const rendered = Array.from(chunks, (chunk) => textDecoder.decode(chunk))

      assert.strictEqual(response.headers["content-type"], "text/event-stream")
      assert.strictEqual(rendered.length, 1)
      assert.isTrue(rendered[0]!.startsWith("event: effect/httpapi/stream/failure\ndata: "))
      assert.isTrue(rendered[0]!.endsWith("\n\n"))

      const data = rendered[0]!.split("\n")[1]!.slice("data: ".length)
      const FailureSchema = Schema.toCodecJson(Schema.Cause(StreamError, Schema.Defect()))
      const cause = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(FailureSchema))(data)
      assert.deepStrictEqual(cause, Cause.fail({ reason: "boom" }))
    }))

  it.effect("supports buffered and stream successes with the same status", () =>
    Effect.gen(function*() {
      const Buffered = Schema.Struct({ message: Schema.String })
      const EventData = Schema.Struct({
        text: Schema.String
      })

      const Api = HttpApi.make("Api").add(
        HttpApiGroup.make("test").add(
          HttpApiEndpoint.get("chat", "/test", {
            query: {
              stream: Schema.String
            },
            success: [
              Buffered,
              HttpApiSchema.StreamSse({ data: EventData, error: StreamError })
            ]
          })
        )
      )

      const GroupLayer = HttpApiBuilder.group(
        Api,
        "test",
        (handlers) =>
          handlers.handle("chat", ({ query }) =>
            Effect.succeed(
              query.stream === "true" ?
                Stream.make({ text: "hello" }) :
                { message: "done" }
            ))
      )

      const client = yield* HttpApiTest.groups(Api, ["test"]).pipe(Effect.provide(GroupLayer))
      const bufferedResponse = yield* client.test.chat({ query: { stream: "false" }, responseMode: "response-only" })
      assert.strictEqual(bufferedResponse.status, 200)
      assert.strictEqual(bufferedResponse.headers["content-type"], "application/json")

      const streamResponse = yield* client.test.chat({ query: { stream: "true" }, responseMode: "response-only" })
      const chunks = yield* Stream.runCollect(streamResponse.stream)

      assert.strictEqual(streamResponse.status, 200)
      assert.strictEqual(streamResponse.headers["content-type"], "text/event-stream")
      assert.deepStrictEqual(Array.from(chunks, (chunk) => textDecoder.decode(chunk)), [
        `data: {"text":"hello"}\n\n`
      ])
    }))

  it.effect("keeps a plain buffered alternative when the stream is wrapped", () =>
    Effect.gen(function*() {
      const Buffered = Schema.Struct({ message: Schema.String })
      const Api = HttpApi.make("Api").add(
        HttpApiGroup.make("test").add(
          HttpApiEndpoint.get("result", "/test", {
            success: [
              HttpApiSchema.WithHeaders(
                HttpApiSchema.StreamUint8Array(),
                { "x-source": Schema.String }
              ),
              Buffered
            ]
          })
        )
      )
      const GroupLayer = HttpApiBuilder.group(
        Api,
        "test",
        (handlers) => handlers.handle("result", () => Effect.succeed({ message: "done" }))
      )

      const client = yield* HttpApiTest.groups(Api, ["test"]).pipe(Effect.provide(GroupLayer))
      const response = yield* client.test.result({ responseMode: "response-only" })

      assert.strictEqual(response.headers["content-type"], "application/json")
      assert.deepStrictEqual(yield* response.json, { message: "done" })
    }))

  it.effect("detects a wrapped buffered alternative alongside a plain stream", () =>
    Effect.gen(function*() {
      const Buffered = Schema.Struct({ message: Schema.String })
      const Api = HttpApi.make("Api").add(
        HttpApiGroup.make("test").add(
          HttpApiEndpoint.get("result", "/test", {
            success: [
              HttpApiSchema.StreamUint8Array(),
              HttpApiSchema.WithHeaders(Buffered, { "x-source": Schema.String })
            ]
          })
        )
      )
      const GroupLayer = HttpApiBuilder.group(
        Api,
        "test",
        (handlers) =>
          handlers.handle("result", () =>
            Effect.succeed(HttpApiSchema.withHeaders({
              body: { message: "done" },
              headers: { "x-source": "buffered" }
            })))
      )

      const client = yield* HttpApiTest.groups(Api, ["test"]).pipe(Effect.provide(GroupLayer))
      const response = yield* client.test.result({ responseMode: "response-only" })

      assert.strictEqual(response.headers["content-type"], "application/json")
      assert.strictEqual(response.headers["x-source"], "buffered")
      assert.deepStrictEqual(yield* response.json, { message: "done" })
    }))

  it.effect("registers handleAll handlers at runtime", () =>
    Effect.gen(function*() {
      const User = Schema.Struct({
        id: Schema.String,
        name: Schema.String
      })
      const CreateUser = Schema.Struct({
        name: Schema.String
      })

      const Api = HttpApi.make("Api").add(
        HttpApiGroup.make("users").add(
          HttpApiEndpoint.get("getUser", "/users/:id", {
            params: {
              id: Schema.String
            },
            success: User
          }),
          HttpApiEndpoint.post("createUser", "/users", {
            payload: CreateUser,
            success: User
          })
        )
      )

      const GroupLayer = HttpApiBuilder.group(
        Api,
        "users",
        (handlers) =>
          handlers.handleAll({
            getUser: ({ params }) =>
              Effect.succeed({
                id: params.id,
                name: "Ada"
              }),
            createUser: {
              handler: ({ payload }) =>
                Effect.succeed({
                  id: "created",
                  name: payload.name
                }),
              options: { uninterruptible: true }
            }
          })
      )

      const client = yield* HttpApiTest.groups(Api, ["users"]).pipe(Effect.provide(GroupLayer))
      const getUser = yield* client.users.getUser({ params: { id: "user-1" } })
      const createUser = yield* client.users.createUser({ payload: { name: "Grace" } })

      assert.deepStrictEqual(getUser, { id: "user-1", name: "Ada" })
      assert.deepStrictEqual(createUser, { id: "created", name: "Grace" })
    }))

  it.effect("rejects unknown endpoint identifiers", () =>
    Effect.gen(function*() {
      const Api = HttpApi.make("Api").add(
        HttpApiGroup.make("users").add(
          HttpApiEndpoint.get("getUser", "/users", { success: Schema.String })
        )
      )

      for (const identifier of ["missing", "toString"] as const) {
        const GroupLayer = HttpApiBuilder.group(
          Api,
          "users",
          (handlers) => handlers.handle(identifier as "getUser", () => Effect.succeed("missing"))
        )
        const exit = yield* Effect.exit(Effect.scoped(Layer.build(GroupLayer)))

        assert.strictEqual(exit._tag, "Failure")
        if (exit._tag === "Failure") {
          const error = Cause.squash(exit.cause)
          assert.instanceOf(error, Error)
          assert.strictEqual(
            error.message,
            `HttpApiEndpoint "${identifier}" not found in HttpApiGroup "users"`
          )
        }
      }
    }))

  it.effect("rejects duplicate handle and handleAll registrations", () =>
    Effect.gen(function*() {
      const Api = HttpApi.make("Api").add(
        HttpApiGroup.make("users").add(
          HttpApiEndpoint.get("getUser", "/users", { success: Schema.String })
        )
      )
      const HandleLayer = HttpApiBuilder.group(
        Api,
        "users",
        (handlers) => {
          handlers.handle("getUser", () => Effect.succeed("first"))
          return handlers.handle("getUser", () => Effect.succeed("second"))
        }
      )
      const HandleAllLayer = HttpApiBuilder.group(
        Api,
        "users",
        (handlers) => {
          handlers.handleAll({ getUser: () => Effect.succeed("first") })
          return handlers.handleAll({ getUser: () => Effect.succeed("second") })
        }
      )

      for (const GroupLayer of [HandleLayer, HandleAllLayer]) {
        const exit = yield* Effect.exit(Effect.scoped(Layer.build(GroupLayer)))
        assert.strictEqual(exit._tag, "Failure")
        if (exit._tag === "Failure") {
          const error = Cause.squash(exit.cause)
          assert.instanceOf(error, Error)
          assert.strictEqual(
            error.message,
            "Handler for HttpApiEndpoint \"getUser\" is already registered in HttpApiGroup \"users\""
          )
        }
      }
    }))

  it.effect("ignores inherited handleAll properties", () =>
    Effect.gen(function*() {
      const Api = HttpApi.make("Api").add(
        HttpApiGroup.make("users").add(
          HttpApiEndpoint.get("getUser", "/users", {
            success: Schema.String
          })
        )
      )
      const implementations: {
        readonly getUser: () => Effect.Effect<string>
      } = Object.assign(
        Object.create({
          inherited: () => Effect.succeed("inherited")
        }),
        {
          getUser: () => Effect.succeed("own")
        }
      )
      const GroupLayer = HttpApiBuilder.group(
        Api,
        "users",
        (handlers) => handlers.handleAll(implementations)
      )

      const client = yield* HttpApiTest.groups(Api, ["users"]).pipe(Effect.provide(GroupLayer))

      assert.strictEqual(yield* client.users.getUser(), "own")
    }))

  it.effect("executes effectful handler builders", () =>
    Effect.gen(function*() {
      const User = Schema.Struct({
        id: Schema.String,
        name: Schema.String
      })

      const Api = HttpApi.make("Api").add(
        HttpApiGroup.make("users").add(
          HttpApiEndpoint.get("getUser", "/users/:id", {
            params: {
              id: Schema.String
            },
            success: User
          })
        )
      )

      const GroupLayer = HttpApiBuilder.group(
        Api,
        "users",
        (handlers) =>
          Effect.succeed(
            handlers.handle("getUser", ({ params }) =>
              Effect.succeed({
                id: params.id,
                name: "Ada"
              }))
          )
      )

      const client = yield* HttpApiTest.groups(Api, ["users"]).pipe(Effect.provide(GroupLayer))
      const getUser = yield* client.users.getUser({ params: { id: "user-1" } })

      assert.deepStrictEqual(getUser, { id: "user-1", name: "Ada" })
    }))

  it.effect("does not try another security scheme after the handler fails", () =>
    Effect.gen(function*() {
      class HandlerFailure extends Schema.TaggedError<HandlerFailure>()("HandlerFailure", {
        message: Schema.String
      }, { httpApiStatus: 418 }) {}

      // @effect-diagnostics-next-line leakingRequirements:off
      class M extends HttpApiMiddleware.Service<M>()("Security/HandlerFailure", {
        error: Schema.String.pipe(
          HttpApiSchema.status(401),
          HttpApiSchema.asText()
        ),
        security: {
          first: HttpApiSecurity.apiKey({
            in: "header",
            key: "x-first"
          }),
          second: HttpApiSecurity.apiKey({
            in: "header",
            key: "x-second"
          })
        }
      }) {}

      const Api = HttpApi.make("Api").add(
        HttpApiGroup.make("test").add(
          HttpApiEndpoint.get("protected", "/protected", {
            headers: {
              "x-first": Schema.String
            },
            success: Schema.String,
            error: HandlerFailure
          }).middleware(M)
        )
      )
      const GroupLayer = HttpApiBuilder.group(
        Api,
        "test",
        (handlers) => handlers.handle("protected", () => Effect.fail(new HandlerFailure({ message: "handler failed" })))
      )
      const MLayer = Layer.succeed(M)({
        first: (effect, { credential }) =>
          Redacted.value(credential) === "ok" ? effect : Effect.fail("first unauthorized"),
        second: (effect, { credential }) =>
          Redacted.value(credential) === "ok" ? effect : Effect.fail("second unauthorized")
      })

      const client = yield* HttpApiTest.groups(Api, ["test"]).pipe(
        Effect.provide(GroupLayer),
        Effect.provide(MLayer)
      )
      const error = yield* Effect.flip(client.test.protected({ headers: { "x-first": "ok" } }))

      assert.deepStrictEqual(error, new HandlerFailure({ message: "handler failed" }))
    }))
})
