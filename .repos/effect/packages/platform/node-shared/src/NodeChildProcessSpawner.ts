/**
 * Shared Node.js implementation of the child process spawner service.
 *
 * This module adapts `node:child_process.spawn` to the Effect
 * `ChildProcessSpawner` service. Provide {@link layer} to run `ChildProcess`
 * commands in Node-compatible runtimes: commands get scoped process handles
 * with stdin sinks, stdout and stderr streams, exit-code waiting,
 * interruption-time cleanup, process killing, and custom file-descriptor pipes.
 * Provide {@link layerProxyProcess} instead to launch commands from a separate
 * proxy process, for Node.js builds where spawning from a process that holds a
 * lot of memory stalls the event loop. Packaged applications that start the
 * proxy process themselves run it with `NodeChildProcessProxy.run`.
 *
 * The implementation sits below the command-building API. It validates and
 * resolves `cwd` through the Effect `FileSystem` and `Path` services,
 * translates Node errno failures to `PlatformError`, and uses scopes to
 * terminate referenced children when the owning effect is interrupted or
 * finalized. Pipelines are flattened by {@link flattenCommand} and spawned one
 * process at a time, wiring the selected source stream (`stdout`, `stderr`,
 * `all`, or `fdN`) to the destination `stdin` or `fdN`.
 *
 * Scoped release and `kill` wait for the signalled process group. Without
 * `forceKillAfter`, cleanup waits for the leader to exit with no time limit,
 * then gives remaining group members up to one second to exit, without
 * escalating.
 * With it, cleanup may take the configured duration plus a final one-second
 * wait after `SIGKILL`. Zombie descendants can consume either full bound. On
 * Windows, `taskkill` terminates the tree while the leader is running, and
 * cleanup waits only for the leader's exit. Descendants that outlive the
 * leader are left running.
 *
 * POSIX cleanup targets a numeric process-group ID. If the group disappears
 * and its ID is reused before cleanup, an unrelated group may be signalled.
 *
 * @stability unstable
 * @since 4.0.0
 */
import type * as Arr from "effect/Array"
import * as Context from "effect/Context"
import * as Deferred from "effect/Deferred"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import type * as Option from "effect/Option"
import * as Path from "effect/Path"
import * as PlatformError from "effect/PlatformError"
import * as Predicate from "effect/Predicate"
import * as ChildProcess from "effect/process/ChildProcess"
import type { ChildProcessHandle } from "effect/process/ChildProcessSpawner"
import {
  ChildProcessSpawner,
  ExitCode,
  make as makeSpawner,
  makeHandle,
  ProcessId
} from "effect/process/ChildProcessSpawner"
import * as CommandLine from "effect/process/CommandLine"
import * as Redacted from "effect/Redacted"
import * as Scope from "effect/Scope"
import * as Sink from "effect/Sink"
import * as Stream from "effect/Stream"
import * as NodeChildProcess from "node:child_process"
import { PassThrough, type Writable } from "node:stream"
import { buildSpawnOptions, type SpawnedProcess, type SpawnProcess } from "./internal/nodeChildProcessSpawner.ts"
import * as ProxyProcesses from "./internal/proxyProcess.ts"
import { handleErrnoException } from "./internal/utils.ts"
import * as NodeSink from "./NodeSink.ts"
import * as NodeStream from "./NodeStream.ts"

const toError = (error: unknown): Error =>
  error instanceof globalThis.Error
    ? error
    : new globalThis.Error(String(error))

const toPlatformError = (
  method: string,
  error: NodeJS.ErrnoException,
  command: ChildProcess.Command
): PlatformError.PlatformError => {
  const { commands } = flattenCommand(command)
  const format = globalThis.process.platform === "win32" ? "windows" : "posix"
  const commandStr = commands.map((cmd) => CommandLine.display([cmd.command, ...cmd.args], { format })).join(" | ")
  return handleErrnoException("ChildProcess", method)(error, [commandStr])
}

const unwrap = (value: string | Redacted.Redacted<string>): string =>
  Redacted.isRedacted(value) ? Redacted.value(value) : value

// Node's own NUL check throws an error that includes the value, so NUL is
// rejected here to keep Redacted values out of errors.
const findNulCharacter = (command: ChildProcess.StandardCommand): string | undefined => {
  if (command.command.includes("\0")) return "The command contains a NUL character"
  const index = command.args.findIndex((arg) => unwrap(arg).includes("\0"))
  if (index !== -1) return `Argument ${index + 1} contains a NUL character`
  for (const [name, value] of Object.entries(command.options.env ?? {})) {
    if (value !== undefined && unwrap(value).includes("\0")) {
      return `The environment variable ${name} contains a NUL character`
    }
  }
  return undefined
}

type ExitCodeWithSignal = readonly [code: number | null, signal: NodeJS.Signals | null]
// Fails when the exit status can no longer be observed, such as when the proxy
// process that launched the child exits first
type ExitSignal = Deferred.Deferred<ExitCodeWithSignal, PlatformError.PlatformError>

const processGroupGraceMillis = 1_000
const processGroupPollIntervalMillis = 10

// Buffered writes can fail after the sink has been interrupted and removed its
// error listener. Keep a fallback until close, without replacing the sink
// listener that propagates errors while it is active.
const handleInputErrors = (writable: Writable): void => {
  const onError = () => {}
  writable.on("error", onError)
  writable.once("close", () => writable.off("error", onError))
}

