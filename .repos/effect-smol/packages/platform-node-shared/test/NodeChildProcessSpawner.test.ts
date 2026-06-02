import * as NodeChildProcessSpawner from "@effect/platform-node-shared/NodeChildProcessSpawner"
import * as NodeFileSystem from "@effect/platform-node-shared/NodeFileSystem"
import * as NodePath from "@effect/platform-node-shared/NodePath"
import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Path from "effect/Path"
import * as PlatformError from "effect/PlatformError"
import * as Scope from "effect/Scope"
import * as Stream from "effect/Stream"
import * as TestClock from "effect/testing/TestClock"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"

const TEST_BASH_SCRIPTS_PATH = [__dirname, "fixtures", "bash"]

const NodeServices = NodeChildProcessSpawner.layer.pipe(
  Layer.provideMerge(Layer.mergeAll(
    NodeFileSystem.layer,
    NodePath.layer
  ))
)

// Helper to collect stream output into a string
const decodeByteStream = Effect.fnUntraced(
  function*(
    stream: Stream.Stream<Uint8Array, PlatformError.PlatformError>,
    encoding: ChildProcess.Encoding = "utf-8"
  ) {
    const chunks = yield* Stream.runCollect(stream)
    const totalLength = chunks.reduce((acc, c) => acc + c.length, 0)
    const result = new Uint8Array(totalLength)
    let offset = 0
    for (const chunk of chunks) {
      result.set(chunk, offset)
      offset += chunk.length
    }
    return new TextDecoder(encoding).decode(result).trim()
  }
)

