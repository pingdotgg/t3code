import {
  type EnvironmentId,
  type ServerConfig,
  type ServerLifecycleStreamReadyEvent,
  type ServerSelfUpdateProgressEvent,
  type ServerSelfUpdateResult,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Atom } from "effect/reactivity";

import {
  createAtomCommandScheduler,
  createRuntimeCommand,
  scheduleAtomCommandEffect,
} from "./runtime.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as Persistence from "../platform/persistence.ts";
import {
  isRpcClientError,
  request,
  runStream,
  subscribe,
  type EnvironmentRpcInput,
} from "../rpc/client.ts";

export type ServerUpdateStage = "downloading" | "installing" | "resuming";

export type ServerUpdateState =
  | { readonly status: "idle" }
  | {
      readonly status: "running";
      readonly stage: ServerUpdateStage;
      readonly fromVersion: string;
      readonly targetVersion: string;
    }
  | {
      readonly status: "failed";
      readonly stage: ServerUpdateStage;
      readonly fromVersion: string;
      readonly targetVersion: string;
      readonly message: string;
    };

export interface ServerUpdateTarget {
  readonly environmentId: EnvironmentId;
  readonly input: EnvironmentRpcInput<typeof WS_METHODS.serverUpdateServer>;
}

export const IDLE_SERVER_UPDATE_STATE: ServerUpdateState = { status: "idle" };
export const EMPTY_SERVER_UPDATE_STATE_ATOM = Atom.make<ServerUpdateState>(
  IDLE_SERVER_UPDATE_STATE,
).pipe(Atom.withLabel("environment-data:server:update-state:empty"));
export const serverUpdateStateAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make<ServerUpdateState>(IDLE_SERVER_UPDATE_STATE).pipe(
    Atom.withLabel(`environment-data:server:update-state:${environmentId}`),
  ),
);

export class ServerUpdateResumeTimeoutError extends Schema.TaggedError<ServerUpdateResumeTimeoutError>()(
  "ServerUpdateResumeTimeoutError",
  {
    environmentId: Schema.String,
    targetVersion: Schema.String,
  },
) {
  override get message(): string {
    return `Could not confirm that the server resumed on t3@${this.targetVersion}. Reconnect to check the update outcome.`;
  }
}

export class ServerUpdateProgressIncompleteError extends Schema.TaggedError<ServerUpdateProgressIncompleteError>()(
  "ServerUpdateProgressIncompleteError",
  {
    targetVersion: Schema.String,
  },
) {
  override get message(): string {
    return `The t3@${this.targetVersion} update ended before the server accepted the restart.`;
  }
}

export class ServerUpdateTerminalError extends Schema.TaggedError<ServerUpdateTerminalError>()(
  "ServerUpdateTerminalError",
  {
    targetVersion: Schema.String,
    status: Schema.Literals(["committed", "rolled-back", "failed"]),
    reason: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    return this.reason ?? `The t3@${this.targetVersion} update ${this.status}.`;
  }
}

// Covers the service launcher's 30-minute trial deadline (PREPARED_TIMEOUT_MS)
// and a final restart of the previous version when the trial rolls back.
export const SERVER_UPDATE_RESUME_TIMEOUT = Duration.minutes(32);

export function matchesServerUpdateReadyEvent(
  result: ServerSelfUpdateResult,
  event: ServerLifecycleStreamReadyEvent,
): boolean {
  return result.updateId === undefined
    ? event.payload.environment.serverVersion === result.targetVersion
    : event.payload.updateOutcome?.id === result.updateId;
}

export function matchesServerUpdateResumeEvent(
  result: ServerSelfUpdateResult,
  event: ServerLifecycleStreamReadyEvent,
): boolean {
  return (
    (result.method === "desktop-app" && result.desktopUpdateToken !== undefined) ||
    matchesServerUpdateReadyEvent(result, event)
  );
}