/** Node has recorded the leader's exit, after which its PID may be reused by an unrelated process. */
const hasExited = (childProcess: SpawnedProcess): boolean =>
  childProcess.exitCode !== null || childProcess.signalCode !== null

/** Only a detached POSIX child leads its own process group. */
const ownsProcessGroup = (command: ChildProcess.StandardCommand): boolean =>
  globalThis.process.platform !== "win32" && command.options.detached !== false

/**
 * The process group exists but has no member that can be signalled, such as
 * on macOS when its remaining members are zombies.
 */
const isUnsignallableProcessGroup = (error: unknown): boolean =>
  (error as NodeJS.ErrnoException | undefined)?.code === "EPERM"

/**
 * The leader has not exited, or a member of its process group still exists. A
 * process whose exit status can no longer be observed is not reported alive,
 * since it may have exited and its ID been reused.
 */
const isProcessAlive = (
  command: ChildProcess.StandardCommand,
  childProcess: SpawnedProcess
): boolean => {
  if (childProcess.lost === true) {
    return false
  }
  if (!hasExited(childProcess)) {
    return true
  }
  if (!ownsProcessGroup(command)) {
    return false
  }
  try {
    globalThis.process.kill(-childProcess.pid!, 0)
    return true
  } catch (error) {
    return isUnsignallableProcessGroup(error)
  }
}

const taskkill = (
  childProcess: SpawnedProcess,
  onExit: (error: NodeChildProcess.ExecException | null) => void = () => {}
) => {
  if (hasExited(childProcess)) {
    onExit(null)
    return
  }
  NodeChildProcess.execFile(
    "taskkill",
    ["/pid", String(childProcess.pid!), "/T", "/F"],
    { windowsHide: true },
    onExit
  )
}

const spawnDirect: SpawnProcess = (command, args, options) => NodeChildProcess.spawn(command, args, options)

