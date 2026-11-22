import { describe, it, test } from "@effect/vitest"
import { assertTrue, deepStrictEqual, strictEqual } from "@effect/vitest/utils"
import { Cause, Context, Effect, Exit, Option, References, Scope, Stream, Tracer } from "effect"
import { identity } from "effect/Function"
import { HttpEffect, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import * as Layer from "effect/Layer"

const TestValue = Context.Reference<number>("test/TestValue", { defaultValue: () => 0 })

describe("HttpEffect", () => {
  it.effect("restores the request Scope context identity", () => {
    const request = HttpServerRequest.fromWeb(new Request("http://localhost:3000/"))
    return Effect.gen(function*() {
      const before = yield* Effect.withFiber((fiber) => Effect.succeed(fiber.context))
      let during: Context.Context<never> | undefined

      yield* HttpEffect.toHandled(
        Effect.withFiber((fiber) => {
          during = fiber.context
          strictEqual(Context.getOrUndefined(fiber.context, Scope.Scope) !== undefined, true)
          return Effect.succeed(HttpServerResponse.empty())
        }),
        () => Effect.void
      )

      const after = yield* Effect.withFiber((fiber) => Effect.succeed(fiber.context))
      strictEqual(during === before, false)
      strictEqual(after, before)
    }).pipe(
      Effect.provideService(HttpServerRequest.HttpServerRequest, request),
      Effect.provideService(References.TracerEnabled, false)
    )
  })

  it.effect("propagates a handler failure through middleware to request and forked scopes", () => {
    const request = HttpServerRequest.fromWeb(new Request("http://localhost:3000/"))
    const error = new Error("handler failed")
    let requestExit: Exit.Exit<unknown, unknown> | undefined
    let childExit: Exit.Exit<unknown, unknown> | undefined
    return Effect.gen(function*() {
      yield* HttpEffect.toHandled(
        Effect.gen(function*() {
          const scope = yield* Effect.scope
          const child = yield* Scope.fork(scope)
          yield* Scope.addFinalizerExit(child, (exit) =>
            Effect.sync(() => {
              childExit = exit
            }))
          yield* Scope.addFinalizerExit(scope, (exit) =>
            Effect.sync(() => {
              requestExit = exit
            }))
          return yield* Effect.fail(error)
        }),
        () => Effect.void,
        identity
      )
      for (const exit of [requestExit, childExit]) {
        strictEqual(exit !== undefined && Exit.isFailure(exit), true)
        if (exit && Exit.isFailure(exit)) {
          strictEqual(exit.cause.reasons.length, 1)
          strictEqual(Cause.squash(exit.cause), error)
        }
      }
    }).pipe(
      Effect.provideService(HttpServerRequest.HttpServerRequest, request),
      Effect.provideService(References.TracerEnabled, false)
    )
  })

  it.effect.each(["plain", "failure", "stream"] as const)(
    "a disabled, untransferred request scope stays open until the host closes it: %s",
    (responseKind) =>
      Effect.gen(function*() {
        let requestScope!: Scope.Closeable
        let response!: HttpServerResponse.HttpServerResponse
        const exits: Array<Exit.Exit<unknown, unknown>> = []
        const handledExit = yield* HttpEffect.toHandled(
          Effect.gen(function*() {
            requestScope = (yield* Effect.scope) as Scope.Closeable
            HttpEffect.scopeDisableClose(requestScope)
            yield* Effect.addFinalizer((exit) =>
              Effect.sync(() => {
                exits.push(exit)
              })
            )
            if (responseKind === "failure") return yield* Effect.fail(new Error("handler failed"))
            return responseKind === "stream"
              ? HttpServerResponse.stream(Stream.make("body").pipe(Stream.encodeText))
              : HttpServerResponse.text("body")
          }),
          (_, handled) =>
            Effect.sync(() => {
              response = handled
            })
        ).pipe(Effect.exit)
        strictEqual(Exit.isFailure(handledExit), responseKind === "failure")
        deepStrictEqual(exits, [])
        strictEqual(response.status, responseKind === "failure" ? 500 : 200)
        if (responseKind === "stream") {
          assertTrue(response.body._tag === "Stream")
          strictEqual(yield* Stream.mkString(Stream.decodeText(response.body.stream)), "body")
          deepStrictEqual(exits, [])
        }
        const hostExit = Exit.fail(new Error("host background work failed"))
        yield* Scope.close(requestScope, hostExit)
        deepStrictEqual(exits, [hostExit])
        yield* Scope.close(requestScope, Exit.void)
        deepStrictEqual(exits, [hostExit])
      }).pipe(
        Effect.provideService(
          HttpServerRequest.HttpServerRequest,
          HttpServerRequest.fromWeb(new Request("http://localhost:3000/"))
        ),
        Effect.provideService(References.TracerEnabled, false)
      )
  )

  describe("toWebHandler", () => {
    test("skips the server span with the default tracer", async () => {
      let hasParentSpan = false
      const handler = HttpEffect.toWebHandler(Effect.gen(function*() {
        hasParentSpan = Option.isSome(yield* Effect.serviceOption(Tracer.ParentSpan))
        return HttpServerResponse.empty()
      }))

      await handler(new Request("http://localhost:3000/"))

      strictEqual(hasParentSpan, false)
    })

    test("provides a parent span with a configured tracer", async () => {
      let hasParentSpan = false
      const tracer = Tracer.make({
        span: (options) => new Tracer.NativeSpan(options)
      })
      const handler = HttpEffect.toWebHandler(Effect.gen(function*() {
        hasParentSpan = Option.isSome(yield* Effect.serviceOption(Tracer.ParentSpan))
        return HttpServerResponse.empty()
      }))

      await handler(new Request("http://localhost:3000/"), Context.make(Tracer.Tracer, tracer))

      strictEqual(hasParentSpan, true)
    })

    test("json", async () => {
      const handler = HttpEffect.toWebHandler(HttpServerResponse.json({ foo: "bar" }))
      const response = await handler(new Request("http://localhost:3000/"))
      deepStrictEqual(await response.json(), {
        foo: "bar"
      })
    })

    test("cookies", async () => {
      const handler = HttpEffect.toWebHandler(Effect.succeed(
        HttpServerResponse.jsonUnsafe({ foo: "bar" }).pipe(
          HttpServerResponse.setCookieUnsafe("foo", "bar"),
          HttpServerResponse.setCookieUnsafe("test", "123", { secure: true, httpOnly: true, sameSite: "strict" })
        )
      ))
      const response = await handler(new Request("http://localhost:3000/"))
      deepStrictEqual(response.headers.getSetCookie(), [
        "foo=bar",
        "test=123; HttpOnly; Secure; SameSite=Strict"
      ])
      deepStrictEqual(await response.json(), {
        foo: "bar"
      })
    })

    test("expireCookie", async () => {
      const handler = HttpEffect.toWebHandler(
        HttpServerResponse.empty().pipe(
          HttpServerResponse.expireCookie("foo", { path: "/" }),
          Effect.map(HttpServerResponse.expireCookieUnsafe("bar"))
        )
      )
      const response = await handler(new Request("http://localhost:3000/"))
      deepStrictEqual(response.headers.getSetCookie(), [
        "foo=; Max-Age=0; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT",
        "bar=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT"
      ])
    })

    test("stream", async () => {
      const handler = HttpEffect.toWebHandler(
        Effect.succeed(HttpServerResponse.stream(Stream.make("foo", "bar").pipe(Stream.encodeText)))
      )
      const response = await handler(new Request("http://localhost:3000/"))
      strictEqual(await response.text(), "foobar")
    })

    test("preserves explicit stream headers", async () => {
      const handler = HttpEffect.toWebHandler(Effect.succeed(
        HttpServerResponse.stream(Stream.empty).pipe(
          HttpServerResponse.setHeaders({
            "Content-Type": "text/javascript",
            "Content-Length": "9007199254740993"
          })
        )
      ))
      const response = await handler(new Request("http://localhost/script.js"))
      await response.arrayBuffer()

      strictEqual(response.headers.get("content-type"), "text/javascript")
      strictEqual(response.headers.get("content-length"), "9007199254740993")
    })

    test.each(["before the request", "while the handler starts"] as const)(
      "an abort %s interrupts the handler as a client abort",
      async (when) => {
        const controller = new AbortController()
        if (when === "before the request") controller.abort()
        let interrupted = false
        const handler = HttpEffect.toWebHandler(
          Effect.sync(() => {
            if (when === "while the handler starts") controller.abort()
          }).pipe(
            Effect.andThen(Effect.never),
            Effect.onInterrupt(() =>
              Effect.sync(() => {
                interrupted = true
              })
            ),
            // Handlers are uninterruptible unless they opt in, as router routes do.
            Effect.interruptible
          )
        )
        const response = await handler(new Request("http://localhost:3000/", { signal: controller.signal }))
        strictEqual(response.status, 499)
        strictEqual(interrupted, true)
      }
    )

    test.each(["after reading a chunk", "while the unread body is full"] as const)(
      "an abort %s releases the request scope owned by a streamed body",
      async (when) => {
        const controller = new AbortController()
        let finalized = false
        let pulledSecond = false
        const handler = HttpEffect.toWebHandler(Effect.gen(function*() {
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              finalized = true
            })
          )
          return HttpServerResponse.stream(
            Stream.make("first").pipe(
              Stream.concat(Stream.fromEffect(Effect.sync(() => {
                pulledSecond = true
                return "second"
              }))),
              Stream.concat(Stream.never),
              Stream.encodeText
            )
          )
        }))
        const waitFor = (predicate: () => boolean) =>
          new Promise<void>((resolve) => {
            const deadline = Date.now() + 1000
            const poll = () => predicate() || Date.now() > deadline ? resolve() : setImmediate(poll)
            poll()
          })
        const response = await handler(new Request("http://localhost:3000/", { signal: controller.signal }))
        if (when === "after reading a chunk") {
          await response.body!.getReader().read()
        } else {
          // The body has taken its second chunk and now waits for a read that never comes.
          await waitFor(() => pulledSecond)
        }

        controller.abort()
        await waitFor(() => finalized)
        strictEqual(finalized, true)
      }
    )

    test("stream scope", async () => {
      let order = 0
      let streamFinalized = 0
      let handlerFinalized = 0
      const handler = HttpEffect.toWebHandler(Effect.gen(function*() {
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            handlerFinalized = order
            order += 1
          })
        )
        const stream = Stream.make("foo", "bar").pipe(
          Stream.encodeText,
          Stream.ensuring(Effect.sync(() => {
            streamFinalized = order
            order += 1
          }))
        )
        return HttpServerResponse.stream(stream)
      }))
      const response = await handler(new Request("http://localhost:3000/"))
      strictEqual(await response.text(), "foobar")
      strictEqual(streamFinalized < handlerFinalized, true)
    })

    test("a streamed body that exits during the request closes the request scope after the request ends", async () => {
      const events: Array<string> = []
      let scopeExit: Exit.Exit<unknown, unknown> | undefined
      const tracer = Tracer.make({
        span: (options) => {
          const span = new Tracer.NativeSpan(options)
          const end = span.end.bind(span)
          span.end = (endTime, exit) => {
            events.push("span ended")
            end(endTime, exit)
          }
          return span
        }
      })
      const controller = new AbortController()
      // A pre-aborted signal interrupts the body while the response is still being handled.
      controller.abort()
      const handler = HttpEffect.toWebHandler(Effect.gen(function*() {
        yield* Effect.addFinalizer((exit) =>
          Effect.sync(() => {
            events.push("scope closed")
            scopeExit = exit
          })
        )
        return HttpServerResponse.stream(Stream.make("body").pipe(Stream.encodeText))
      }))

      await handler(
        new Request("http://localhost:3000/", { signal: controller.signal }),
        Context.make(Tracer.Tracer, tracer)
      )

      deepStrictEqual(events, ["span ended", "scope closed"])
      strictEqual(scopeExit !== undefined && Exit.hasInterrupts(scopeExit), true)
    })

    test("a streamed body that exits before middleware finishes closes the request scope after the middleware", async () => {
      const events: Array<string> = []
      let release!: () => void
      const released = new Promise<void>((resolve) => {
        release = resolve
      })
      const handler = HttpEffect.toWebHandler(
        Effect.gen(function*() {
          yield* Effect.addFinalizer(() => Effect.sync(() => events.push("scope closed")))
          return HttpServerResponse.stream(Stream.make("body").pipe(Stream.encodeText))
        }),
        (app) =>
          Effect.tap(app, () =>
            Effect.promise(() => released).pipe(
              Effect.andThen(Effect.sync(() => events.push("middleware finished")))
            ))
      )

      const response = await handler(new Request("http://localhost:3000/"))
      strictEqual(await response.text(), "body")
      release()
      await new Promise<void>((resolve) => {
        const deadline = Date.now() + 1000
        const poll = () => events.length === 2 || Date.now() > deadline ? resolve() : setImmediate(poll)
        poll()
      })

      deepStrictEqual(events, ["middleware finished", "scope closed"])
    })

    test("a streamed body closes the request scope after the handler disables closing", async () => {
      let finalized = false
      const handler = HttpEffect.toWebHandler(Effect.gen(function*() {
        HttpEffect.scopeDisableClose(yield* Effect.scope)
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            finalized = true
          })
        )
        return HttpServerResponse.stream(Stream.make("body").pipe(Stream.encodeText))
      }))

      const response = await handler(new Request("http://localhost:3000/"))
      strictEqual(await response.text(), "body")

      strictEqual(finalized, true)
    })

    test("a transferred body keeps its first exit when a later transfer succeeds before the request ends", async () => {
      let release!: () => void
      const released = new Promise<void>((resolve) => {
        release = resolve
      })
      const failure = new Error("body failed")
      let scopeExit: Exit.Exit<unknown, unknown> | undefined
      const handler = HttpEffect.toWebHandler(
        Effect.gen(function*() {
          yield* Effect.addFinalizer((exit) =>
            Effect.sync(() => {
              scopeExit = exit
            })
          )
          // A helper transfers a failing body, an outer layer recovers it, and the web
          // handler transfers the recovered response again.
          const transferred = HttpEffect.scopeTransferToStream(HttpServerResponse.stream(Stream.fail(failure)))
          const failing = transferred.body._tag === "Stream" ? transferred.body.stream : Stream.empty
          return HttpServerResponse.stream(
            Stream.catchCause(failing, () => Stream.make("fallback").pipe(Stream.encodeText))
          )
        }),
        (app) => Effect.tap(app, () => Effect.promise(() => released))
      )

      const response = await handler(new Request("http://localhost:3000/"))
      strictEqual(await response.text(), "fallback")
      release()
      await new Promise<void>((resolve) => {
        const deadline = Date.now() + 1000
        const poll = () => scopeExit !== undefined || Date.now() > deadline ? resolve() : setImmediate(poll)
        poll()
      })

      strictEqual(
        scopeExit !== undefined && Exit.isFailure(scopeExit) && Cause.squash(scopeExit.cause) === failure,
        true
      )
    })

    test("streaming HEAD closes the request scope", async () => {
      let finalized = false
      const handler = HttpEffect.toWebHandler(Effect.gen(function*() {
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            finalized = true
          })
        )
        return HttpServerResponse.stream(Stream.make("body").pipe(Stream.encodeText))
      }))

      await handler(new Request("http://localhost:3000/", { method: "HEAD" }))

      strictEqual(finalized, true)
    })

    test.each([204, 205, 304])("status %i closes the request scope without starting the stream", async (status) => {
      let finalized = false
      let streamStarted = false
      const handler = HttpEffect.toWebHandler(Effect.gen(function*() {
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            finalized = true
          })
        )
        return HttpServerResponse.stream(
          Stream.fromEffect(Effect.sync(() => {
            streamStarted = true
            return new Uint8Array([1])
          })),
          { status }
        )
      }))

      const response = await handler(new Request("http://localhost:3000/"))

      strictEqual(response.status, status)
      strictEqual(response.body, null)
      strictEqual(streamStarted, false)
      strictEqual(finalized, true)
    })

    test("stream runtime", async () => {
      const handler = Effect.succeed(HttpServerResponse.stream(
        Stream.fromEffect(TestValue).pipe(Stream.map(String), Stream.encodeText)
      )).pipe(
        HttpEffect.toWebHandlerWith(TestValue.context(420))
      )
      const response = await handler(new Request("http://localhost:3000/"))
      strictEqual(await response.text(), "420")
    })

    test("stream layer", async () => {
      const { handler } = HttpEffect.toWebHandlerLayer(
        Effect.succeed(HttpServerResponse.stream(
          TestValue.pipe(
            Stream.fromEffect,
            Stream.map(String),
            Stream.encodeText
          )
        )),
        Layer.succeed(TestValue, 420)
      )
      const response = await handler(new Request("http://localhost:3000/"))
      strictEqual(await response.text(), "420")
    })

    test("runs pre-response handlers registered in a prefix-sliced route", async () => {
      const { dispose, handler } = HttpRouter.toWebHandler(
        HttpRouter.use((router) =>
          router.prefixed("/api").add(
            "GET",
            "/hello",
            Effect.gen(function*() {
              const request = yield* HttpServerRequest.HttpServerRequest
              yield* HttpEffect.appendPreResponseHandler((_request, response) =>
                Effect.succeed(HttpServerResponse.setHeader(response, "x-pre-response", "applied"))
              )
              return HttpServerResponse.text(request.url)
            })
          )
        ),
        { disableLogger: true }
      )

      try {
        const response = await handler(new Request("http://localhost/api/hello"))
        strictEqual(await response.text(), "/hello")
        strictEqual(response.headers.get("x-pre-response"), "applied")
      } finally {
        await dispose()
      }
    })
  })

  test("custom context", async () => {
    const Env = Context.Reference<{ foo: string }>("Env", {
      defaultValue: () => ({ foo: "bar" })
    })
    const handler = HttpEffect.toWebHandler(Effect.gen(function*() {
      const env = yield* Env
      return yield* HttpServerResponse.json(env)
    }))
    const response = await handler(new Request("http://localhost:3000/"), Env.context({ foo: "baz" }))
    deepStrictEqual(await response.json(), {
      foo: "baz"
    })
  })

  describe("toWebHandlerLayer", () => {
    test("builds the layer when the handler is created", async () => {
      let builds = 0
      const { dispose, handler } = HttpEffect.toWebHandlerLayer(
        Effect.map(TestValue, (value) => HttpServerResponse.text(String(value))),
        Layer.effect(
          TestValue,
          Effect.sync(() => {
            builds++
            return 420
          })
        )
      )
      strictEqual(builds, 1)
      const response = await handler(new Request("http://localhost:3000/"))
      strictEqual(await response.text(), "420")
      strictEqual(builds, 1)
      await dispose()
    })

    test("a failing layer rejects every request without an unhandled rejection", async () => {
      const unhandled: Array<unknown> = []
      const onUnhandled = (reason: unknown) => {
        unhandled.push(reason)
      }
      process.on("unhandledRejection", onUnhandled)
      try {
        const error = new Error("boom")
        const { handler } = HttpEffect.toWebHandlerLayer(
          Effect.succeed(HttpServerResponse.empty()),
          Layer.effectDiscard(Effect.fail(error))
        )
        await new Promise((resolve) => setTimeout(resolve, 0))
        for (let i = 0; i < 2; i++) {
          const rejected = await handler(new Request("http://localhost:3000/")).then(
            () => undefined,
            (cause) => cause
          )
          strictEqual(rejected, error)
        }
        await new Promise((resolve) => setTimeout(resolve, 0))
        deepStrictEqual(unhandled, [])
      } finally {
        process.off("unhandledRejection", onUnhandled)
      }
    })
  })

  describe("fromWebHandler", () => {
    test("basic GET request", async () => {
      const webHandler = async (request: Request) => {
        return new Response(`Hello from ${request.url}`, {
          status: 200,
          headers: { "Content-Type": "text/plain" }
        })
      }
      const app = HttpEffect.fromWebHandler(webHandler)
      const handler = HttpEffect.toWebHandler(app)
      const response = await handler(new Request("http://localhost:3000/hello"))
      strictEqual(response.status, 200)
      strictEqual(await response.text(), "Hello from http://localhost:3000/hello")
    })

    test("POST with JSON body", async () => {
      const webHandler = async (request: Request) => {
        const body = await request.json()
        return Response.json({ received: body })
      }
      const app = HttpEffect.fromWebHandler(webHandler)
      const handler = HttpEffect.toWebHandler(app)
      const response = await handler(
        new Request("http://localhost:3000/", {
          method: "POST",
          body: JSON.stringify({ message: "hello" }),
          headers: { "Content-Type": "application/json" }
        })
      )
      deepStrictEqual(await response.json(), {
        received: { message: "hello" }
      })
    })

    test("preserves request headers", async () => {
      const webHandler = async (request: Request) => {
        return Response.json({
          authorization: request.headers.get("Authorization"),
          custom: request.headers.get("X-Custom-Header")
        })
      }
      const app = HttpEffect.fromWebHandler(webHandler)
      const handler = HttpEffect.toWebHandler(app)
      const response = await handler(
        new Request("http://localhost:3000/", {
          headers: {
            "Authorization": "Bearer token123",
            "X-Custom-Header": "custom-value"
          }
        })
      )
      deepStrictEqual(await response.json(), {
        authorization: "Bearer token123",
        custom: "custom-value"
      })
    })

    test("preserves response status and headers", async () => {
      const webHandler = async (_request: Request) => {
        return new Response("Not Found", {
          status: 404,
          statusText: "Not Found",
          headers: {
            "X-Error-Code": "RESOURCE_NOT_FOUND",
            "Content-Type": "text/plain"
          }
        })
      }
      const app = HttpEffect.fromWebHandler(webHandler)
      const handler = HttpEffect.toWebHandler(app)
      const response = await handler(new Request("http://localhost:3000/missing"))
      strictEqual(response.status, 404)
      strictEqual(response.headers.get("X-Error-Code"), "RESOURCE_NOT_FOUND")
      strictEqual(await response.text(), "Not Found")
    })

    test("round-trip with toWebHandler", async () => {
      // Create an Effect app, convert to web handler, then back to Effect app
      const originalApp = HttpServerResponse.json({ source: "effect" })
      const webHandler = HttpEffect.toWebHandler(originalApp)
      const wrappedApp = HttpEffect.fromWebHandler(webHandler)
      const finalHandler = HttpEffect.toWebHandler(wrappedApp)

      const response = await finalHandler(new Request("http://localhost:3000/"))
      deepStrictEqual(await response.json(), { source: "effect" })
    })

    test("json preserves content-type", async () => {
      const handler = HttpEffect.toWebHandler(HttpServerResponse.json({ foo: "bar" }))
      const response = await handler(new Request("http://localhost:3000/"))
      strictEqual(response.headers.get("Content-Type"), "application/json")
    })

    test("preserves response content-type header", async () => {
      const webHandler = async (_request: Request) => {
        return Response.json({ message: "hello" })
      }
      const app = HttpEffect.fromWebHandler(webHandler)
      const handler = HttpEffect.toWebHandler(app)
      const response = await handler(new Request("http://localhost:3000/"))
      strictEqual(response.headers.get("Content-Type"), "application/json")
      deepStrictEqual(await response.json(), { message: "hello" })
    })

    test("preserves custom content-type header", async () => {
      const webHandler = async (_request: Request) => {
        return new Response("<html></html>", {
          headers: { "Content-Type": "text/html; charset=utf-8" }
        })
      }
      const app = HttpEffect.fromWebHandler(webHandler)
      const handler = HttpEffect.toWebHandler(app)
      const response = await handler(new Request("http://localhost:3000/"))
      strictEqual(response.headers.get("Content-Type"), "text/html; charset=utf-8")
    })
  })
})
