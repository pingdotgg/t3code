import { buildSpawnOptions } from "@effect/platform-node-shared/internal/nodeChildProcessSpawner"
import { ProxiedProcess } from "@effect/platform-node-shared/internal/proxyProcess"
import { source as proxyProcessSource } from "@effect/platform-node-shared/internal/proxyProcessSource"
import * as NodeChildProcessSpawner from "@effect/platform-node-shared/NodeChildProcessSpawner"
import * as NodeFileSystem from "@effect/platform-node-shared/NodeFileSystem"
import * as NodePath from "@effect/platform-node-shared/NodePath"
import { assert, describe, it } from "@effect/vitest"
import * as ChildProcessSpawnerTest from "effect-test/process/ChildProcessSpawnerTest"
import * as ByteSize from "effect/ByteSize"
import * as Context from "effect/Context"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as ChildProcess from "effect/process/ChildProcess"
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner"
import * as Scope from "effect/Scope"
import * as Stream from "effect/Stream"
import NodeChildProcess, { spawnSync } from "node:child_process"
import NodeFs from "node:fs"
import { syncBuiltinESMExports } from "node:module"
import * as Net from "node:net"
import { join } from "node:path"
import { vi } from "vitest"

const NodeServices = NodeChildProcessSpawner.layer.pipe(
  Layer.provideMerge(Layer.mergeAll(
    NodeFileSystem.layer,
    NodePath.layer
  ))
)

const proxyServices = (options?: Parameters<typeof NodeChildProcessSpawner.layerProxyProcess>[0]) =>
  NodeChildProcessSpawner.layerProxyProcess(options).pipe(
    Layer.provideMerge(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer))
  )

const ProxyServices = proxyServices()

// The process supervision tests count processes by name, so the suites must
// not run at the same time
describe("shared suite", { concurrent: false }, () => {
  ChildProcessSpawnerTest.suite("NodeChildProcessSpawner", NodeServices, {
    processGroups: true
  })

  // The proxy process layer fails to build on Windows
  if (process.platform !== "win32") {
    ChildProcessSpawnerTest.suite("NodeChildProcessSpawner.layerProxyProcess", Layer.orDie(ProxyServices), {
      processGroups: true
    })
  }
})