// Returns the function that launches a command. The proxy process layer waits
// here, interruptibly, for a proxy process that is ready, since the launch
// itself cannot be interrupted.
const makeWith = Effect.fnUntraced(function*(prepareSpawn: Effect.Effect<SpawnProcess, PlatformError.PlatformError>) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path

  const resolveWorkingDirectory = Effect.fnUntraced(
    function*(options: ChildProcess.CommandOptions) {
      if (Predicate.isUndefined(options.cwd)) return undefined
      // Validate that the specified directory is accessible
      yield* fs.access(options.cwd)
      return path.resolve(options.cwd)
    }
  )

  const resolveEnvironment = (options: ChildProcess.CommandOptions) => {
    if (options.env === undefined) return undefined
    const env: Record<string, string | undefined> = options.extendEnv === true ? { ...globalThis.process.env } : {}
    for (const [key, value] of Object.entries(options.env)) {
      if (value === undefined) delete env[key]
      else env[key] = unwrap(value)
    }
    return env
  }

  const inputToStdioOption = (input: ChildProcess.CommandInput | undefined): NodeChildProcess.IOType | undefined =>
    Stream.isStream(input) ? "pipe" : input

  const outputToStdioOption = (input: ChildProcess.CommandOutput | undefined): NodeChildProcess.IOType | undefined =>
    Sink.isSink(input) ? "pipe" : input

  const resolveStdinOption = (options: ChildProcess.CommandOptions): ChildProcess.StdinConfig => {
    const defaultConfig: ChildProcess.StdinConfig = { stream: "pipe", encoding: "utf-8", endOnDone: true }
    if (Predicate.isUndefined(options.stdin)) {
      return defaultConfig
    }
    if (typeof options.stdin === "string") {
      return { ...defaultConfig, stream: options.stdin }
    }
    if (Stream.isStream(options.stdin)) {
      return { ...defaultConfig, stream: options.stdin }
    }
    return {
      stream: options.stdin.stream,
      encoding: options.stdin.encoding ?? defaultConfig.encoding,
      endOnDone: options.stdin.endOnDone ?? defaultConfig.endOnDone
    }
  }

  const resolveOutputOption = (
    options: ChildProcess.CommandOptions,
    streamName: "stdout" | "stderr"
  ): ChildProcess.StdoutConfig => {
    const option = options[streamName]
    if (Predicate.isUndefined(option)) {
      return { stream: "pipe" }
    }
    if (typeof option === "string") {
      return { stream: option }
    }
    if (Sink.isSink(option)) {
      return { stream: option }
    }
    return { stream: option.stream }
  }

  interface ResolvedAdditionalFd {
    readonly fd: number
    readonly config: ChildProcess.AdditionalFdConfig
  }

  const resolveAdditionalFds = (
    options: ChildProcess.CommandOptions
  ): ReadonlyArray<ResolvedAdditionalFd> => {
    if (Predicate.isUndefined(options.additionalFds)) {
      return []
    }
    const result: Array<ResolvedAdditionalFd> = []
    for (const [name, config] of Object.entries(options.additionalFds)) {
      const fd = ChildProcess.parseFdName(name)
      if (Predicate.isNotUndefined(fd)) {
        result.push({ fd, config })
      }
    }
    // Sort by fd number to ensure correct ordering
    return result.sort((a, b) => a.fd - b.fd)
  }

  const buildStdioArray = (
    stdinConfig: ChildProcess.StdinConfig,
    stdoutConfig: ChildProcess.StdoutConfig,
    stderrConfig: ChildProcess.StderrConfig,
    additionalFds: ReadonlyArray<ResolvedAdditionalFd>
  ): NodeChildProcess.StdioOptions => {
    const stdio: Array<NodeChildProcess.IOType | undefined> = [
      inputToStdioOption(stdinConfig.stream),
      outputToStdioOption(stdoutConfig.stream),
      outputToStdioOption(stderrConfig.stream)
    ]

    if (additionalFds.length === 0) {
      return stdio as NodeChildProcess.StdioOptions
    }

    // Find the maximum fd number to size the array correctly
    const maxFd = additionalFds.reduce((max, { fd }) => Math.max(max, fd), 2)

    // Fill gaps with "ignore"
    for (let i = 3; i <= maxFd; i++) {
      stdio[i] = "ignore"
    }

    // Set up additional fds as "pipe"
    for (const { fd } of additionalFds) {
      stdio[fd] = "pipe"
    }

    return stdio as NodeChildProcess.StdioOptions
  }

  // Runs a user-provided input stream into its sink, recording a failure of
  // the source stream so that it can be surfaced by the process exit code
  const runInputStream = (
    stream: Stream.Stream<Uint8Array, PlatformError.PlatformError>,
    sink: Sink.Sink<void, Uint8Array, never, PlatformError.PlatformError>,
    inputFailure: Deferred.Deferred<never, PlatformError.PlatformError>
  ) => Effect.forkScoped(Stream.run(Stream.tapError(stream, (error) => Deferred.fail(inputFailure, error)), sink))

  const setupAdditionalFds = Effect.fnUntraced(function*(
    command: ChildProcess.StandardCommand,
    childProcess: SpawnedProcess,
    additionalFds: ReadonlyArray<ResolvedAdditionalFd>,
    inputFailure: Deferred.Deferred<never, PlatformError.PlatformError>
  ) {
    if (additionalFds.length === 0) {
      return {
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty
      }
    }

    const inputSinks = new Map<number, Sink.Sink<void, Uint8Array, never, PlatformError.PlatformError>>()
    const outputStreams = new Map<number, Stream.Stream<Uint8Array, PlatformError.PlatformError>>()

    const setupInput = (
      fd: number,
      nodeStream: SpawnedProcess["stdio"][number],
      stream: Stream.Stream<Uint8Array, PlatformError.PlatformError> | undefined
    ) =>
      Effect.suspend(() => {
        let sink: Sink.Sink<void, Uint8Array, never, PlatformError.PlatformError> = Sink.drain
        if (nodeStream && "write" in nodeStream) {
          handleInputErrors(nodeStream)
          sink = NodeSink.fromWritable({
            evaluate: () => nodeStream,
            onError: (error) => toPlatformError(`fromWritable(fd${fd})`, toError(error), command)
          })
        }

        if (stream) {
          return Effect.map(runInputStream(stream, sink, inputFailure), () => {
            inputSinks.set(fd, sink)
          })
        }

        inputSinks.set(fd, sink)
        return Effect.void
      })

    const setupOutput = (
      fd: number,
      nodeStream: SpawnedProcess["stdio"][number],
      sink: Sink.Sink<Uint8Array, Uint8Array, never, PlatformError.PlatformError> | undefined
    ) => {
      let stream: Stream.Stream<Uint8Array, PlatformError.PlatformError> = Stream.empty
      if (nodeStream && "read" in nodeStream) {
        const passThrough = new PassThrough()
        // Retain errors raised before anyone reads, e.g. a failed write on a
        // duplex fd, so they neither go uncaught nor leave later readers hanging
        let error: unknown = undefined
        passThrough.on("error", (cause) => {
          error ??= cause
        })
        nodeStream.on("error", (cause) => passThrough.destroy(cause))
        nodeStream.pipe(passThrough)
        const onError = (cause: unknown) => toPlatformError(`fromReadable(fd${fd})`, toError(cause), command)
        stream = Stream.suspend(() =>
          error === undefined
            ? NodeStream.fromReadable({ evaluate: () => passThrough, onError })
            : Stream.fail(onError(error))
        )
      }

      if (sink) {
        stream = Stream.transduce(stream, sink)
      }

      outputStreams.set(fd, stream)
    }

    for (const { config, fd } of additionalFds) {
      const nodeStream = childProcess.stdio[fd]

      switch (config.type) {
        case "input": {
          yield* setupInput(fd, nodeStream, config.stream)
          break
        }
        case "output": {
          setupOutput(fd, nodeStream, config.sink)
          break
        }
        case "duplex": {
          // Keep writing possible after the child closes its write side.
          if (nodeStream && "allowHalfOpen" in nodeStream) {
            nodeStream.allowHalfOpen = true
          }
          setupOutput(fd, nodeStream, config.sink)
          yield* setupInput(fd, nodeStream, config.stream)
          break
        }
      }
    }

    return {
      getInputFd: (fd: number) => inputSinks.get(fd) ?? Sink.drain,
      getOutputFd: (fd: number) => outputStreams.get(fd) ?? Stream.empty
    }
  })

  const setupChildStdin = (
    command: ChildProcess.StandardCommand,
    childProcess: SpawnedProcess,
    config: ChildProcess.StdinConfig,
    inputFailure: Deferred.Deferred<never, PlatformError.PlatformError>
  ) =>
    Effect.suspend(() => {
      // If the child process has a standard input stream, connect it to the
      // sink that will attached to the process handle
      let sink: Sink.Sink<void, unknown, never, PlatformError.PlatformError> = Sink.drain
      if (Predicate.isNotNull(childProcess.stdin)) {
        handleInputErrors(childProcess.stdin)
        sink = NodeSink.fromWritable({
          evaluate: () => childProcess.stdin!,
          onError: (error) => toPlatformError("fromWritable(stdin)", toError(error), command),
          endOnDone: config.endOnDone,
          encoding: config.encoding
        })
      }

      // If the user provided a `Stream`, run it into the stdin sink
      if (Stream.isStream(config.stream)) {
        return Effect.as(runInputStream(config.stream, sink, inputFailure), sink)
      }

      return Effect.succeed(sink)
    })

  const setupChildOutputStreams = (
    command: ChildProcess.StandardCommand,
    childProcess: SpawnedProcess,
    stdoutConfig: ChildProcess.StdoutConfig,
    stderrConfig: ChildProcess.StderrConfig
  ): {
    stdout: Stream.Stream<Uint8Array, PlatformError.PlatformError>
    stderr: Stream.Stream<Uint8Array, PlatformError.PlatformError>
    all: Stream.Stream<Uint8Array, PlatformError.PlatformError>
  } => {
    let stdout = childProcess.stdout ?
      (() => {
        const passThrough = new PassThrough()
        childProcess.stdout!.on("error", (error) => passThrough.destroy(error))
        childProcess.stdout!.pipe(passThrough)
        return NodeStream.fromReadable({
          evaluate: () => passThrough,
          onError: (error) => toPlatformError("fromReadable(stdout)", toError(error), command)
        })
      })() :
      Stream.empty
    let stderr = childProcess.stderr ?
      (() => {
        const passThrough = new PassThrough()
        childProcess.stderr!.on("error", (error) => passThrough.destroy(error))
        childProcess.stderr!.pipe(passThrough)
        return NodeStream.fromReadable({
          evaluate: () => passThrough,
          onError: (error) => toPlatformError("fromReadable(stderr)", toError(error), command)
        })
      })() :
      Stream.empty

    if (Sink.isSink(stdoutConfig.stream)) {
      stdout = Stream.transduce(stdout, stdoutConfig.stream)
    }
    if (Sink.isSink(stderrConfig.stream)) {
      stderr = Stream.transduce(stderr, stderrConfig.stream)
    }

    const all = Stream.merge(stdout, stderr)

    return { stdout, stderr, all }
  }

  const spawn = (
    spawnProcess: SpawnProcess,
    command: ChildProcess.StandardCommand,
    spawnOptions: NodeChildProcess.SpawnOptions
  ) =>
    Effect.callback<
      readonly [SpawnedProcess, ExitSignal],
      PlatformError.PlatformError
    >((resume) => {
      const deferred = Deferred.makeUnsafe<ExitCodeWithSignal, PlatformError.PlatformError>()
      const handle = spawnProcess(
        command.command,
        command.args.map(unwrap),
        spawnOptions
      )
      handle.on("error", (error) => {
        // Node copies the arguments into `spawnargs`.
        if (command.args.some(Redacted.isRedacted)) {
          Object.assign(error, {
            spawnargs: [command.command, ...command.args.map((arg) => Redacted.isRedacted(arg) ? "<redacted>" : arg)]
          })
        }
        resume(Effect.fail(toPlatformError("spawn", error, command)))
      })
      handle.on("exit", (...args: ExitCodeWithSignal) => {
        Deferred.doneUnsafe(deferred, Exit.succeed(args))
      })
      handle.on("lost", (error: Error) => {
        Deferred.doneUnsafe(deferred, Exit.fail(toPlatformError("exitCode", error, command)))
      })
      handle.on("spawn", () => {
        resume(Effect.succeed([handle, deferred]))
      })
      return Effect.sync(() => {
        handle.kill("SIGTERM")
      })
    })

  const killProcessGroup = (
    command: ChildProcess.StandardCommand,
    childProcess: SpawnedProcess,
    signal: NodeJS.Signals
  ) => {
    if (globalThis.process.platform === "win32") {
      return Effect.callback<void, PlatformError.PlatformError>((resume) => {
        taskkill(childProcess, (error) => {
          if (error) {
            resume(Effect.fail(toPlatformError("kill", toError(error), command)))
          } else {
            resume(Effect.void)
          }
        })
      })
    }
    return Effect.try({
      try: () => {
        globalThis.process.kill(-childProcess.pid!, signal)
      },
      catch: (error) => toPlatformError("kill", toError(error), command)
    })
  }

  const killProcessGroupOnExit = (
    childProcess: SpawnedProcess,
    signal: NodeJS.Signals
  ): void => {
    try {
      globalThis.process.kill(-childProcess.pid!, signal)
    } catch {
      // ignore errors during best-effort cleanup
    }
  }

  const killProcess = (
    command: ChildProcess.StandardCommand,
    childProcess: SpawnedProcess,
    signal: NodeJS.Signals
  ) =>
    Effect.suspend(() => {
      const killed = childProcess.kill(signal)
      if (!killed) {
        const error = new globalThis.Error("Failed to kill child process")
        return Effect.fail(toPlatformError("kill", error, command))
      }
      return Effect.void
    })

  /**
   * Waits for the leader and its process group, bounded by native time. Stops
   * waiting when the exit status can no longer be observed.
   */
  const awaitProcessExit = (
    command: ChildProcess.StandardCommand,
    childProcess: SpawnedProcess,
    timeoutMillis: number
  ): Effect.Effect<void> =>
    Effect.callback<void>((resume) => {
      const deadline = Date.now() + timeoutMillis
      let timer: NodeJS.Timeout | undefined
      const stop = () => {
        clearTimeout(timer)
        childProcess.removeListener("exit", poll)
        childProcess.removeListener("lost", poll)
      }
      const poll = () => {
        clearTimeout(timer)
        if (Date.now() >= deadline || !isProcessAlive(command, childProcess)) {
          stop()
          resume(Effect.void)
          return
        }
        timer = setTimeout(poll, processGroupPollIntervalMillis)
      }
      childProcess.on("exit", poll)
      childProcess.on("lost", poll)
      poll()
      return Effect.sync(stop)
    })

  const terminateProcessGroup = Effect.fnUntraced(function*(
    command: ChildProcess.StandardCommand,
    childProcess: SpawnedProcess,
    exitSignal: ExitSignal,
    options: ChildProcess.KillOptions | undefined
  ) {
    // `taskkill /T` stops the whole process tree on Windows, detached or not.
    const signalGroup = (signal: NodeJS.Signals) =>
      globalThis.process.platform === "win32" || ownsProcessGroup(command) ?
        killProcessGroup(command, childProcess, signal).pipe(
          Effect.catch((error) =>
            // Only zombies remain in the exited leader's group, so nothing is left to signal.
            hasExited(childProcess) && isUnsignallableProcessGroup(error.cause) ?
              Effect.void :
              killProcess(command, childProcess, signal)
          )
        ) :
        killProcess(command, childProcess, signal)
    yield* signalGroup(options?.killSignal ?? "SIGTERM")
    if (Predicate.isUndefined(options?.forceKillAfter)) {
      yield* Deferred.await(exitSignal)
      yield* awaitProcessExit(command, childProcess, processGroupGraceMillis)
    } else {
      yield* awaitProcessExit(command, childProcess, Duration.toMillis(options.forceKillAfter))
      if (isProcessAlive(command, childProcess)) {
        yield* signalGroup("SIGKILL")
        yield* awaitProcessExit(command, childProcess, processGroupGraceMillis)
      }
    }
    yield* Deferred.await(exitSignal)
  })

  /**
   * Get the appropriate source stream from a process handle based on the
   * `from` pipe option.
   */
  const getSourceStream = (
    handle: ChildProcessHandle,
    from: ChildProcess.PipeFromOption | undefined
  ): Stream.Stream<Uint8Array, PlatformError.PlatformError> => {
    const fromOption = from ?? "stdout"
    switch (fromOption) {
      case "stdout":
        return handle.stdout
      case "stderr":
        return handle.stderr
      case "all":
        return handle.all
      default: {
        // Handle fd3, fd4, etc.
        const fd = ChildProcess.parseFdName(fromOption)
        if (Predicate.isNotUndefined(fd)) {
          return handle.getOutputFd(fd)
        }
        // Fallback to stdout for invalid fd names
        return handle.stdout
      }
    }
  }

  const spawnCommand: (
    command: ChildProcess.Command
  ) => Effect.Effect<
    ChildProcessHandle,
    PlatformError.PlatformError,
    Scope.Scope
  > = Effect.fnUntraced(function*(cmd) {
    switch (cmd._tag) {
      case "StandardCommand": {
        if (cmd.options.shell !== undefined && cmd.options.shell !== false && cmd.args.length > 0) {
          return yield* Effect.fail(PlatformError.badArgument({
            module: "ChildProcess",
            method: "spawn",
            description: "The shell option cannot be combined with arguments; pass the whole script as the command"
          }))
        }
        const nulCharacter = findNulCharacter(cmd)
        if (nulCharacter !== undefined) {
          return yield* Effect.fail(PlatformError.badArgument({
            module: "ChildProcess",
            method: "spawn",
            description: nulCharacter
          }))
        }
        const stdinConfig = resolveStdinOption(cmd.options)
        const stdoutConfig = resolveOutputOption(cmd.options, "stdout")
        const stderrConfig = resolveOutputOption(cmd.options, "stderr")
        const resolvedAdditionalFds = resolveAdditionalFds(cmd.options)
        let isReferenced = true

        const cwd = yield* resolveWorkingDirectory(cmd.options)
        const env = resolveEnvironment(cmd.options)
        const stdio = buildStdioArray(stdinConfig, stdoutConfig, stderrConfig, resolvedAdditionalFds)

        const releaseProcess = Effect.fnUntraced(function*(
          childProcess: SpawnedProcess,
          exitSignal: ExitSignal
        ) {
          // A child whose exit status can no longer be observed may have exited
          // and its ID been reused, so it is left alone. An unref'ed child and its
          // process group are no longer owned by the scope.
          if (childProcess.lost === true || !isReferenced) {
            return
          }
          if (Deferred.isDoneUnsafe(exitSignal)) {
            // Only a lost child fails its exit signal
            const [code] = yield* Effect.orDie(Deferred.await(exitSignal))
            if ((code === 0 || Predicate.isNull(code)) && !ownsProcessGroup(cmd)) {
              return
            }
          }
          yield* Effect.ignore(terminateProcessGroup(cmd, childProcess, exitSignal, cmd.options))
        })
        const spawnProcess = yield* prepareSpawn
        // The input feeders run in a standalone scope, so a failed spawn leaves
        // nothing behind in the caller's scope. It is closed concurrently with
        // process termination, since either may wait on the other: Bun does not
        // settle a destroyed, backpressured stdin while the child is alive, and
        // a child may wait for stdin EOF before exiting.
        const inputScope = Scope.makeUnsafe()
        const [childProcess, exitSignal] = yield* Effect.acquireRelease(
          spawn(spawnProcess, cmd, buildSpawnOptions(cmd.options, { cwd, env, stdio }, process.platform)),
          ([childProcess, exitSignal], exit) =>
            Effect.all([Scope.close(inputScope, exit), releaseProcess(childProcess, exitSignal)], {
              concurrency: "unbounded",
              discard: true
            })
        )

        const pid = ProcessId(childProcess.pid!)
        if (ownsProcessGroup(cmd)) {
          childProcess.on("exit", (code) => {
            if (isReferenced && code !== 0 && Predicate.isNotNull(code)) {
              killProcessGroupOnExit(childProcess, cmd.options.killSignal ?? "SIGTERM")
            }
          })
        }
        const reref = Effect.sync(() => {
          if (!isReferenced) {
            childProcess.ref()
            isReferenced = true
          }
        })
        const unref = Effect.sync(() => {
          if (isReferenced) {
            childProcess.unref()
            isReferenced = false
          }
          return reref
        })
        const inputFailure = Deferred.makeUnsafe<never, PlatformError.PlatformError>()
        const stdin = yield* Scope.provide(inputScope)(setupChildStdin(cmd, childProcess, stdinConfig, inputFailure))
        const { all, stderr, stdout } = setupChildOutputStreams(cmd, childProcess, stdoutConfig, stderrConfig)
        const { getInputFd, getOutputFd } = yield* Scope.provide(inputScope)(
          setupAdditionalFds(cmd, childProcess, resolvedAdditionalFds, inputFailure)
        )
        // Fails once the exit status can no longer be observed
        const isRunning = Effect.suspend(() =>
          Deferred.isDoneUnsafe(exitSignal) ? Effect.as(Deferred.await(exitSignal), false) : Effect.succeed(true)
        )
        // A failed input stream truncates the input of the child process, so
        // its failure takes precedence over the exit status and is surfaced
        // without waiting for the child process to exit
        const exitCode = Effect.flatMap(
          Effect.raceFirst(Deferred.await(exitSignal), Deferred.await(inputFailure)),
          ([code, signal]) => {
            if (Deferred.isDoneUnsafe(inputFailure)) {
              return Deferred.await(inputFailure)
            }
            if (Predicate.isNotNull(code)) {
              return Effect.succeed(ExitCode(code))
            }
            // If code is `null`, then `signal` must be defined. See the NodeJS
            // documentation for the `"exit"` event on a `child_process`.
            // https://nodejs.org/api/child_process.html#child_process_event_exit
            const error = new globalThis.Error(`Process interrupted due to receipt of signal: '${signal}'`)
            return Effect.fail(toPlatformError("exitCode", error, cmd))
          }
        )
        const kill = (options?: ChildProcess.KillOptions | undefined) =>
          terminateProcessGroup(cmd, childProcess, exitSignal, options)

        return makeHandle({
          pid,
          exitCode,
          isRunning,
          kill,
          stdin,
          stdout,
          stderr,
          all,
          getInputFd,
          getOutputFd,
          unref
        })
      }
      case "PipedCommand": {
        const { commands, pipeOptions } = flattenCommand(cmd)
        const [root, ...pipeline] = commands

        const handles = [yield* spawnCommand(root)]

        for (let i = 0; i < pipeline.length; i++) {
          const command = pipeline[i]
          const options = pipeOptions[i] ?? {}
          const stdinConfig = resolveStdinOption(command.options)

          // Get the appropriate stream from the source based on `from` option
          const sourceStream = Stream.unwrap(
            Effect.succeed(getSourceStream(handles[handles.length - 1], options.from))
          )

          // Determine where to pipe: stdin or custom fd
          const toOption = options.to ?? "stdin"

          if (toOption === "stdin") {
            // Pipe to stdin (default behavior)
            handles.push(
              yield* spawnCommand(ChildProcess.make(command.command, command.args, {
                ...command.options,
                stdin: { ...stdinConfig, stream: sourceStream }
              }))
            )
          } else {
            // Pipe to custom fd (fd3, fd4, etc.)
            const fd = ChildProcess.parseFdName(toOption)
            if (Predicate.isNotUndefined(fd)) {
              const fdName = ChildProcess.fdName(fd) as `fd${number}`
              const existingFds = command.options.additionalFds ?? {}
              const existingFd = existingFds[fdName]
              const fdConfig: ChildProcess.AdditionalFdConfig = existingFd?.type === "duplex"
                ? { ...existingFd, stream: sourceStream }
                : { type: "input", stream: sourceStream }
              handles.push(
                yield* spawnCommand(ChildProcess.make(command.command, command.args, {
                  ...command.options,
                  additionalFds: {
                    ...existingFds,
                    [fdName]: fdConfig
                  }
                }))
              )
            } else {
              // Invalid fd name, fall back to stdin
              handles.push(
                yield* spawnCommand(ChildProcess.make(command.command, command.args, {
                  ...command.options,
                  stdin: { ...stdinConfig, stream: sourceStream }
                }))
              )
            }
          }
        }

        const handle = handles[handles.length - 1]
        const kill = (options?: ChildProcess.KillOptions | undefined) =>
          Effect.forEach([...handles].reverse(), (handle) => Effect.ignore(handle.kill(options)), { discard: true })
        const unref = Effect.gen(function*() {
          const rerefs: Array<Effect.Effect<void, PlatformError.PlatformError>> = []
          for (const handle of handles) {
            rerefs.push(yield* handle.unref)
          }
          return Effect.forEach([...rerefs].reverse(), (reref) => reref, { discard: true })
        })

        return makeHandle({
          pid: handle.pid,
          exitCode: handle.exitCode,
          isRunning: handle.isRunning,
          kill,
          stdin: handles[0].stdin,
          stdout: handle.stdout,
          stderr: handle.stderr,
          all: handle.all,
          getInputFd: handle.getInputFd,
          getOutputFd: handle.getOutputFd,
          unref
        })
      }
    }
  })

  return makeSpawner(spawnCommand)
})