export function validateServerUpdateReadyEvent(
  result: ServerSelfUpdateResult,
  event: ServerLifecycleStreamReadyEvent,
): Effect.Effect<void, ServerUpdateTerminalError> {
  if (result.updateId === undefined) return Effect.void;
  const outcome = event.payload.updateOutcome;
  if (
    outcome?.id === result.updateId &&
    outcome.status === "committed" &&
    outcome.targetVersion === result.targetVersion &&
    event.payload.environment.serverVersion === result.targetVersion
  ) {
    return Effect.void;
  }
  return Effect.fail(
    new ServerUpdateTerminalError({
      targetVersion: result.targetVersion,
      status: outcome?.status ?? "failed",
      reason:
        outcome?.reason ??
        "The service launcher resumed without committing the requested server version.",
    }),
  );
}

/**
 * The sleep before each nudge is the pacer: a connection that fails instantly
 * re-enters backoff immediately and would otherwise spin a tight retry loop.
 *
 * Callers fork this as a child of the update command so it is interrupted as
 * soon as the update settles, whether it succeeds, fails, or times out.
 */
export function nudgeReconnectDuringUpdateRestart(input: {
  readonly stateChanges: Stream.Stream<
    {
      readonly phase: string;
      readonly lastFailure?: { readonly reason: string } | null;
    },
    unknown
  >;
  readonly retryNow: Effect.Effect<void>;
  readonly interval?: Duration.Duration;
}): Effect.Effect<void> {
  return input.stateChanges.pipe(
    Stream.filter(
      (state) =>
        state.phase === "backoff" ||
        (state.phase === "blocked" && state.lastFailure?.reason === "authentication"),
    ),
    Stream.runForEach(() =>
      Effect.sleep(input.interval ?? Duration.seconds(1)).pipe(Effect.andThen(input.retryNow)),
    ),
    Effect.timeoutOption(SERVER_UPDATE_RESUME_TIMEOUT),
    Effect.ignore,
  );
}

export function waitForNextEnvironmentReconnect<E>(
  stateChanges: Stream.Stream<{ readonly phase: string }, E>,
): Effect.Effect<void, E> {
  return stateChanges.pipe(
    Stream.dropWhile((state) => state.phase === "connected"),
    Stream.filter((state) => state.phase === "connected"),
    Stream.runHead,
    Effect.asVoid,
  );
}

export const runDesktopCommitWithReconnectObserver = Effect.fn(
  "runDesktopCommitWithReconnectObserver",
)(function* <EState, ECommit>(
  stateChanges: Stream.Stream<{ readonly phase: string }, EState>,
  commit: Effect.Effect<void, ECommit>,
) {
  const armed = yield* Deferred.make<void>();
  const reconnected = yield* Deferred.make<void>();
  const observer = yield* stateChanges.pipe(
    Stream.tap(() => Deferred.succeed(armed, undefined)),
    waitForNextEnvironmentReconnect,
    Effect.andThen(Deferred.succeed(reconnected, undefined)),
    Effect.forkChild,
  );
  yield* Deferred.await(armed);
  const commitExit = yield* commit.pipe(Effect.exit);
  if (Exit.isSuccess(commitExit)) {
    yield* Fiber.interrupt(observer);
    return;
  }
  if (!isLegacyUpdateHandoffLoss(commitExit.cause)) {
    yield* Fiber.interrupt(observer);
    return yield* Effect.failCause(commitExit.cause);
  }
  yield* Deferred.await(reconnected).pipe(Effect.timeout(SERVER_UPDATE_RESUME_TIMEOUT));
  return yield* Effect.failCause(commitExit.cause);
});

export const waitForDesktopUpdateTarget = Effect.fn("waitForDesktopUpdateTarget")(function* <
  EReady,
  ECommit,
>(
  targetVersion: string,
  nextReady: Effect.Effect<ServerLifecycleStreamReadyEvent, EReady>,
  retryCommit: Effect.Effect<void, ECommit>,
): Effect.fn.Return<ServerLifecycleStreamReadyEvent, EReady | ECommit | ServerUpdateTerminalError> {
  const maxCommitAttempts = 3;
  for (let attempt = 1; attempt <= maxCommitAttempts; attempt += 1) {
    const ready = yield* nextReady;
    if (ready.payload.environment.serverVersion === targetVersion) return ready;
    if (attempt === maxCommitAttempts) break;
    const retryExit = yield* retryCommit.pipe(Effect.exit);
    if (Exit.isSuccess(retryExit)) break;
    if (!isLegacyUpdateHandoffLoss(retryExit.cause)) {
      return yield* Effect.failCause(retryExit.cause);
    }
  }
  return yield* new ServerUpdateTerminalError({
    targetVersion,
    status: "failed",
    reason: "The desktop app resumed without installing the prepared update.",
  });
});