describe.skipIf(process.platform === "win32")("layerProxyProcess", { concurrent: false }, () => {
  // Commands are launched by the proxy process, so their parent is the proxy.
  // The tag is the last argument of the spawn request.
  const tagged = Effect.fnUntraced(function*(...tag: ReadonlyArray<string>) {
    const spawner = yield* ChildProcessSpawner
    return Number((yield* spawner.string(ChildProcess.make("sh", ["-c", "echo $PPID", ...tag]))).trim())
  })

  const proxyPid = tagged()

  const isAlive = (pid: number) => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  const currentPid = Effect.flatMap(NodeChildProcessSpawner.ProxyProcess, (proxy) => proxy.currentPid)

  // Holds back the `Ready` reply of proxy processes started while `hold`
  // exists, and records the tag (last argument) of each spawn request
  const heldProxyProgram = (hold: string, requests: string) =>
    `const fs = process.getBuiltinModule("node:fs")
process.on("message", (message) => {
  if (message.command !== undefined) fs.appendFileSync(${JSON.stringify(requests)}, message.args.at(-1) + "\\n")
})
const sendMessage = process.send.bind(process)
process.send = (message, ...rest) => {
  if (message._tag !== "Ready") return sendMessage(message, ...rest)
  const release = () => fs.existsSync(${JSON.stringify(hold)}) ? setTimeout(release, 10) : sendMessage(message, ...rest)
  release()
  return true
}
${proxyProcessSource}`

  // A layer whose proxy processes run the held program
  const heldProxy = Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const directory = yield* fs.makeTempDirectoryScoped()
    const hold = join(directory, "hold")
    const requests = join(directory, "requests")
    const layer = proxyServices({ args: ["--input-type=module", "-e", heldProxyProgram(hold, requests)] })
    return { fs, hold, requests, layer }
  })

  // Each call makes the application appear to have changed its user ID
  const credentialChanges = Effect.gen(function*() {
    const uid = process.getuid!()
    const getuid = yield* Effect.acquireRelease(
      Effect.sync(() => vi.spyOn(process, "getuid")),
      (spy) => Effect.sync(() => spy.mockRestore())
    )
    let changes = 0
    return () => {
      getuid.mockReturnValue(uid + ++changes)
    }
  })

  it.live("stops the proxy process when the layer scope closes", () =>
    Effect.gen(function*() {
      const [pid, proxy, spawner] = yield* Effect.gen(function*() {
        const pid = yield* proxyPid
        assert.deepStrictEqual(yield* currentPid, Option.some(pid))
        return [pid, yield* NodeChildProcessSpawner.ProxyProcess, yield* ChildProcessSpawner] as const
      }).pipe(Effect.provide(ProxyServices))
      assert.notStrictEqual(pid, process.pid)
      assert.isFalse(isAlive(pid))
      assert.deepStrictEqual(yield* proxy.currentPid, Option.none())
      // A retained spawner does not start a proxy process the layer no longer owns
      const error = yield* Effect.flip(spawner.string(ChildProcess.make("true")))
      assert.strictEqual(error.reason._tag, "BadResource")
    }))

  it.live("never sends a spawn that is interrupted while a replacement proxy process starts", () =>
    Effect.gen(function*() {
      const { fs, hold, layer, requests } = yield* heldProxy
      yield* Effect.gen(function*() {
        const first = Option.getOrThrow(yield* currentPid)
        yield* fs.writeFileString(hold, "")
        process.kill(first, "SIGKILL")
        while (Option.isSome(yield* currentPid)) yield* Effect.sleep("10 millis")

        const interrupted = yield* Effect.forkChild(tagged("interrupted"))
        const survivor = yield* Effect.forkChild(tagged("survivor"))
        yield* Effect.sleep("100 millis")
        // The replacement is starting
        assert.deepStrictEqual(yield* currentPid, Option.none())
        yield* Fiber.interrupt(interrupted)
        yield* fs.remove(hold)

        const pid = yield* Fiber.join(survivor)
        assert.notStrictEqual(pid, first)
        assert.deepStrictEqual(yield* currentPid, Option.some(pid))
        assert.strictEqual(yield* fs.readFileString(requests), "survivor\n")
      }).pipe(Effect.provide(layer))
    }).pipe(Effect.provide(NodeFileSystem.layer), Effect.scoped))

  it.live("sends spawns waiting on a proxy process retired while starting to its replacement", () =>
    Effect.gen(function*() {
      const { fs, hold, layer, requests } = yield* heldProxy
      const changeCredentials = yield* credentialChanges
      yield* Effect.gen(function*() {
        yield* fs.writeFileString(hold, "")
        // Retires the ready proxy process, and starts one that is held
        changeCredentials()
        const waiting = yield* Effect.forkChild(tagged("waiting"))
        yield* Effect.sleep("100 millis")
        // Retires the held one while it starts, and starts another
        changeCredentials()
        const latest = yield* Effect.forkChild(tagged("latest"))
        yield* Effect.sleep("100 millis")
        yield* fs.remove(hold)

        const pid = yield* Fiber.join(latest)
        assert.strictEqual(yield* Fiber.join(waiting), pid)
        assert.deepStrictEqual(yield* currentPid, Option.some(pid))
        assert.deepStrictEqual((yield* fs.readFileString(requests)).split("\n").sort(), ["", "latest", "waiting"])
      }).pipe(Effect.provide(layer))
    }).pipe(Effect.provide(NodeFileSystem.layer), Effect.scoped))

  it.live("fails to build when the proxy process cannot start or does not answer", () =>
    Effect.gen(function*() {
      const build = (options: Parameters<typeof proxyServices>[0]) =>
        Effect.flip(Effect.scoped(Layer.build(proxyServices(options))))
      const missing = yield* build({ executable: "/nonexistent/node" })
      assert.strictEqual(missing.reason._tag, "NotFound")

      const pidFile = join(yield* FileSystem.FileSystem.use((fs) => fs.makeTempDirectoryScoped()), "pid")
      const silent = yield* build({
        args: [
          "-e",
          `require("node:fs").writeFileSync(${
            JSON.stringify(pidFile)
          }, String(process.pid)); setInterval(() => {}, 60_000)`
        ],
        responseTimeout: "1 second"
      })
      assert.strictEqual(silent.reason._tag, "TimedOut")
      const pid = Number(NodeFs.readFileSync(pidFile, "utf8"))
      while (isAlive(pid)) yield* Effect.sleep("10 millis")
    }).pipe(Effect.provide(NodeFileSystem.layer), Effect.scoped))

  it("generates the default launcher's program from the worker that run calls", () => {
    const script = join(__dirname, "..", "scripts", "generateProxyProcessSource.ts")
    const result = spawnSync(process.execPath, [script, "--check"], { encoding: "utf8" })
    // Run `pnpm codegen` after changing the worker
    assert.strictEqual(result.status, 0, result.stderr)
  })

  it.live("runs the proxy process from a packaged application's subcommand", () =>
    Effect.gen(function*() {
      const fixture = join(__dirname, "fixtures", "proxy-cli.ts")
      // Packaged applications may forbid compiling code from strings
      const pid = yield* proxyPid.pipe(
        Effect.provide(proxyServices({ args: ["--disallow-code-generation-from-strings", fixture, "__proxy-process"] }))
      )
      assert.notStrictEqual(pid, process.pid)

      const { NODE_OPTIONS: _, ...env } = process.env
      const result = spawnSync(process.execPath, [fixture, "__proxy-process"], { encoding: "utf8", env })
      assert.strictEqual(result.status, 1)
      assert.include(result.stderr, "must be started by NodeChildProcessSpawner.layerProxyProcess")
    }))

  it.live("does not send a command again when its acknowledgement is lost", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const directory = yield* fs.makeTempDirectoryScoped()
      const runs = join(directory, "runs")
      const dropFlag = join(directory, "drop")
      yield* fs.writeFileString(dropFlag, "")
      // The first proxy process starts commands but never acknowledges them
      const program = `const dropSpawned = (() => {
  try {
    process.getBuiltinModule("node:fs").rmSync(${JSON.stringify(dropFlag)})
    return true
  } catch {
    return false
  }
})()
const sendMessage = process.send.bind(process)
process.send = (message, ...rest) => dropSpawned && message._tag === "Spawned" ? true : sendMessage(message, ...rest)
${proxyProcessSource}`

      yield* Effect.gen(function*() {
        const first = Option.getOrThrow(yield* currentPid)
        const error = yield* Effect.flip(Effect.scoped(ChildProcess.make("sh", ["-c", "echo run >> \"$0\"", runs])))
        assert.include(String((error.reason.cause as Error).message), "may have started")
        assert.deepStrictEqual(yield* currentPid, Option.none())
        // The command ran once
        while (!(yield* fs.exists(runs))) yield* Effect.sleep("10 millis")

        const next = yield* proxyPid
        assert.notStrictEqual(next, first)
        assert.deepStrictEqual(yield* currentPid, Option.some(next))
        assert.strictEqual(yield* fs.readFileString(runs), "run\n")
        while (isAlive(first)) yield* Effect.sleep("10 millis")
      }).pipe(
        Effect.provide(proxyServices({ args: ["--input-type=module", "-e", program], responseTimeout: "1 second" }))
      )
    }).pipe(Effect.provide(NodeFileSystem.layer), Effect.scoped))

  it.live("keeps stdio and kill working, fails exitCode, and restarts when the proxy process exits", () =>
    Effect.gen(function*() {
      const pid = yield* proxyPid
      const echo = yield* ChildProcess.make("sh", ["-c", "read line; echo \"got $line\""])
      const sleep = yield* ChildProcess.make("sleep", ["30"])
      process.kill(pid, "SIGKILL")

      const exitCodeError = yield* Effect.flip(echo.exitCode)
      assert.strictEqual(exitCodeError._tag, "PlatformError")
      assert.deepStrictEqual(yield* currentPid, Option.none())
      assert.strictEqual((yield* Effect.flip(echo.isRunning))._tag, "PlatformError")

      yield* Stream.run(Stream.make(new TextEncoder().encode("hello\n")), echo.stdin)
      const output = yield* Stream.mkString(Stream.decodeText(echo.stdout))
      assert.strictEqual(output, "got hello\n")

      // The signal is delivered, but the exit can no longer be observed
      assert.strictEqual((yield* Effect.flip(sleep.kill()))._tag, "PlatformError")
      // stdout closes once the signalled command has exited
      yield* Stream.runDrain(sleep.stdout).pipe(Effect.timeout("2 seconds"))

      const nextPid = yield* proxyPid
      assert.notStrictEqual(nextPid, pid)
      assert.deepStrictEqual(yield* currentPid, Option.some(nextPid))
    }).pipe(Effect.provide(ProxyServices)))

  // Simulates an application that can no longer remove the socket directory,
  // such as after dropping privileges
  const denySocketDirectoryRemoval = Effect.gen(function*() {
    const rmSync = NodeFs.rmSync
    const denied: Array<string> = []
    const spy = vi.spyOn(NodeFs, "rmSync").mockImplementation((path) => {
      denied.push(String(path))
      throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" })
    })
    syncBuiltinESMExports()
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        spy.mockRestore()
        syncBuiltinESMExports()
        for (const path of denied) rmSync(path, { recursive: true, force: true })
      })
    )
    return denied
  })

  it.live(
    "stops escalating, does not signal on release, and restarts on proxy loss even when socket directory removal fails",
    () =>
      Effect.gen(function*() {
        const kill = yield* Effect.acquireRelease(
          Effect.sync(() => vi.spyOn(process, "kill")),
          (spy) => Effect.sync(() => spy.mockRestore())
        )
        const signalsTo = (pid: number) =>
          kill.mock.calls.filter(([target, signal]) => Math.abs(target) === pid && signal !== 0).map(([, signal]) =>
            signal
          )
        const pid = yield* proxyPid
        const scope = yield* Scope.make()
        // Ignores SIGTERM, so only an escalation could stop it
        const stubborn = yield* Scope.provide(scope)(
          ChildProcess.make("sh", ["-c", "trap '' TERM; echo ready; sleep 30"])
        )
        const idle = yield* Scope.provide(scope)(ChildProcess.make("sleep", ["30"]))
        yield* Effect.addFinalizer(() =>
          Effect.forEach([stubborn, idle], (handle) => killDescendant(-handle.pid), { discard: true })
        )
        const denied = yield* denySocketDirectoryRemoval

        yield* Stream.runHead(stubborn.stdout)
        const killing = yield* Effect.forkChild(Effect.flip(stubborn.kill({ forceKillAfter: "30 seconds" })))
        while (signalsTo(stubborn.pid).length === 0) yield* Effect.sleep("5 millis")
        process.kill(pid, "SIGKILL")
        const error = yield* Fiber.join(killing).pipe(Effect.timeout("5 seconds"))
        assert.strictEqual(error._tag, "PlatformError")
        yield* Scope.close(scope, Exit.void)

        assert.isAbove(denied.length, 0)
        assert.deepStrictEqual(signalsTo(stubborn.pid), ["SIGTERM"])
        assert.deepStrictEqual(signalsTo(idle.pid), [])
        assert.notStrictEqual(yield* proxyPid, pid)
      }).pipe(Effect.provide(ProxyServices), Effect.scoped)
  )

  it.live("retires proxy processes when credentials change even when socket directory removal fails", () =>
    Effect.gen(function*() {
      const denied = yield* denySocketDirectoryRemoval
      const changeCredentials = yield* credentialChanges

      // A busy retired proxy process still reports its command's exit
      const first = yield* proxyPid
      const running = yield* ChildProcess.make("sh", ["-c", "read line; exit 3"])
      changeCredentials()
      const second = yield* proxyPid
      assert.notStrictEqual(second, first)
      yield* Stream.run(Stream.make(new TextEncoder().encode("\n")), running.stdin)
      assert.strictEqual(yield* running.exitCode, 3)

      // An idle retired proxy process exits without waiting for commands
      changeCredentials()
      assert.notStrictEqual(yield* proxyPid, second)
      while (isAlive(first) || isAlive(second)) yield* Effect.sleep("10 millis")
      assert.isAbove(denied.length, 0)
    }).pipe(Effect.provide(ProxyServices), Effect.scoped, Effect.timeout("5 seconds")))

  it("fails a spawn whose exit is lost while its stdio sockets are pending", () => {
    const released: Array<number> = []
    const child = new ProxiedProcess({ ref() {}, unref() {}, release: (id) => released.push(id) }, 7, [true, true])
    const events: Array<string> = []
    child.on("spawn", () => events.push("spawn"))
    child.on("lost", () => events.push("lost"))
    child.on("error", (error: Error) => events.push(`error: ${error.message}`))

    const stdin = new Net.Socket()
    assert.isTrue(child.attach(0, stdin))
    child.onSpawned(1234)
    child.onLost(new Error("proxy exited"))()

    const lateStdout = new Net.Socket()
    assert.isFalse(child.attach(1, lateStdout))
    lateStdout.destroy()
    assert.deepStrictEqual(events, ["error: proxy exited"])
    assert.isTrue(stdin.destroyed)
    assert.deepStrictEqual(released, [7])
  })
})

