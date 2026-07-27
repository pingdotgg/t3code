import { assert, it, vi } from "@effect/vitest"
import { Cause, Effect, FileSystem, Layer, Path, Redacted, Schema, Stream } from "effect"
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

it.effect("reuses response schema transformations by source AST", () => {
  const SharedSuccess = Schema.String.pipe(HttpApiSchema.asText())
  const DistinctSuccess = Schema.String.pipe(HttpApiSchema.asText({ contentType: "text/custom" }))
  const Api = HttpApi.make("Api").add(
    HttpApiGroup.make("test")
      .add(HttpApiEndpoint.get("first", "/first", { success: SharedSuccess }))
      .add(HttpApiEndpoint.get("second", "/second", { success: SharedSuccess }))
      .add(HttpApiEndpoint.get("distinct", "/distinct", { success: DistinctSuccess }))
  )
  const GroupLive = HttpApiBuilder.group(
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
        yield* Effect.scoped(Layer.build(GroupLive))
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
      const GroupLive = HttpApiBuilder.group(
        Api,
        "test",
        (handlers) => handlers.handle("create", ({ payload }) => Effect.succeed(payload))
      )

      const client = yield* HttpApiTest.groups(Api, ["test"]).pipe(Effect.provide(GroupLive))
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
      const GroupLive = HttpApiBuilder.group(
        Api,
        "test",
        (handlers) => handlers.handle("create", ({ payload }) => Effect.succeed(payload))
      )

      const client = yield* HttpApiTest.groups(Api, ["test"]).pipe(Effect.provide(GroupLive))
      const result = yield* client.test.create({ payload: { name: "Ada" } })

      assert.deepStrictEqual(result, { name: "Ada" })
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

      const GroupLive = HttpApiBuilder.group(
        Api,
        "test",
        (handlers) =>
          handlers.handle("download", () =>
            Effect.succeed(
              Stream.make(new Uint8Array([1, 2]), new Uint8Array([3]))
            ))
      )

      const client = yield* HttpApiTest.groups(Api, ["test"]).pipe(Effect.provide(GroupLive))
      const response = yield* client.test.download({ responseMode: "response-only" })
      const chunks = yield* response.stream.pipe(Stream.runCollect)

      assert.strictEqual(response.status, 206)
      assert.strictEqual(response.headers["content-type"], "application/custom-bytes")
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
      const GroupLive = HttpApiBuilder.group(
        Api,
        "test",
        (handlers) =>
          handlers.handle("events", () =>
            Effect.succeed(Stream.make(
              { event: "first" as const, data: "one" },
              { event: "second" as const, data: "two" }
            )))
      )

      const client = yield* HttpApiTest.groups(Api, ["test"]).pipe(Effect.provide(GroupLive))
      const response = yield* client.test.events({ responseMode: "response-only" })
      const chunks = yield* response.stream.pipe(Stream.runCollect)

      assert.strictEqual(response.status, 202)
      assert.strictEqual(response.headers["content-type"], "text/event-stream; charset=utf-8")
      assert.deepStrictEqual(
        Array.from(chunks, (chunk) => textDecoder.decode(chunk)),
        ["event: first\ndata: one\n\n", "event: second\ndata: two\n\n"]
      )
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

      const GroupLive = HttpApiBuilder.group(
        Api,
        "test",
        (handlers) =>
          handlers.handle("events", () =>
            Effect.succeed(
              Stream.fail({ reason: "boom" })
            ))
      )

      const client = yield* HttpApiTest.groups(Api, ["test"]).pipe(Effect.provide(GroupLive))
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

      const GroupLive = HttpApiBuilder.group(
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

      const client = yield* HttpApiTest.groups(Api, ["test"]).pipe(Effect.provide(GroupLive))
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

      const GroupLive = HttpApiBuilder.group(
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

      const client = yield* HttpApiTest.groups(Api, ["users"]).pipe(Effect.provide(GroupLive))
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
        const GroupLive = HttpApiBuilder.group(
          Api,
          "users",
          (handlers) => handlers.handle(identifier as "getUser", () => Effect.succeed("missing"))
        )
        const exit = yield* Effect.exit(Effect.scoped(Layer.build(GroupLive)))

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
      const HandleLive = HttpApiBuilder.group(
        Api,
        "users",
        (handlers) => {
          handlers.handle("getUser", () => Effect.succeed("first"))
          return handlers.handle("getUser", () => Effect.succeed("second"))
        }
      )
      const HandleAllLive = HttpApiBuilder.group(
        Api,
        "users",
        (handlers) => {
          handlers.handleAll({ getUser: () => Effect.succeed("first") })
          return handlers.handleAll({ getUser: () => Effect.succeed("second") })
        }
      )

      for (const GroupLive of [HandleLive, HandleAllLive]) {
        const exit = yield* Effect.exit(Effect.scoped(Layer.build(GroupLive)))
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
      const GroupLive = HttpApiBuilder.group(
        Api,
        "users",
        (handlers) => handlers.handleAll(implementations)
      )

      const client = yield* HttpApiTest.groups(Api, ["users"]).pipe(Effect.provide(GroupLive))

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

      const GroupLive = HttpApiBuilder.group(
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

      const client = yield* HttpApiTest.groups(Api, ["users"]).pipe(Effect.provide(GroupLive))
      const getUser = yield* client.users.getUser({ params: { id: "user-1" } })

      assert.deepStrictEqual(getUser, { id: "user-1", name: "Ada" })
    }))

  it.effect("does not try another security scheme after the handler fails", () =>
    Effect.gen(function*() {
      class HandlerFailure extends Schema.TaggedErrorClass<HandlerFailure>()("HandlerFailure", {
        message: Schema.String
      }, { httpApiStatus: 418 }) {}

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
      const GroupLive = HttpApiBuilder.group(
        Api,
        "test",
        (handlers) => handlers.handle("protected", () => Effect.fail(new HandlerFailure({ message: "handler failed" })))
      )
      const MLive = Layer.succeed(M)({
        first: (effect, { credential }) =>
          Redacted.value(credential) === "ok" ? effect : Effect.fail("first unauthorized"),
        second: (effect, { credential }) =>
          Redacted.value(credential) === "ok" ? effect : Effect.fail("second unauthorized")
      })

      const client = yield* HttpApiTest.groups(Api, ["test"]).pipe(
        Effect.provide(GroupLive),
        Effect.provide(MLive)
      )
      const error = yield* Effect.flip(client.test.protected({ headers: { "x-first": "ok" } }))

      assert.deepStrictEqual(error, new HandlerFailure({ message: "handler failed" }))
    }))
})
