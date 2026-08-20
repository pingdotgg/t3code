import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import type * as PlatformError from "effect/PlatformError";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import type * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

/**
 * Kimi CLI executes shell commands through the ACP client's terminal
 * capability (as Zed does): `terminal/create` spawns the command,
 * `terminal/wait_for_exit` blocks until it exits, `terminal/output` reads the
 * captured output, and `terminal/kill`/`terminal/release` stop and dispose it.
 * This manager implements those handlers for one Kimi ACP session.
 *
 * Wire-shape note verified against Kimi CLI 0.37.2: the
 * `terminal/wait_for_exit` response carries `exitCode`/`signal` at the TOP
 * level (`WaitForTerminalExitResponse`). Nesting them under an `exitStatus`
 * key makes Kimi read exit code -1 and mark the tool call failed. Only the
 * `terminal/output` response nests them as `exitStatus`.
 */
export interface KimiAcpTerminalManager {
  readonly handleCreateTerminal: (
    request: EffectAcpSchema.CreateTerminalRequest,
  ) => Effect.Effect<EffectAcpSchema.CreateTerminalResponse, EffectAcpErrors.AcpError>;
  readonly handleTerminalOutput: (
    request: EffectAcpSchema.TerminalOutputRequest,
  ) => Effect.Effect<EffectAcpSchema.TerminalOutputResponse, EffectAcpErrors.AcpError>;
  readonly handleTerminalWaitForExit: (
    request: EffectAcpSchema.WaitForTerminalExitRequest,
  ) => Effect.Effect<EffectAcpSchema.WaitForTerminalExitResponse, EffectAcpErrors.AcpError>;
  readonly handleTerminalKill: (
    request: EffectAcpSchema.KillTerminalRequest,
  ) => Effect.Effect<EffectAcpSchema.KillTerminalResponse, EffectAcpErrors.AcpError>;
  readonly handleTerminalRelease: (
    request: EffectAcpSchema.ReleaseTerminalRequest,
  ) => Effect.Effect<EffectAcpSchema.ReleaseTerminalResponse, EffectAcpErrors.AcpError>;
  /**
   * Kills every live terminal's process and settles its exit with a SIGTERM
   * status, but keeps the terminal registered: per ACP the agent may still
   * call `terminal/output`/`terminal/release` on a killed terminal. Used at
   * turn interrupt to unblock an agent parked in `terminal/wait_for_exit`;
   * `shutdown` remains the full-dispose session-stop path. Idempotent:
   * already-exited or already-killed terminals are no-ops.
   */
  readonly killAll: Effect.Effect<void>;
  /** Kills and disposes every terminal still open; used at session stop. */
  readonly shutdown: Effect.Effect<void>;
}

/** Kimi CLI 0.37.2 sends outputByteLimit 4 MiB; used when a create omits it. */
const DEFAULT_OUTPUT_BYTE_LIMIT = 4 * 1024 * 1024;

interface KimiTerminalExit {
  readonly exitCode: number | null;
  readonly signal: string | null;
}

interface KimiTerminalOutputBuffer {
  output: string;
  outputBytes: number;
  truncated: boolean;
  readonly byteLimit: number;
}

interface KimiTerminalState {
  readonly scope: Scope.Closeable;
  readonly buffer: KimiTerminalOutputBuffer;
  readonly exit: Deferred.Deferred<KimiTerminalExit>;
  readonly drainFibers: ReadonlyArray<Fiber.Fiber<void>>;
  readonly kill: Effect.Effect<void>;
}

function utf8ByteLengthOfCodePoint(codePoint: number): number {
  if (codePoint <= 0x7f) return 1;
  if (codePoint <= 0x7ff) return 2;
  if (codePoint <= 0xffff) return 3;
  return 4;
}

/**
 * Appends decoded output while enforcing the ACP byte limit: when the buffer
 * exceeds it, drop from the beginning at a character boundary and flag the
 * output as truncated, as the protocol requires.
 */
function appendTerminalOutput(buffer: KimiTerminalOutputBuffer, text: string): void {
  if (text.length === 0) {
    return;
  }
  buffer.output += text;
  buffer.outputBytes += Buffer.byteLength(text, "utf8");
  if (buffer.outputBytes <= buffer.byteLimit) {
    return;
  }
  buffer.truncated = true;
  let overBytes = buffer.outputBytes - buffer.byteLimit;
  let dropUnits = 0;
  let droppedBytes = 0;
  while (overBytes > 0 && dropUnits < buffer.output.length) {
    const codePoint = buffer.output.codePointAt(dropUnits) ?? 0;
    const codePointBytes = utf8ByteLengthOfCodePoint(codePoint);
    dropUnits += codePoint > 0xffff ? 2 : 1;
    droppedBytes += codePointBytes;
    overBytes -= codePointBytes;
  }
  buffer.output = buffer.output.slice(dropUnits);
  buffer.outputBytes -= droppedBytes;
}