describe.skipIf(process.platform === "win32")("error descriptions", () => {
  it.effect("quote arguments and escape control characters", () =>
    Effect.gen(function*() {
      const error = yield* Effect.flip(ChildProcess.make("nonexistent-command-12345", ["a b", "it's", "\u001b[2J"]))

      assert.strictEqual(error.reason._tag, "NotFound")
      assert.strictEqual(
        error.reason._tag === "NotFound" ? error.reason.pathOrDescriptor : undefined,
        "nonexistent-command-12345 'a b' 'it'\\''s' '\\u001b[2J'"
      )
    }).pipe(Effect.provide(NodeServices)))
})

describe("Windows cleanup", { concurrent: false }, () => {
  // Simulated on other platforms
  it.live("fails to build the proxy process layer on Windows, and Layer.catch falls back to layer", () =>
    Effect.gen(function*() {
      const platform = Object.getOwnPropertyDescriptor(process, "platform")!
      yield* Effect.acquireRelease(
        Effect.sync(() => Object.defineProperty(process, "platform", { value: "win32" })),
        () => Effect.sync(() => Object.defineProperty(process, "platform", platform))
      )
      const error = yield* Effect.flip(Layer.build(NodeChildProcessSpawner.layerProxyProcess()))
      assert.include(error.message, "not supported on Windows")
      const context = yield* Layer.build(
        NodeChildProcessSpawner.layerProxyProcess().pipe(Layer.catch(() => NodeChildProcessSpawner.layer))
      )
      assert.isTrue(Option.isSome(Context.getOption(context, ChildProcessSpawner)))
      assert.isTrue(Option.isNone(Context.getOption(context, NodeChildProcessSpawner.ProxyProcess)))
    }).pipe(Effect.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)), Effect.scoped))

  for (const signal of [false, true]) {
    it.skipIf(signal && process.platform === "win32")(
      `does not taskkill a ${signal ? "signal-terminated" : "failed"} child during exit, kill or scope release`,
      async () => {
        const platform = Object.getOwnPropertyDescriptor(process, "platform")!
        const taskkill = vi.spyOn(NodeChildProcess, "execFile").mockImplementation((...args) => {
          const callback = args.at(-1)
          if (typeof callback === "function") callback(null, "", "")
          return new NodeChildProcess.ChildProcess()
        })
        syncBuiltinESMExports()
        try {
          await Effect.runPromise(
            Effect.scoped(Effect.gen(function*() {
              const handle = yield* ChildProcess.make(process.execPath, [
                "-e",
                signal ? "process.kill(process.pid, 'SIGTERM')" : "process.exit(1)"
              ])
              // Spawn natively, then exercise the Windows exit and cleanup paths.
              Object.defineProperty(process, "platform", { value: "win32" })
              if (signal) {
                assert.isTrue(Exit.isFailure(yield* Effect.exit(handle.exitCode)))
              } else {
                assert.strictEqual(yield* handle.exitCode, 1)
              }
              yield* handle.kill()
            })).pipe(Effect.provide(NodeServices))
          )
          assert.strictEqual(taskkill.mock.calls.length, 0)
        } finally {
          Object.defineProperty(process, "platform", platform)
          taskkill.mockRestore()
          syncBuiltinESMExports()
        }
      }
    )
  }
})

