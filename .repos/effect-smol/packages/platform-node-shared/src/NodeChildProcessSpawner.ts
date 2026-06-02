/**
 * Shared Node.js implementation of the child process spawner service.
 *
 * This module adapts `node:child_process.spawn` to the Effect
 * `ChildProcessSpawner` service. Provide {@link layer} to run `ChildProcess`
 * commands in Node-compatible runtimes: commands get scoped process handles
 * with stdin sinks, stdout and stderr streams, exit-code waiting,
 * interruption-time cleanup, process killing, and custom file-descriptor pipes.
 *
 * The implementation sits below the command-building API. It validates and
 * resolves `cwd` through the Effect `FileSystem` and `Path` services,
 * translates Node errno failures to `PlatformError`, and uses scopes to
 * terminate referenced children when the owning effect is interrupted or
 * finalized. Pipelines are flattened by {@link flattenCommand} and spawned one
 * process at a time, wiring the selected source stream (`stdout`, `stderr`,
 * `all`, or `fdN`) to the destination `stdin` or `fdN`.
 *
 * @since 4.0.0
 */
import type * as Arr from "effect/Array"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Path from "effect/Path"
import type * as PlatformError from "effect/PlatformError"
import * as Predicate from "effect/Predicate"
import type * as Scope from "effect/Scope"
import * as Sink from "effect/Sink"
import * as Stream from "effect/Stream"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import type { ChildProcessHandle } from "effect/unstable/process/ChildProcessSpawner"
import {
  ChildProcessSpawner,
  ExitCode,
  make as makeSpawner,
  makeHandle,
  ProcessId
} from "effect/unstable/process/ChildProcessSpawner"
import * as NodeChildProcess from "node:child_process"
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
  const commandStr = commands.reduce((acc, curr) => {
    const cmd = `${curr.command} ${curr.args.join(" ")}`
    return acc.length === 0 ? cmd : `${acc} | ${cmd}`
  }, "")
  return handleErrnoException("ChildProcess", method)(error, [commandStr])
}

type ExitCodeWithSignal = readonly [code: number | null, signal: NodeJS.Signals | null]
type ExitSignal = Deferred.Deferred<ExitCodeWithSignal>

