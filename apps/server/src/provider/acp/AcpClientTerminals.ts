import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/compat";
import * as NodeBuffer from "node:buffer";

/**
 * Client-side implementation of the ACP `terminal` capability.
 *
 * Agents create terminals to run commands through the client
 * (`terminal/create`), poll buffered output, await exit, kill, and release
 * them. Terminals also appear as embedded tool-call content, which
 * {@link resolveEmbeddedTerminalContent} rewrites into plain text so the
 * existing tool-call projection renders live command output.
 */

const MAX_LIVE_TERMINALS = 16;
const MAX_UNRELEASED_TERMINALS = 64;
const MAX_RETAINED_TERMINALS = 32;
const MAX_RETAINED_OUTPUT_BYTES = 16 * 1024 * 1024;
const DEFAULT_OUTPUT_BYTE_LIMIT = 4 * 1024 * 1024;
const MAX_OUTPUT_BYTE_LIMIT = 8 * 1024 * 1024;

const terminalRequestError = (message: string, cause?: unknown) =>
  EffectAcpErrors.AcpRequestError.internalError(
    message,
    undefined,
    cause === undefined ? {} : { cause },
  );

interface OutputBufferState {
  chunks: Array<Uint8Array>;
  bytes: number;
  truncated: boolean;
  readonly limit: number;
}

function trimOutputStart(state: OutputBufferState, bytes: number): void {
  let remaining = Math.min(bytes, state.bytes);
  while (remaining > 0) {
    const head = state.chunks[0]!;
    if (head.byteLength <= remaining) {
      state.chunks.shift();
      state.bytes -= head.byteLength;
      remaining -= head.byteLength;
    } else {
      state.chunks[0] = head.subarray(remaining);
      state.bytes -= remaining;
      remaining = 0;
    }
    state.truncated = true;
  }
}

function appendOutput(state: OutputBufferState, chunk: Uint8Array): void {
  state.chunks.push(chunk);
  state.bytes += chunk.byteLength;
  // The spec requires truncation from the beginning of the output.
  if (state.bytes > state.limit) trimOutputStart(state, state.bytes - state.limit);
}

function readOutput(state: OutputBufferState): string {
  let combined: Uint8Array = NodeBuffer.Buffer.concat(state.chunks, state.bytes);
  if (state.truncated) {
    // Drop leading UTF-8 continuation bytes so truncation lands on a
    // character boundary, as the spec requires.
    let start = 0;
    while (start < combined.byteLength && (combined[start]! & 0b1100_0000) === 0b1000_0000) {
      start += 1;
    }
    combined = combined.subarray(start);
  }
  return NodeBuffer.Buffer.from(combined).toString("utf8");
}

function terminalExitSignal(error: unknown): string | null {
  const cause = error instanceof Error ? error.cause : undefined;
  const message =
    cause instanceof Error ? cause.message : error instanceof Error ? error.message : "";
  return message.match(/signal: '([^']+)'/u)?.[1] ?? null;
}

export interface AcpTerminalOutputSnapshot {
  readonly output: string;
  readonly truncated: boolean;
  readonly exitStatus: EffectAcpSchema.TerminalExitStatus | undefined;
}

interface ManagedAcpTerminal {
  readonly terminalId: string;
  readonly sessionId: string;
  /** The spawned command with args, kept for MCP-fallback identification. */
  readonly commandLine: string;
  readonly buffer: OutputBufferState;
  readonly exit: Deferred.Deferred<EffectAcpSchema.WaitForTerminalExitResponse>;
  readonly kill: Effect.Effect<void>;
  /** Closes the terminal's scope, killing the process if still running. */
  readonly dispose: Effect.Effect<void>;
  exitStatus: EffectAcpSchema.TerminalExitStatus | undefined;
  released: boolean;
}