const assertNoProcessGroupSignals = Effect.fnUntraced(
  function*<E, R>(spawn: Effect.Effect<{ readonly pid: number }, E, R>) {
    const kill = vi.spyOn(process, "kill")
    yield* Effect.addFinalizer(() => Effect.sync(() => kill.mockRestore()))
    const { pid } = yield* Effect.scoped(spawn)
    assert.deepStrictEqual(kill.mock.calls.filter(([target]) => target === -pid), [])
  },
  Effect.scoped,
  Effect.provide(NodeServices)
)

describe.skipIf(process.platform === "win32")("non-detached exit cleanup", { concurrent: false }, () => {
  for (const signal of [false, true]) {
    it.live(
      `does not signal the process group of a ${
        signal ? "signal-terminated" : "failed"
      } child during exit, kill or scope release`,
      () =>
        assertNoProcessGroupSignals(Effect.gen(function*() {
          const handle = yield* ChildProcess.make(process.execPath, [
            "-e",
            signal ? "process.kill(process.pid, 'SIGTERM')" : "process.exit(1)"
          ], { detached: false, forceKillAfter: "100 millis" })
          if (signal) {
            assert.isTrue(Exit.isFailure(yield* Effect.exit(handle.exitCode)))
          } else {
            assert.strictEqual(yield* handle.exitCode, 1)
          }
          // The exited child's PID may now lead an unrelated process group.
          yield* Effect.ignore(handle.kill())
          return handle
        }))
    )
  }

  it.live("does not signal or poll the process group when terminating a running child", () =>
    assertNoProcessGroupSignals(Effect.gen(function*() {
      const handle = yield* ChildProcess.make(process.execPath, [
        "-e",
        "process.on('SIGTERM', () => {}); console.log('READY'); setInterval(() => {}, 1000)"
      ], { detached: false, forceKillAfter: "100 millis" })
      yield* Stream.runHead(handle.stdout)
      return handle
    })))
})