describe("NodeChildProcessSpawner", () => {
  it.layer(NodeServices)((it) => {
    describe("spawn", () => {
      describe("basic spawning", () => {
        it.effect("should spawn a simple command and collect output", () =>
          Effect.gen(function*() {
            const handle = yield* ChildProcess.make("node", ["--version"])
            const output = yield* decodeByteStream(handle.stdout)
            const exitCode = yield* handle.exitCode

            assert.strictEqual(exitCode, ChildProcessSpawner.ExitCode(0))
            // Verify it contains "v" (version string starts with v)
            assert.isTrue(output.includes("v"))
          }).pipe(Effect.scoped))

        it.effect("should spawn echo command", () =>
          Effect.gen(function*() {
            const handle = yield* ChildProcess.make("echo", ["hello", "world"])
            const output = yield* decodeByteStream(handle.stdout)
            const exitCode = yield* handle.exitCode

            assert.strictEqual(exitCode, ChildProcessSpawner.ExitCode(0))
            assert.strictEqual(output, "hello world")
          }).pipe(Effect.scoped))

        it.effect("should spawn with template literal", () =>
          Effect.gen(function*() {
            const handle = yield* ChildProcess.make`echo spawned`
            const output = yield* decodeByteStream(handle.stdout)
            const exitCode = yield* handle.exitCode

            assert.strictEqual(exitCode, ChildProcessSpawner.ExitCode(0))
            assert.strictEqual(output, "spawned")
          }).pipe(Effect.scoped))
      })

      describe("cwd option", () => {
        it.effect("should handle command with working directory", () =>
          Effect.gen(function*() {
            const handle = yield* ChildProcess.make("pwd", [], { cwd: "/tmp" })
            const output = yield* decodeByteStream(handle.stdout)
            const exitCode = yield* handle.exitCode

            assert.strictEqual(exitCode, ChildProcessSpawner.ExitCode(0))
            // On macOS, /tmp is a symlink to /private/tmp
            assert.isTrue(output.includes("tmp"))
          }).pipe(Effect.scoped))

        it.effect("should use cwd with template literal form", () =>
          Effect.gen(function*() {
            const handle = yield* ChildProcess.make({ cwd: "/tmp" })`pwd`
            const output = yield* decodeByteStream(handle.stdout)
            const exitCode = yield* handle.exitCode

            assert.strictEqual(exitCode, ChildProcessSpawner.ExitCode(0))
            assert.isTrue(output.includes("tmp"))
          }).pipe(Effect.scoped))
      })

      describe("env option", () => {
        it.effect("should handle environment variables", () =>
          Effect.gen(function*() {
            const handle = yield* ChildProcess.make("sh", ["-c", "echo $TEST_VAR"], {
              env: { TEST_VAR: "test_value" },
              extendEnv: true
            })
            const output = yield* decodeByteStream(handle.stdout)
            const exitCode = yield* handle.exitCode

            assert.strictEqual(exitCode, ChildProcessSpawner.ExitCode(0))
            assert.strictEqual(output, "test_value")
          }).pipe(Effect.scoped))

        it.effect("should handle multiple environment variables", () =>
          Effect.gen(function*() {
            const handle = yield* ChildProcess.make("sh", ["-c", "echo $VAR1-$VAR2-$VAR3"], {
              env: { VAR1: "one", VAR2: "two", VAR3: "three" },
              extendEnv: true
            })
            const output = yield* decodeByteStream(handle.stdout)
            const exitCode = yield* handle.exitCode

            assert.strictEqual(exitCode, ChildProcessSpawner.ExitCode(0))
            assert.strictEqual(output, "one-two-three")
          }).pipe(Effect.scoped))

        it.effect("should merge environment variables with setEnv", () =>
          Effect.gen(function*() {
            const command = ChildProcess.make("sh", ["-c", "echo $VAR1-$VAR2-$VAR3"], {
              env: { VAR1: "one", VAR2: "two" },
              extendEnv: true
            }).pipe(ChildProcess.setEnv({ VAR2: "override", VAR3: "three" }))
            const handle = yield* command
            const output = yield* decodeByteStream(handle.stdout)
            const exitCode = yield* handle.exitCode

            assert.strictEqual(exitCode, ChildProcessSpawner.ExitCode(0))
            assert.strictEqual(output, "one-override-three")
          }).pipe(Effect.scoped))
      })

      describe("shell option", () => {
        it.effect("should execute with shell when using sh -c", () =>
          Effect.gen(function*() {
            // Use sh -c to test shell expansion without triggering deprecation warning
            const handle = yield* ChildProcess.make("sh", ["-c", "echo $HOME"])
            const output = yield* decodeByteStream(handle.stdout)
            const exitCode = yield* handle.exitCode

            assert.strictEqual(exitCode, ChildProcessSpawner.ExitCode(0))
            // With shell, $HOME should be expanded
            assert.isTrue(output.length > 0)
            assert.isFalse(output.includes("$HOME"))
          }).pipe(Effect.scoped))

        it.effect("should not expand variables without shell", () =>
          Effect.gen(function*() {
            const handle = yield* ChildProcess.make("echo", ["$HOME"], { shell: false })
            const output = yield* decodeByteStream(handle.stdout)
            const exitCode = yield* handle.exitCode

            assert.strictEqual(exitCode, ChildProcessSpawner.ExitCode(0))
            // Without shell, $HOME should not be expanded
            assert.strictEqual(output, "$HOME")
          }).pipe(Effect.scoped))

        it.effect("should allow piping with shell", () =>
          Effect.gen(function*() {
            const handle = yield* ChildProcess.make("sh", ["-c", "echo hello | tr a-z A-Z"])
            const output = yield* decodeByteStream(handle.stdout)
            const exitCode = yield* handle.exitCode

            assert.strictEqual(exitCode, ChildProcessSpawner.ExitCode(0))
            assert.strictEqual(output, "HELLO")
          }).pipe(Effect.scoped))
      })

      describe("template literal forms", () => {
        it.effect("should work with template literal form", () =>
          Effect.gen(function*() {
            const handle = yield* ChildProcess.make`echo hello`
            const output = yield* decodeByteStream(handle.stdout)
            const exitCode = yield* handle.exitCode

            assert.strictEqual(exitCode, ChildProcessSpawner.ExitCode(0))
            assert.strictEqual(output, "hello")
          }).pipe(Effect.scoped))

        it.effect("should handle string interpolation", () =>
          Effect.gen(function*() {
            const name = "world"
            const handle = yield* ChildProcess.make`echo hello ${name}`
            const output = yield* decodeByteStream(handle.stdout)
            const exitCode = yield* handle.exitCode

            assert.strictEqual(exitCode, ChildProcessSpawner.ExitCode(0))
            assert.strictEqual(output, "hello world")
          }).pipe(Effect.scoped))

        it.effect("should handle number interpolation", () =>
          Effect.gen(function*() {
            const count = 42
            const handle = yield* ChildProcess.make`echo count is ${count}`
            const output = yield* decodeByteStream(handle.stdout)
            const exitCode = yield* handle.exitCode

            assert.strictEqual(exitCode, ChildProcessSpawner.ExitCode(0))
            assert.strictEqual(output, "count is 42")
          }).pipe(Effect.scoped))

        it.effect("should handle array interpolation", () =>
          Effect.gen(function*() {
            const fs = yield* FileSystem.FileSystem
            const path = yield* Path.Path
            const dir = yield* fs.makeTempDirectoryScoped()
            const file = path.join(dir, "array-interpolation.txt")
            const args = ["-l", "-a"]
            yield* fs.writeFile(file, new TextEncoder().encode("test"))

            const handle = yield* ChildProcess.make`ls ${args} ${dir}`
            const exitCode = yield* handle.exitCode
            const output = yield* decodeByteStream(handle.stdout)

            assert.strictEqual(exitCode, ChildProcessSpawner.ExitCode(0))
            assert.isTrue(output.includes("array-interpolation.txt"))
          }).pipe(Effect.scoped))

        it.effect("should handle multiple interpolations", () =>
          Effect.gen(function*() {
            const greeting = "hello"
            const target = "world"
            const handle = yield* ChildProcess.make`echo ${greeting} ${target}`
            const output = yield* decodeByteStream(handle.stdout)
            const exitCode = yield* handle.exitCode

            assert.strictEqual(exitCode, ChildProcessSpawner.ExitCode(0))
            assert.strictEqual(output, "hello world")
          }).pipe(Effect.scoped))

        it.effect("should handle options with template literal", () =>
          Effect.gen(function*() {
            const filename = "test.txt"
            const handle = yield* ChildProcess.make({ cwd: "/tmp" })`echo ${filename}`
            const output = yield* decodeByteStream(handle.stdout)
            const exitCode = yield* handle.exitCode

            assert.strictEqual(exitCode, ChildProcessSpawner.ExitCode(0))
            assert.strictEqual(output, "test.txt")
          }).pipe(Effect.scoped))
      })

      describe("stderr streaming", () => {
        it.effect("should capture stderr output", () =>
          Effect.gen(function*() {
            const handle = yield* ChildProcess.make("sh", ["-c", "echo error message >&2"])
            const stderr = yield* decodeByteStream(handle.stderr)
            const exitCode = yield* handle.exitCode

            assert.strictEqual(exitCode, ChildProcessSpawner.ExitCode(0))
            assert.strictEqual(stderr, "error message")
          }).pipe(Effect.scoped))

        it.effect("should capture both stdout and stderr", () =>
          Effect.gen(function*() {
            const handle = yield* ChildProcess.make("sh", ["-c", "echo stdout; echo stderr >&2"])
            const stdout = yield* decodeByteStream(handle.stdout)
            const stderr = yield* decodeByteStream(handle.stderr)
            const exitCode = yield* handle.exitCode

            assert.strictEqual(exitCode, ChildProcessSpawner.ExitCode(0))
            assert.strictEqual(stdout, "stdout")
            assert.strictEqual(stderr, "stderr")
          }).pipe(Effect.scoped))

        it.effect("should handle more stdout than stderr", () =>
          Effect.gen(function*() {
            // Process outputs many lines to stdout but only one to stderr
            const handle = yield* ChildProcess.make(
              "sh",
              ["-c", "echo line1; echo line2; echo line3; echo line4; echo line5; echo error >&2"]
            )
            const [stdout, stderr] = yield* Effect.all([
              decodeByteStream(handle.stdout),
              decodeByteStream(handle.stderr)
            ], { concurrency: "unbounded" })
            const exitCode = yield* handle.exitCode

            assert.strictEqual(exitCode, ChildProcessSpawner.ExitCode(0))
            assert.strictEqual(stdout, ["line1", "line2", "line3", "line4", "line5"].join("\n"))
            assert.strictEqual(stderr, "error")
          }).pipe(Effect.scoped))

        it.effect("should handle more stderr than stdout", () =>
          Effect.gen(function*() {
            // Process outputs many lines to stderr but only one to stdout
            const handle = yield* ChildProcess.make(
              "sh",
              ["-c", "echo output; echo err1 >&2; echo err2 >&2; echo err3 >&2; echo err4 >&2; echo err5 >&2"]
            )
            const stdout = yield* decodeByteStream(handle.stdout)
            const stderr = yield* decodeByteStream(handle.stderr)
            const exitCode = yield* handle.exitCode

            assert.strictEqual(exitCode, ChildProcessSpawner.ExitCode(0))
            assert.strictEqual(stdout, "output")
            assert.strictEqual(stderr, ["err1", "err2", "err3", "err4", "err5"].join("\n"))
          }).pipe(Effect.scoped))

        it.effect("should allow reading only stdout when stderr is empty", () =>
          Effect.gen(function*() {
            const handle = yield* ChildProcess.make("echo", ["only stdout"])
            // Read streams in parallel to avoid deadlock when one stream is empty
            const [stdout, stderr] = yield* Effect.all([
              decodeByteStream(handle.stdout),
              decodeByteStream(handle.stderr)
            ], { concurrency: "unbounded" })
            const exitCode = yield* handle.exitCode

            assert.strictEqual(exitCode, ChildProcessSpawner.ExitCode(0))
            assert.strictEqual(stdout, "only stdout")
            assert.strictEqual(stderr, "")
          }).pipe(Effect.scoped))

        it.effect("should allow reading only stderr when stdout is empty", () =>
          Effect.gen(function*() {
            const handle = yield* ChildProcess.make("sh", ["-c", "echo only stderr >&2"])
            // Read streams in parallel to avoid deadlock when one stream is empty
            const [stdout, stderr] = yield* Effect.all([
              decodeByteStream(handle.stdout),
              decodeByteStream(handle.stderr)
            ], { concurrency: "unbounded" })
            const exitCode = yield* handle.exitCode

            assert.strictEqual(exitCode, ChildProcessSpawner.ExitCode(0))
            assert.strictEqual(stdout, "")
            assert.strictEqual(stderr, "only stderr")
          }).pipe(Effect.scoped))
      })

      describe("combined output (all)", () => {
        it.effect("should read interspersed stdout and stderr via .all", () =>
          Effect.gen(function*() {
            // Use sleep to force buffer flushes between writes, ensuring
            // stdout and stderr chunks arrive separately for proper interleaving
            const handle = yield* ChildProcess.make(
              "sh",
              [
                "-c",
                [
                  "echo stdout1; sleep 0.01;",
                  "echo stderr1 >&2; sleep 0.01;",
                  "echo stdout2; sleep 0.01;",
                  "echo stderr2 >&2"
                ].join(" ")
              ]
            )
            const all = yield* decodeByteStream(handle.all)
            const exitCode = yield* handle.exitCode

            assert.strictEqual(exitCode, ChildProcessSpawner.ExitCode(0))
            // With delays forcing buffer flushes, we should see proper interleaving
            assert.strictEqual(all, ["stdout1", "stderr1", "stdout2", "stderr2"].join("\n"))
          }).pipe(Effect.scoped))

        it.effect("should capture only stdout via .all when no stderr", () =>
          Effect.gen(function*() {
            const handle = yield* ChildProcess.make("echo", ["hello from stdout"])
            const all = yield* decodeByteStream(handle.all)
            const exitCode = yield* handle.exitCode

            assert.strictEqual(exitCode, ChildProcessSpawner.ExitCode(0))
            assert.strictEqual(all, "hello from stdout")
          }).pipe(Effect.scoped))

        it.effect("should capture only stderr via .all when no stdout", () =>
          Effect.gen(function*() {
            const handle = yield* ChildProcess.make("sh", ["-c", "echo hello from stderr >&2"])
            const all = yield* decodeByteStream(handle.all)
            const exitCode = yield* handle.exitCode

            assert.strictEqual(exitCode, ChildProcessSpawner.ExitCode(0))
            assert.strictEqual(all, "hello from stderr")
          }).pipe(Effect.scoped))

        it.effect("should handle many lines of interspersed output via .all", () =>
          Effect.gen(function*() {
            // Use sleep to force buffer flushes, ensuring interleaved arrival
            const handle = yield* ChildProcess.make(
              "sh",
              ["-c", "for i in 1 2 3 4 5; do echo stdout$i; sleep 0.01; echo stderr$i >&2; sleep 0.01; done"]
            )
            const all = yield* decodeByteStream(handle.all)
            const exitCode = yield* handle.exitCode

            assert.strictEqual(exitCode, ChildProcessSpawner.ExitCode(0))
            // Verify all lines are present in interleaved order
            const expected = []
            for (let i = 1; i <= 5; i++) {
              expected.push(`stdout${i}`, `stderr${i}`)
            }
            assert.strictEqual(all, expected.join("\n"))
          }).pipe(Effect.scoped))

        it.effect("should allow reading .all independently", () =>
          Effect.gen(function*() {
            const handle = yield* ChildProcess.make(
              "sh",
              ["-c", "echo out; sleep 0.01; echo err >&2"]
            )
            const all = yield* decodeByteStream(handle.all)
            const exitCode = yield* handle.exitCode

            assert.strictEqual(exitCode, ChildProcessSpawner.ExitCode(0))
            assert.strictEqual(all, ["out", "err"].join("\n"))
          }).pipe(Effect.scoped))
      })

      describe("stdout streaming", () => {
        it.effect("should stream stdout", () =>
          Effect.gen(function*() {
            const handle = yield* ChildProcess.make("echo", ["streaming output"])
            const output = yield* decodeByteStream(handle.stdout)

            assert.strictEqual(output, "streaming output")
          }).pipe(Effect.scoped))

        it.effect("should stream multiple lines", () =>
          Effect.gen(function*() {
            const handle = yield* ChildProcess.make("sh", ["-c", "echo line1; echo line2; echo line3"])
            const output = yield* decodeByteStream(handle.stdout)

            assert.strictEqual(output, ["line1", "line2", "line3"].join("\n"))
          }).pipe(Effect.scoped))
      })

      describe("process control", () => {
        it.effect("should kill a process", () =>
          Effect.gen(function*() {
            const handle = yield* ChildProcess.make("sleep", ["10"])

            yield* handle.kill()

            // After killing, exitCode should eventually resolve (with signal error)
            const exit = yield* Effect.exit(handle.exitCode)
            assert.isTrue(exit._tag === "Failure")
          }).pipe(Effect.scoped))

        it.effect("should kill with specific signal", () =>
          Effect.gen(function*() {
            const handle = yield* ChildProcess.make("sleep", ["10"])

            yield* handle.kill({ killSignal: "SIGKILL" })

            const exit = yield* Effect.exit(handle.exitCode)
            assert.isTrue(exit._tag === "Failure")
          }).pipe(Effect.scoped))
      })
    })

    describe("pipeline spawning", () => {
      it.effect("should spawn a simple pipeline", () =>
        Effect.gen(function*() {
          const handle = yield* ChildProcess.make`echo hello world`.pipe(
            ChildProcess.pipeTo(ChildProcess.make`tr a-z A-Z`)
          )
          const output = yield* decodeByteStream(handle.stdout)
          const exitCode = yield* handle.exitCode

          assert.strictEqual(exitCode, ChildProcessSpawner.ExitCode(0))
          assert.strictEqual(output, "HELLO WORLD")
        }).pipe(Effect.scoped))

      it.effect("should spawn a three-stage pipeline", () =>
        Effect.gen(function*() {
          const handle = yield* ChildProcess.make`echo hello world`.pipe(
            ChildProcess.pipeTo(ChildProcess.make`tr a-z A-Z`),
            ChildProcess.pipeTo(ChildProcess.make("tr", [" ", "-"]))
          )
          const output = yield* decodeByteStream(handle.stdout)
          const exitCode = yield* handle.exitCode

          assert.strictEqual(exitCode, ChildProcessSpawner.ExitCode(0))
          assert.strictEqual(output, "HELLO-WORLD")
        }).pipe(Effect.scoped))

      it.effect("should pipe grep output", () =>
        Effect.gen(function*() {
          const handle = yield* ChildProcess.make("echo", ["line1\nline2\nline3"]).pipe(
            ChildProcess.pipeTo(ChildProcess.make`grep line2`)
          )
          const output = yield* decodeByteStream(handle.stdout)
          const exitCode = yield* handle.exitCode

          assert.strictEqual(exitCode, ChildProcessSpawner.ExitCode(0))
          assert.strictEqual(output, "line2")
        }).pipe(Effect.scoped))

      it.effect("should handle mixed command forms in pipeline", () =>
        Effect.gen(function*() {
          const handle = yield* ChildProcess.make("echo", ["hello"]).pipe(
            ChildProcess.pipeTo(ChildProcess.make`tr a-z A-Z`)
          )
          const output = yield* decodeByteStream(handle.stdout)
          const exitCode = yield* handle.exitCode

          assert.strictEqual(exitCode, ChildProcessSpawner.ExitCode(0))
          assert.strictEqual(output, "HELLO")
        }).pipe(Effect.scoped))
    })

    describe("pipeline pipe options", () => {
      it.effect("should pipe stderr to stdin with { from: 'stderr' }", () =>
        Effect.gen(function*() {
          // Command that writes "error" to stderr
          const handle = yield* ChildProcess.make("sh", ["-c", "echo error >&2"]).pipe(
            ChildProcess.pipeTo(ChildProcess.make`cat`, { from: "stderr" })
          )
          const output = yield* decodeByteStream(handle.stdout)
          const exitCode = yield* handle.exitCode

          assert.strictEqual(exitCode, ChildProcessSpawner.ExitCode(0))
          assert.strictEqual(output, "error")
        }).pipe(Effect.scoped))

      it.effect("should pipe combined output with { from: 'all' }", () =>
        Effect.gen(function*() {
          // Command that writes to both stdout and stderr with small delays
          const handle = yield* ChildProcess.make("sh", [
            "-c",
            "echo out1; sleep 0.01; echo err1 >&2; sleep 0.01; echo out2"
          ]).pipe(
            ChildProcess.pipeTo(ChildProcess.make`cat`, { from: "all" })
          )
          const output = yield* decodeByteStream(handle.stdout)
          const exitCode = yield* handle.exitCode

          assert.strictEqual(exitCode, ChildProcessSpawner.ExitCode(0))
          assert.strictEqual(output, ["out1", "err1", "out2"].join("\n"))
        }).pipe(Effect.scoped))

      it.effect("should default to stdout when no options provided", () =>
        Effect.gen(function*() {
          // Command that writes to both stdout and stderr
          const handle = yield* ChildProcess.make("sh", ["-c", "echo stdout; echo stderr >&2"]).pipe(
            ChildProcess.pipeTo(ChildProcess.make`cat`)
          )
          const output = yield* decodeByteStream(handle.stdout)
          const exitCode = yield* handle.exitCode

          assert.strictEqual(exitCode, ChildProcessSpawner.ExitCode(0))
          // Only stdout should be piped (default behavior)
          assert.strictEqual(output, "stdout")
        }).pipe(Effect.scoped))

      it.effect("should work with empty options object", () =>
        Effect.gen(function*() {
          const handle = yield* ChildProcess.make`echo hello`.pipe(
            ChildProcess.pipeTo(ChildProcess.make`tr a-z A-Z`, {})
          )
          const output = yield* decodeByteStream(handle.stdout)
          const exitCode = yield* handle.exitCode

          assert.strictEqual(exitCode, ChildProcessSpawner.ExitCode(0))
          assert.strictEqual(output, "HELLO")
        }).pipe(Effect.scoped))

      it.effect("should work with explicit { from: 'stdout' }", () =>
        Effect.gen(function*() {
          const handle = yield* ChildProcess.make`echo hello`.pipe(
            ChildProcess.pipeTo(ChildProcess.make`tr a-z A-Z`, { from: "stdout" })
          )
          const output = yield* decodeByteStream(handle.stdout)
          const exitCode = yield* handle.exitCode

          assert.strictEqual(exitCode, ChildProcessSpawner.ExitCode(0))
          assert.strictEqual(output, "HELLO")
        }).pipe(Effect.scoped))

      it.effect("should work with explicit { to: 'stdin' }", () =>
        Effect.gen(function*() {
          const handle = yield* ChildProcess.make`echo hello`.pipe(
            ChildProcess.pipeTo(ChildProcess.make`tr a-z A-Z`, { to: "stdin" })
          )
          const output = yield* decodeByteStream(handle.stdout)
          const exitCode = yield* handle.exitCode

          assert.strictEqual(exitCode, ChildProcessSpawner.ExitCode(0))
          assert.strictEqual(output, "HELLO")
        }).pipe(Effect.scoped))

      it.effect("should support chained pipes with different options", () =>
        Effect.gen(function*() {
          // First pipe: stdout to stdin (default)
          // Second pipe: from stderr
          const handle = yield* ChildProcess.make`echo hello`.pipe(
            ChildProcess.pipeTo(ChildProcess.make("sh", ["-c", "cat; echo error >&2"])),
            ChildProcess.pipeTo(ChildProcess.make`cat`, { from: "stderr" })
          )
          const output = yield* decodeByteStream(handle.stdout)
          const exitCode = yield* handle.exitCode

          assert.strictEqual(exitCode, ChildProcessSpawner.ExitCode(0))
          assert.strictEqual(output, "error")
        }).pipe(Effect.scoped))
    })

    describe("error handling", () => {
      it.effect("should return non-zero exit code", () =>
        Effect.gen(function*() {
          const handle = yield* ChildProcess.make("sh", ["-c", "exit 1"])
          const exitCode = yield* handle.exitCode

          assert.strictEqual(exitCode, ChildProcessSpawner.ExitCode(1))
        }).pipe(Effect.scoped))

      it.effect("should fail for invalid command", () =>
        Effect.gen(function*() {
          const exit = yield* Effect.exit(
            ChildProcess.make("nonexistent-command-12345")
          )

          assert.isTrue(exit._tag === "Failure")
        }).pipe(Effect.scoped))

      it.effect("should handle spawn error with invalid cwd", () =>
        Effect.gen(function*() {
          const exit = yield* Effect.exit(
            ChildProcess.make("echo", ["test"], { cwd: "/nonexistent/directory/path" })
          )

          assert.isTrue(exit._tag === "Failure")
        }).pipe(Effect.scoped))

      it.effect("should throw permission denied as a typed error", () =>
        Effect.gen(function*() {
          const path = yield* Path.Path
          const cwd = path.join(...TEST_BASH_SCRIPTS_PATH)

          const command = ChildProcess.make({ cwd })`./no-permissions.sh`
          const result = yield* Effect.flip(command)

          assert.deepStrictEqual(
            result,
            PlatformError.systemError({
              _tag: "PermissionDenied",
              module: "ChildProcess",
              method: "spawn",
              pathOrDescriptor: "./no-permissions.sh ",
              syscall: "spawn ./no-permissions.sh"
            })
          )
        }).pipe(Effect.scoped))
    })

    describe("stdin", () => {
      it.effect("allows providing standard input to a command", () =>
        Effect.gen(function*() {
          const input = "a b c"
          const stdin = Stream.make(Buffer.from(input, "utf-8"))
          const handle = yield* ChildProcess.make("cat", { stdin })
          const output = yield* decodeByteStream(handle.stdout)
          const exitCode = yield* handle.exitCode

          assert.deepStrictEqual(exitCode, ChildProcessSpawner.ExitCode(0))
          assert.strictEqual(output, input)
        }).pipe(Effect.scoped))
    })

    describe("additionalFds", () => {
      it.effect("should read data from an output fd (fd3)", () =>
        Effect.gen(function*() {
          // Use a shell script that writes to fd3
          // The script echoes "hello from fd3" to file descriptor 3
          const handle = yield* ChildProcess.make("sh", ["-c", "echo 'hello from fd3' >&3"], {
            additionalFds: { fd3: { type: "output" } }
          })

          const fd3Output = yield* decodeByteStream(handle.getOutputFd(3))
          const exitCode = yield* handle.exitCode

          assert.strictEqual(exitCode, ChildProcessSpawner.ExitCode(0))
          assert.strictEqual(fd3Output, "hello from fd3")
        }).pipe(Effect.scoped))

      it.effect("should write data to an input fd (fd3)", () =>
        Effect.gen(function*() {
          // Use a shell script that reads from fd3 and echoes it to stdout
          // The script reads from file descriptor 3 and outputs to stdout
          const inputData = "data from parent"
          const inputStream = Stream.make(new TextEncoder().encode(inputData))

          const handle = yield* ChildProcess.make("sh", ["-c", "cat <&3"], {
            additionalFds: {
              fd3: { type: "input", stream: inputStream }
            }
          })

          const stdout = yield* decodeByteStream(handle.stdout)
          const exitCode = yield* handle.exitCode

          assert.strictEqual(exitCode, ChildProcessSpawner.ExitCode(0))
          assert.strictEqual(stdout, inputData)
        }).pipe(Effect.scoped))

      it.effect("should handle multiple additional fds", () =>
        Effect.gen(function*() {
          // Script that writes different messages to fd3 and fd4
          const handle = yield* ChildProcess.make(
            "sh",
            ["-c", "echo 'output on fd3' >&3; echo 'output on fd4' >&4"],
            {
              additionalFds: {
                fd3: { type: "output" },
                fd4: { type: "output" }
              }
            }
          )

          const fd3Output = yield* decodeByteStream(handle.getOutputFd(3))
          const fd4Output = yield* decodeByteStream(handle.getOutputFd(4))
          const exitCode = yield* handle.exitCode

          assert.strictEqual(exitCode, ChildProcessSpawner.ExitCode(0))
          assert.strictEqual(fd3Output, "output on fd3")
          assert.strictEqual(fd4Output, "output on fd4")
        }).pipe(Effect.scoped))

      it.effect("should handle fd gaps (e.g., fd3 and fd5 without fd4)", () =>
        Effect.gen(function*() {
          // Script that writes to fd3 and fd5, skipping fd4
          const handle = yield* ChildProcess.make(
            "sh",
            ["-c", "echo 'on fd3' >&3; echo 'on fd5' >&5"],
            {
              additionalFds: {
                fd3: { type: "output" },
                fd5: { type: "output" }
              }
            }
          )

          const fd3Output = yield* decodeByteStream(handle.getOutputFd(3))
          const fd5Output = yield* decodeByteStream(handle.getOutputFd(5))
          const exitCode = yield* handle.exitCode

          assert.strictEqual(exitCode, ChildProcessSpawner.ExitCode(0))
          assert.strictEqual(fd3Output, "on fd3")
          assert.strictEqual(fd5Output, "on fd5")
        }).pipe(Effect.scoped))

      it.effect("should return empty stream for unconfigured output fd", () =>
        Effect.gen(function*() {
          const handle = yield* ChildProcess.make("echo", ["test"])

          // fd3 was not configured, should return empty stream
          const fd3Output = yield* decodeByteStream(handle.getOutputFd(3))
          const exitCode = yield* handle.exitCode

          assert.strictEqual(exitCode, ChildProcessSpawner.ExitCode(0))
          assert.strictEqual(fd3Output, "")
        }).pipe(Effect.scoped))

      it.effect("should handle bidirectional communication via separate fds", () =>
        Effect.gen(function*() {
          // Script that reads from fd3, transforms it, and writes to fd4
          const inputData = "hello"
          const inputStream = Stream.make(new TextEncoder().encode(inputData))

          const handle = yield* ChildProcess.make(
            "sh",
            ["-c", "cat <&3 | tr a-z A-Z >&4"],
            {
              additionalFds: {
                fd3: { type: "input", stream: inputStream },
                fd4: { type: "output" }
              }
            }
          )

          const fd4Output = yield* decodeByteStream(handle.getOutputFd(4))
          const exitCode = yield* handle.exitCode

          assert.strictEqual(exitCode, ChildProcessSpawner.ExitCode(0))
          assert.strictEqual(fd4Output, "HELLO")
        }).pipe(Effect.scoped))

      it.effect("should work alongside normal stdin/stdout/stderr", () =>
        Effect.gen(function*() {
          // Script that uses all standard streams plus fd3
          const handle = yield* ChildProcess.make(
            "sh",
            ["-c", "echo 'stdout'; echo 'stderr' >&2; echo 'fd3' >&3"],
            { additionalFds: { fd3: { type: "output" } } }
          )

          const stdout = yield* decodeByteStream(handle.stdout)
          const stderr = yield* decodeByteStream(handle.stderr)
          const fd3Output = yield* decodeByteStream(handle.getOutputFd(3))
          const exitCode = yield* handle.exitCode

          assert.strictEqual(exitCode, ChildProcessSpawner.ExitCode(0))
          assert.strictEqual(stdout, "stdout")
          assert.strictEqual(stderr, "stderr")
          assert.strictEqual(fd3Output, "fd3")
        }).pipe(Effect.scoped))
    })

    describe("process supervision", () => {
      const countMatchingProcesses = (pattern: string) =>
        Effect.gen(function*() {
          const handle = yield* ChildProcess.make("bash", [
            "-c",
            `ps aux | grep '${pattern}' | grep -v grep | wc -l`
          ])
          const output = yield* decodeByteStream(handle.stdout)
          return Number.parseInt(output.trim())
        }).pipe(Effect.orElseSucceed(() => 0))

      const killMatchingProcesses = (pattern: string) =>
        Effect.gen(function*() {
          const escaped = `[${pattern[0]}]${pattern.slice(1)}`
          const handle = yield* ChildProcess.make("bash", ["-c", `pkill -f '${escaped}' || true`])
          yield* Effect.ignore(handle.exitCode)
        }).pipe(Effect.asVoid)

      const longRunningCommand = () =>
        ChildProcess.make("node", ["-e", "setTimeout(() => {}, 30000)"], {
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore"
        })

      it.effect("should kill all child processes in process group", () =>
        Effect.gen(function*() {
          const path = yield* Path.Path
          const cwd = path.join(...TEST_BASH_SCRIPTS_PATH)

          // Start the process that spawns children and grandchildren
          const handle = yield* ChildProcess.make("./spawn-children.sh", { cwd })

          // Give it time to spawn all processes
          yield* TestClock.withLive(Effect.sleep("100 millis"))

          // Verify the main process is running
          const isRunningBeforeKill = yield* handle.isRunning
          assert.isTrue(isRunningBeforeKill)

          // Count processes before killing - should be at least 7 (1 parent + 3 children + 3 grandchildren)
          const beforeKillHandle = yield* ChildProcess.make("bash", [
            "-c",
            "ps aux | grep spawn-children.sh | grep -v grep | wc -l"
          ])
          const beforeKill = yield* decodeByteStream(beforeKillHandle.stdout).pipe(
            Effect.map((s) => Number.parseInt(s.trim())),
            Effect.orElseSucceed(() => 0)
          )
          assert.isAtLeast(beforeKill, 7)

          // Kill the main process
          yield* handle.kill()

          // Verify the main process is no longer running
          const isRunningAfterKill = yield* handle.isRunning
          assert.isFalse(isRunningAfterKill)

          // Give a moment for cleanup to complete
          yield* TestClock.withLive(Effect.sleep("100 millis"))

          // Check that no processes from the script are still running
          const afterKillHandle = yield* ChildProcess.make("bash", [
            "-c",
            "ps aux | grep spawn-children.sh | grep -v grep | wc -l"
          ])
          const afterKill = yield* decodeByteStream(afterKillHandle.stdout).pipe(
            Effect.map((s) => Number.parseInt(s.trim())),
            Effect.orElseSucceed(() => 0)
          )
          assert.strictEqual(afterKill, 0)
        }).pipe(Effect.scoped))

      it.effect("should cleanup child processes when parent exits with non-zero code", () =>
        Effect.gen(function*() {
          const path = yield* Path.Path
          const cwd = path.join(...TEST_BASH_SCRIPTS_PATH)

          // Count processes before running the command
          const beforeRunHandle = yield* ChildProcess.make("bash", [
            "-c",
            "ps aux | grep parent-exits-early.sh | grep -v grep | wc -l"
          ])
          const beforeRun = yield* decodeByteStream(beforeRunHandle.stdout).pipe(
            Effect.map((s) => Number.parseInt(s.trim())),
            Effect.orElseSucceed(() => 0)
          )
          assert.strictEqual(beforeRun, 0)

          // Run command in a separate scope so cleanup happens before we check
          const exitCode = yield* Effect.scoped(Effect.gen(function*() {
            const handle = yield* ChildProcess.make({ cwd })`./parent-exits-early.sh`
            return yield* handle.exitCode
          }))

          assert.strictEqual(exitCode, ChildProcessSpawner.ExitCode(1))

          // Allow cleanup to occur
          yield* TestClock.withLive(Effect.sleep("10 millis"))

          const afterExitHandle = yield* ChildProcess.make("bash", [
            "-c",
            "ps aux | grep 'sleep 30' | grep -v grep | wc -l"
          ])
          const afterExit = yield* decodeByteStream(afterExitHandle.stdout).pipe(
            Effect.map((s) => Number.parseInt(s.trim())),
            Effect.orElseSucceed(() => 0)
          )
          // Child processes should be cleaned up after non-zero exit
          assert.strictEqual(afterExit, 0)
        }).pipe(Effect.scoped))

      it.effect("should not kill an unrefed process when scope closes", () =>
        Effect.gen(function*() {
          const scope = yield* Scope.make()
          const handle = yield* Scope.provide(scope)(Effect.gen(function*() {
            return yield* longRunningCommand()
          })).pipe(
            Effect.provide(NodeServices)
          )

          // @effect-diagnostics-next-line floatingEffect:off
          yield* Scope.provide(scope)(handle.unref).pipe(Effect.provide(NodeServices))
          yield* Scope.close(scope, Exit.void)
          yield* TestClock.withLive(Effect.sleep("100 millis"))

          const isRunning = yield* handle.isRunning
          assert.isTrue(isRunning)

          yield* handle.kill({ killSignal: "SIGKILL" })
        }).pipe(Effect.provide(NodeServices)))

      it.effect("should kill a restored process when scope closes", () =>
        Effect.gen(function*() {
          const scope = yield* Scope.make()
          const handle = yield* Scope.provide(scope)(Effect.gen(function*() {
            return yield* longRunningCommand()
          })).pipe(
            Effect.provide(NodeServices)
          )

          const reref = yield* Scope.provide(scope)(handle.unref).pipe(Effect.provide(NodeServices))
          yield* reref
          yield* Scope.close(scope, Exit.void)
          yield* TestClock.withLive(Effect.sleep("100 millis"))

          const isRunning = yield* handle.isRunning
          assert.isFalse(isRunning)
        }).pipe(Effect.provide(NodeServices)))

      it.effect("should resolve exitCode after closing the original scope of an unrefed process", () =>
        Effect.gen(function*() {
          const scope = yield* Scope.make()
          const handle = yield* Scope.provide(scope)(Effect.gen(function*() {
            return yield* ChildProcess.make("node", ["-e", "setTimeout(() => process.exit(0), 50)"], {
              stdin: "ignore",
              stdout: "ignore",
              stderr: "ignore"
            })
          })).pipe(Effect.provide(NodeServices))

          // @effect-diagnostics-next-line floatingEffect:off
          yield* Scope.provide(scope)(handle.unref).pipe(Effect.provide(NodeServices))
          yield* Scope.close(scope, Exit.void)

          const exitCode = yield* handle.exitCode
          assert.strictEqual(exitCode, ChildProcessSpawner.ExitCode(0))
        }).pipe(Effect.provide(NodeServices)))

      it.effect("should cleanup descendants after an unrefed parent exits non-zero", () =>
        Effect.gen(function*() {
          const path = yield* Path.Path
          const cwd = path.join(...TEST_BASH_SCRIPTS_PATH)
          const scope = yield* Scope.make()

          const handle = yield* Scope.provide(scope)(Effect.gen(function*() {
            return yield* ChildProcess.make({ cwd })`./parent-exits-early.sh`
          })).pipe(Effect.provide(NodeServices))

          // @effect-diagnostics-next-line floatingEffect:off
          yield* Scope.provide(scope)(handle.unref).pipe(Effect.provide(NodeServices))
          yield* Scope.close(scope, Exit.void)

          const exitCode = yield* handle.exitCode
          assert.strictEqual(exitCode, ChildProcessSpawner.ExitCode(1))

          yield* TestClock.withLive(Effect.sleep("100 millis"))

          const remaining = yield* countMatchingProcesses("sleep 30")
          assert.strictEqual(remaining, 0)
        }).pipe(Effect.provide(NodeServices)))

      it.effect("should unref every process in a pipeline", () =>
        Effect.gen(function*() {
          const scope = yield* Scope.make()
          const rootMarker = "pipeline-unref-root"
          const tailMarker = "pipeline-unref-tail"

          const handle = yield* Scope.provide(scope)(Effect.gen(function*() {
            return yield* ChildProcess.make("node", ["-e", "setTimeout(() => {}, 30000)", rootMarker], {
              stdin: "ignore",
              stdout: "pipe",
              stderr: "ignore"
            }).pipe(
              ChildProcess.pipeTo(
                ChildProcess.make("node", ["-e", "setTimeout(() => {}, 30000)", tailMarker], {
                  stdin: "pipe",
                  stdout: "ignore",
                  stderr: "ignore"
                })
              )
            )
          })).pipe(Effect.provide(NodeServices))

          // @effect-diagnostics-next-line floatingEffect:off
          yield* Scope.provide(scope)(handle.unref).pipe(Effect.provide(NodeServices))
          yield* Scope.close(scope, Exit.void)
          yield* TestClock.withLive(Effect.sleep("100 millis"))

          const rootCount = yield* countMatchingProcesses(rootMarker)
          const tailCount = yield* countMatchingProcesses(tailMarker)
          assert.strictEqual(rootCount, 1)
          assert.strictEqual(tailCount, 1)

          yield* killMatchingProcesses(rootMarker)
          yield* killMatchingProcesses(tailMarker)
        }).pipe(Effect.provide(NodeServices)))
    })

    it.effect("should not deadlock on large stdout output", () =>
      Effect.gen(function*() {
        // Generate ~5MB of output — enough to exceed the default PassThrough
        // highWaterMark (16KB) many times over. Without the fix, the unread
        // combinedPassThrough (.all) would exert backpressure on the source
        // stream, blocking stdout too.
        const handle = yield* ChildProcess.make("sh", ["-c", "seq 1 100000"])
        const output = yield* handle.stdout.pipe(
          Stream.decodeText(),
          Stream.runFold(() => "", (acc, chunk) => acc + chunk)
        )
        const exitCode = yield* handle.exitCode

        assert.strictEqual(exitCode, ChildProcessSpawner.ExitCode(0))
        const lines = output.trim().split("\n")
        assert.strictEqual(lines.length, 100000)
        assert.strictEqual(lines[0], "1")
        assert.strictEqual(lines[99999], "100000")
      }).pipe(Effect.scoped), { timeout: 10_000 })

    it.effect("ChildProcess.string should not deadlock on large output", () =>
      Effect.gen(function*() {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
        const output = yield* spawner.string(ChildProcess.make("sh", ["-c", "seq 1 100000"]))
        const lines = output.trim().split("\n")
        assert.strictEqual(lines.length, 100000)
        assert.strictEqual(lines[0], "1")
        assert.strictEqual(lines[99999], "100000")
      }), { timeout: 10_000 })
  })
})