export interface AcpClientTerminals {
  readonly create: (
    request: EffectAcpSchema.CreateTerminalRequest,
  ) => Effect.Effect<EffectAcpSchema.CreateTerminalResponse, EffectAcpErrors.AcpRequestError>;
  readonly output: (
    request: EffectAcpSchema.TerminalOutputRequest,
  ) => Effect.Effect<EffectAcpSchema.TerminalOutputResponse, EffectAcpErrors.AcpRequestError>;
  readonly waitForExit: (
    request: EffectAcpSchema.WaitForTerminalExitRequest,
  ) => Effect.Effect<EffectAcpSchema.WaitForTerminalExitResponse, EffectAcpErrors.AcpRequestError>;
  readonly kill: (
    request: EffectAcpSchema.KillTerminalRequest,
  ) => Effect.Effect<EffectAcpSchema.KillTerminalResponse, EffectAcpErrors.AcpRequestError>;
  readonly release: (
    request: EffectAcpSchema.ReleaseTerminalRequest,
  ) => Effect.Effect<EffectAcpSchema.ReleaseTerminalResponse, EffectAcpErrors.AcpRequestError>;
  /** Buffered output for embedded tool-call content; survives release. */
  readonly readOutputSnapshot: (
    sessionId: string,
    terminalId: string,
  ) => AcpTerminalOutputSnapshot | undefined;
  /** Command line a terminal was created with; presentation-only lookup. */
  readonly readCommandLine: (terminalId: string) => string | undefined;
  /** Kills every terminal that is still running. Safe to call repeatedly. */
  readonly disposeAll: Effect.Effect<void>;
}

export interface AcpClientTerminalsOptions {
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly defaultCwd: string;
  readonly environment?: NodeJS.ProcessEnv | undefined;
  readonly environmentForSession?:
    | ((sessionId: string) => NodeJS.ProcessEnv | undefined)
    | undefined;
  readonly forceKillAfter?: Duration.Input | undefined;
}

export function acpTerminalCommand(input: {
  readonly request: EffectAcpSchema.CreateTerminalRequest;
  readonly defaultCwd: string;
  readonly environment?: NodeJS.ProcessEnv | undefined;
  readonly forceKillAfter?: Duration.Input | undefined;
}) {
  return ChildProcess.make(input.request.command, input.request.args ?? [], {
    cwd: input.request.cwd ?? input.defaultCwd,
    ...(input.environment === undefined ? {} : { env: input.environment }),
    shell: false,
    forceKillAfter: input.forceKillAfter ?? "5 seconds",
  });
}