const zombieProbes = 3

// macOS answers EPERM rather than ESRCH while the group's remaining members are zombies.
const stubZombieProcessGroup = Effect.fnUntraced(function*() {
  const nativeKill = process.kill.bind(process)
  const group = { pid: 0, probes: 0, signals: [] as Array<string | number | undefined> }
  const kill = vi.spyOn(process, "kill").mockImplementation((target, signal) => {
    if (group.pid === 0 || target !== -group.pid) {
      return nativeKill(target, signal)
    }
    if (signal === 0) {
      group.probes++
    } else {
      group.signals.push(signal)
    }
    throw Object.assign(new Error("kill"), { code: group.probes <= zombieProbes ? "EPERM" : "ESRCH" })
  })
  yield* Effect.addFinalizer(() => Effect.sync(() => kill.mockRestore()))
  return group
})

describe.skipIf(process.platform === "win32")("detached exit cleanup", { concurrent: false }, () => {
  it.live("kill waits for a process group that exists but cannot be signalled", () =>
    Effect.gen(function*() {
      const group = yield* stubZombieProcessGroup()
      const handle = yield* ChildProcess.make(process.execPath, ["-e", "setInterval(() => {}, 1000)"])
      group.pid = handle.pid

      yield* handle.kill()

      assert.strictEqual(group.probes, zombieProbes + 1)
    }).pipe(Effect.scoped, Effect.provide(NodeServices)))

  it.live("kill escalates and waits for a process group whose exited leader left only zombies", () =>
    Effect.gen(function*() {
      const group = yield* stubZombieProcessGroup()
      const handle = yield* ChildProcess.make(process.execPath, ["-e", ""])
      group.pid = handle.pid
      assert.strictEqual(yield* handle.exitCode, 0)

      yield* handle.kill({ forceKillAfter: "0 millis" })

      assert.deepStrictEqual(group.signals, ["SIGTERM", "SIGKILL"])
      assert.strictEqual(group.probes, zombieProbes + 1)
    }).pipe(Effect.scoped, Effect.provide(NodeServices)))
})

