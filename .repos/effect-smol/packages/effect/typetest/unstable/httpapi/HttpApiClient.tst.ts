/** @effect-diagnostics missingEffectContext:skip-file */
import { Effect, Schema } from "effect"
import { FetchHttpClient, HttpClient, type HttpClientError, type HttpClientResponse } from "effect/unstable/http"
import {
  HttpApi,
  HttpApiClient,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiMiddleware,
  HttpApiSchema
} from "effect/unstable/httpapi"
import { describe, expect, it } from "tstyche"

type ResponseMode = HttpApiEndpoint.ClientResponseMode

describe("HttpApiClient", () => {
  describe("path option", () => {
    it("should accept a record of fields", () => {
      const Api = HttpApi.make("Api")
        .add(
          HttpApiGroup.make("group")
            .add(
              HttpApiEndpoint.get("a", "/a", {
                params: {
                  id: Schema.Finite
                }
              })
            )
        )
      const client = Effect.runSync(
        HttpApiClient.make(Api).pipe(Effect.provide(FetchHttpClient.layer))
      )
      const f = client.group.a
      expect<Parameters<typeof f>[0]>().type.toBe<
        { readonly params: { readonly id: number }; readonly responseMode?: ResponseMode }
      >()
    })
  })

  describe("query option", () => {
    it("should accept a record of fields", () => {
      const Api = HttpApi.make("Api")
        .add(
          HttpApiGroup.make("group")
            .add(
              HttpApiEndpoint.get("a", "/a", {
                query: {
                  id: Schema.Finite
                }
              })
            )
        )
      const client = Effect.runSync(
        HttpApiClient.make(Api).pipe(Effect.provide(FetchHttpClient.layer))
      )
      const f = client.group.a
      expect<Parameters<typeof f>[0]>().type.toBe<
        { readonly query: { readonly id: number }; readonly responseMode?: ResponseMode }
      >()
    })
  })

  describe("urlBuilder", () => {
    it("should mirror client shape and use schema input types", () => {
      const Api = HttpApi.make("Api")
        .add(
          HttpApiGroup.make("users")
            .add(
              HttpApiEndpoint.get("getUser", "/users/:id", {
                disableCodecs: true,
                params: {
                  id: Schema.FiniteFromString
                },
                query: {
                  page: Schema.FiniteFromString
                }
              }),
              HttpApiEndpoint.get("health", "/health", {
                disableCodecs: true
              })
            )
        )

      const builder = HttpApiClient.urlBuilder(Api, {
        baseUrl: "https://api.example.com"
      })

      expect(builder.users.getUser({ params: { id: 123 }, query: { page: 1 } })).type.toBe<string>()
      expect(builder.users.health()).type.toBe<string>()
      expect(builder.users.getUser).type.not.toBeCallableWith({ params: { id: "123" }, query: { page: 1 } })
      expect(builder.users.getUser).type.not.toBeCallableWith({ params: { id: 123 }, query: { page: "1" } })
      expect(builder.users).type.not.toHaveProperty("missing")
    })

    it("should support prefixes and top-level endpoints", () => {
      const Api = HttpApi.make("Api")
        .add(
          HttpApiGroup.make("users")
            .add(
              HttpApiEndpoint.get("getUser", "/users/:id", {
                disableCodecs: true,
                params: {
                  id: Schema.FiniteFromString
                }
              }),
              HttpApiEndpoint.get("health", "/health")
            )
        )
        .add(
          HttpApiGroup.make("top", { topLevel: true })
            .add(
              HttpApiEndpoint.get("topHealth", "/top-health")
            )
        )
        .prefix("/v1")

      const builder = HttpApiClient.urlBuilder(Api)

      expect(builder.users.getUser({ params: { id: 123 } })).type.toBe<string>()
      expect(builder.topHealth()).type.toBe<string>()
      expect(builder.users.getUser).type.not.toBeCallableWith({ params: { id: "123" } })
      expect(builder).type.not.toHaveProperty("top")
    })
  })

  describe("headers option", () => {
    it("should accept a record of fields", () => {
      const Api = HttpApi.make("Api")
        .add(
          HttpApiGroup.make("group")
            .add(
              HttpApiEndpoint.get("a", "/a", {
                headers: {
                  id: Schema.FiniteFromString
                }
              })
            )
        )
      const client = Effect.runSync(
        HttpApiClient.make(Api).pipe(Effect.provide(FetchHttpClient.layer))
      )
      const f = client.group.a
      expect<Parameters<typeof f>[0]>().type.toBe<
        { readonly headers: { readonly id: number }; readonly responseMode?: ResponseMode }
      >()
    })
  })

  describe("payload option", () => {
    it("should default to void", () => {
      const Api = HttpApi.make("Api")
        .add(
          HttpApiGroup.make("group")
            .add(
              HttpApiEndpoint.get("a", "/a")
            )
        )
      const client = Effect.runSync(
        HttpApiClient.make(Api).pipe(Effect.provide(FetchHttpClient.layer))
      )
      const f = client.group.a
      expect<Parameters<typeof f>[0]>().type.toBe<void | { readonly responseMode?: ResponseMode } | undefined>()
    })

    it("should accept a record of fields", () => {
      const Api = HttpApi.make("Api")
        .add(
          HttpApiGroup.make("group")
            .add(
              HttpApiEndpoint.get("a", "/a", {
                payload: {
                  id: Schema.FiniteFromString
                }
              })
            )
        )
      const client = Effect.runSync(
        HttpApiClient.make(Api).pipe(Effect.provide(FetchHttpClient.layer))
      )
      const f = client.group.a
      expect<Parameters<typeof f>[0]>().type.toBe<
        { readonly payload: { readonly id: number }; readonly responseMode?: ResponseMode }
      >()
    })

    it("should accept a multipart", () => {
      const Api = HttpApi.make("Api")
        .add(
          HttpApiGroup.make("group")
            .add(
              HttpApiEndpoint.post("a", "/a", {
                payload: Schema.String.pipe(HttpApiSchema.asMultipart())
              })
            )
        )
      const client = Effect.runSync(
        HttpApiClient.make(Api).pipe(Effect.provide(FetchHttpClient.layer))
      )
      const f = client.group.a
      expect<Parameters<typeof f>[0]>().type.toBe<
        { readonly payload: FormData; readonly responseMode?: ResponseMode }
      >()
    })

    it("should accept a multipart stream", () => {
      const Api = HttpApi.make("Api")
        .add(
          HttpApiGroup.make("group")
            .add(
              HttpApiEndpoint.post("a", "/a", {
                payload: Schema.String.pipe(HttpApiSchema.asMultipartStream())
              })
            )
        )
      const client = Effect.runSync(
        HttpApiClient.make(Api).pipe(Effect.provide(FetchHttpClient.layer))
      )
      const f = client.group.a
      expect<Parameters<typeof f>[0]>().type.toBe<
        { readonly payload: FormData; readonly responseMode?: ResponseMode }
      >()
    })
  })

  describe("success option", () => {
    it("should accept a schema", () => {
      const Api = HttpApi.make("Api")
        .add(
          HttpApiGroup.make("group")
            .add(
              HttpApiEndpoint.get("a", "/a", {
                success: Schema.Struct({ a: Schema.FiniteFromString })
              })
            )
        )
      const client = Effect.runSync(
        HttpApiClient.make(Api).pipe(Effect.provide(FetchHttpClient.layer))
      )
      expect(client.group.a()).type.toBe<
        Effect.Effect<
          { readonly a: number },
          HttpClientError.HttpClientError | Schema.SchemaError
        >
      >()
    })

    it("should accept an array of schemas", () => {
      const Api = HttpApi.make("Api")
        .add(
          HttpApiGroup.make("group")
            .add(
              HttpApiEndpoint.get("a", "/a", {
                success: [
                  Schema.Struct({ a: Schema.Finite }), // application/json
                  Schema.String.pipe(HttpApiSchema.asText()), // text/plain
                  Schema.Uint8Array.pipe(HttpApiSchema.asUint8Array()) // application/octet-stream
                ]
              })
            )
        )
      const client = Effect.runSync(
        HttpApiClient.make(Api).pipe(Effect.provide(FetchHttpClient.layer))
      )
      expect(client.group.a()).type.toBe<
        Effect.Effect<
          | string
          | { readonly a: number }
          | Uint8Array<ArrayBufferLike>,
          HttpClientError.HttpClientError | Schema.SchemaError
        >
      >()
    })

    it("should infer return type from responseMode", () => {
      const Api = HttpApi.make("Api")
        .add(
          HttpApiGroup.make("group")
            .add(
              HttpApiEndpoint.get("a", "/a", {
                success: Schema.Struct({ a: Schema.FiniteFromString })
              })
            )
        )
      const client = Effect.runSync(
        HttpApiClient.make(Api).pipe(Effect.provide(FetchHttpClient.layer))
      )
      const f = client.group.a

      expect(f({ responseMode: "decoded-only" })).type.toBe<
        Effect.Effect<
          { readonly a: number },
          HttpClientError.HttpClientError | Schema.SchemaError
        >
      >()

      expect(f({ responseMode: "decoded-and-response" })).type.toBe<
        Effect.Effect<
          [{ readonly a: number }, HttpClientResponse.HttpClientResponse],
          HttpClientError.HttpClientError | Schema.SchemaError
        >
      >()

      expect(f({ responseMode: "response-only" })).type.toBe<
        Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError.HttpClientError>
      >()
    })
  })

  describe("error option", () => {
    it("should default to client and schema errors", () => {
      const Api = HttpApi.make("Api")
        .add(
          HttpApiGroup.make("group")
            .add(
              HttpApiEndpoint.get("a", "/a")
            )
        )
      const client = Effect.runSync(
        HttpApiClient.make(Api).pipe(Effect.provide(FetchHttpClient.layer))
      )
      expect(client.group.a()).type.toBe<
        Effect.Effect<
          void,
          | HttpClientError.HttpClientError
          | Schema.SchemaError
        >
      >()
    })

    it("should accept a schema", () => {
      const Api = HttpApi.make("Api")
        .add(
          HttpApiGroup.make("group")
            .add(
              HttpApiEndpoint.get("a", "/a", {
                error: Schema.Struct({ a: Schema.FiniteFromString })
              })
            )
        )
      const client = Effect.runSync(
        HttpApiClient.make(Api).pipe(Effect.provide(FetchHttpClient.layer))
      )
      expect(client.group.a()).type.toBe<
        Effect.Effect<
          void,
          | { readonly a: number }
          | HttpClientError.HttpClientError
          | Schema.SchemaError
        >
      >()
    })
  })

  describe("client middleware", () => {
    it("requiredForClient requires layer and includes required client errors", () => {
      class RequiredClientError extends Schema.ErrorClass<RequiredClientError>("RequiredClientError")({
        _tag: Schema.tag("RequiredClientError")
      }) {}

      class OptionalClientError extends Schema.ErrorClass<OptionalClientError>("OptionalClientError")({
        _tag: Schema.tag("OptionalClientError")
      }) {}

      class RequiredMiddleware extends HttpApiMiddleware.Service<RequiredMiddleware, {
        clientError: RequiredClientError
      }>()("RequiredMiddleware", {
        requiredForClient: true
      }) {}

      class OptionalMiddleware extends HttpApiMiddleware.Service<OptionalMiddleware, {
        clientError: OptionalClientError
      }>()("OptionalMiddleware") {}

      const Api = HttpApi.make("Api")
        .add(
          HttpApiGroup.make("group")
            .add(
              HttpApiEndpoint.get("a", "/a", {
                success: Schema.String
              })
                .middleware(RequiredMiddleware)
                .middleware(OptionalMiddleware)
            )
        )

      const client = Effect.runSync(
        HttpApiClient.make(Api).pipe(
          Effect.provide([
            FetchHttpClient.layer,
            HttpApiMiddleware.layerClient(RequiredMiddleware, ({ next, request }) => next(request))
          ])
        )
      )
      expect(client.group.a()).type.toBe<
        Effect.Effect<
          string,
          | RequiredClientError
          | HttpClientError.HttpClientError
          | Schema.SchemaError
        >
      >()

      expect(Effect.runSync).type.not.toBeCallableWith(
        HttpApiClient.make(Api).pipe(Effect.provide(FetchHttpClient.layer))
      )
    })

    it("requiredForClient is enforced for makeWith, group, and endpoint", () => {
      class RequiredClientError extends Schema.ErrorClass<RequiredClientError>("RequiredClientError")({
        _tag: Schema.tag("RequiredClientError")
      }) {}

      class RequiredMiddleware extends HttpApiMiddleware.Service<RequiredMiddleware, {
        clientError: RequiredClientError
      }>()("RequiredMiddleware", {
        requiredForClient: true
      }) {}

      const Api = HttpApi.make("Api")
        .add(
          HttpApiGroup.make("group")
            .add(
              HttpApiEndpoint.get("a", "/a", {
                success: Schema.String
              })
                .middleware(RequiredMiddleware)
            )
        )

      const TestHttpClient = HttpClient.make(() => Effect.die("not used"))

      expect(Effect.runSync).type.not.toBeCallableWith(HttpApiClient.makeWith(Api, { httpClient: TestHttpClient }))
      expect(Effect.runSync).type.not.toBeCallableWith(
        HttpApiClient.group(Api, { group: "group", httpClient: TestHttpClient })
      )
      expect(Effect.runSync).type.not.toBeCallableWith(
        HttpApiClient.endpoint(Api, { group: "group", endpoint: "a", httpClient: TestHttpClient })
      )

      const middlewareLayer = HttpApiMiddleware.layerClient(
        RequiredMiddleware,
        ({ next, request }) => next(request)
      )

      const withClient = Effect.runSync(
        HttpApiClient.makeWith(Api, { httpClient: TestHttpClient }).pipe(
          Effect.provide(middlewareLayer)
        )
      )
      const fromClient = withClient.group.a

      const withGroup = Effect.runSync(
        HttpApiClient.group(Api, { group: "group", httpClient: TestHttpClient }).pipe(
          Effect.provide(middlewareLayer)
        )
      )
      const fromGroup = withGroup.a

      const fromEndpoint = Effect.runSync(
        HttpApiClient.endpoint(Api, { group: "group", endpoint: "a", httpClient: TestHttpClient }).pipe(
          Effect.provide(middlewareLayer)
        )
      )

      expect(fromClient()).type.toBe<
        Effect.Effect<
          string,
          | RequiredClientError
          | HttpClientError.HttpClientError
          | Schema.SchemaError
        >
      >()

      expect(fromGroup()).type.toBe<
        Effect.Effect<
          string,
          | RequiredClientError
          | HttpClientError.HttpClientError
          | Schema.SchemaError
        >
      >()

      expect(fromEndpoint()).type.toBe<
        Effect.Effect<
          string,
          | RequiredClientError
          | HttpClientError.HttpClientError
          | Schema.SchemaError
        >
      >()
    })
  })
})