export function serverUpdateStateForProgressEvent(
  fromVersion: string,
  targetVersion: string,
  event: ServerSelfUpdateProgressEvent,
): Extract<ServerUpdateState, { status: "running" }> {
  return {
    status: "running",
    stage:
      event.type !== "complete"
        ? event.stage
        : event.result.method === "desktop-app" && event.result.desktopUpdateToken !== undefined
          ? "installing"
          : "resuming",
    fromVersion,
    targetVersion,
  };
}

export function serverUpdateStateForServerVersion(
  state: ServerUpdateState,
  serverVersion: string | null,
): ServerUpdateState {
  return state.status === "idle" ||
    state.status === "running" ||
    serverVersion === null ||
    state.fromVersion === serverVersion
    ? state
    : IDLE_SERVER_UPDATE_STATE;
}

export function serverUpdateFailureMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Server update failed.";
}

function isRpcSocketError(error: unknown): boolean {
  if (!isRpcClientError(error)) {
    return false;
  }
  switch (error.reason._tag) {
    case "SocketReadError":
    case "SocketWriteError":
    case "SocketCloseError":
      return true;
    default:
      return false;
  }
}

export function isLegacyUpdateHandoffLoss(cause: Cause.Cause<unknown>): boolean {
  if (Cause.hasInterruptsOnly(cause)) {
    return true;
  }
  return (
    cause.reasons.length > 0 &&
    cause.reasons.every((reason) => Cause.isFailReason(reason) && isRpcSocketError(reason.error))
  );
}

export function resolveServerUpdateProgressResult<E>(
  targetVersion: string,
  terminal: Option.Option<ServerSelfUpdateResult>,
  streamExit: Exit.Exit<void, E>,
  accepted?: ServerSelfUpdateResult,
): Effect.Effect<ServerSelfUpdateResult, E | ServerUpdateProgressIncompleteError> {
  if (
    Option.isSome(terminal) &&
    (Exit.isSuccess(streamExit) || isLegacyUpdateHandoffLoss(streamExit.cause))
  ) {
    return Effect.succeed(terminal.value);
  }
  if (Exit.isFailure(streamExit)) {
    if (accepted !== undefined && isLegacyUpdateHandoffLoss(streamExit.cause)) {
      return Effect.succeed(accepted);
    }
    return Effect.failCause(streamExit.cause);
  }
  return Effect.fail(new ServerUpdateProgressIncompleteError({ targetVersion }));
}