// Synchronous fixture runs must not block other tests with active timeout budgets.
describe("interrupted buffered input", { concurrent: false, timeout: 15_000 }, () => {
  for (const input of ["stdin", "fd3"] as const) {
    it(`does not crash the host when ${input} is interrupted`, () => {
      // Isolate the host so an unhandled writable error becomes an assertion
      // failure rather than an uncaught exception in the test runner.
      const result = spawnSync(process.execPath, [join(__dirname, "fixtures", "buffered-input.ts"), input], {
        encoding: "utf8",
        timeout: 10_000
      })
      assert.strictEqual(result.error, undefined)
      assert.strictEqual(result.status, 0, result.stderr)
      assert.strictEqual(result.stdout, "program finished: Failure\nstill alive after 500ms\n")
    })
  }
})

describe("buildSpawnOptions", () => {
  const base = { stdio: "pipe" } as const

  it("defaults to hiding non-detached Windows children", () => {
    assert.deepStrictEqual(buildSpawnOptions({}, base, "win32"), {
      stdio: "pipe",
      detached: false,
      shell: undefined,
      windowsHide: true
    })
    assert.deepStrictEqual(buildSpawnOptions({ detached: true }, base, "win32"), {
      stdio: "pipe",
      detached: true,
      shell: undefined,
      windowsHide: false
    })
    assert.deepStrictEqual(buildSpawnOptions({ detached: false }, base, "win32"), {
      stdio: "pipe",
      detached: false,
      shell: undefined,
      windowsHide: true
    })
  })

  it("allows windowsHide to be configured independently of detached", () => {
    assert.deepStrictEqual(
      buildSpawnOptions({ detached: false, windowsHide: false }, base, "win32"),
      {
        stdio: "pipe",
        detached: false,
        shell: undefined,
        windowsHide: false
      }
    )
    assert.deepStrictEqual(
      buildSpawnOptions({ detached: true, windowsHide: true }, base, "win32"),
      {
        stdio: "pipe",
        detached: true,
        shell: undefined,
        windowsHide: true
      }
    )
  })
})

it.live("kills every process in a pipeline", () =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const directory = yield* fs.makeTempDirectoryScoped()
    const rootHeartbeat = `${directory}/root-heartbeat`
    const childHeartbeat = `${directory}/child-heartbeat`
    const handle = yield* ChildProcess.make(
      "sh",
      [
        "-c",
        "printf x >> \"$1\"; printf 'ROOT_READY\\n'; while :; do printf x >> \"$1\"; sleep 0.01; done",
        "pipeline-root",
        rootHeartbeat
      ]
    ).pipe(ChildProcess.pipeTo(ChildProcess.make(
      "sh",
      [
        "-c",
        "printf x >> \"$1\"; printf 'CHILD_READY\\n'; read -r ready; printf '%s\\n' \"$ready\"; while :; do printf x >> \"$1\"; sleep 0.01; done",
        "pipeline-child",
        childHeartbeat
      ]
    )))
    const readyLines = yield* handle.stdout.pipe(
      Stream.decodeText,
      Stream.splitLines,
      Stream.take(2),
      Stream.runCollect
    )
    assert.deepStrictEqual(readyLines, ["CHILD_READY", "ROOT_READY"])
    yield* handle.kill({ killSignal: "SIGKILL" })
    const rootSizeAfterKill = (yield* fs.stat(rootHeartbeat)).size
    const childSizeAfterKill = (yield* fs.stat(childHeartbeat)).size
    yield* Effect.sleep("100 millis")
    const rootFinalSize = (yield* fs.stat(rootHeartbeat)).size
    const childFinalSize = (yield* fs.stat(childHeartbeat)).size

    assert.strictEqual(ByteSize.toBigInt(rootFinalSize), ByteSize.toBigInt(rootSizeAfterKill))
    assert.strictEqual(ByteSize.toBigInt(childFinalSize), ByteSize.toBigInt(childSizeAfterKill))
  }).pipe(Effect.scoped, Effect.provide(NodeServices)))