/**
 * Layer that provides the `NodeChildProcessSpawner` implementation.
 *
 * @stability unstable
 * @category layers
 * @since 4.0.0
 */
export const layer: Layer.Layer<
  ChildProcessSpawner,
  never,
  FileSystem.FileSystem | Path.Path
> = Layer.effect(ChildProcessSpawner, makeWith(Effect.succeed(spawnDirect)))

/**
 * Service that reports the proxy process started by {@link layerProxyProcess}.
 *
 * **Details**
 *
 * `currentPid` is the process ID of the proxy process that new spawns go to,
 * which is the parent process ID of the commands it launches. It is `None`
 * from the moment that proxy process is seen to exit, or is replaced after a
 * credential change, until the replacement started by a later spawn is ready.
 * It is also `None` after the layer's scope closes.
 *
 * **Gotchas**
 *
 * - The service does not show which spawner is in context. If a layer
 *   providing another `ChildProcessSpawner`, such as {@link layer}, is merged
 *   over {@link layerProxyProcess}, commands are spawned directly while this
 *   service still reports the proxy process.
 * - Commands of a proxy process that was replaced keep their old parent.
 *
 * @stability unstable
 * @category services
 * @since 4.1.6
 */
export class ProxyProcess extends Context.Service<ProxyProcess, {
  readonly currentPid: Effect.Effect<Option.Option<ProcessId>>
}>()("@effect/platform-node/NodeChildProcessSpawner/ProxyProcess") {}

