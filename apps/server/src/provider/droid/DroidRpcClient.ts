import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import {
  DROID_SERVER_REQUEST_CONCURRENCY,
  DROID_SESSION_REQUEST_TIMEOUT_MS,
  DroidRpcError,
  makeDroidRpcProtocol,
  type DroidNotificationEnvelope,
  type DroidProcessExit,
  type DroidRpcProtocol,
  type DroidServerRequest,
} from "./DroidRpcProtocol.ts";
import { logDroidWarning } from "./DroidDiagnostics.ts";

export { DROID_SERVER_REQUEST_CONCURRENCY, DROID_SESSION_REQUEST_TIMEOUT_MS, DroidRpcError };
export type {
  DroidAskUserServerRequest,
  DroidNotificationEnvelope,
  DroidPermissionServerRequest,
  DroidProcessExit,
  DroidServerRequest,
} from "./DroidRpcProtocol.ts";

const gracefulShutdownTimeout = Duration.seconds(2);
const stdoutExitObservationGrace = Duration.millis(100);
const stdoutDrainAfterProcessExitGrace = Duration.millis(250);

export interface DroidRpcSpawnInput {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
}

export interface DroidExecRpcInput {
  readonly binaryPath: string;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
}

export class DroidRpcSpawnError extends Schema.TaggedErrorClass<DroidRpcSpawnError>()(
  "DroidRpcSpawnError",
  {
    command: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message() {
    return `Failed to spawn Droid process for command: ${this.command}`;
  }
}

export interface DroidRpcClient {
  readonly request: DroidRpcProtocol["request"];
  readonly notifications: Stream.Stream<DroidNotificationEnvelope>;
  readonly serverRequests: Stream.Stream<DroidServerRequest>;
  readonly latestServerRequestSequence: Effect.Effect<number>;
  readonly exits: Effect.Effect<DroidProcessExit>;
  readonly shutdown: Effect.Effect<void>;
}

export const makeDroidRpcClient = (
  input: DroidRpcSpawnInput,
): Effect.Effect<
  DroidRpcClient,
  DroidRpcSpawnError,
  ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
> =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const runtimeScope = yield* Scope.Scope;
    const protocol = yield* makeDroidRpcProtocol();
    const exitDeferred = yield* Deferred.make<DroidProcessExit>();
    const exitFinalized = yield* SynchronizedRef.make(false);

    const spawnCommand = yield* resolveSpawnCommand(
      input.command,
      input.args,
      input.env ? { env: input.env, extendEnv: true } : {},
    );
    const child = yield* spawner
      .spawn(
        ChildProcess.make(spawnCommand.command, spawnCommand.args, {
          ...(input.cwd ? { cwd: input.cwd } : {}),
          ...(input.env ? { env: input.env, extendEnv: true } : {}),
          shell: spawnCommand.shell,
          stdin: {
            stream: Stream.encodeText(protocol.outgoing),
            endOnDone: true,
          },
        }),
      )
      .pipe(
        Effect.provideService(Scope.Scope, runtimeScope),
        Effect.mapError(
          (cause) =>
            new DroidRpcSpawnError({
              command: input.command,
              cause,
            }),
        ),
      );

    const observeChildExit = yield* Effect.cached(
      child.exitCode.pipe(
        Effect.match({
          onFailure: () =>
            ({
              code: null,
              description: "Droid process exit status was unavailable",
            }) satisfies DroidProcessExit,
          onSuccess: (code) =>
            ({
              code: Number(code),
              description: `Droid process exited with code ${Number(code)}`,
            }) satisfies DroidProcessExit,
        }),
      ),
    );

    const finalizeExit = (
      exit: DroidProcessExit,
      beforePublishing: Effect.Effect<void> = Effect.void,
    ) =>
      SynchronizedRef.getAndSet(exitFinalized, true).pipe(
        Effect.flatMap((alreadyFinalized) =>
          alreadyFinalized
            ? Effect.void
            : protocol
                .handleExit(exit)
                .pipe(
                  Effect.andThen(beforePublishing),
                  Effect.andThen(Deferred.succeed(exitDeferred, exit)),
                  Effect.asVoid,
                ),
        ),
      );

    const terminateTransport = (exit: DroidProcessExit) =>
      Effect.uninterruptible(
        protocol
          .beginShutdown(exit)
          .pipe(
            Effect.flatMap((transitioned) =>
              transitioned
                ? protocol.closeOutgoing.pipe(
                    Effect.andThen(
                      finalizeExit(
                        exit,
                        child
                          .kill({ killSignal: "SIGTERM", forceKillAfter: Duration.seconds(2) })
                          .pipe(Effect.ignore),
                      ),
                    ),
                  )
                : Effect.void,
            ),
          ),
      );

    const stdoutFiber = yield* child.stdout.pipe(
      Stream.decodeText(),
      Stream.runForEach(protocol.acceptChunk),
      Effect.matchCauseEffect({
        onFailure: (cause) =>
          logDroidWarning("Droid stdout stream failed", { cause }).pipe(
            Effect.andThen(
              terminateTransport({
                code: null,
                description: "Droid stdout stream failed",
              }),
            ),
          ),
        onSuccess: () =>
          protocol.endInput.pipe(
            Effect.matchCauseEffect({
              onFailure: (cause) =>
                logDroidWarning("Droid stdout stream failed", { cause }).pipe(
                  Effect.andThen(
                    terminateTransport({
                      code: null,
                      description: "Droid stdout stream failed",
                    }),
                  ),
                ),
              onSuccess: () =>
                observeChildExit.pipe(
                  Effect.timeoutOption(stdoutExitObservationGrace),
                  Effect.flatMap(
                    Option.match({
                      onNone: () =>
                        terminateTransport({
                          code: null,
                          description: "Droid stdout stream closed before the process exited",
                        }),
                      onSome: () => Effect.void,
                    }),
                  ),
                ),
            }),
          ),
      }),
      Effect.forkIn(runtimeScope),
    );

    const stderrFiber = yield* child.stderr.pipe(
      Stream.decodeText(),
      Stream.runForEach((output) =>
        output.trim().length === 0
          ? Effect.void
          : logDroidWarning("Droid stderr received", {
              details: { stderrBytes: new TextEncoder().encode(output).byteLength },
            }),
      ),
      Effect.catch(() => Effect.void),
      Effect.forkIn(runtimeScope),
    );

    yield* observeChildExit.pipe(
      Effect.flatMap((exit) =>
        Effect.gen(function* () {
          yield* protocol.beginShutdown(exit);
          yield* protocol.closeOutgoing;
          const stdoutDrained = yield* Fiber.join(stdoutFiber).pipe(
            Effect.as(true),
            Effect.timeoutOption(stdoutDrainAfterProcessExitGrace),
            Effect.map(Option.getOrElse(() => false)),
          );
          if (!stdoutDrained) {
            yield* Fiber.interrupt(stdoutFiber);
          }
          yield* finalizeExit(exit);
          yield* Fiber.interrupt(stderrFiber);
        }),
      ),
      Effect.forkIn(runtimeScope),
    );

    const exits = Deferred.await(exitDeferred);
    const shutdown = Effect.uninterruptible(
      protocol.beginShutdown().pipe(
        Effect.flatMap((transitioned) =>
          transitioned
            ? protocol.closeOutgoing.pipe(
                Effect.andThen(
                  Effect.raceFirst(
                    exits.pipe(Effect.as(true)),
                    Effect.sleep(gracefulShutdownTimeout).pipe(Effect.as(false)),
                  ),
                ),
                Effect.flatMap((exited) =>
                  exited
                    ? Effect.void
                    : child
                        .kill({ killSignal: "SIGTERM", forceKillAfter: Duration.seconds(2) })
                        .pipe(Effect.ignore),
                ),
              )
            : Effect.void,
        ),
      ),
    );

    yield* Effect.addFinalizer(() => shutdown);

    return {
      request: protocol.request,
      notifications: protocol.notifications,
      serverRequests: protocol.serverRequests,
      latestServerRequestSequence: protocol.latestServerRequestSequence,
      exits,
      shutdown,
    } satisfies DroidRpcClient;
  });

export const makeDroidExecRpcClient = (input: DroidExecRpcInput) =>
  makeDroidRpcClient({
    command: input.binaryPath,
    args: ["exec", "--input-format", "stream-jsonrpc", "--output-format", "stream-jsonrpc"],
    ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
    ...(input.env === undefined ? {} : { env: input.env }),
  });
