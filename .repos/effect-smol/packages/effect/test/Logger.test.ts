import { assert, describe, it } from "@effect/vitest"
import { Exit, Scope } from "effect"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Logger from "effect/Logger"
import * as References from "effect/References"
import * as TestConsole from "effect/testing/TestConsole"

describe("Logger", () => {
  it.effect("should output logs", () =>
    Effect.gen(function*() {
      yield* Effect.logInfo("info", "message").pipe(
        Effect.annotateLogs("key", "value"),
        Effect.withLogSpan("span")
      )

      const result = yield* TestConsole.logLines

      assert.match(
        result[0] as string,
        /\[\d{2}:\d{2}:\d{2}\.\d{3}\]\sINFO\s\(#1\)\sspan=\dms:/
      )
      assert.strictEqual(result[1], "info")
      assert.strictEqual(result[2], "message")
      assert.deepStrictEqual(result[3], { key: "value" })
    }))

  it.effect(
    "replace loggers",
    Effect.fnUntraced(function*() {
      const result: Array<string> = []
      const context = yield* Layer.build(Logger.layer([Logger.formatJson.pipe(
        Logger.map((inp): void => {
          result.push(inp)
        })
      )]))
      yield* Effect.logInfo("info", "message").pipe(Effect.provideContext(context))
      assert.strictEqual(result.length, 1)
    })
  )

  it.effect("formatLogFmt does not double quote string messages or annotations", () =>
    Effect.gen(function*() {
      const result: Array<string> = []
      const logger = Logger.formatLogFmt.pipe(
        Logger.map((output): void => {
          result.push(output)
        })
      )

      yield* Effect.logInfo("Welcome to the Effect Playground!").pipe(
        Effect.annotateLogs({
          annotation1: "first",
          annotation2: "second",
          annotation3: "\"omg\""
        }),
        Effect.provide(Logger.layer([logger]))
      )

      assert.strictEqual(result.length, 1)
      const output = result[0] as string
      assert.match(output, /message="Welcome to the Effect Playground!"/)
      assert.match(output, /annotation1=first/)
      assert.match(output, /annotation2=second/)
      assert.match(output, /annotation3="\\"omg\\""/)
      assert.ok(!output.includes("message=\"\\\"Welcome to the Effect Playground!\\\"\""))
      assert.ok(!output.includes("annotation1=\"\\\"first\\\"\""))
    }))

  it.effect("formatSimple does not double quote string messages or annotations", () =>
    Effect.gen(function*() {
      const result: Array<string> = []
      const logger = Logger.formatSimple.pipe(
        Logger.map((output): void => {
          result.push(output)
        })
      )

      yield* Effect.logInfo("hello world").pipe(
        Effect.annotateLogs("annotation", "value with spaces"),
        Effect.provide(Logger.layer([logger]))
      )

      assert.strictEqual(result.length, 1)
      const output = result[0] as string
      assert.match(output, /message="hello world"/)
      assert.match(output, /annotation="value with spaces"/)
      assert.ok(!output.includes("message=\"\\\"hello world\\\"\""))
      assert.ok(!output.includes("annotation=\"\\\"value with spaces\\\"\""))
    }))

  it.effect("annotateLogsScoped applies annotations only while scoped", () =>
    Effect.gen(function*() {
      const annotations: Array<Record<string, unknown>> = []
      const logger = Logger.make<unknown, void>((options) => {
        annotations.push({ ...options.fiber.getRef(References.CurrentLogAnnotations) })
      })

      yield* Effect.gen(function*() {
        yield* Effect.log("before")
        yield* Effect.scoped(
          Effect.gen(function*() {
            yield* Effect.annotateLogsScoped("requestId", "req-123")
            yield* Effect.log("inside")
          })
        )
        yield* Effect.log("after")
      }).pipe(Effect.provide(Logger.layer([logger])))

      assert.deepStrictEqual(annotations, [{}, { requestId: "req-123" }, {}])
    }))

  it.effect("annotateLogsScoped restores previous annotations", () =>
    Effect.gen(function*() {
      const annotations: Array<Record<string, unknown>> = []
      const logger = Logger.make<unknown, void>((options) => {
        annotations.push({ ...options.fiber.getRef(References.CurrentLogAnnotations) })
      })

      const scope = Scope.makeUnsafe()

      yield* Effect.gen(function*() {
        yield* Effect.log("before")
        yield* Effect.annotateLogsScoped("inner", "scope")
        yield* Effect.log("after")
      }).pipe(
        Effect.annotateLogs("outer", "program"),
        Effect.ensuring(Scope.close(scope, Exit.void)),
        Effect.andThen(Effect.log("outside")),
        Effect.provide(Logger.layer([logger]))
      )

      assert.deepStrictEqual(
        annotations,
        [{ outer: "program" }, { outer: "program", inner: "scope" }, {}]
      )
    }))

  it.effect("default logger preserves message item order when logging a cause", () =>
    Effect.gen(function*() {
      yield* Effect.log("first", Cause.fail("boom"), "second")

      const result = yield* TestConsole.logLines

      assert.match(
        result[0] as string,
        /\[\d{2}:\d{2}:\d{2}\.\d{3}\]\sINFO\s\(#\d+\):/
      )
      assert.strictEqual(result[1], "first")
      assert.strictEqual(result[2], "second")
      assert.match(result[3] as string, /boom/)
    }))
})