const processGroupFixture = join(__dirname, "fixtures", "process-group.ts")

// Use native timers under TestClock.
const liveSleep = (millis: number) =>
  Effect.callback<void>((resume) => {
    const timer = setTimeout(() => resume(Effect.void), millis)
    return Effect.sync(() => clearTimeout(timer))
  })

const liveTimeout = (millis: number) => <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.raceFirst(effect, liveSleep(millis).pipe(Effect.andThen(Effect.die(new Error("timed out")))))

const startProcessGroup = Effect.fnUntraced(function*(
  mode: "exit-on-signal" | "ignore-signal",
  options?: ChildProcess.CommandOptions,
  delays: { readonly leader: number; readonly descendant: number } = { leader: 0, descendant: 200 }
) {
  const fs = yield* FileSystem.FileSystem
  const directory = yield* fs.makeTempDirectoryScoped()
  const marker = `${directory}/marker`
  const scope = yield* Scope.fork(yield* Effect.scope)
  const handle = yield* Scope.provide(scope)(ChildProcess.make(
    process.execPath,
    [processGroupFixture, "leader", mode, marker, String(delays.leader), String(delays.descendant)],
    { stdin: "ignore", ...options }
  ))
  const ready = yield* Deferred.make<number>()
  yield* handle.stdout.pipe(
    Stream.decodeText,
    Stream.splitLines,
    Stream.runForEach((line) =>
      line.startsWith("READY ") ? Deferred.succeed(ready, Number(line.slice("READY ".length))) : Effect.void
    ),
    Effect.forkScoped
  )
  const descendantPid = yield* Deferred.await(ready).pipe(liveTimeout(5_000))
  return { handle, descendantPid, marker, scope }
})

const killDescendant = (pid: number) =>
  Effect.sync(() => {
    try {
      process.kill(pid, "SIGKILL")
    } catch {}
  })

const assertHeartbeatStopped = Effect.fnUntraced(function*(marker: string) {
  const fs = yield* FileSystem.FileSystem
  const sizeAfterKill = (yield* fs.stat(marker)).size
  yield* liveSleep(100)
  const finalSize = (yield* fs.stat(marker)).size
  assert.strictEqual(finalSize, sizeAfterKill)
})

const timed = Effect.fnUntraced(function*<A, E, R>(effect: Effect.Effect<A, E, R>) {
  const start = Date.now()
  yield* effect
  return Date.now() - start
})

