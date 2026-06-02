/** @effect-diagnostics preferSchemaOverJson:skip-file */
import { NodeHttpServer } from "@effect/platform-node"
import { assert, describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import * as Duration from "effect/Duration"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import * as Tracer from "effect/Tracer"
import {
  Cookies,
  HttpBody,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
  HttpPlatform,
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerRespondable,
  HttpServerResponse,
  Multipart,
  UrlParams
} from "effect/unstable/http"
import * as HttpApiError from "effect/unstable/httpapi/HttpApiError"
import * as Buffer from "node:buffer"

const Todo = Schema.Struct({
  id: Schema.Number,
  title: Schema.String
})
const IdParams = Schema.Struct({
  id: Schema.FiniteFromString
})
const todoResponse = HttpServerResponse.schemaJson(Todo)

describe("HttpServer", () => {
  it.effect("schema", () =>
    Effect.gen(function*() {
      yield* HttpRouter.add(
        "GET",
        "/todos/:id",
        Effect.flatMap(
          HttpRouter.schemaParams(IdParams),
          ({ id }) => todoResponse({ id, title: "test" })
        )
      ).pipe(
        HttpRouter.serve,
        Layer.build
      )
      const todo = yield* HttpClient.get("/todos/1").pipe(
        Effect.flatMap(HttpClientResponse.schemaBodyJson(Todo))
      )
      expect(todo).toEqual({ id: 1, title: "test" })
    }).pipe(Effect.provide(NodeHttpServer.layerTest)))

  it.effect("formData", () =>
    Effect.gen(function*() {
      yield* HttpRouter.add(
        "POST",
        "/upload",
        Effect.gen(function*() {
          const request = yield* HttpServerRequest.HttpServerRequest
          const formData = yield* request.multipart
          const part = formData.file
          assert(typeof part !== "string")
          const file = part[0]
          assert(typeof file !== "string")
          expect(file.path.endsWith("/test.txt")).toEqual(true)
          expect(file.contentType).toEqual("text/plain")
          return yield* HttpServerResponse.json({ ok: "file" in formData })
        })
      ).pipe(
        HttpRouter.serve,
        Layer.build
      )
      const client = yield* HttpClient.HttpClient
      const formData = new FormData()
      formData.append("file", new Blob(["test"], { type: "text/plain" }), "test.txt")
      const result = yield* client.post("/upload", { body: HttpBody.formData(formData) }).pipe(
        Effect.flatMap((r) => r.json)
      )
      expect(result).toEqual({ ok: true })
    }).pipe(Effect.provide(NodeHttpServer.layerTest)))

  it.effect("schemaBodyForm", () =>
    Effect.gen(function*() {
      yield* HttpRouter.add(
        "POST",
        "/upload",
        Effect.gen(function*() {
          const files = yield* HttpServerRequest.schemaBodyForm(Schema.Struct({
            file: Multipart.FilesSchema,
            test: Schema.String
          }))
          expect(files).toHaveProperty("file")
          expect(files).toHaveProperty("test")
          return HttpServerResponse.empty()
        })
      ).pipe(
        HttpRouter.serve,
        Layer.build
      )
      const client = yield* HttpClient.HttpClient
      const formData = new FormData()
      formData.append("file", new Blob(["test"], { type: "text/plain" }), "test.txt")
      formData.append("test", "test")
      const response = yield* client.post("/upload", { body: HttpBody.formData(formData) })
      expect(response.status).toEqual(204)
    }).pipe(Effect.provide(NodeHttpServer.layerTest)))

  it.effect("formData withMaxFileSize", () =>
    Effect.gen(function*() {
      yield* HttpRouter.add(
        "POST",
        "/upload",
        Effect.gen(function*() {
          const request = yield* HttpServerRequest.HttpServerRequest
          yield* request.multipart
          return HttpServerResponse.empty()
        }).pipe(
          Effect.catchTag("MultipartError", (error) =>
            error.reason._tag === "FileTooLarge" ?
              Effect.succeed(HttpServerResponse.empty({ status: 413 })) :
              Effect.fail(error))
        )
      ).pipe(
        HttpRouter.serve,
        Layer.build,
        Effect.provideService(Multipart.MaxFileSize, 100)
      )
      const client = yield* HttpClient.HttpClient
      const formData = new FormData()
      const data = new Uint8Array(1000)
      formData.append("file", new Blob([data], { type: "text/plain" }), "test.txt")
      const response = yield* client.post("/upload", { body: HttpBody.formData(formData) })
      expect(response.status).toEqual(413)
    }).pipe(Effect.provide(NodeHttpServer.layerTest)))

  it.effect("formData withMaxFieldSize", () =>
    Effect.gen(function*() {
      yield* HttpRouter.add(
        "POST",
        "/upload",
        Effect.gen(function*() {
          const request = yield* HttpServerRequest.HttpServerRequest
          yield* request.multipart
          return HttpServerResponse.empty()
        }).pipe(
          Effect.catchTag("MultipartError", (error) =>
            error.reason._tag === "FieldTooLarge" ?
              Effect.succeed(HttpServerResponse.empty({ status: 413 })) :
              Effect.fail(error))
        )
      ).pipe(
        HttpRouter.serve,
        Layer.build,
        Effect.provideService(Multipart.MaxFieldSize, 100)
      )
      const client = yield* HttpClient.HttpClient
      const formData = new FormData()
      const data = new Uint8Array(1000).fill(1)
      formData.append("file", new TextDecoder().decode(data))
      const response = yield* client.post("/upload", { body: HttpBody.formData(formData) })
      expect(response.status).toEqual(413)
    }).pipe(Effect.provide(NodeHttpServer.layerTest)))

  it.effect("mountApp", () =>
    Effect.gen(function*() {
      const child = Effect.map(HttpServerRequest.HttpServerRequest, (_) => HttpServerResponse.text(_.url))
      yield* HttpRouter.use((router) => router.prefixed("/child").add("*", "*", child)).pipe(
        HttpRouter.serve,
        Layer.build
      )
      const client = yield* HttpClient.HttpClient
      const todo = yield* client.get("/child/1").pipe(Effect.flatMap((_) => _.text))
      expect(todo).toEqual("/1")
      const root = yield* client.get("/child").pipe(Effect.flatMap((_) => _.text))
      expect(root).toEqual("/")
      const rootSearch = yield* client.get("/child?foo=bar").pipe(Effect.flatMap((_) => _.text))
      expect(rootSearch).toEqual("?foo=bar")
      const rootSlash = yield* client.get("/child/").pipe(Effect.flatMap((_) => _.text))
      expect(rootSlash).toEqual("/")
      const invalid = yield* client.get("/child1/", {
        urlParams: { foo: "bar" }
      }).pipe(Effect.map((_) => _.status))
      expect(invalid).toEqual(404)
    }).pipe(Effect.provide(NodeHttpServer.layerTest)))

  it.effect("file", () =>
    Effect.gen(function*() {
      yield* (yield* HttpServerResponse.file(`${__dirname}/fixtures/text.txt`).pipe(
        Effect.updateService(
          HttpPlatform.HttpPlatform,
          (_) => ({
            ..._,
            fileResponse: (path, options) =>
              Effect.map(
                _.fileResponse(path, options),
                (res) => {
                  ;(res as any).headers.etag = "\"etag\""
                  return res
                }
              )
          })
        )
      )).pipe(
        Effect.succeed,
        HttpServer.serveEffect()
      )
      const client = yield* HttpClient.HttpClient
      const res = yield* client.get("/")
      expect(res.status).toEqual(200)
      expect(res.headers["content-type"]).toEqual("text/plain")
      expect(res.headers["content-length"]).toEqual("27")
      expect(res.headers.etag).toEqual("\"etag\"")
      const text = yield* res.text
      expect(text.trim()).toEqual("lorem ipsum dolar sit amet")
    }).pipe(Effect.provide(NodeHttpServer.layerTest)))

  it.effect("fileWeb", () =>
    Effect.gen(function*() {
      const now = new Date()
      const file = new Buffer.File([new TextEncoder().encode("test")], "test.txt", {
        type: "text/plain",
        lastModified: now.getTime()
      })
      yield* HttpServerResponse.fileWeb(file).pipe(
        Effect.updateService(
          HttpPlatform.HttpPlatform,
          (_) => ({
            ..._,
            fileWebResponse: (path, options) =>
              Effect.map(
                _.fileWebResponse(path, options),
                (res) => ({ ...res, headers: { ...res.headers, etag: "W/\"etag\"" } })
              )
          })
        ),
        HttpServer.serveEffect()
      )
      const client = yield* HttpClient.HttpClient
      const res = yield* client.get("/")
      expect(res.status).toEqual(200)
      expect(res.headers["content-type"]).toEqual("text/plain")
      expect(res.headers["content-length"]).toEqual("4")
      expect(res.headers["last-modified"]).toEqual(now.toUTCString())
      expect(res.headers.etag).toEqual("W/\"etag\"")
      const text = yield* res.text
      expect(text.trim()).toEqual("test")
    }).pipe(Effect.provide(NodeHttpServer.layerTest)))

  it.effect("schemaBodyUrlParams", () =>
    Effect.gen(function*() {
      yield* HttpRouter.add(
        "POST",
        "/todos",
        Effect.flatMap(
          HttpServerRequest.schemaBodyUrlParams(Schema.Struct({
            id: Schema.FiniteFromString,
            title: Schema.String
          })),
          ({ id, title }) => todoResponse({ id, title })
        )
      ).pipe(
        HttpRouter.serve,
        Layer.build
      )
      const todo = yield* HttpClientRequest.post("/todos").pipe(
        HttpClientRequest.bodyUrlParams({ id: "1", title: "test" }),
        HttpClient.execute,
        Effect.flatMap(HttpClientResponse.schemaBodyJson(Todo))
      )
      expect(todo).toEqual({ id: 1, title: "test" })
    }).pipe(Effect.provide(NodeHttpServer.layerTest)))

  it.effect("schemaBodyUrlParams error", () =>
    Effect.gen(function*() {
      yield* HttpRouter.add(
        "GET",
        "/todos",
        Effect.flatMap(
          HttpServerRequest.schemaBodyUrlParams(Schema.Struct({
            id: Schema.FiniteFromString,
            title: Schema.String
          })),
          ({ id, title }) => todoResponse({ id, title })
        ).pipe(
          Effect.catchTag("SchemaError", (error) =>
            Effect.succeed(HttpServerResponse.jsonUnsafe({ error }, { status: 400 })))
        )
      ).pipe(
        HttpRouter.serve,
        Layer.build
      )
      const client = yield* HttpClient.HttpClient
      const response = yield* client.get("/todos")
      expect(response.status).toEqual(400)
    }).pipe(Effect.provide(NodeHttpServer.layerTest)))

  it.effect("schemaBodyFormJson", () =>
    Effect.gen(function*() {
      yield* HttpRouter.add(
        "POST",
        "/upload",
        Effect.gen(function*() {
          const result = yield* HttpServerRequest.schemaBodyFormJson(Schema.Struct({
            test: Schema.String
          }))("json")
          expect(result.test).toEqual("content")
          return HttpServerResponse.empty()
        })
      ).pipe(
        HttpRouter.serve,
        Layer.build
      )
      const client = yield* HttpClient.HttpClient
      const formData = new FormData()
      formData.append("json", JSON.stringify({ test: "content" }))
      const response = yield* client.post("/upload", { body: HttpBody.formData(formData) })
      expect(response.status).toEqual(204)
    }).pipe(Effect.provide(NodeHttpServer.layerTest)))

  it.effect("schemaBodyFormJson file", () =>
    Effect.gen(function*() {
      yield* HttpRouter.add(
        "POST",
        "/upload",
        Effect.gen(function*() {
          const result = yield* HttpServerRequest.schemaBodyFormJson(Schema.Struct({
            test: Schema.String
          }))("json")

          expect(result.test).toEqual("content")
          return HttpServerResponse.empty()
        })
      ).pipe(
        HttpRouter.serve,
        Layer.build
      )
      const client = yield* HttpClient.HttpClient
      const formData = new FormData()
      formData.append(
        "json",
        new Blob([JSON.stringify({ test: "content" })], { type: "application/json" }),
        "test.json"
      )
      const response = yield* client.post("/upload", { body: HttpBody.formData(formData) })
      expect(response.status).toEqual(204)
    }).pipe(Effect.provide(NodeHttpServer.layerTest)))

  it.effect("schemaBodyFormJson url encoded", () =>
    Effect.gen(function*() {
      yield* HttpRouter.add(
        "POST",
        "/upload",
        Effect.gen(function*() {
          const result = yield* HttpServerRequest.schemaBodyFormJson(Schema.Struct({
            test: Schema.String
          }))("json")
          expect(result.test).toEqual("content")
          return HttpServerResponse.empty()
        })
      ).pipe(
        HttpRouter.serve,
        Layer.build
      )
      const client = yield* HttpClient.HttpClient
      const response = yield* client.post("/upload", {
        body: HttpBody.urlParams(UrlParams.fromInput({
          json: JSON.stringify({ test: "content" })
        }))
      })
      expect(response.status).toEqual(204)
    }).pipe(Effect.provide(NodeHttpServer.layerTest)))

  it.effect("tracing", () =>
    Effect.gen(function*() {
      yield* HttpRouter.add(
        "GET",
        "/",
        Effect.flatMap(
          Effect.currentSpan,
          (_) => HttpServerResponse.json({ spanId: _.spanId, parent: _.parent })
        )
      ).pipe(
        HttpRouter.serve,
        Layer.build
      )
      const client = yield* HttpClient.HttpClient
      const requestSpan = yield* Effect.makeSpan("client request")
      const body = yield* client.get("/").pipe(
        Effect.flatMap((r) => r.json),
        Effect.provideService(
          Tracer.Tracer,
          Tracer.make({
            span(options) {
              assert.strictEqual(options.name, "http.client GET")
              assert.strictEqual(options.kind, "client")
              assert(options.parent._tag === "Some")
              if (options.parent.value._tag !== "Span") {
                throw new Error("Expected span parent")
              }
              assert.strictEqual(options.parent.value.name, "request parent")
              return requestSpan
            }
          })
        ),
        Effect.withSpan("request parent"),
        Effect.repeat({ times: 2 })
      )
      expect((body as any).parent._tag).toEqual("Some")
      expect((body as any).parent.value.spanId).toEqual(requestSpan.spanId)
    }).pipe(Effect.provide(NodeHttpServer.layerTest)))

  it.effect("html", () =>
    Effect.gen(function*() {
      yield* HttpRouter.addAll([
        HttpRouter.route("GET", "/home", HttpServerResponse.html("<html />")),
        HttpRouter.route(
          "GET",
          "/about",
          HttpServerResponse.html`<html>${Effect.succeed("<body />")}</html>`
        ),
        HttpRouter.route(
          "GET",
          "/stream",
          HttpServerResponse.htmlStream`<html>${Stream.make("<body />", 123, "hello")}</html>`
        )
      ]).pipe(
        HttpRouter.serve,
        Layer.build
      )
      const client = yield* HttpClient.HttpClient
      const home = yield* client.get("/home").pipe(Effect.flatMap((r) => r.text))
      expect(home).toEqual("<html />")
      const about = yield* client.get("/about").pipe(Effect.flatMap((r) => r.text))
      expect(about).toEqual("<html><body /></html>")
      const stream = yield* client.get("/stream").pipe(Effect.flatMap((r) => r.text))
      expect(stream).toEqual("<html><body />123hello</html>")
    }).pipe(Effect.provide(NodeHttpServer.layerTest)))

  it.effect("setCookie", () =>
    Effect.gen(function*() {
      yield* HttpRouter.add(
        "GET",
        "/home",
        HttpServerResponse.empty().pipe(
          HttpServerResponse.setCookieUnsafe("test", "value"),
          HttpServerResponse.setCookieUnsafe("test2", "value2", {
            httpOnly: true,
            secure: true,
            sameSite: "lax",
            partitioned: true,
            path: "/",
            domain: "example.com",
            expires: new Date(2022, 1, 1, 0, 0, 0, 0),
            maxAge: "5 minutes"
          })
        )
      ).pipe(
        HttpRouter.serve,
        Layer.build
      )
      const client = yield* HttpClient.HttpClient
      const res = yield* client.get("/home")
      assert.deepStrictEqual(
        res.cookies.toJSON(),
        Cookies.fromReadonlyRecord({
          test: Cookies.makeCookieUnsafe("test", "value"),
          test2: Cookies.makeCookieUnsafe("test2", "value2", {
            httpOnly: true,
            secure: true,
            sameSite: "lax",
            partitioned: true,
            path: "/",
            domain: "example.com",
            expires: new Date(2022, 1, 1, 0, 0, 0, 0),
            maxAge: Duration.minutes(5)
          })
        }).toJSON()
      )
    }).pipe(Effect.provide(NodeHttpServer.layerTest)))

  it.live("uninterruptible routes", () =>
    Effect.gen(function*() {
      yield* HttpRouter.add(
        "GET",
        "/home",
        Effect.gen(function*() {
          const fiber = Fiber.getCurrent()!
          setTimeout(() => fiber.interruptUnsafe(fiber.id), 10)
          yield* Effect.sleep(50)
          return HttpServerResponse.empty()
        }),
        { uninterruptible: true }
      ).pipe(
        HttpRouter.serve,
        Layer.build
      )
      const client = yield* HttpClient.HttpClient
      const res = yield* client.get("/home")
      assert.strictEqual(res.status, 204)
    }).pipe(Effect.provide(NodeHttpServer.layerTest)))

  describe("HttpServerRespondable", () => {
    it.effect("error/schema", () =>
      Effect.gen(function*() {
        class CustomError extends Schema.ErrorClass<CustomError>("CustomError")({
          _tag: Schema.tag("CustomError"),
          name: Schema.String
        }) {
          [HttpServerRespondable.symbol]() {
            return HttpServerResponse.schemaJson(CustomError)(this, { status: 599 })
          }
        }
        yield* HttpRouter.add(
          "GET",
          "/home",
          new CustomError({ name: "test" })
        ).pipe(
          HttpRouter.serve,
          Layer.build
        )
        const client = yield* HttpClient.HttpClient
        const res = yield* client.get("/home")
        assert.strictEqual(res.status, 599)
        const err = yield* HttpClientResponse.schemaBodyJson(CustomError)(res)
        assert.deepStrictEqual(err, new CustomError({ name: "test" }))
      }).pipe(Effect.provide(NodeHttpServer.layerTest)))

    it.effect("httpapi error", () =>
      Effect.gen(function*() {
        yield* HttpRouter.add(
          "GET",
          "/home",
          new HttpApiError.BadRequest({})
        ).pipe(
          HttpRouter.serve,
          Layer.build
        )
        const client = yield* HttpClient.HttpClient
        const res = yield* client.get("/home")
        assert.strictEqual(res.status, 400)
      }).pipe(Effect.provide(NodeHttpServer.layerTest)))
  })

  it.effect("RouterConfig", () =>
    Effect.gen(function*() {
      yield* HttpRouter.add(
        "GET",
        "/:param",
        Effect.succeed(HttpServerResponse.empty())
      ).pipe(
        HttpRouter.serve,
        Layer.build
      )
      let res = yield* HttpClient.get("/123456")
      assert.strictEqual(res.status, 404)
      res = yield* HttpClient.get("/12345")
      assert.strictEqual(res.status, 204)
    }).pipe(
      Effect.provide([
        NodeHttpServer.layerTest,
        Layer.succeed(HttpRouter.RouterConfig)({ maxParamLength: 5 })
      ])
    ))

  it.effect("HttpRouter prefixed", () =>
    Effect.gen(function*() {
      const handler = HttpRouter.serve(HttpRouter.use(Effect.fnUntraced(function*(router_) {
        const router = router_.prefixed("/todos")
        yield* router.add(
          "GET",
          "/:id",
          Effect.flatMap(
            HttpRouter.schemaParams(IdParams),
            ({ id }) => todoResponse({ id, title: "test" })
          )
        )
        yield* router.addAll([
          HttpRouter.route("GET", "/", Effect.succeed(HttpServerResponse.text("root")))
        ])
      })))

      yield* Layer.build(handler)

      const todo = yield* HttpClient.get("/todos/1").pipe(
        Effect.flatMap(HttpClientResponse.schemaBodyJson(Todo))
      )
      expect(todo).toEqual({ id: 1, title: "test" })
      const root = yield* HttpClient.get("/todos").pipe(
        Effect.flatMap((r) => r.text)
      )
      expect(root).toEqual("root")
    }).pipe(Effect.provide(NodeHttpServer.layerTest)))
})
