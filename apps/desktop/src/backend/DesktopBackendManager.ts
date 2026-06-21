import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import {
  DesktopBackendBootstrap,
  type DesktopBackendBootstrap as DesktopBackendBootstrapValue,
} from "@t3tools/contracts";
import {
  cleanupDesktopBackendAdvertisements,
  createDesktopBackendAdvertisement,
  DESKTOP_BACKEND_ADVERTISEMENT_HEARTBEAT_MS,
  removeDesktopBackendAdvertisement,
  writeDesktopBackendAdvertisement,
} from "@t3tools/shared/desktopBackendAdvertisement";

import * as DesktopBackendConfiguration from "./DesktopBackendConfiguration.ts";
import * as DesktopObservability from "../app/DesktopObservability.ts";
import * as DesktopState from "../app/DesktopState.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";

const INITIAL_RESTART_DELAY = Duration.millis(500);
const MAX_RESTART_DELAY = Duration.seconds(10);
const DEFAULT_BACKEND_READINESS_TIMEOUT = Duration.minutes(1);
const DEFAULT_BACKEND_READINESS_INTERVAL = Duration.millis(100);
const DEFAULT_BACKEND_READINESS_REQUEST_TIMEOUT = Duration.seconds(1);
const DEFAULT_BACKEND_TERMINATE_GRACE = Duration.seconds(2);
const BACKEND_READINESS_PATH = "/.well-known/t3/environment";

type BackendProcessLayerServices = ChildProcessSpawner.ChildProcessSpawner | HttpClient.HttpClient;

type BackendProcessRunRequirements = BackendProcessLayerServices | Scope.Scope;

export type BackendProcessOutputStream = "stdout" | "stderr";

export interface BackendProcessContext {
  readonly executablePath: string;
  readonly entryPath: string;
  readonly cwd: string;
  readonly httpBaseUrl: URL;
}

export interface DesktopBackendStartConfig extends BackendProcessContext {
  readonly env: Record<string, string | undefined>;
  readonly bootstrap: DesktopBackendBootstrapValue;
  readonly captureOutput: boolean;
}

interface BackendProcessExit {
  readonly code: Option.Option<number>;
  readonly reason: string;
}

const backendProcessContextSchema = {
  executablePath: Schema.String,
  entryPath: Schema.String,
  cwd: Schema.String,
  httpBaseUrl: Schema.URL,
};

export class BackendReadinessTimeoutError extends Schema.TaggedErrorClass<BackendReadinessTimeoutError>()(
  "BackendReadinessTimeoutError",
  {
    ...backendProcessContextSchema,
    readinessUrl: Schema.URL,
    timeoutMs: Schema.Number,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Timed out after ${this.timeoutMs}ms waiting for desktop backend readiness at ${this.readinessUrl.href}.`;
  }
}

export class BackendProcessBootstrapEncodeError extends Schema.TaggedErrorClass<BackendProcessBootstrapEncodeError>()(
  "BackendProcessBootstrapEncodeError",
  {
    ...backendProcessContextSchema,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to encode the desktop backend bootstrap payload for ${this.entryPath}.`;
  }
}

export class BackendProcessSpawnError extends Schema.TaggedErrorClass<BackendProcessSpawnError>()(
  "BackendProcessSpawnError",
  {
    ...backendProcessContextSchema,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to spawn desktop backend entry ${this.entryPath} with ${this.executablePath}.`;
  }
}

export class BackendProcessOutputReadError extends Schema.TaggedErrorClass<BackendProcessOutputReadError>()(
  "BackendProcessOutputReadError",
  {
    ...backendProcessContextSchema,
    pid: Schema.Number,
    streamName: Schema.Literals(["stdout", "stderr"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to read ${this.streamName} from desktop backend process ${this.pid}.`;
  }
}