export const makeAcpClientTerminals = (
  options: AcpClientTerminalsOptions,
): Effect.Effect<AcpClientTerminals> =>
  Effect.gen(function* () {
    const creationPermit = yield* Semaphore.make(1);
    const terminals = new Map<string, ManagedAcpTerminal>();
    let nextTerminalNumber = 1;

    const enforceTotalOutputLimit = (): void => {
      let excess =
        Array.from(terminals.values()).reduce(
          (total, terminal) => total + terminal.buffer.bytes,
          0,
        ) - MAX_RETAINED_OUTPUT_BYTES;
      if (excess <= 0) return;
      for (const terminal of terminals.values()) {
        const before = terminal.buffer.bytes;
        trimOutputStart(terminal.buffer, excess);
        excess -= before - terminal.buffer.bytes;
        if (excess <= 0) return;
      }
    };

    const pruneReleasedSnapshots = (): void => {
      const released = Array.from(terminals.values()).filter((terminal) => terminal.released);
      let retainedBytes = released.reduce((total, terminal) => total + terminal.buffer.bytes, 0);
      while (
        released.length > MAX_RETAINED_TERMINALS ||
        retainedBytes > MAX_RETAINED_OUTPUT_BYTES
      ) {
        const terminal = released.shift();
        if (terminal === undefined) break;
        retainedBytes -= terminal.buffer.bytes;
        terminals.delete(terminal.terminalId);
      }
    };

    const requireTerminal = (
      sessionId: string,
      terminalId: string,
      operation: string,
    ): Effect.Effect<ManagedAcpTerminal, EffectAcpErrors.AcpRequestError> => {
      const terminal = terminals.get(terminalId);
      if (terminal === undefined || terminal.sessionId !== sessionId || terminal.released) {
        return Effect.fail(
          terminalRequestError(`ACP ${operation} received an unknown terminal ID '${terminalId}'.`),
        );
      }
      return Effect.succeed(terminal);
    };

    const create: AcpClientTerminals["create"] = (request) =>
      creationPermit.withPermit(
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const liveCount = Array.from(terminals.values()).filter(
              (terminal) => !terminal.released && terminal.exitStatus === undefined,
            ).length;
            const unreleasedCount = Array.from(terminals.values()).filter(
              (terminal) => !terminal.released,
            ).length;
            if (unreleasedCount >= MAX_UNRELEASED_TERMINALS) {
              return yield* terminalRequestError(
                `ACP terminal/create exceeded the limit of ${MAX_UNRELEASED_TERMINALS} unreleased terminals.`,
              );
            }
            if (liveCount >= MAX_LIVE_TERMINALS) {
              return yield* terminalRequestError(
                `ACP terminal/create exceeded the limit of ${MAX_LIVE_TERMINALS} concurrent terminals.`,
              );
            }
            const requestEnvironment = Object.fromEntries(
              (request.env ?? []).map((variable) => [variable.name, variable.value] as const),
            );
            const sessionEnvironment = options.environmentForSession?.(request.sessionId);
            const environment =
              options.environment === undefined &&
              sessionEnvironment === undefined &&
              (request.env?.length ?? 0) === 0
                ? undefined
                : { ...options.environment, ...sessionEnvironment, ...requestEnvironment };
            // Each terminal owns a scope so the spawned process is reliably reaped:
            // closing the scope kills a still-running command and frees the handle.
            const terminalScope = yield* Scope.make();
            const child = yield* restore(
              options.spawner
                .spawn(
                  acpTerminalCommand({
                    request,
                    defaultCwd: options.defaultCwd,
                    environment,
                    forceKillAfter: options.forceKillAfter,
                  }),
                )
                .pipe(
                  Effect.provideService(Scope.Scope, terminalScope),
                  Effect.mapError((cause) =>
                    terminalRequestError(
                      `Could not start terminal command '${request.command}'.`,
                      cause,
                    ),
                  ),
                ),
            ).pipe(
              Effect.onExit((exit) =>
                Exit.isFailure(exit) ? Scope.close(terminalScope, Exit.void) : Effect.void,
              ),
            );

            const terminalId = `t3-term-${nextTerminalNumber}`;
            nextTerminalNumber += 1;
            const record: ManagedAcpTerminal = {
              terminalId,
              sessionId: request.sessionId,
              commandLine: [request.command, ...(request.args ?? [])].join(" "),
              buffer: {
                chunks: [],
                bytes: 0,
                truncated: false,
                limit: Math.min(
                  request.outputByteLimit ?? DEFAULT_OUTPUT_BYTE_LIMIT,
                  MAX_OUTPUT_BYTE_LIMIT,
                ),
              },
              exit: yield* Deferred.make<EffectAcpSchema.WaitForTerminalExitResponse>(),
              kill: child.kill().pipe(Effect.ignore),
              dispose: Scope.close(terminalScope, Exit.void).pipe(Effect.ignore),
              exitStatus: undefined,
              released: false,
            };
            terminals.set(terminalId, record);

            const pump = (stream: typeof child.stdout) =>
              stream.pipe(
                Stream.runForEach((chunk) =>
                  Effect.sync(() => {
                    appendOutput(record.buffer, chunk);
                    enforceTotalOutputLimit();
                  }),
                ),
                Effect.ignore,
              );
            const stdoutPump = yield* Effect.forkDetach(pump(child.stdout));
            const stderrPump = yield* Effect.forkDetach(pump(child.stderr));
            yield* Effect.forkDetach(
              child.exitCode.pipe(
                Effect.match({
                  onFailure: (error) => ({ exitCode: null, signal: terminalExitSignal(error) }),
                  onSuccess: (code) => ({ exitCode: Number(code), signal: null }),
                }),
                Effect.flatMap((status) =>
                  Effect.all([Fiber.join(stdoutPump), Fiber.join(stderrPump)], {
                    discard: true,
                  }).pipe(
                    Effect.andThen(
                      Effect.sync(() => {
                        record.exitStatus = status;
                      }),
                    ),
                    Effect.andThen(Deferred.succeed(record.exit, status)),
                  ),
                ),
              ),
            );
            return { terminalId };
          }),
        ),
      );

    const output: AcpClientTerminals["output"] = (request) =>
      requireTerminal(request.sessionId, request.terminalId, "terminal/output").pipe(
        Effect.map((terminal) => ({
          output: readOutput(terminal.buffer),
          truncated: terminal.buffer.truncated,
          ...(terminal.exitStatus === undefined ? {} : { exitStatus: terminal.exitStatus }),
        })),
      );

    const waitForExit: AcpClientTerminals["waitForExit"] = (request) =>
      requireTerminal(request.sessionId, request.terminalId, "terminal/wait_for_exit").pipe(
        Effect.flatMap((terminal) => Deferred.await(terminal.exit)),
      );

    const kill: AcpClientTerminals["kill"] = (request) =>
      requireTerminal(request.sessionId, request.terminalId, "terminal/kill").pipe(
        Effect.flatMap((terminal) => terminal.kill),
        Effect.as({}),
      );

    const release: AcpClientTerminals["release"] = (request) =>
      Effect.uninterruptible(
        requireTerminal(request.sessionId, request.terminalId, "terminal/release").pipe(
          Effect.flatMap((terminal) =>
            Effect.sync(() => {
              terminal.released = true;
            }).pipe(
              Effect.andThen(terminal.dispose),
              Effect.andThen(Deferred.await(terminal.exit)),
              Effect.andThen(Effect.sync(pruneReleasedSnapshots)),
            ),
          ),
          Effect.as({}),
        ),
      );

    const readOutputSnapshot: AcpClientTerminals["readOutputSnapshot"] = (
      sessionId,
      terminalId,
    ) => {
      const terminal = terminals.get(terminalId);
      if (terminal === undefined || terminal.sessionId !== sessionId) return undefined;
      return {
        output: readOutput(terminal.buffer),
        truncated: terminal.buffer.truncated,
        exitStatus: terminal.exitStatus,
      };
    };

    const readCommandLine: AcpClientTerminals["readCommandLine"] = (terminalId) =>
      terminals.get(terminalId)?.commandLine;

    const disposeAll: AcpClientTerminals["disposeAll"] = Effect.uninterruptible(
      Effect.suspend(() =>
        Effect.forEach(
          Array.from(terminals.values()),
          (terminal) =>
            Effect.sync(() => {
              terminal.released = true;
            }).pipe(
              Effect.andThen(terminal.dispose),
              Effect.andThen(Deferred.await(terminal.exit)),
            ),
          { concurrency: "unbounded", discard: true },
        ).pipe(Effect.andThen(Effect.sync(pruneReleasedSnapshots))),
      ),
    );

    // Terminal failures surface to the agent as JSON-RPC errors and to the
    // user only as a failed tool item, so log them for server-side diagnosis.
    const logged =
      <Request, Response>(
        operation: string,
        handler: (request: Request) => Effect.Effect<Response, EffectAcpErrors.AcpRequestError>,
      ) =>
      (request: Request) =>
        handler(request).pipe(
          Effect.tapError((error) =>
            Effect.logWarning("ACP client terminal operation failed", {
              operation,
              detail: error.message,
            }),
          ),
        );

    return {
      create: logged("terminal/create", create),
      output: logged("terminal/output", output),
      waitForExit: logged("terminal/wait_for_exit", waitForExit),
      kill: logged("terminal/kill", kill),
      release: logged("terminal/release", release),
      readOutputSnapshot,
      readCommandLine,
      disposeAll,
    };
  });

/**
 * Rewrites embedded `terminal` tool-call content into plain text content so
 * the provider-neutral tool-call projection can display live command output.
 */
export function resolveEmbeddedTerminalContent(
  notification: EffectAcpSchema.SessionNotification,
  readOutputSnapshot: AcpClientTerminals["readOutputSnapshot"],
): EffectAcpSchema.SessionNotification {
  const update = notification.update;
  if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") {
    return notification;
  }
  const content = update.content;
  if (!content || !content.some((entry) => entry.type === "terminal")) {
    return notification;
  }
  const mapped = content.map((entry): EffectAcpSchema.ToolCallContent => {
    if (entry.type !== "terminal") return entry;
    const snapshot = readOutputSnapshot(notification.sessionId, entry.terminalId);
    return {
      type: "content",
      content: {
        type: "text",
        text: snapshot === undefined ? `[terminal ${entry.terminalId}]` : snapshot.output,
      },
    };
  });
  return { ...notification, update: { ...update, content: mapped } };
}
