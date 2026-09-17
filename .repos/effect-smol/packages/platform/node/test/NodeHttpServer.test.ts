/** @effect-diagnostics preferSchemaOverJson:skip-file */
import { NodeHttpServer } from "@effect/platform-node"
import { NodeWS } from "@effect/platform-node/NodeSocket"
import { assert, describe, expect, it } from "@effect/vitest"
import { Effect, Option } from "effect"
import * as Duration from "effect/Duration"
import * as Fiber from "effect/Fiber"
import * as Latch from "effect/Latch"
import * as Layer from "effect/Layer"
import * as ManagedRuntime from "effect/ManagedRuntime"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import * as Tracer from "effect/Tracer"
import {
  Cookies,
  FetchHttpClient,
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
import { EventEmitter } from "node:events"
import * as Http from "node:http"
import * as Net from "node:net"

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

  it.effect("schemaJson applies a JSON reviver", () =>
    Effect.gen(function*() {
      yield* HttpRouter.add(
        "POST",
        "/json",
        Effect.gen(function*() {
          const decoded = yield* HttpRouter.schemaJson(
            Schema.Struct({ body: Schema.Struct({ value: Schema.String }) }),
            { reviver: (key, value) => key === "value" ? "revived" : value }
          )
          assert.deepStrictEqual(decoded, { body: { value: "revived" } })
          return HttpServerResponse.empty()
        })
      ).pipe(HttpRouter.serve, Layer.build)

      const response = yield* HttpClient.post("/json", {
        body: HttpBody.jsonUnsafe({ value: "original" })
      })
      assert.strictEqual(response.status, 204)
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
          const result = yield* HttpServerRequest.schemaBodyFormJson(
            Schema.Struct({
              test: Schema.String
            }),
            { reviver: (key, value) => key === "test" ? "revived" : value }
          )("json")
          expect(result.test).toEqual("revived")
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

  it.effect("completes a HEAD response once when close precedes the end callback", () =>
    Effect.gen(function*() {
      const scope = yield* Effect.scope
      const handler = yield* NodeHttpServer.makeHandler(
        Effect.succeed(HttpServerResponse.empty()),
        { scope }
      )
      const completed = Latch.makeUnsafe()
      let writableEnded = false
      const nodeResponse = Object.defineProperty(new EventEmitter(), "writableEnded", {
        get: () => writableEnded
      }) as Http.ServerResponse
      let closeListenerRemovals = 0
      nodeResponse.writeHead = () => nodeResponse
      nodeResponse.off = ((event: string | symbol, listener: (...args: Array<unknown>) => void) => {
        if (event === "close") {
          closeListenerRemovals++
        }
        return EventEmitter.prototype.off.call(nodeResponse, event, listener) as Http.ServerResponse
      }) as Http.ServerResponse["off"]
      nodeResponse.end = ((callback: () => void) => {
        writableEnded = true
        nodeResponse.emit("close")
        callback()
        completed.openUnsafe()
        return nodeResponse
      }) as Http.ServerResponse["end"]

      handler(
        { method: "HEAD", url: "/", headers: {}, socket: {} } as Http.IncomingMessage,
        nodeResponse
      )
      yield* completed.await

      assert.strictEqual(closeListenerRemovals, 1)
    }))

  it.effect("returns none when a late remoteAddress read finds no socket", () =>
    Effect.gen(function*() {
      const scope = yield* Effect.scope
      let request: HttpServerRequest.HttpServerRequest | undefined
      const handler = yield* NodeHttpServer.makeHandler(
        Effect.gen(function*() {
          request = yield* HttpServerRequest.HttpServerRequest
          return HttpServerResponse.empty()
        }),
        { scope }
      )
      const completed = Latch.makeUnsafe()
      let writableEnded = false
      const nodeResponse = Object.defineProperty(new EventEmitter(), "writableEnded", {
        get: () => writableEnded
      }) as Http.ServerResponse
      nodeResponse.writeHead = () => nodeResponse
      nodeResponse.end = (() => {
        writableEnded = true
        completed.openUnsafe()
        return nodeResponse
      }) as Http.ServerResponse["end"]
      const nodeRequest = {
        method: "GET",
        url: "/",
        headers: {},
        socket: { remoteAddress: "127.0.0.1" }
      } as unknown as Http.IncomingMessage

      handler(nodeRequest, nodeResponse)
      yield* completed.await
      assert(request !== undefined)
      ;(nodeRequest as unknown as { socket: null }).socket = null

      assert.deepStrictEqual(request.remoteAddress, Option.none())
    }))

  it.effect("coalesces streaming chunks from the same pull", () =>
    Effect.gen(function*() {
      const scope = yield* Effect.scope
      const handler = yield* NodeHttpServer.makeHandler(
        Effect.succeed(HttpServerResponse.stream(Stream.make(
          Buffer.Buffer.from("a"),
          Buffer.Buffer.from("b")
        ))),
        { scope }
      )
      const completed = Latch.makeUnsafe()
      const writes: Array<Uint8Array> = []
      let writableEnded = false
      const nodeResponse = Object.defineProperty(new EventEmitter(), "writableEnded", {
        get: () => writableEnded
      }) as Http.ServerResponse
      nodeResponse.writeHead = () => nodeResponse
      nodeResponse.write = ((chunk: Uint8Array) => {
        writes.push(chunk)
        return true
      }) as Http.ServerResponse["write"]
      nodeResponse.end = (() => {
        writableEnded = true
        completed.openUnsafe()
        return nodeResponse
      }) as Http.ServerResponse["end"]

      handler(
        { method: "GET", url: "/", headers: {}, socket: {} } as Http.IncomingMessage,
        nodeResponse
      )
      yield* completed.await

      assert.deepStrictEqual(writes.map((chunk) => Buffer.Buffer.from(chunk).toString()), ["ab"])
    }))

  it.effect("waits for drain after a streaming write applies backpressure", () =>
    Effect.gen(function*() {
      const scope = yield* Effect.scope
      const handler = yield* NodeHttpServer.makeHandler(
        Effect.succeed(HttpServerResponse.stream(Stream.make(
          Buffer.Buffer.from("a"),
          Buffer.Buffer.from("b")
        ))),
        { scope }
      )
      const writeObserved = Latch.makeUnsafe()
      const completed = Latch.makeUnsafe()
      let writableEnded = false
      const nodeResponse = Object.defineProperty(new EventEmitter(), "writableEnded", {
        get: () => writableEnded
      }) as Http.ServerResponse
      let writeCount = 0
      nodeResponse.writeHead = () => nodeResponse
      nodeResponse.write = (() => {
        writeCount++
        queueMicrotask(() => writeObserved.openUnsafe())
        return writeCount > 1
      }) as Http.ServerResponse["write"]
      nodeResponse.end = (() => {
        writableEnded = true
        completed.openUnsafe()
        return nodeResponse
      }) as Http.ServerResponse["end"]

      handler(
        { method: "GET", url: "/", headers: {}, socket: {} } as Http.IncomingMessage,
        nodeResponse
      )
      yield* writeObserved.await
      assert.strictEqual(nodeResponse.writableEnded, false)

      nodeResponse.emit("drain")
      yield* completed.await
      assert.strictEqual(writeCount, 1)
    }))

  it.live("disposes after a client aborts a handler awaiting an upstream request", () => {
    const upstreamStarted = Latch.makeUnsafe()
    const upstream = Http.createServer(() => {
      upstreamStarted.openUnsafe()
    })
    const server = Http.createServer()
    const router = HttpRouter.use((router) =>
      router.add(
        "GET",
        "/",
        Effect.gen(function*() {
          const request = yield* HttpServerRequest.HttpServerRequest
          if (request.method !== "HEAD") {
            return HttpServerResponse.text("ok")
          }
          yield* HttpClient.head(`http://localhost:${tcpPort(upstream)}`)
          return HttpServerResponse.empty()
        })
      )
    )
    const runtime = ManagedRuntime.make(
      Layer.effectDiscard(
        HttpRouter.serve(router).pipe(
          Layer.provide(NodeHttpServer.layer(() => server, {
            port: 0,
            gracefulShutdownTimeout: "100 millis"
          })),
          Layer.provide(FetchHttpClient.layer),
          Layer.launch,
          Effect.forkScoped,
          Effect.asVoid
        )
      )
    )

    return Effect.gen(function*() {
      yield* Effect.callback<void>((resume) => {
        upstream.listen(0, () => resume(Effect.void))
      })
      yield* Effect.promise(() => runtime.context())
      yield* Effect.callback<void>((resume) => {
        if (server.listening) {
          resume(Effect.void)
        } else {
          server.once("listening", () => resume(Effect.void))
        }
      })

      const downstreamClosed = Latch.makeUnsafe()
      const downstream = Http.request({ method: "HEAD", port: tcpPort(server), path: "/" })
      downstream.on("error", () => {})
      downstream.on("close", () => downstreamClosed.openUnsafe())
      downstream.end()
      yield* upstreamStarted.await
      downstream.destroy()
      yield* downstreamClosed.await

      const disposed = yield* Effect.promise(() => runtime.dispose()).pipe(
        Effect.timeoutOption("2 seconds")
      )
      assert.strictEqual(disposed._tag, "Some")
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          upstream.closeAllConnections()
          upstream.close()
        }).pipe(
          Effect.andThen(Effect.promise(() => runtime.dispose())),
          Effect.timeoutOrElse({ duration: "2 seconds", orElse: () => Effect.void })
        )
      )
    )
  })

  describe("HttpServerRespondable", () => {
    it.effect("error/schema", () =>
      Effect.gen(function*() {
        class CustomError extends Schema.Error<CustomError>("CustomError")({
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

  it.effect("websocket options are forwarded to the WebSocketServer", () =>
    Effect.gen(function*() {
      yield* HttpRouter.add(
        "GET",
        "/ws",
        Effect.gen(function*() {
          const request = yield* HttpServerRequest.HttpServerRequest
          const socket = yield* Effect.orDie(request.upgrade)
          yield* Effect.orDie(socket.run(() => Effect.void))
          return HttpServerResponse.empty()
        })
      ).pipe(
        HttpRouter.serve,
        Layer.build
      )
      const server = yield* HttpServer.HttpServer
      const port = (server.address as HttpServer.TcpAddress).port

      const connect = (perMessageDeflate: boolean) =>
        Effect.acquireRelease(
          Effect.callback<NodeWS.WebSocket, Error>((resume) => {
            const ws = new NodeWS.WebSocket(`ws://127.0.0.1:${port}/ws`, { perMessageDeflate })
            ws.on("open", () => resume(Effect.succeed(ws)))
            ws.on("error", (error) => resume(Effect.fail(error)))
          }),
          (ws) => Effect.sync(() => ws.close())
        )

      // layerTest configures websocket: { perMessageDeflate: true }, so the
      // server accepts the extension when the client offers it...
      const compressed = yield* connect(true)
      expect(compressed.extensions).toContain("permessage-deflate")

      // ...and clients that do not offer it still connect uncompressed.
      const plain = yield* connect(false)
      expect(plain.extensions).not.toContain("permessage-deflate")
    }).pipe(Effect.scoped, Effect.provide(layerTestWebsocket)))

  it.effect("an upgrade connection reset by the peer does not crash the process", () =>
    Effect.gen(function*() {
      yield* HttpRouter.add("GET", "/", HttpServerResponse.text("ok")).pipe(
        HttpRouter.serve,
        Layer.build
      )
      const server = yield* HttpServer.HttpServer
      const port = (server.address as HttpServer.TcpAddress).port

      const uncaught: Array<unknown> = []
      const onUncaught = (error: unknown) => uncaught.push(error)
      process.on("uncaughtException", onUncaught)
      yield* Effect.addFinalizer(() => Effect.sync(() => process.off("uncaughtException", onUncaught)))

      yield* Effect.callback<void>((resume) => {
        const socket = Net.connect({ port, host: "127.0.0.1" }, () => {
          socket.write(
            "GET /ws HTTP/1.1\r\n" +
              "Host: 127.0.0.1\r\n" +
              "Upgrade: websocket\r\n" +
              "Connection: Upgrade\r\n" +
              "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n" +
              "Sec-WebSocket-Version: 13\r\n\r\n"
          )
          setTimeout(() => {
            socket.resetAndDestroy()
            setTimeout(() => resume(Effect.void), 50)
          }, 50)
        })
        socket.on("error", () => {})
      })

      expect(uncaught).toEqual([])
      const response = yield* HttpClient.get("/")
      expect(response.status).toEqual(200)
    }).pipe(Effect.provide(layerTestWebsocket)))
})

const layerTestWebsocket = HttpServer.layerTestClient.pipe(
  Layer.provide(
    Layer.fresh(FetchHttpClient.layer).pipe(
      Layer.provide(Layer.succeed(FetchHttpClient.RequestInit)({ keepalive: false }))
    )
  ),
  Layer.provideMerge(NodeHttpServer.layer(Http.createServer, {
    port: 0,
    websocket: { perMessageDeflate: true }
  }))
)

const tcpPort = (server: Http.Server): number => {
  const address = server.address()
  assert(address !== null && typeof address !== "string")
  return address.port
}