export class BackendProcessOutputHandlingError extends Schema.TaggedErrorClass<BackendProcessOutputHandlingError>()(
  "BackendProcessOutputHandlingError",
  {
    ...backendProcessContextSchema,
    pid: Schema.Number,
    streamName: Schema.Literals(["stdout", "stderr"]),
    chunkByteLength: Schema.Number,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to handle ${this.chunkByteLength} bytes from ${this.streamName} of desktop backend process ${this.pid}.`;
  }
}

export type BackendProcessOutputError =
  | BackendProcessOutputReadError
  | BackendProcessOutputHandlingError;

export class BackendProcessExitStatusError extends Schema.TaggedErrorClass<BackendProcessExitStatusError>()(
  "BackendProcessExitStatusError",
  {
    ...backendProcessContextSchema,
    pid: Schema.Number,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to read the exit status of desktop backend process ${this.pid}.`;
  }
}

export class DesktopBackendRestartError extends Schema.TaggedErrorClass<DesktopBackendRestartError>()(
  "DesktopBackendRestartError",
  {
    reason: Schema.String,
    delayMs: Schema.Number,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Desktop backend restart failed after a scheduled ${this.delayMs}ms delay.`;
  }
}

export const BackendProcessError = Schema.Union([
  BackendProcessBootstrapEncodeError,
  BackendProcessSpawnError,
  BackendProcessExitStatusError,
]);
export type BackendProcessError = typeof BackendProcessError.Type;

class DesktopBackendAdvertisementError extends Data.TaggedError(
  "DesktopBackendAdvertisementError",
)<{
  readonly cause: unknown;
}> {
  override get message() {
    return this.cause instanceof Error ? this.cause.message : String(this.cause);
  }
}

interface RunBackendProcessOptions extends DesktopBackendStartConfig {
  readonly readinessTimeout?: Duration.Duration;
  readonly onStarted?: (pid: number) => Effect.Effect<void>;
  readonly onReady?: () => Effect.Effect<void>;
  readonly onReadinessFailure?: (error: BackendReadinessTimeoutError) => Effect.Effect<void>;
  readonly onOutput?: (
    streamName: BackendProcessOutputStream,
    chunk: Uint8Array,
  ) => Effect.Effect<void, Error>;
  readonly onOutputFailure?: (error: BackendProcessOutputError) => Effect.Effect<void>;
}

export interface DesktopBackendSnapshot {
  readonly desiredRunning: boolean;
  readonly ready: boolean;
  readonly activePid: Option.Option<number>;
  readonly restartAttempt: number;
  readonly restartScheduled: boolean;
}

export class DesktopBackendManager extends Context.Service<
  DesktopBackendManager,
  {
    readonly start: Effect.Effect<void>;
    readonly stop: (options?: { readonly timeout?: Duration.Duration }) => Effect.Effect<void>;
    readonly currentConfig: Effect.Effect<Option.Option<DesktopBackendStartConfig>>;
    readonly snapshot: Effect.Effect<DesktopBackendSnapshot>;
  }
>()("@t3tools/desktop/backend/DesktopBackendManager") {}

const { logWarning: logBackendManagerWarning, logError: logBackendManagerError } =
  DesktopObservability.makeComponentLogger("desktop-backend-manager");

interface ActiveBackendRun {
  readonly id: number;
  readonly scope: Scope.Closeable;
  readonly fiber: Option.Option<Fiber.Fiber<void, never>>;
  readonly pid: Option.Option<number>;
  readonly advertisement: Option.Option<DesktopBackendAdvertisementHandle>;
}

interface DesktopBackendAdvertisementHandle {
  readonly t3Home: string;
  readonly backendId: string;
}

interface BackendManagerState {
  readonly desiredRunning: boolean;
  readonly ready: boolean;
  readonly config: Option.Option<DesktopBackendStartConfig>;
  readonly active: Option.Option<ActiveBackendRun>;
  readonly restartAttempt: number;
  readonly restartFiber: Option.Option<Fiber.Fiber<void, never>>;
  readonly nextRunId: number;
}

const initialState: BackendManagerState = {
  desiredRunning: false,
  ready: false,
  config: Option.none(),
  active: Option.none(),
  restartAttempt: 0,
  restartFiber: Option.none(),
  nextRunId: 1,
};

const activePid = (active: Option.Option<ActiveBackendRun>): Option.Option<number> =>
  Option.flatMap(active, (run) => run.pid);

const withActiveRun =
  (runId: number, f: (run: ActiveBackendRun) => ActiveBackendRun) =>
  (state: BackendManagerState): BackendManagerState => ({
    ...state,
    active: Option.map(state.active, (run) => (run.id === runId ? f(run) : run)),
  });

const calculateRestartDelay = (attempt: number): Duration.Duration =>
  Duration.min(Duration.times(INITIAL_RESTART_DELAY, 2 ** attempt), MAX_RESTART_DELAY);

const closeRun = (
  run: ActiveBackendRun,
  options?: { readonly timeout?: Duration.Duration },
): Effect.Effect<void> => {
  const waitForFiber = Option.match(run.fiber, {
    onNone: () => Effect.void,
    onSome: (fiber) => Fiber.await(fiber).pipe(Effect.asVoid),
  });
  const close = Scope.close(run.scope, Exit.void).pipe(Effect.andThen(waitForFiber));

  return (
    options?.timeout ? close.pipe(Effect.timeoutOption(options.timeout), Effect.asVoid) : close
  ).pipe(Effect.ignore);
};

function makeDesktopBackendAdvertisementHandle(input: {
  readonly runId: number;
  readonly config: DesktopBackendStartConfig;
}): DesktopBackendAdvertisementHandle {
  return {
    t3Home: input.config.bootstrap.t3Home,
    backendId: `desktop-backend-${process.pid}-${input.runId}`,
  };
}

function refreshDesktopBackendAdvertisement(
  handle: DesktopBackendAdvertisementHandle,
  config: DesktopBackendStartConfig,
): Effect.Effect<void, never> {
  return refreshDesktopBackendAdvertisementStrict(handle, config).pipe(
    Effect.catch((error) =>
      logBackendManagerWarning("failed to refresh desktop backend advertisement", {
        message: error instanceof Error ? error.message : String(error),
      }),
    ),
  );
}

function refreshDesktopBackendAdvertisementStrict(
  handle: DesktopBackendAdvertisementHandle,
  config: DesktopBackendStartConfig,
): Effect.Effect<void, DesktopBackendAdvertisementError> {
  return Effect.try({
    try: () => {
      writeDesktopBackendAdvertisement({
        t3Home: handle.t3Home,
        advertisement: createDesktopBackendAdvertisement({
          backendId: handle.backendId,
          httpBaseUrl: config.httpBaseUrl.href,
        }),
      });
      cleanupDesktopBackendAdvertisements({ t3Home: handle.t3Home });
    },
    catch: toDesktopBackendAdvertisementError,
  });
}

function removeDesktopBackendAdvertisementForRun(
  handle: Option.Option<DesktopBackendAdvertisementHandle>,
): Effect.Effect<void> {
  return Option.match(handle, {
    onNone: () => Effect.void,
    onSome: (advertisement) =>
      Effect.try({
        try: () => {
          removeDesktopBackendAdvertisement(advertisement);
        },
        catch: toDesktopBackendAdvertisementError,
      }).pipe(
        Effect.catch((error) =>
          logBackendManagerWarning("failed to remove desktop backend advertisement", {
            message: error instanceof Error ? error.message : String(error),
          }),
        ),
      ),
  });
}

function toDesktopBackendAdvertisementError(cause: unknown): DesktopBackendAdvertisementError {
  return new DesktopBackendAdvertisementError({ cause });
}

export const waitForHttpReady = Effect.fn("desktop.backendManager.waitForHttpReady")(function* (
  options: BackendProcessContext & { readonly timeout: Duration.Duration },
): Effect.fn.Return<void, BackendReadinessTimeoutError, HttpClient.HttpClient> {
  const readinessUrl = new URL(BACKEND_READINESS_PATH, options.httpBaseUrl);
  const client = (yield* HttpClient.HttpClient).pipe(
    HttpClient.filterStatusOk,
    HttpClient.transformResponse(Effect.timeout(DEFAULT_BACKEND_READINESS_REQUEST_TIMEOUT)),
    HttpClient.retry(Schedule.spaced(DEFAULT_BACKEND_READINESS_INTERVAL)),
  );

  yield* client.get(readinessUrl).pipe(
    Effect.asVoid,
    Effect.timeout(options.timeout),
    Effect.mapError(
      (cause) =>
        new BackendReadinessTimeoutError({
          executablePath: options.executablePath,
          entryPath: options.entryPath,
          cwd: options.cwd,
          httpBaseUrl: options.httpBaseUrl,
          readinessUrl,
          timeoutMs: Duration.toMillis(options.timeout),
          cause,
        }),
    ),
  );
});

function drainBackendOutput(
  context: BackendProcessContext & { readonly pid: number },
  streamName: BackendProcessOutputStream,
  stream: Stream.Stream<Uint8Array, PlatformError.PlatformError>,
  onOutput: (
    streamName: BackendProcessOutputStream,
    chunk: Uint8Array,
  ) => Effect.Effect<void, Error>,
  onOutputFailure: (error: BackendProcessOutputError) => Effect.Effect<void>,
): Effect.Effect<void> {
  return stream.pipe(
    Stream.mapError(
      (cause) =>
        new BackendProcessOutputReadError({
          ...context,
          streamName,
          cause,
        }),
    ),
    Stream.runForEach((chunk) =>
      onOutput(streamName, chunk).pipe(
        Effect.mapError(
          (cause) =>
            new BackendProcessOutputHandlingError({
              ...context,
              streamName,
              chunkByteLength: chunk.byteLength,
              cause,
            }),
        ),
      ),
    ),
    Effect.catchTags({
      BackendProcessOutputReadError: onOutputFailure,
      BackendProcessOutputHandlingError: onOutputFailure,
    }),
  );
}

const encodeBootstrapJson = Schema.encodeEffect(Schema.fromJsonString(DesktopBackendBootstrap));

export const runBackendProcess = Effect.fn("runBackendProcess")(function* (
  options: RunBackendProcessOptions,
): Effect.fn.Return<BackendProcessExit, BackendProcessError, BackendProcessRunRequirements> {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const bootstrapJson = yield* encodeBootstrapJson(options.bootstrap).pipe(
    Effect.mapError(
      (cause) =>
        new BackendProcessBootstrapEncodeError({
          executablePath: options.executablePath,
          entryPath: options.entryPath,
          cwd: options.cwd,
          httpBaseUrl: options.httpBaseUrl,
          cause,
        }),
    ),
  );
  const onOutput = options.onOutput ?? (() => Effect.void);
  const command = ChildProcess.make(
    options.executablePath,
    [options.entryPath, "--bootstrap-fd", "3"],
    {
      cwd: options.cwd,
      env: options.env,
      extendEnv: true,
      // In Electron main, process.execPath points to the Electron binary.
      // Run the child in Node mode so this backend process does not become a GUI app instance.
      stdin: "ignore",
      stdout: options.captureOutput ? "pipe" : "inherit",
      stderr: options.captureOutput ? "pipe" : "inherit",
      killSignal: "SIGTERM",
      forceKillAfter: DEFAULT_BACKEND_TERMINATE_GRACE,
      additionalFds: {
        fd3: {
          type: "input",
          stream: Stream.encodeText(Stream.make(`${bootstrapJson}\n`)),
        },
      },
    },
  );

  const handle = yield* spawner.spawn(command).pipe(
    Effect.mapError(
      (cause) =>
        new BackendProcessSpawnError({
          executablePath: options.executablePath,
          entryPath: options.entryPath,
          cwd: options.cwd,
          httpBaseUrl: options.httpBaseUrl,
          cause,
        }),
    ),
  );

  yield* options.onStarted?.(handle.pid) ?? Effect.void;
  if (options.captureOutput) {
    const outputContext = {
      executablePath: options.executablePath,
      entryPath: options.entryPath,
      cwd: options.cwd,
      httpBaseUrl: options.httpBaseUrl,
      pid: Number(handle.pid),
    };
    const onOutputFailure = options.onOutputFailure ?? (() => Effect.void);
    yield* drainBackendOutput(
      outputContext,
      "stdout",
      handle.stdout,
      onOutput,
      onOutputFailure,
    ).pipe(Effect.forkScoped);
    yield* drainBackendOutput(
      outputContext,
      "stderr",
      handle.stderr,
      onOutput,
      onOutputFailure,
    ).pipe(Effect.forkScoped);
  }
  yield* waitForHttpReady({
    executablePath: options.executablePath,
    entryPath: options.entryPath,
    cwd: options.cwd,
    httpBaseUrl: options.httpBaseUrl,
    timeout: options.readinessTimeout ?? DEFAULT_BACKEND_READINESS_TIMEOUT,
  }).pipe(
    Effect.tap(() => options.onReady?.() ?? Effect.void),
    Effect.catchTags({
      BackendReadinessTimeoutError: (error) => options.onReadinessFailure?.(error) ?? Effect.void,
    }),
    Effect.forkScoped,
  );

  const exitCode = yield* handle.exitCode.pipe(
    Effect.mapError(
      (cause) =>
        new BackendProcessExitStatusError({
          executablePath: options.executablePath,
          entryPath: options.entryPath,
          cwd: options.cwd,
          httpBaseUrl: options.httpBaseUrl,
          pid: Number(handle.pid),
          cause,
        }),
    ),
  );
  return {
    code: Option.some(exitCode),
    reason: `code=${exitCode}`,
  } satisfies BackendProcessExit;
});

export const make = Effect.gen(function* () {
  const parentScope = yield* Scope.Scope;
  const fileSystem = yield* FileSystem.FileSystem;
  const configuration = yield* DesktopBackendConfiguration.DesktopBackendConfiguration;
  const backendOutputLog = yield* DesktopObservability.DesktopBackendOutputLog;
  const desktopState = yield* DesktopState.DesktopState;
  const desktopWindow = yield* DesktopWindow.DesktopWindow;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const httpClient = yield* HttpClient.HttpClient;
  const state = yield* Ref.make(initialState);
  const mutex = yield* Semaphore.make(1);

  const updateActiveRun = (runId: number, f: (run: ActiveBackendRun) => ActiveBackendRun) =>
    Ref.update(state, withActiveRun(runId, f));

  const snapshot = Ref.get(state).pipe(
    Effect.map(
      (current): DesktopBackendSnapshot => ({
        desiredRunning: current.desiredRunning,
        ready: current.ready,
        activePid: activePid(current.active),
        restartAttempt: current.restartAttempt,
        restartScheduled: Option.isSome(current.restartFiber),
      }),
    ),
  );
  const currentConfig = Ref.get(state).pipe(Effect.map((current) => current.config));

  const cancelRestart = Effect.gen(function* () {
    const restartFiber = yield* Ref.modify(state, (current) => [
      current.restartFiber,
      {
        ...current,
        restartFiber: Option.none(),
      },
    ]);

    yield* Option.match(restartFiber, {
      onNone: () => Effect.void,
      onSome: (fiber) => Fiber.interrupt(fiber).pipe(Effect.asVoid),
    });
  });

  const start: Effect.Effect<void> = Effect.suspend(() =>
    mutex.withPermits(1)(
      Effect.gen(function* () {
        const current = yield* Ref.get(state);
        if (Option.isSome(current.active)) {
          return;
        }

        yield* Ref.set(desktopState.backendReady, false);
        const config = yield* configuration.resolve.pipe(
          Effect.tapError((error) =>
            logBackendManagerError("failed to generate desktop backend configuration", {
              cause: error,
            }),
          ),
          Effect.option,
        );
        if (Option.isNone(config)) {
          return;
        }
        const entryExists = yield* fileSystem
          .exists(config.value.entryPath)
          .pipe(Effect.orElseSucceed(() => false));

        yield* cancelRestart;
        yield* Ref.update(state, (latest) => ({
          ...latest,
          desiredRunning: true,
          ready: false,
          config: Option.some(config.value),
        }));

        if (!entryExists) {
          yield* scheduleRestart(`missing server entry at ${config.value.entryPath}`);
          return;
        }

        const runScope = yield* Scope.make("sequential");
        const runId = yield* Ref.modify(state, (latest) => [
          latest.nextRunId,
          {
            ...latest,
            active: Option.some({
              id: latest.nextRunId,
              scope: runScope,
              fiber: Option.none(),
              pid: Option.none(),
              advertisement: Option.none(),
            } satisfies ActiveBackendRun),
            nextRunId: latest.nextRunId + 1,
          },
        ]);

        const finalizeRun = Effect.fn("desktop.backendManager.finalizeRun")(function* (
          reason: string,
        ) {
          yield* mutex.withPermits(1)(
            Effect.gen(function* () {
              const { isCurrentRun, nextState, pid, advertisement } = yield* Ref.modify(
                state,
                (
                  latest,
                ): readonly [
                  {
                    readonly isCurrentRun: boolean;
                    readonly nextState: BackendManagerState;
                    readonly pid: Option.Option<number>;
                    readonly advertisement: Option.Option<DesktopBackendAdvertisementHandle>;
                  },
                  BackendManagerState,
                ] => {
                  const currentRun = Option.getOrUndefined(latest.active);
                  if (currentRun?.id !== runId) {
                    return [
                      {
                        isCurrentRun: false,
                        nextState: latest,
                        pid: Option.none<number>(),
                        advertisement: Option.none<DesktopBackendAdvertisementHandle>(),
                      },
                      latest,
                    ] as const;
                  }

                  const next = {
                    ...latest,
                    active: Option.none<ActiveBackendRun>(),
                    ready: false,
                  };
                  return [
                    {
                      isCurrentRun: true,
                      nextState: next,
                      pid: currentRun.pid,
                      advertisement: currentRun.advertisement,
                    },
                    next,
                  ] as const;
                },
              );

              if (isCurrentRun) {
                yield* removeDesktopBackendAdvertisementForRun(advertisement);
                if (Option.isSome(pid)) {
                  yield* backendOutputLog.writeSessionBoundary({
                    phase: "END",
                    details: `pid=${pid.value} ${reason}`,
                  });
                }
                yield* Ref.set(desktopState.backendReady, false);
              }

              if (isCurrentRun && nextState.desiredRunning) {
                yield* scheduleRestart(reason);
              }
            }),
          );
        });

        const program = runBackendProcess({
          ...config.value,
          onStarted: Effect.fn("desktop.backendManager.onStarted")(function* (pid) {
            yield* updateActiveRun(runId, (run) => ({
              ...run,
              pid: Option.some(pid),
            }));
            yield* backendOutputLog.writeSessionBoundary({
              phase: "START",
              details: `pid=${pid} port=${config.value.bootstrap.port} cwd=${config.value.cwd}`,
            });
          }),
          onReady: Effect.fn("desktop.backendManager.onReady")(function* () {
            const isCurrentRunBeforeAdvertisement = yield* Ref.get(state).pipe(
              Effect.map((latest) => Option.getOrUndefined(latest.active)?.id === runId),
            );
            if (!isCurrentRunBeforeAdvertisement) {
              return;
            }

            const advertisement = makeDesktopBackendAdvertisementHandle({
              runId,
              config: config.value,
            });
            const advertisementReady = yield* refreshDesktopBackendAdvertisementStrict(
              advertisement,
              config.value,
            ).pipe(
              Effect.matchEffect({
                onFailure: (error) =>
                  logBackendManagerWarning("failed to refresh desktop backend advertisement", {
                    message: error instanceof Error ? error.message : String(error),
                  }).pipe(Effect.as(false)),
                onSuccess: () => Effect.succeed(true),
              }),
            );
            if (!advertisementReady) {
              return;
            }

            const isCurrentRun = yield* Ref.modify(state, (latest) => {
              const activeRun = Option.getOrUndefined(latest.active);
              if (activeRun?.id !== runId) {
                return [false, latest] as const;
              }

              return [
                true,
                {
                  ...latest,
                  restartAttempt: 0,
                  ready: true,
                  active: Option.some({
                    ...activeRun,
                    advertisement: Option.some(advertisement),
                  }),
                },
              ] as const;
            });
            if (!isCurrentRun) {
              yield* removeDesktopBackendAdvertisementForRun(Option.some(advertisement));
              return;
            }

            yield* Ref.set(desktopState.backendReady, true);
            yield* Effect.repeat(
              refreshDesktopBackendAdvertisement(advertisement, config.value),
              Schedule.spaced(Duration.millis(DESKTOP_BACKEND_ADVERTISEMENT_HEARTBEAT_MS)),
            ).pipe((effect) => Effect.forkIn(effect, runScope), Effect.asVoid);
            yield* desktopWindow.handleBackendReady.pipe(
              Effect.catch((error) =>
                logBackendManagerError("failed to open main window after backend readiness", {
                  cause: error,
                }),
              ),
            );
          }),
          onReadinessFailure: (error) =>
            logBackendManagerWarning("backend readiness check failed during bootstrap", {
              error,
            }),
          onOutput: (streamName, chunk) => backendOutputLog.writeOutputChunk(streamName, chunk),
          onOutputFailure: (error) => logBackendManagerError(error.message, { error }),
        }).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(HttpClient.HttpClient, httpClient),
          Scope.provide(runScope),
          Effect.matchEffect({
            onFailure: (error) =>
              logBackendManagerError(error.message, { error }).pipe(
                Effect.andThen(finalizeRun(error.message)),
              ),
            onSuccess: (exit) => finalizeRun(exit.reason),
          }),
          Effect.ensuring(Scope.close(runScope, Exit.void).pipe(Effect.ignore)),
        );

        const fiber = yield* Effect.forkIn(program, parentScope);
        yield* updateActiveRun(runId, (run) => ({
          ...run,
          fiber: Option.some(fiber),
        }));
      }),
    ),
  ).pipe(Effect.withSpan("desktop.backendManager.start"));

  const scheduleRestart = Effect.fn("desktop.backendManager.scheduleRestart")(function* (
    reason: string,
  ) {
    const scheduled = yield* Ref.modify(state, (latest) => {
      if (!latest.desiredRunning || Option.isSome(latest.restartFiber)) {
        return [Option.none<Duration.Duration>(), latest] as const;
      }

      const delay = calculateRestartDelay(latest.restartAttempt);
      return [
        Option.some(delay),
        {
          ...latest,
          restartAttempt: latest.restartAttempt + 1,
        },
      ] as const;
    });

    yield* Option.match(scheduled, {
      onNone: () => Effect.void,
      onSome: Effect.fn("desktop.backendManager.scheduleRestartFiber")(function* (delay) {
        yield* logBackendManagerError("backend exited unexpectedly; restart scheduled", {
          reason,
          delayMs: Duration.toMillis(delay),
        });
        const restartFiber = yield* Effect.forkIn(
          Effect.sleep(delay).pipe(
            Effect.andThen(
              Ref.modify(state, (latest) => {
                const shouldRestart = latest.desiredRunning;
                return [
                  shouldRestart,
                  {
                    ...latest,
                    restartFiber: Option.none(),
                  },
                ] as const;
              }),
            ),
            Effect.flatMap((shouldRestart) => (shouldRestart ? start : Effect.void)),
            Effect.catchCause((cause) => {
              if (Cause.hasInterruptsOnly(cause)) {
                return Effect.void;
              }
              const error = new DesktopBackendRestartError({
                reason,
                delayMs: Duration.toMillis(delay),
                cause,
              });
              return logBackendManagerError(error.message, { error });
            }),
          ),
          parentScope,
        );
        yield* Ref.update(state, (latest) =>
          Option.isNone(latest.restartFiber)
            ? {
                ...latest,
                restartFiber: Option.some(restartFiber),
              }
            : latest,
        );
      }),
    });
  });

  const stop = Effect.fn("desktop.backendManager.stop")(function* (options?: {
    readonly timeout?: Duration.Duration;
  }) {
    const { active, restartFiber } = yield* mutex.withPermits(1)(
      Effect.gen(function* () {
        const result = yield* Ref.modify(state, (latest) => [
          {
            active: latest.active,
            restartFiber: latest.restartFiber,
          },
          {
            ...latest,
            desiredRunning: false,
            ready: false,
            active: Option.none<ActiveBackendRun>(),
            restartFiber: Option.none<Fiber.Fiber<void, never>>(),
          },
        ]);
        yield* Ref.set(desktopState.backendReady, false);
        return result;
      }),
    );

    yield* Option.match(restartFiber, {
      onNone: () => Effect.void,
      onSome: (fiber) => Fiber.interrupt(fiber).pipe(Effect.asVoid),
    });
    yield* Option.match(active, {
      onNone: () => Effect.void,
      onSome: (run) =>
        closeRun(run, options).pipe(
          Effect.andThen(removeDesktopBackendAdvertisementForRun(run.advertisement)),
        ),
    });
  });

  yield* Effect.addFinalizer(() => stop());

  return DesktopBackendManager.of({
    start,
    stop,
    currentConfig,
    snapshot,
  });
});

export const layer = Layer.effect(DesktopBackendManager, make);
