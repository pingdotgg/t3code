import * as NodeStdio from "@effect/platform-node-shared/NodeStdio"
import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Stdio from "effect/Stdio"
import { spawn } from "node:child_process"
import { join } from "node:path"

const streams = [process.stdin, process.stdout, process.stderr] as const
const fixture = join(__dirname, "fixtures", "node-stdio.ts")

const setIsTTY = (stdin: boolean, stdout: boolean, stderr: boolean | undefined) =>
  Effect.sync(() => {
    Object.defineProperty(streams[0], "isTTY", { configurable: true, value: stdin })
    Object.defineProperty(streams[1], "isTTY", { configurable: true, value: stdout })
    Object.defineProperty(streams[2], "isTTY", { configurable: true, value: stderr })
  })

const withRestoredIsTTY = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => streams.map((stream) => Object.getOwnPropertyDescriptor(stream, "isTTY"))),
    () => effect,
    (descriptors) =>
      Effect.sync(() => {
        streams.forEach((stream, index) => {
          const descriptor = descriptors[index]
          if (descriptor === undefined) {
            Reflect.deleteProperty(stream, "isTTY")
          } else {
            Object.defineProperty(stream, "isTTY", descriptor)
          }
        })
      })
  )

describe("NodeStdio", () => {
  it.effect("reads terminal state when the effects run", () =>
    withRestoredIsTTY(
      Effect.gen(function*() {
        const stdio = yield* Stdio.Stdio

        yield* setIsTTY(false, false, true)
        assert.deepStrictEqual(
          yield* Effect.all([stdio.stdinIsTerminal, stdio.stdoutIsTerminal, stdio.stderrIsTerminal]),
          [false, false, true]
        )

        yield* setIsTTY(true, true, false)
        assert.deepStrictEqual(
          yield* Effect.all([stdio.stdinIsTerminal, stdio.stdoutIsTerminal, stdio.stderrIsTerminal]),
          [true, true, false]
        )
        yield* setIsTTY(false, true, undefined)
        assert.isFalse(yield* stdio.stderrIsTerminal)
      }).pipe(Effect.provide(NodeStdio.layer))
    ))

  it.effect(
    "exits when stdin consumers stop while the pipe stays open and supports later reads",
    () =>
      Effect.callback<void>((resume) => {
        const child = spawn(process.execPath, [fixture], { stdio: ["pipe", "pipe", "inherit"] })
        let stdout = ""
        child.stdout.setEncoding("utf8")
        child.stdout.on("data", (data) => {
          stdout += data
          if (stdout === "a") {
            child.stdin.write("b")
          }
        })
        child.on("error", (error) => resume(Effect.die(error)))
        child.on("close", (code) => {
          resume(Effect.sync(() => assert.deepStrictEqual({ code, stdout }, { code: 0, stdout: "ab" })))
        })
        child.stdin.write("a")
        return Effect.sync(() => child.kill())
      }),
    { timeout: 15_000 }
  )
})