export function createServerUpdateCommand<R, E>(input: {
  readonly runtime: Atom.AtomRuntime<
    EnvironmentRegistry.EnvironmentRegistry | Persistence.EnvironmentCacheStore | R,
    E
  >;
  readonly scheduler: ReturnType<typeof createAtomCommandScheduler>;
  readonly configScheduler: ReturnType<typeof createAtomCommandScheduler>;
  readonly concurrency: {
    readonly mode: "serial";
    readonly key: (input: { readonly environmentId: string }) => string;
  };
  readonly configValueAtom: (environmentId: EnvironmentId | null) => Atom.Atom<ServerConfig | null>;
}) {
  const { runtime, configScheduler, configValueAtom } = input;
  const updateScheduler = input.scheduler;
  const configConcurrency = input.concurrency;
  const updateServer = createRuntimeCommand<
    EnvironmentRegistry.EnvironmentRegistry | Persistence.EnvironmentCacheStore | R,
    E,
    ServerUpdateTarget,
    ServerSelfUpdateResult,
    unknown
  >(runtime, {
    label: "environment-data:server:update-server",
    scheduler: updateScheduler,
    concurrency: configConcurrency,
    execute: Effect.fn("ServerUpdate.updateServer")(function (target, atomRegistry) {
      const stateAtom = serverUpdateStateAtom(target.environmentId);
      let targetVersion = target.input.targetVersion;
      let fromVersion =
        atomRegistry.get(configValueAtom(target.environmentId))?.environment.serverVersion ??
        targetVersion;
      let currentStage: ServerUpdateStage = "downloading";
      let desktopCommitLostTransport = false;
      atomRegistry.set(stateAtom, {
        status: "running",
        stage: currentStage,
        fromVersion,
        targetVersion,
      });

      return Effect.gen(function* () {
        const environmentRegistry = yield* EnvironmentRegistry.EnvironmentRegistry;
        const desktopCommitStarting = yield* Deferred.make<void>();
        const desktopReconnectObserverArmed = yield* Deferred.make<void>();
        const desktopReconnected = yield* Deferred.make<void>();
        yield* Deferred.await(desktopCommitStarting).pipe(
          Effect.andThen(
            environmentRegistry.stateChanges(target.environmentId).pipe(
              Stream.tap(() => Deferred.succeed(desktopReconnectObserverArmed, undefined)),
              Stream.dropWhile((state) => state.phase === "connected"),
              Stream.filter((state) => state.phase === "connected"),
              Stream.runHead,
            ),
          ),
          Effect.andThen(Deferred.succeed(desktopReconnected, undefined)),
          Effect.forkChild,
        );
        const result = yield* scheduleAtomCommandEffect(
          atomRegistry,
          configScheduler,
          configConcurrency,
          target,
          Effect.gen(function* () {
            const currentConfig = atomRegistry.get(configValueAtom(target.environmentId));
            fromVersion = currentConfig?.environment.serverVersion ?? targetVersion;
            atomRegistry.set(stateAtom, {
              status: "running",
              stage: currentStage,
              fromVersion,
              targetVersion,
            });

            const supportsProgress =
              currentConfig?.environment.capabilities.serverSelfUpdateProgress === true;
            const updateResult: ServerSelfUpdateResult = supportsProgress
              ? yield* Effect.gen(function* () {
                  let receivedProgress = false;
                  const terminal = yield* Ref.make<Option.Option<ServerSelfUpdateResult>>(
                    Option.none(),
                  );
                  const streamExit = yield* environmentRegistry
                    .runStream(
                      target.environmentId,
                      runStream(WS_METHODS.serverUpdateServerWithProgress, target.input),
                    )
                    .pipe(
                      Stream.runForEach((event) =>
                        Effect.sync(() => {
                          receivedProgress ||= event.type === "progress";
                          const state = serverUpdateStateForProgressEvent(
                            fromVersion,
                            targetVersion,
                            event,
                          );
                          currentStage = state.stage;
                          atomRegistry.set(stateAtom, state);
                        }).pipe(
                          Effect.andThen(
                            event.type === "complete"
                              ? Ref.set(terminal, Option.some(event.result))
                              : Effect.void,
                          ),
                        ),
                      ),
                      Effect.exit,
                    );
                  const selfUpdateMethod = currentConfig?.environment.capabilities.serverSelfUpdate;
                  // Desktop preparation needs its terminal commit token.
                  const accepted =
                    receivedProgress &&
                    (selfUpdateMethod === "boot-service" || selfUpdateMethod === "respawn")
                      ? { targetVersion, method: selfUpdateMethod }
                      : undefined;
                  return yield* resolveServerUpdateProgressResult(
                    targetVersion,
                    yield* Ref.get(terminal),
                    streamExit,
                    accepted,
                  );
                })
              : yield* Effect.gen(function* () {
                  const selfUpdateMethod = currentConfig?.environment.capabilities.serverSelfUpdate;
                  const exit = yield* environmentRegistry
                    .run(target.environmentId, request(WS_METHODS.serverUpdateServer, target.input))
                    .pipe(Effect.exit);
                  if (Exit.isSuccess(exit)) {
                    return exit.value;
                  }
                  if (
                    (selfUpdateMethod === "boot-service" || selfUpdateMethod === "respawn") &&
                    isLegacyUpdateHandoffLoss(exit.cause)
                  ) {
                    // Older servers can tear down the transport before their
                    // unary acknowledgement arrives. Treat only that transport
                    // loss as a handoff, then prove it by waiting for target ready.
                    return { targetVersion, method: selfUpdateMethod };
                  }
                  return yield* Effect.failCause(exit.cause);
                });

            if (
              updateResult.method === "desktop-app" &&
              updateResult.desktopUpdateToken !== undefined
            ) {
              yield* Deferred.succeed(desktopCommitStarting, undefined);
              yield* Deferred.await(desktopReconnectObserverArmed);
              const commitExit = yield* environmentRegistry
                .run(
                  target.environmentId,
                  request(WS_METHODS.serverCommitDesktopUpdate, {
                    requestId: updateResult.desktopUpdateToken,
                  }),
                )
                .pipe(Effect.exit);
              if (Exit.isFailure(commitExit) && !isLegacyUpdateHandoffLoss(commitExit.cause)) {
                return yield* Effect.failCause(commitExit.cause);
              }
              desktopCommitLostTransport = Exit.isFailure(commitExit);
            }

            targetVersion = updateResult.targetVersion;

            currentStage = "resuming";
            atomRegistry.set(stateAtom, {
              status: "running",
              stage: currentStage,
              fromVersion,
              targetVersion,
            });
            return updateResult;
          }),
        );

        // A track switch's desktop host already on its track's newest build only saved the
        // track; nothing restarts.
        if (
          result.method === "desktop-app" &&
          result.desktopUpdateToken === undefined &&
          result.targetVersion === fromVersion
        ) {
          atomRegistry.set(stateAtom, IDLE_SERVER_UPDATE_STATE);
          return result;
        }

        yield* nudgeReconnectDuringUpdateRestart({
          stateChanges: environmentRegistry.stateChanges(target.environmentId),
          retryNow: environmentRegistry.retryNow(target.environmentId),
        }).pipe(Effect.forkChild);

        if (result.method === "desktop-app" && desktopCommitLostTransport) {
          yield* Deferred.await(desktopReconnected).pipe(
            Effect.timeout(SERVER_UPDATE_RESUME_TIMEOUT),
          );
        }

        const waitForReady = environmentRegistry
          .followStream(target.environmentId, subscribe(WS_METHODS.subscribeServerLifecycle, {}))
          .pipe(
            Stream.filter(
              (event): event is ServerLifecycleStreamReadyEvent =>
                event.type === "ready" && matchesServerUpdateResumeEvent(result, event),
            ),
            Stream.runHead,
            Effect.timeoutOption(SERVER_UPDATE_RESUME_TIMEOUT),
            Effect.map(Option.flatten),
          );
        const nextReady = waitForReady.pipe(
          Effect.flatMap(
            Option.match({
              onNone: () =>
                new ServerUpdateResumeTimeoutError({
                  environmentId: target.environmentId,
                  targetVersion,
                }),
              onSome: Effect.succeed,
            }),
          ),
        );
        const desktopUpdateToken = result.desktopUpdateToken;
        const resumed =
          result.method === "desktop-app" && desktopUpdateToken !== undefined
            ? yield* waitForDesktopUpdateTarget(
                result.targetVersion,
                nextReady,
                runDesktopCommitWithReconnectObserver(
                  environmentRegistry.stateChanges(target.environmentId),
                  environmentRegistry
                    .run(
                      target.environmentId,
                      request(WS_METHODS.serverCommitDesktopUpdate, {
                        requestId: desktopUpdateToken,
                      }),
                    )
                    .pipe(Effect.asVoid),
                ),
              )
            : yield* nextReady;
        yield* validateServerUpdateReadyEvent(result, resumed);

        atomRegistry.set(stateAtom, IDLE_SERVER_UPDATE_STATE);
        return result;
      }).pipe(
        Effect.onExit((exit) =>
          Effect.sync(() => {
            if (Exit.isSuccess(exit)) {
              return;
            }
            if (Cause.hasInterruptsOnly(exit.cause)) {
              atomRegistry.set(stateAtom, IDLE_SERVER_UPDATE_STATE);
              return;
            }
            atomRegistry.set(stateAtom, {
              status: "failed",
              stage: currentStage,
              fromVersion,
              targetVersion,
              message: serverUpdateFailureMessage(Cause.squash(exit.cause)),
            });
          }),
        ),
      );
    }),
  });
  return updateServer;
}