/**
 * Creates a layer that provides a `ChildProcessSpawner` which launches commands
 * from a small, long-lived proxy process instead of the current process, along
 * with the {@link ProxyProcess} service.
 *
 * **When to use**
 *
 * Use when spawning a command measurably stalls the event loop of a Node.js
 * application on Linux that holds a lot of memory outside the JavaScript heap,
 * such as large `Buffer`s. The stall depends on the Node.js
 * build, so measure a direct spawn with {@link layer} on the deployed build
 * first.
 *
 * **Details**
 *
 * Only the spawn request goes through the proxy process. Piped stdio is
 * connected to the application over Unix domain sockets, and signals are sent
 * to the command directly, so output does not pass through the proxy process.
 *
 * Building the layer starts the proxy process and waits until it is ready.
 * The build fails with a `PlatformError` if it cannot start, does not answer
 * within `responseTimeout` (10 seconds by default), or runs on Windows. Fall
 * back with `Layer.catch(() => NodeChildProcessSpawner.layer)`. The proxy
 * process stops when the layer's scope closes, once its remaining referenced
 * commands have exited. Commands keep running if the application exits, as
 * with {@link layer}.
 *
 * By default the proxy process runs
 * `process.execPath --input-type=module -e <program>` with the
 * application's environment minus `NODE_OPTIONS`. `executable`, `args` and
 * `env` replace these. A custom entry point must call
 * `NodeChildProcessProxy.run`. Commands always receive their own environment.
 *
 * If the proxy process exits, or the application changes its user or group
 * IDs, the next spawn starts a new proxy process and waits until it is ready.
 * Spawns are not queued: each one waits, interruptibly, and its request is
 * created only when it is sent, so a spawn interrupted while waiting never
 * starts its command. A spawn whose proxy process fails to start fails with a
 * `PlatformError`. Its command was not sent, so retrying is safe. After the
 * layer's scope closes, spawns fail without starting a proxy process.
 *
 * A spawn request is sent at most once. If the proxy process exits, or sends
 * nothing within `responseTimeout`, after a request was sent but before it
 * replied, the command may already be running. The proxy process is stopped,
 * the spawn fails with a `PlatformError`, and the request is not sent again.
 *
 * **Gotchas**
 *
 * - A proxy process that does not respond in time is killed, so the exit
 *   status of every command it launched is lost.
 * - A command that started but was never acknowledged cannot be signalled,
 *   since its process ID was never received. Its stdio is closed.
 * - Commands run with the user and group IDs the proxy process started with.
 *   Build the layer after the application has changed its credentials, and
 *   before it has grown large, since starting the proxy process from a large
 *   process stalls once.
 * - If the proxy process exits early, commands it launched keep their stdio,
 *   but `exitCode` and `isRunning` fail with a `PlatformError` because their
 *   exit can no longer be observed. `kill` still sends its first signal,
 *   without escalating, and that signal can reach an unrelated process if the
 *   command has already exited and its ID has been reused. On a
 *   single-command handle `kill` then fails with a `PlatformError`. A
 *   pipeline handle's `kill` ignores the failures of its commands, so it
 *   succeeds. Scope release does not signal these commands, so they keep
 *   running.
 * - Every call creates a separate layer, with its own proxy process. Keep the
 *   result in one constant to share a proxy process.
 * - The socket path under `os.tmpdir()` must fit the platform limit of about
 *   100 bytes.
 *
 * **Example** (Wiring a packaged command-line application)
 *
 * ```ts
 * // bin.ts dispatches `__proxy-process` to `NodeChildProcessProxy.run` before
 * // it imports the application
 * import * as NodeChildProcessSpawner from "@effect/platform-node/NodeChildProcessSpawner"
 * import { Effect, Layer, Option } from "effect"
 * import * as NodeSea from "node:sea"
 *
 * // One constant, so the whole application shares one proxy process
 * export const SpawnerLayer = NodeChildProcessSpawner.layerProxyProcess({
 *   // In a single executable application, process.execPath is the application
 *   args: NodeSea.isSea() ? ["__proxy-process"] : undefined
 * }).pipe(Layer.catch(() => NodeChildProcessSpawner.layer))
 *
 * // The parent process ID of commands spawned from now on
 * export const spawnParentPid = Effect.gen(function*() {
 *   const proxy = yield* Effect.serviceOption(NodeChildProcessSpawner.ProxyProcess)
 *   const pid = Option.isSome(proxy) ? yield* proxy.value.currentPid : Option.none()
 *   return Option.getOrElse(pid, () => process.pid)
 * })
 * ```
 *
 * @stability unstable
 * @category layers
 * @since 4.1.6
 */