const make = Effect.gen(function*() {
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
    return options.extendEnv
      ? { ...globalThis.process.env, ...options.env }
      : options.env
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

  const setupAdditionalFds = Effect.fnUntraced(function*(
    command: ChildProcess.StandardCommand,
    childProcess: NodeChildProcess.ChildProcess,
    additionalFds: ReadonlyArray<ResolvedAdditionalFd>
  ) {
    if (additionalFds.length === 0) {
      return {
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty
      }
    }

    const inputSinks = new Map<number, Sink.Sink<void, Uint8Array, never, PlatformError.PlatformError>>()
    const outputStreams = new Map<number, Stream.Stream<Uint8Array, PlatformError.PlatformError>>()

    for (const { config, fd } of additionalFds) {
      const nodeStream = childProcess.stdio[fd]

      switch (config.type) {
        case "input": {
          // Create a sink to write to for input file descriptors
          let sink: Sink.Sink<void, Uint8Array, never, PlatformError.PlatformError> = Sink.drain
          if (nodeStream && "write" in nodeStream) {
            sink = NodeSink.fromWritable({
              evaluate: () => nodeStream,
              onError: (error) => toPlatformError(`fromWritable(fd${fd})`, toError(error), command)
            })
          }

          // If user provided a stream, pipe it into the sink
          if (config.stream) {
            yield* Effect.forkScoped(Stream.run(config.stream, sink))
          }

          inputSinks.set(fd, sink)

          break
        }
        case "output": {
          // Create a stream to read from for output file descriptors
          let stream: Stream.Stream<Uint8Array, PlatformError.PlatformError> = Stream.empty
          if (nodeStream && "read" in nodeStream) {
            stream = NodeStream.fromReadable({
              evaluate: () => nodeStream,
              onError: (error) => toPlatformError(`fromReadable(fd${fd})`, toError(error), command)
            })
          }

          // If user provided a sink, transduce the stream through it
          if (config.sink) {
            stream = Stream.transduce(stream, config.sink)
          }

          outputStreams.set(fd, stream)

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
    childProcess: NodeChildProcess.ChildProcess,
    config: ChildProcess.StdinConfig
  ) =>
    Effect.suspend(() => {
      // If the child process has a standard input stream, connect it to the
      // sink that will attached to the process handle
      let sink: Sink.Sink<void, unknown, never, PlatformError.PlatformError> = Sink.drain
      if (Predicate.isNotNull(childProcess.stdin)) {
        sink = NodeSink.fromWritable({
          evaluate: () => childProcess.stdin!,
          onError: (error) => toPlatformError("fromWritable(stdin)", toError(error), command),
          endOnDone: config.endOnDone,
          encoding: config.encoding
        })
      }

      // If the user provided a `Stream`, run it into the stdin sink
      if (Stream.isStream(config.stream)) {
        return Effect.as(Effect.forkScoped(Stream.run(config.stream, sink)), sink)
      }

      return Effect.succeed(sink)
    })

  const setupChildOutputStreams = (
    command: ChildProcess.StandardCommand,
    childProcess: NodeChildProcess.ChildProcess,
    stdoutConfig: ChildProcess.StdoutConfig,
    stderrConfig: ChildProcess.StderrConfig
  ): {
    stdout: Stream.Stream<Uint8Array, PlatformError.PlatformError>
    stderr: Stream.Stream<Uint8Array, PlatformError.PlatformError>
    all: Stream.Stream<Uint8Array, PlatformError.PlatformError>
  } => {
    let stdout = childProcess.stdout ?
      NodeStream.fromReadable({
        evaluate: () => childProcess.stdout!,
        onError: (error) => toPlatformError("fromReadable(stdout)", toError(error), command)
      }) :
      Stream.empty
    let stderr = childProcess.stderr ?
      NodeStream.fromReadable({
        evaluate: () => childProcess.stderr!,
        onError: (error) => toPlatformError("fromReadable(stderr)", toError(error), command)
      }) :
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
    command: ChildProcess.StandardCommand,
    spawnOptions: NodeChildProcess.SpawnOptions
  ) =>
    Effect.callback<
      readonly [NodeChildProcess.ChildProcess, ExitSignal],
      PlatformError.PlatformError
    >((resume) => {
      const deferred = Deferred.makeUnsafe<ExitCodeWithSignal>()
      const handle = NodeChildProcess.spawn(
        command.command,
        command.args,
        spawnOptions
      )
      handle.on("error", (error) => {
        resume(Effect.fail(toPlatformError("spawn", error, command)))
      })
      handle.on("exit", (...args) => {
        Deferred.doneUnsafe(deferred, Exit.succeed(args))
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
    childProcess: NodeChildProcess.ChildProcess,
    signal: NodeJS.Signals
  ) => {
    if (globalThis.process.platform === "win32") {
      return Effect.callback<void, PlatformError.PlatformError>((resume) => {
        NodeChildProcess.exec(`taskkill /pid ${childProcess.pid} /T /F`, (error) => {
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
    childProcess: NodeChildProcess.ChildProcess,
    signal: NodeJS.Signals
  ): void => {
    if (globalThis.process.platform === "win32") {
      NodeChildProcess.exec(`taskkill /pid ${childProcess.pid} /T /F`, () => {
        // ignore errors during best-effort cleanup
      })
      return
    }
    try {
      globalThis.process.kill(-childProcess.pid!, signal)
    } catch {
      // ignore errors during best-effort cleanup
    }
  }

  const killProcess = (
    command: ChildProcess.StandardCommand,
    childProcess: NodeChildProcess.ChildProcess,
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

  const withTimeout = (
    childProcess: NodeChildProcess.ChildProcess,
    command: ChildProcess.StandardCommand,
    options: ChildProcess.KillOptions | undefined
  ) =>
  <A, E, R>(
    kill: (
      command: ChildProcess.StandardCommand,
      childProcess: NodeChildProcess.ChildProcess,
      signal: NodeJS.Signals
    ) => Effect.Effect<A, E, R>
  ) => {
    const killSignal = options?.killSignal ?? "SIGTERM"
    return Predicate.isUndefined(options?.forceKillAfter)
      ? kill(command, childProcess, killSignal)
      : Effect.timeoutOrElse(kill(command, childProcess, killSignal), {
        duration: options.forceKillAfter,
        orElse: () => kill(command, childProcess, "SIGKILL")
      })
  }

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
        const stdinConfig = resolveStdinOption(cmd.options)
        const stdoutConfig = resolveOutputOption(cmd.options, "stdout")
        const stderrConfig = resolveOutputOption(cmd.options, "stderr")
        const resolvedAdditionalFds = resolveAdditionalFds(cmd.options)
        let isReferenced = true
        let cleanupOnNonZeroExit = false

        const cwd = yield* resolveWorkingDirectory(cmd.options)
        const env = resolveEnvironment(cmd.options)
        const stdio = buildStdioArray(stdinConfig, stdoutConfig, stderrConfig, resolvedAdditionalFds)

        const [childProcess, exitSignal] = yield* Effect.acquireRelease(
          spawn(cmd, {
            cwd,
            env,
            stdio,
            detached: cmd.options.detached ?? process.platform !== "win32",
            shell: cmd.options.shell
          }),
          Effect.fnUntraced(function*([childProcess, exitSignal]) {
            const exited = yield* Deferred.isDone(exitSignal)
            const killWithTimeout = withTimeout(childProcess, cmd, cmd.options)
            if (exited) {
              // Process already exited, check if children need cleanup
              const [code] = yield* Deferred.await(exitSignal)
              if (code !== 0 && Predicate.isNotNull(code)) {
                // Non-zero exit code ,attempt to clean up process group
                return yield* Effect.ignore(killWithTimeout(killProcessGroup))
              }
              return yield* Effect.void
            }
            if (!isReferenced) {
              return yield* Effect.void
            }
            // Process is still running, kill it
            return yield* killWithTimeout((command, childProcess, signal) =>
              Effect.catch(
                killProcessGroup(command, childProcess, signal),
                () => killProcess(command, childProcess, signal)
              )
            ).pipe(
              Effect.andThen(Deferred.await(exitSignal)),
              Effect.ignore
            )
          })
        )

        const pid = ProcessId(childProcess.pid!)
        childProcess.on("exit", (code) => {
          if (cleanupOnNonZeroExit && code !== 0 && Predicate.isNotNull(code)) {
            killProcessGroupOnExit(childProcess, cmd.options.killSignal ?? "SIGTERM")
          }
        })
        const reref = Effect.sync(() => {
          if (!isReferenced) {
            childProcess.ref()
            isReferenced = true
            cleanupOnNonZeroExit = false
          }
        })
        const unref = Effect.sync(() => {
          if (isReferenced) {
            childProcess.unref()
            isReferenced = false
            cleanupOnNonZeroExit = true
          }
          return reref
        })
        const stdin = yield* setupChildStdin(cmd, childProcess, stdinConfig)
        const { all, stderr, stdout } = setupChildOutputStreams(cmd, childProcess, stdoutConfig, stderrConfig)
        const { getInputFd, getOutputFd } = yield* setupAdditionalFds(cmd, childProcess, resolvedAdditionalFds)
        const isRunning = Effect.map(Deferred.isDone(exitSignal), (done) => !done)
        const exitCode = Effect.flatMap(Deferred.await(exitSignal), ([code, signal]) => {
          if (Predicate.isNotNull(code)) {
            return Effect.succeed(ExitCode(code))
          }
          // If code is `null`, then `signal` must be defined. See the NodeJS
          // documentation for the `"exit"` event on a `child_process`.
          // https://nodejs.org/api/child_process.html#child_process_event_exit
          const error = new globalThis.Error(`Process interrupted due to receipt of signal: '${signal}'`)
          return Effect.fail(toPlatformError("exitCode", error, cmd))
        })
        const kill = (options?: ChildProcess.KillOptions | undefined) => {
          const killWithTimeout = withTimeout(childProcess, cmd, options)
          return killWithTimeout((command, childProcess, signal) =>
            Effect.catch(
              killProcessGroup(command, childProcess, signal),
              () => killProcess(command, childProcess, signal)
            )
          ).pipe(
            Effect.andThen(Deferred.await(exitSignal)),
            Effect.asVoid
          )
        }

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
              handles.push(
                yield* spawnCommand(ChildProcess.make(command.command, command.args, {
                  ...command.options,
                  additionalFds: {
                    ...existingFds,
                    [fdName]: { type: "input" as const, stream: sourceStream }
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
          kill: handle.kill,
          stdin: handle.stdin,
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
 * @category layers
 * @since 4.0.0
 */
export const layer: Layer.Layer<
  ChildProcessSpawner,
  never,
  FileSystem.FileSystem | Path.Path
> = Layer.effect(ChildProcessSpawner, make)

// =============================================================================
// Internal Helpers
// =============================================================================

/**
 * Result of flattening a pipeline of commands.
 *
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
 * @category utils
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