const KILLED_BY_SIGNAL_PATTERN = /signal: '([A-Z0-9]+)'/;

/**
 * `ChildProcessHandle.exitCode` fails only when the process was terminated by
 * a signal (POSIX; Windows kills surface as a normal exit code). Recover the
 * signal name for the ACP exit status so a killed command reports as killed
 * rather than exit 0. The wire schema requires exitCode >= 0, so the fallback
 * when the signal name cannot be parsed is a generic SIGTERM, never -1.
 */
function exitFromSignalFailure(error: PlatformError.PlatformError): KimiTerminalExit {
  const text = `${error.message} ${String(error.cause ?? "")}`;
  const signal = KILLED_BY_SIGNAL_PATTERN.exec(text)?.[1];
  return { exitCode: null, signal: signal ?? "SIGTERM" };
}

function unknownTerminalError(method: string, terminalId: string): EffectAcpErrors.AcpRequestError {
  return EffectAcpErrors.AcpRequestError.internalError(
    `Unknown or released terminal '${terminalId}'.`,
    undefined,
    { method },
  );
}

export const makeKimiAcpTerminalManager = (input: {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
}): Effect.Effect<KimiAcpTerminalManager> =>
  Effect.sync(() => {
    const terminals = new Map<string, KimiTerminalState>();
    let nextTerminalId = 0;

    const requireTerminal = (
      method: string,
      terminalId: string,
    ): Effect.Effect<KimiTerminalState, EffectAcpErrors.AcpRequestError> => {
      const state = terminals.get(terminalId);
      return state ? Effect.succeed(state) : Effect.fail(unknownTerminalError(method, terminalId));
    };

    const disposeTerminal = (terminalId: string, state: KimiTerminalState): Effect.Effect<void> =>
      Effect.gen(function* () {
        terminals.delete(terminalId);
        // Closing the terminal scope interrupts the drain fibers and runs the
        // spawner finalizer, which kills the process (group) if it is still
        // running and waits for it to exit.
        yield* Effect.ignore(Scope.close(state.scope, Exit.void));
        // The scope close may have interrupted the exit watcher before it
        // resolved; settle the deferred so an in-flight wait_for_exit cannot
        // hang. Release kills the process, so a signal exit is honest. A
        // no-op when the process exit already resolved it.
        yield* Deferred.succeed(state.exit, { exitCode: null, signal: "SIGTERM" });
      });

    const handleCreateTerminal: KimiAcpTerminalManager["handleCreateTerminal"] = (request) =>
      Effect.gen(function* () {
        const terminalId = `term-${++nextTerminalId}`;
        const scope = yield* Scope.make();
        const env = request.env
          ? Object.fromEntries(request.env.map((entry) => [entry.name, entry.value]))
          : undefined;
        // Kimi sends an absolute command path (its Git Bash wrapper on
        // Windows), so no shell resolution is involved.
        const handle = yield* input.childProcessSpawner
          .spawn(
            ChildProcess.make(request.command, request.args ?? [], {
              ...(request.cwd ? { cwd: request.cwd } : {}),
              ...(env ? { env, extendEnv: true } : {}),
              stdin: "ignore",
              // Kill escalation for release/shutdown of commands that ignore
              // the default termination signal.
              forceKillAfter: "5 seconds",
            }),
          )
          .pipe(
            Effect.provideService(Scope.Scope, scope),
            Effect.onError(() => Effect.ignore(Scope.close(scope, Exit.void))),
            Effect.mapError((cause) =>
              EffectAcpErrors.AcpRequestError.internalError(
                `Failed to spawn terminal command '${request.command}'.`,
                undefined,
                { method: "terminal/create", cause },
              ),
            ),
          );

        const buffer: KimiTerminalOutputBuffer = {
          output: "",
          outputBytes: 0,
          truncated: false,
          byteLimit: Math.max(0, request.outputByteLimit ?? DEFAULT_OUTPUT_BYTE_LIMIT),
        };
        const exit = yield* Deferred.make<KimiTerminalExit>();

        // One streaming decoder per stream so interleaving cannot split a
        // multi-byte character across decode calls.
        const drainStream = (stream: typeof handle.stdout): Effect.Effect<void> =>
          Effect.suspend(() => {
            const decoder = new TextDecoder("utf-8");
            return Stream.runForEach(stream, (chunk) =>
              Effect.sync(() =>
                appendTerminalOutput(buffer, decoder.decode(chunk, { stream: true })),
              ),
            ).pipe(
              Effect.ensuring(Effect.sync(() => appendTerminalOutput(buffer, decoder.decode()))),
              Effect.ignore,
            );
          });

        const stdoutFiber = yield* drainStream(handle.stdout).pipe(Effect.forkIn(scope));
        const stderrFiber = yield* drainStream(handle.stderr).pipe(Effect.forkIn(scope));
        yield* handle.exitCode.pipe(
          Effect.matchEffect({
            onSuccess: (exitCode) => Deferred.succeed(exit, { exitCode, signal: null }),
            onFailure: (error) => Deferred.succeed(exit, exitFromSignalFailure(error)),
          }),
          Effect.forkIn(scope),
        );

        terminals.set(terminalId, {
          scope,
          buffer,
          exit,
          drainFibers: [stdoutFiber, stderrFiber],
          kill: Effect.ignore(handle.kill()),
        });
        return { terminalId } satisfies EffectAcpSchema.CreateTerminalResponse;
      });

    const handleTerminalOutput: KimiAcpTerminalManager["handleTerminalOutput"] = (request) =>
      Effect.gen(function* () {
        const state = yield* requireTerminal("terminal/output", request.terminalId);
        const exited = yield* Deferred.isDone(state.exit);
        if (!exited) {
          return {
            output: state.buffer.output,
            truncated: state.buffer.truncated,
          } satisfies EffectAcpSchema.TerminalOutputResponse;
        }
        // The process exited; wait for the drain fibers to flush the final
        // chunks (deterministic: the pipes close at exit) so the reported
        // output is complete.
        yield* Effect.forEach(state.drainFibers, (fiber) => Effect.ignore(Fiber.join(fiber)), {
          discard: true,
        });
        const exitStatus = yield* Deferred.await(state.exit);
        return {
          output: state.buffer.output,
          truncated: state.buffer.truncated,
          exitStatus,
        } satisfies EffectAcpSchema.TerminalOutputResponse;
      });

    const handleTerminalWaitForExit: KimiAcpTerminalManager["handleTerminalWaitForExit"] = (
      request,
    ) =>
      Effect.gen(function* () {
        const state = yield* requireTerminal("terminal/wait_for_exit", request.terminalId);
        const exit = yield* Deferred.await(state.exit);
        // Top-level exitCode/signal, never nested under exitStatus: Kimi reads
        // a nested shape as exit code -1 and fails the tool call.
        return {
          ...(exit.exitCode !== null ? { exitCode: exit.exitCode } : {}),
          ...(exit.signal !== null ? { signal: exit.signal } : {}),
        } satisfies EffectAcpSchema.WaitForTerminalExitResponse;
      });

    const handleTerminalKill: KimiAcpTerminalManager["handleTerminalKill"] = (request) =>
      Effect.gen(function* () {
        const state = yield* requireTerminal("terminal/kill", request.terminalId);
        // Idempotent: killing an already-exited process is not an error.
        yield* state.kill;
        return {} satisfies EffectAcpSchema.KillTerminalResponse;
      });

    const handleTerminalRelease: KimiAcpTerminalManager["handleTerminalRelease"] = (request) =>
      Effect.gen(function* () {
        const state = yield* requireTerminal("terminal/release", request.terminalId);
        yield* disposeTerminal(request.terminalId, state);
        return {} satisfies EffectAcpSchema.ReleaseTerminalResponse;
      });

    const killAll: Effect.Effect<void> = Effect.suspend(() =>
      Effect.forEach(
        Array.from(terminals.values()),
        (state) =>
          // Settle the exit first so a concurrent wait_for_exit observes the
          // SIGTERM status deterministically; Deferred.succeed is a no-op when
          // the process already exited. The kill then stops the process (a
          // no-op for an already-dead one) while the entry stays readable.
          Effect.gen(function* () {
            yield* Deferred.succeed(state.exit, { exitCode: null, signal: "SIGTERM" });
            yield* state.kill;
          }),
        { discard: true },
      ),
    );

    const shutdown: Effect.Effect<void> = Effect.suspend(() =>
      Effect.forEach(
        Array.from(terminals.entries()),
        ([terminalId, state]) => disposeTerminal(terminalId, state),
        { discard: true },
      ),
    );

    return {
      handleCreateTerminal,
      handleTerminalOutput,
      handleTerminalWaitForExit,
      handleTerminalKill,
      handleTerminalRelease,
      killAll,
      shutdown,
    } satisfies KimiAcpTerminalManager;
  });