export const layerProxyProcess = (options?: {
  readonly executable?: string | undefined
  readonly args?: ReadonlyArray<string> | undefined
  readonly env?: Record<string, string | undefined> | undefined
  readonly responseTimeout?: Duration.Input | undefined
}): Layer.Layer<
  ChildProcessSpawner | ProxyProcess,
  PlatformError.PlatformError,
  FileSystem.FileSystem | Path.Path
> =>
  Layer.effectContext(Effect.gen(function*() {
    if (globalThis.process.platform === "win32") {
      return yield* Effect.fail(PlatformError.systemError({
        _tag: "Unknown",
        module: "ChildProcess",
        method: "layerProxyProcess",
        description: "The proxy process is not supported on Windows"
      }))
    }
    const proxy = yield* Effect.acquireRelease(
      Effect.sync(() =>
        ProxyProcesses.make({
          executable: options?.executable,
          args: options?.args,
          env: options?.env,
          responseTimeoutMillis: Duration.toMillis(options?.responseTimeout ?? "10 seconds")
        })
      ),
      (proxy) => proxy.close
    )
    yield* proxy.ready
    const spawner = yield* makeWith(proxy.prepareSpawn)
    return Context.make(ChildProcessSpawner, spawner).pipe(
      Context.add(ProxyProcess, ProxyProcess.of({ currentPid: proxy.currentPid }))
    )
  }))