describe.skipIf(process.platform === "win32")("process group cleanup", () => {
  it.live("scope release cleans descendants after the leader exits successfully", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const { descendantPid, handle, marker, scope } = yield* startProcessGroup("exit-on-signal", { stdin: "pipe" })
      yield* Effect.addFinalizer(() => killDescendant(descendantPid))

      yield* Stream.run(Stream.make(new TextEncoder().encode("exit\n")), handle.stdin)
      assert.strictEqual(yield* handle.exitCode, 0)
      assert.doesNotThrow(() => process.kill(descendantPid, 0), "descendant must still be alive after the leader exits")
      assert.isFalse(yield* fs.exists(marker))

      yield* Scope.close(scope, Exit.void)

      assert.strictEqual(yield* fs.readFileString(marker), "exited")
    }).pipe(Effect.scoped, Effect.provide(NodeServices)))

  it.live("scope release force kills descendants after the leader exits with a non-zero code", () =>
    Effect.gen(function*() {
      const { descendantPid, handle, marker, scope } = yield* startProcessGroup("ignore-signal", {
        stdin: "pipe",
        forceKillAfter: "200 millis"
      })
      yield* Effect.addFinalizer(() => killDescendant(descendantPid))

      yield* Stream.run(Stream.make(new TextEncoder().encode("exit 1\n")), handle.stdin)
      assert.strictEqual(yield* handle.exitCode, 1)

      yield* Scope.close(scope, Exit.void).pipe(liveTimeout(2_000))

      yield* assertHeartbeatStopped(marker)
    }).pipe(Effect.scoped, Effect.provide(NodeServices)))

  it.live("scope release cleans descendants after the leader is killed externally", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const { descendantPid, handle, marker, scope } = yield* startProcessGroup("exit-on-signal")
      yield* Effect.addFinalizer(() => killDescendant(descendantPid))

      process.kill(handle.pid, "SIGKILL")
      assert.isTrue(Exit.isFailure(yield* Effect.exit(handle.exitCode)))
      assert.doesNotThrow(() => process.kill(descendantPid, 0), "descendant must survive the leader's SIGKILL")
      assert.isFalse(yield* fs.exists(marker))

      yield* Scope.close(scope, Exit.void)

      assert.isTrue(yield* fs.exists(marker), "scope release must wait for the descendant's exit marker")
      assert.strictEqual(yield* fs.readFileString(marker), "exited")
    }).pipe(Effect.scoped, Effect.provide(NodeServices)))

  it.live("scope release waits for descendants that outlive the leader", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const { handle, marker, scope } = yield* startProcessGroup("exit-on-signal")

      yield* Scope.close(scope, Exit.void)

      assert.isFalse(yield* handle.isRunning)
      assert.isTrue(yield* fs.exists(marker))
    }).pipe(Effect.scoped, Effect.provide(NodeServices)))

  it.live("scope release drains descendants after a slow leader exits", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const { descendantPid, handle, marker, scope } = yield* startProcessGroup("exit-on-signal", undefined, {
        leader: 1_500,
        descendant: 2_000
      })
      yield* Effect.addFinalizer(() => killDescendant(descendantPid))

      const releaseMillis = yield* timed(Scope.close(scope, Exit.void))

      assert.isAtLeast(releaseMillis, 1_500)
      assert.isFalse(yield* handle.isRunning)
      assert.isTrue(yield* fs.exists(marker), "scope release must wait for the descendant's exit marker")
      assert.strictEqual(yield* fs.readFileString(marker), "exited")
    }).pipe(Effect.provide(NodeServices)))

  it.live("scope release force kills descendants that ignore the kill signal", () =>
    Effect.gen(function*() {
      const { marker, scope } = yield* startProcessGroup("ignore-signal", { forceKillAfter: "200 millis" })

      yield* Scope.close(scope, Exit.void)

      yield* assertHeartbeatStopped(marker)
    }).pipe(Effect.scoped, Effect.provide(NodeServices)))

  it.live("kill force kills descendants that ignore the kill signal", () =>
    Effect.gen(function*() {
      const { handle, marker, scope } = yield* startProcessGroup("ignore-signal")

      yield* handle.kill({ forceKillAfter: "200 millis" })

      assert.isFalse(yield* handle.isRunning)
      yield* assertHeartbeatStopped(marker)
      yield* Scope.close(scope, Exit.void)
    }).pipe(Effect.scoped, Effect.provide(NodeServices)))

  it.effect("forceKillAfter escalation does not depend on the Effect clock", () =>
    Effect.gen(function*() {
      const { marker, scope } = yield* startProcessGroup("ignore-signal", { forceKillAfter: "200 millis" })

      const releaseMillis = yield* timed(Scope.close(scope, Exit.void))

      assert.isBelow(releaseMillis, 2_000)
      yield* assertHeartbeatStopped(marker)
    }).pipe(Effect.scoped, Effect.provide(NodeServices)))

  it.live("scope release returns when a descendant holds the inherited pipe without forceKillAfter", () =>
    Effect.gen(function*() {
      const { descendantPid, handle, scope } = yield* startProcessGroup("ignore-signal")

      yield* Effect.gen(function*() {
        const releaseMillis = yield* timed(Scope.close(scope, Exit.void))

        assert.isFalse(yield* handle.isRunning)
        assert.isAtLeast(releaseMillis, 1_000)
        assert.isBelow(releaseMillis, 3_000)
      }).pipe(Effect.ensuring(killDescendant(descendantPid)))
    }).pipe(Effect.scoped, Effect.provide(NodeServices)))
})

it.live("scope release returns when stdout is unread and backpressured", () =>
  Effect.gen(function*() {
    const releaseMillis = yield* timed(Effect.scoped(Effect.gen(function*() {
      yield* ChildProcess.make(process.execPath, [
        "-e",
        "process.stdout.write(\"x\".repeat(1024 * 1024)); setInterval(() => {}, 1000)"
      ], { stdin: "ignore" })
      yield* Effect.sleep("100 millis")
    })))

    assert.isBelow(releaseMillis, 2_000)
  }).pipe(Effect.provide(NodeServices)))

it.live("scope release closes stdin for a child that drains it on the kill signal", () =>
  Effect.gen(function*() {
    const releaseMillis = yield* timed(Effect.scoped(Effect.gen(function*() {
      const handle = yield* ChildProcess.make(process.execPath, [
        "-e",
        // Exits with EOF on SIGTERM, or after 3 seconds if stdin stays open.
        "process.on(\"SIGTERM\", () => process.stdin.on(\"end\", () => process.exit(0)).resume()); console.log(\"READY\"); setTimeout(() => process.exit(1), 3_000)"
      ], { stdin: Stream.never })
      yield* Stream.runHead(handle.stdout)
    })))

    assert.isBelow(releaseMillis, 2_000)
  }).pipe(Effect.provide(NodeServices)))