// =============================================================================
// Internal Helpers
// =============================================================================

/**
 * Result of flattening a pipeline of commands.
 *
 * @stability unstable
 * @category models
 * @since 4.0.0
 */
export interface FlattenedPipeline {
  readonly commands: Arr.NonEmptyReadonlyArray<ChildProcess.StandardCommand>
  readonly pipeOptions: ReadonlyArray<ChildProcess.PipeOptions>
}

/**
 * Flattens a `Command` into an array of `StandardCommand`s along with pipe
 * options for each connection.
 *
 * @stability unstable
 * @category transforming
 * @since 4.0.0
 */
export const flattenCommand = (
  command: ChildProcess.Command
): FlattenedPipeline => {
  const commands: Array<ChildProcess.StandardCommand> = []
  const pipeOptions: Array<ChildProcess.PipeOptions> = []

  const flatten = (cmd: ChildProcess.Command): void => {
    switch (cmd._tag) {
      case "StandardCommand": {
        commands.push(cmd)
        break
      }
      case "PipedCommand": {
        // Recursively flatten left side first
        flatten(cmd.left)
        // Store the pipe options for this connection
        pipeOptions.push(cmd.options)
        // Then flatten right side
        flatten(cmd.right)
        break
      }
    }
  }

  flatten(command)

  // The commands array is guaranteed to be non-empty since we always have at
  // least one command in the input. We validate this at runtime and return a
  // properly typed tuple.
  if (commands.length === 0) {
    // This should never happen given a valid Command input
    throw new Error("flattenCommand produced empty commands array")
  }

  const [first, ...rest] = commands
  const nonEmptyCommands: Arr.NonEmptyReadonlyArray<ChildProcess.StandardCommand> = [first, ...rest]

  return { commands: nonEmptyCommands, pipeOptions }
}
