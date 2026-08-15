// Per-instance backend factory. Replaces the legacy singleton
// `DesktopBackendManager` Context.Service: each call to
// `makeBackendInstance(spec)` constructs an isolated backend lifecycle —
// its own state Ref, mutex, restart loop, and active child process. The
// returned `DesktopBackendInstance` exposes start/stop/snapshot/wait
// methods that operate on that single backend.
//
// The pool layer (`DesktopBackendPool.ts`) calls this factory once per
// backend it wants to run. Today that's the Windows primary; follow-up
// commits add a second call for the WSL instance.
//
// Singleton couplings that the legacy service held inline are now
// parameterized via the spec:
//   - configResolve replaces the legacy `DesktopBackendConfiguration.resolve`
//     so each instance can resolve its own start config — the primary wires
//     `configuration.resolvePrimary`, the WSL orchestrator wires a
//     `configuration.resolveWsl({ port, distro })` closure.
//   - onReady / onShutdown drive UI side effects (window auto-open,
//     readiness latch) only for instances that want them — the primary's
//     spec passes the window's handleBackendReady/handleBackendNotReady,
//     other pool instances pass nothing.
//   - log writes go through a per-instance writer that the factory
//     pulls from `DesktopBackendOutputLogFactory.forInstance(spec.id)`,
//     so each instance lands in its own rotating file.

import * as Brand from "effect/Brand";
import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  DesktopBackendBootstrap,
  type DesktopBackendBootstrap as DesktopBackendBootstrapValue,
  PRIMARY_LOCAL_ENVIRONMENT_ID,
  DesktopTelemetryControlMessage,
  type DesktopTelemetryControlMessage as DesktopTelemetryControlMessageValue,
} from "@t3tools/contracts";
import { waitForHttpReady as waitForHttpReadyShared } from "@t3tools/shared/httpReadiness";

import * as DesktopObservability from "../app/DesktopObservability.ts";
import * as DesktopTelemetryPublisher from "../telemetry/DesktopTelemetryPublisher.ts";

const INITIAL_RESTART_DELAY = Duration.millis(500);
const MAX_RESTART_DELAY = Duration.seconds(10);
// After this many consecutive fatal preflight failures, stop the silent
// restart loop and surface the reason via onPreflightFailed. Transient
// failures may instead provide their own larger retryLimit when they should
// self-heal for a while but must not leave the app connecting forever.
const MAX_PREFLIGHT_FAILURE_ATTEMPTS = 5;
const DEFAULT_BACKEND_READINESS_TIMEOUT = Duration.minutes(1);
const DEFAULT_BACKEND_READINESS_INTERVAL = Duration.millis(100);
const DEFAULT_BACKEND_READINESS_REQUEST_TIMEOUT = Duration.seconds(1);
const DEFAULT_BACKEND_TERMINATE_GRACE = Duration.seconds(2);
const DEFAULT_BACKEND_OUTPUT_DRAIN_TIMEOUT = Duration.seconds(5);
const BACKEND_READINESS_PATH = "/.well-known/t3/environment";
const { logWarning: logBackendProcessWarning } =
  DesktopObservability.makeComponentLogger("desktop-backend-process");

type BackendProcessLayerServices = ChildProcessSpawner.ChildProcessSpawner | HttpClient.HttpClient;

type BackendProcessRunRequirements = BackendProcessLayerServices | Scope.Scope;

export type BackendProcessOutputStream = "stdout" | "stderr";

export interface BackendProcessContext {
  readonly executablePath: string;
  readonly entryPath: string;
  readonly cwd: string;
  readonly httpBaseUrl: URL;
}

export type DesktopBackendBootstrapDelivery = "fd3" | "stdin";

export interface DesktopBackendStartConfig extends BackendProcessContext {
  readonly args: ReadonlyArray<string>;
  readonly env: Record<string, string | undefined>;
  // When true the spawner merges the desktop process.env on top of `env`;
  // when false `env` is passed verbatim. WSL mode opts out so a leaking
  // T3CODE_HOME can't pin the WSL backend to /mnt/c/...\.t3.
  readonly extendEnv: boolean;
  readonly bootstrap: DesktopBackendBootstrapValue;
  readonly bootstrapDelivery: DesktopBackendBootstrapDelivery;
  readonly httpBaseUrl: URL;
  readonly captureOutput: boolean;
  readonly preflightFailure: Option.Option<PreflightFailure>;
  // Present for a WSL run after the configured/default distro has been
  // resolved to the concrete distro passed to wsl.exe.
  readonly runningDistro?: string;
}

// A preflight failure records whether it is fatal. Transient failures (WSL
// cold-starting, wslpath while the VM boots) keep retrying so the backend can
// self-heal; fatal ones (no node, wrong version, missing build tools) are
// surfaced via onPreflightFailed and stop the restart loop after
// MAX_PREFLIGHT_FAILURE_ATTEMPTS.
export interface PreflightFailure {
  readonly reason: string;
  readonly fatal: boolean;
  readonly retryLimit?: number;
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

export const BackendProcessError = Schema.Union([
  BackendProcessBootstrapEncodeError,
  BackendProcessSpawnError,
  BackendProcessExitStatusError,
]);
export type BackendProcessError = typeof BackendProcessError.Type;

interface RunBackendProcessOptions extends DesktopBackendStartConfig {
  readonly desktopTelemetryStream: Stream.Stream<Uint8Array>;
  readonly onDesktopTelemetryControl?: (
    message: DesktopTelemetryControlMessageValue,
  ) => Effect.Effect<void>;
  readonly readinessTimeout?: Duration.Duration;
  readonly outputDrainTimeout?: Duration.Duration;
  readonly onStarted?: (pid: number) => Effect.Effect<void>;
  readonly onExitObserved?: () => Effect.Effect<void>;
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

// Opaque identifier for one backend process inside the pool. Today only
// PRIMARY_INSTANCE_ID is registered. Follow-up commits add WSL distros
// under ids derived from the distro name (e.g. "wsl:ubuntu"). Eventually
// these map 1:1 with environment ids on the frontend; keeping them
// desktop-local for now avoids leaking the contracts dependency.
export type BackendInstanceId = string & Brand.Brand<"BackendInstanceId">;
export const BackendInstanceId = Brand.nominal<BackendInstanceId>();

export const PRIMARY_INSTANCE_ID: BackendInstanceId = BackendInstanceId(
  PRIMARY_LOCAL_ENVIRONMENT_ID,
);

// One pooled backend instance. Same lifecycle surface as the legacy
// `DesktopBackendManagerShape`; the id and label give the pool registry
// + UI something to route on.
export interface DesktopBackendInstance {
  readonly id: BackendInstanceId;
  readonly label: Effect.Effect<string>;
  readonly start: Effect.Effect<void>;
  readonly stop: (options?: { readonly timeout?: Duration.Duration }) => Effect.Effect<void>;
  readonly currentConfig: Effect.Effect<Option.Option<DesktopBackendStartConfig>>;
  readonly snapshot: Effect.Effect<DesktopBackendSnapshot>;
  // Polls desiredRunning + the instance's own ready flag until the
  // backend reports ready, or the timeout elapses. Returns true on
  // ready, false on timeout. Used by the WSL backend swap to drive its
  // rollback path.
  readonly waitForReady: (timeout: Duration.Duration) => Effect.Effect<boolean>;
}

// Spec describing one backend instance to spawn. The configResolve
// effect is awaited each time the instance is (re)started so live
// settings changes are picked up on the next start cycle. onReady and
// onShutdown let the primary instance trigger UI side effects (window
// open, global readiness flag) without coupling the factory to those
// concerns; other instances pass them as undefined.
export interface BackendInstanceSpec {
  readonly id: BackendInstanceId;
  readonly label: Effect.Effect<string>;
  // configResolve can now fail with PlatformError because the
  // bootstrap-token closure inside DesktopBackendConfiguration uses
  // crypto.randomBytes (Effect 4 beta.73 migration).
  readonly configResolve: Effect.Effect<DesktopBackendStartConfig, PlatformError.PlatformError>;
  // Receives the *resolved* httpBaseUrl of the run that just became
  // ready. The window service uses this to decide what URL to load
  // (the WSL backend reports its distro IP, the Windows backend reports
  // 127.0.0.1). Splitting this off from configResolve avoids races
  // between "fired onReady" and "currentConfig already advanced".
  readonly onReady?: (httpBaseUrl: URL) => Effect.Effect<void>;
  readonly onShutdown?: () => Effect.Effect<void>;
  // Fired once when a fatal or bounded preflight failure has exhausted its
  // retries. Returns true when the callback changed configuration and the
  // manager should resolve once more; false stops the failed instance.
  readonly onPreflightFailed?: (failure: PreflightFailure) => Effect.Effect<boolean>;
}

interface ActiveBackendRun {
  readonly id: number;
  readonly scope: Scope.Closeable;
  readonly fiber: Option.Option<Fiber.Fiber<void, never>>;
  readonly pid: Option.Option<number>;
  readonly exitObserved: boolean;
  readonly stopRequested: boolean;
}

interface BackendManagerState {
  readonly desiredRunning: boolean;
  readonly ready: boolean;
  readonly config: Option.Option<DesktopBackendStartConfig>;
  readonly active: Option.Option<ActiveBackendRun>;
  readonly restartAttempt: number;
  // Consecutive bounded/fatal preflight failures, reset on a clean or
  // unbounded-transient preflight. restartAttempt counts all restarts.
  readonly preflightFailureAttempt: number;
  readonly restartFiber: Option.Option<Fiber.Fiber<void, never>>;
  readonly nextRunId: number;
}

const initialState: BackendManagerState = {
  desiredRunning: false,
  ready: false,
  config: Option.none(),
  active: Option.none(),
  restartAttempt: 0,
  preflightFailureAttempt: 0,
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
  parentScope: Scope.Scope,
  options?: { readonly timeout?: Duration.Duration },
): Effect.Effect<boolean> => {
  const waitForFiber = Option.match(run.fiber, {
    onNone: () => Effect.void,
    onSome: (fiber) => Fiber.await(fiber).pipe(Effect.asVoid),
  });
  const close = Scope.close(run.scope, Exit.void).pipe(Effect.andThen(waitForFiber));
  const timeout = options?.timeout;

  if (!timeout) {
    return close.pipe(Effect.as(true));
  }

  return Effect.forkIn(close, parentScope).pipe(
    Effect.flatMap((closeFiber) =>
      Fiber.await(closeFiber).pipe(Effect.timeoutOption(timeout), Effect.map(Option.isSome)),
    ),
  );
};

export const waitForHttpReady = (
  options: BackendProcessContext & { readonly timeout: Duration.Duration },
): Effect.Effect<void, BackendReadinessTimeoutError, HttpClient.HttpClient> => {
  const readinessUrl = new URL(BACKEND_READINESS_PATH, options.httpBaseUrl);
  return waitForHttpReadyShared({
    baseUrl: options.httpBaseUrl.href,
    path: BACKEND_READINESS_PATH,
    timeoutMs: Duration.toMillis(options.timeout),
    intervalMs: Duration.toMillis(DEFAULT_BACKEND_READINESS_INTERVAL),
    probeTimeoutMs: Duration.toMillis(DEFAULT_BACKEND_READINESS_REQUEST_TIMEOUT),
    makeError: ({ cause }) =>
      new BackendReadinessTimeoutError({
        executablePath: options.executablePath,
        entryPath: options.entryPath,
        cwd: options.cwd,
        httpBaseUrl: options.httpBaseUrl,
        readinessUrl,
        timeoutMs: Duration.toMillis(options.timeout),
        cause,
      }),
  });
};

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
        Effect.catchTag("BackendProcessOutputHandlingError", onOutputFailure),
      ),
    ),
    Effect.catchTags({
      BackendProcessOutputReadError: onOutputFailure,
    }),
  );
}

const encodeBootstrapJson = Schema.encodeEffect(Schema.fromJsonString(DesktopBackendBootstrap));
const decodeDesktopTelemetryControlLine = Schema.decodeUnknownEffect(
  Schema.fromJsonString(DesktopTelemetryControlMessage),
);

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
  const bootstrapStream = Stream.encodeText(Stream.make(`${bootstrapJson}\n`));
  const additionalFds: Record<`fd${number}`, ChildProcess.AdditionalFdConfig> = {};
  if (options.bootstrapDelivery === "fd3") {
    additionalFds.fd3 = {
      type: "input",
      stream: bootstrapStream,
    };
    if (options.bootstrap.desktopTelemetryFd !== undefined) {
      additionalFds[`fd${options.bootstrap.desktopTelemetryFd}`] = {
        type: "input",
        stream: options.desktopTelemetryStream,
      };
    }
    if (options.bootstrap.desktopTelemetryControlFd !== undefined) {
      additionalFds[`fd${options.bootstrap.desktopTelemetryControlFd}`] = {
        type: "output",
      };
    }
  }
  const command = ChildProcess.make(options.executablePath, options.args, {
    cwd: options.cwd,
    env: options.env,
    extendEnv: options.extendEnv,
    // In Electron main, process.execPath points to the Electron binary.
    // Run the child in Node mode so this backend process does not become a GUI app instance.
    stdin: options.bootstrapDelivery === "stdin" ? bootstrapStream : "ignore",
    stdout: options.captureOutput ? "pipe" : "inherit",
    stderr: options.captureOutput ? "pipe" : "inherit",
    killSignal: "SIGTERM",
    forceKillAfter: DEFAULT_BACKEND_TERMINATE_GRACE,
    // wsl.exe drops additional file descriptors when forwarding to the Linux
    // side, so the WSL spawn path delivers the bootstrap envelope via stdin
    // (`--bootstrap-fd 0`) instead.
    ...(options.bootstrapDelivery === "fd3" ? { additionalFds } : {}),
  });

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
  const outputFibers: Array<Fiber.Fiber<void, never>> = [];

  yield* options.onStarted?.(handle.pid) ?? Effect.void;
  if (
    options.bootstrap.desktopTelemetryControlFd !== undefined &&
    options.onDesktopTelemetryControl !== undefined
  ) {
    const controlFd = options.bootstrap.desktopTelemetryControlFd;
    const handleControl = options.onDesktopTelemetryControl;
    yield* handle.getOutputFd(controlFd).pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.filter((line) => line.trim().length > 0),
      Stream.runForEach((line) =>
        decodeDesktopTelemetryControlLine(line).pipe(
          Effect.flatMap(handleControl),
          Effect.catchCause((cause) =>
            logBackendProcessWarning("ignored invalid desktop telemetry control message", {
              fd: controlFd,
              cause: Cause.pretty(cause),
            }),
          ),
        ),
      ),
      Effect.catchCause((cause) =>
        logBackendProcessWarning("desktop telemetry control stream stopped", {
          fd: controlFd,
          cause: Cause.pretty(cause),
        }),
      ),
      Effect.ensuring(
        handleControl({
          version: 1,
          type: "setDiagnosticsDemand",
          enabled: false,
        }),
      ),
      Effect.forkScoped,
    );
  }
  if (options.captureOutput) {
    const outputContext = {
      executablePath: options.executablePath,
      entryPath: options.entryPath,
      cwd: options.cwd,
      httpBaseUrl: options.httpBaseUrl,
      pid: Number(handle.pid),
    };
    const onOutputFailure = options.onOutputFailure ?? (() => Effect.void);
    outputFibers.push(
      yield* drainBackendOutput(
        outputContext,
        "stdout",
        handle.stdout,
        onOutput,
        onOutputFailure,
      ).pipe(Effect.forkScoped),
      yield* drainBackendOutput(
        outputContext,
        "stderr",
        handle.stderr,
        onOutput,
        onOutputFailure,
      ).pipe(Effect.forkScoped),
    );
  }
  // Probe readiness in a loop while the backend process is still alive
  // instead of giving up after the first budget. A slow cold boot (the
  // WSL bundle loading across /mnt/c, or a first launch right after an
  // update) can exceed the initial readiness budget while the backend is
  // about to come up moments later; a one-shot probe left the app stuck
  // on "Connecting to WSL…" forever even though the backend kept running
  // and became healthy. Each round gets a fresh budget, and the forked
  // loop is torn down with the run scope once the child exits.
  const probeReadiness = Effect.fn("desktop.backendProcess.probeReadiness")(() =>
    waitForHttpReady({
      executablePath: options.executablePath,
      entryPath: options.entryPath,
      cwd: options.cwd,
      httpBaseUrl: options.httpBaseUrl,
      timeout: options.readinessTimeout ?? DEFAULT_BACKEND_READINESS_TIMEOUT,
    }).pipe(
      Effect.flatMap(() => options.onReady?.() ?? Effect.void),
      Effect.as(true),
      Effect.catchTags({
        BackendReadinessTimeoutError: (error) =>
          (options.onReadinessFailure?.(error) ?? Effect.void).pipe(Effect.as(false)),
      }),
    ),
  );

  yield* probeReadiness().pipe(Effect.repeat({ while: (ready) => !ready }), Effect.forkScoped);

  const exit = yield* handle.exitCode.pipe(
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
    Effect.exit,
  );
  yield* options.onExitObserved?.() ?? Effect.void;
  yield* Effect.forEach(outputFibers, Fiber.await, {
    concurrency: "unbounded",
    discard: true,
  }).pipe(
    Effect.timeout(options.outputDrainTimeout ?? DEFAULT_BACKEND_OUTPUT_DRAIN_TIMEOUT),
    Effect.ignore,
  );
  if (Exit.isFailure(exit)) {
    return yield* Effect.failCause(exit.cause);
  }
  const exitCode = exit.value;
  return {
    code: Option.some(exitCode),
    reason: `code=${exitCode}`,
  } satisfies BackendProcessExit;
});

// Factory for one pooled backend instance. The returned instance owns
// its own state Ref, mutex, restart loop, and active child process;
// nothing is shared between instances created from separate
// makeBackendInstance calls. The instance shuts down automatically when
// the calling scope closes (typically the application scope).
export const makeBackendInstance = Effect.fn("makeBackendInstance")(function* (
  spec: BackendInstanceSpec,
): Effect.fn.Return<
  DesktopBackendInstance,
  never,
  | FileSystem.FileSystem
  | ChildProcessSpawner.ChildProcessSpawner
  | HttpClient.HttpClient
  | DesktopObservability.DesktopBackendOutputLogFactory
  | DesktopTelemetryPublisher.DesktopTelemetryPublisher
  | Scope.Scope
> {
  const parentScope = yield* Scope.Scope;
  const fileSystem = yield* FileSystem.FileSystem;
  const backendOutputLogFactory = yield* DesktopObservability.DesktopBackendOutputLogFactory;
  const backendOutputLog = yield* backendOutputLogFactory.forInstance(spec.id);
  const desktopTelemetryPublisher = yield* DesktopTelemetryPublisher.DesktopTelemetryPublisher;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const httpClient = yield* HttpClient.HttpClient;
  const state = yield* Ref.make(initialState);
  const mutex = yield* Semaphore.make(1);

  const { logWarning: logInstanceWarning, logError: logInstanceError } =
    DesktopObservability.makeComponentLogger(`desktop-backend-instance:${spec.id}`);

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
          if (!current.desiredRunning) {
            yield* Ref.update(state, (latest) => ({
              ...latest,
              desiredRunning: true,
            }));
          }
          return;
        }

        if (current.ready) {
          yield* spec.onShutdown?.() ?? Effect.void;
          yield* Ref.update(state, (latest) =>
            latest.ready ? { ...latest, ready: false } : latest,
          );
        }
        const config = yield* spec.configResolve.pipe(
          Effect.tapError((error) =>
            logInstanceError("failed to generate desktop backend configuration", {
              cause: error.message,
            }),
          ),
          Effect.option,
        );
        if (Option.isNone(config)) {
          if (current.desiredRunning) {
            yield* scheduleRestart("failed to generate desktop backend configuration");
          }
          return;
        }
        const entryExists = yield* fileSystem
          .exists(config.value.entryPath)
          .pipe(Effect.orElseSucceed(() => false));

        const resetFatalPreflightCounter =
          !current.desiredRunning && current.preflightFailureAttempt > 0;
        yield* cancelRestart;
        yield* Ref.update(state, (latest) => ({
          ...latest,
          desiredRunning: true,
          ready: false,
          config: Option.some(config.value),
          preflightFailureAttempt: resetFatalPreflightCounter ? 0 : latest.preflightFailureAttempt,
        }));

        const preflightFailure = config.value.preflightFailure;
        if (Option.isSome(preflightFailure)) {
          const { reason, fatal, retryLimit } = preflightFailure.value;
          if (!fatal && retryLimit === undefined) {
            // Transient (WSL cold-starting, wslpath while the VM boots). Keep
            // retrying so the backend self-heals once WSL is ready. Reset a
            // prior bounded/fatal streak because this is a different failure.
            yield* Ref.update(state, (latest) =>
              latest.preflightFailureAttempt === 0
                ? latest
                : { ...latest, preflightFailureAttempt: 0 },
            );
            yield* scheduleRestart(reason);
            return;
          }
          const attemptLimit = retryLimit ?? MAX_PREFLIGHT_FAILURE_ATTEMPTS;
          const attempt = yield* Ref.modify(state, (latest) => {
            const next = latest.preflightFailureAttempt + 1;
            return [next, { ...latest, preflightFailureAttempt: next }] as const;
          });
          if (attempt > attemptLimit) {
            // We already surfaced and asked for the Windows fallback, yet we're
            // still resolving the WSL primary — the fallback didn't take (e.g.
            // the settings write failed). Stop rather than loop forever.
            yield* logInstanceError("backend preflight still failing after fallback; stopping", {
              reason,
              attempt,
            });
            yield* Ref.update(state, (latest) => ({
              ...latest,
              desiredRunning: false,
              ready: false,
            }));
            return;
          }
          if (attempt === attemptLimit) {
            // Fatal/bounded and out of retries. Surface the reason (onPreflightFailed,
            // on the primary, shows a dialog and persists Windows mode), then
            // schedule one more restart so the next resolve picks up the Windows
            // primary and a window can open.
            yield* logInstanceError(
              "backend preflight failed repeatedly; surfacing and falling back",
              { reason, attempt },
            );
            const shouldRestart = yield* (
              spec.onPreflightFailed?.(preflightFailure.value) ?? Effect.succeed(false)
            );
            if (shouldRestart) {
              yield* scheduleRestart(reason);
            } else {
              yield* Ref.update(state, (latest) => ({
                ...latest,
                desiredRunning: false,
                ready: false,
              }));
            }
            return;
          }
          yield* scheduleRestart(reason);
          return;
        }
        // Clean preflight — reset the fatal counter so a later failure gets a
        // fresh allowance.
        yield* Ref.update(state, (latest) =>
          latest.preflightFailureAttempt === 0 ? latest : { ...latest, preflightFailureAttempt: 0 },
        );

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
              exitObserved: false,
              stopRequested: false,
            } satisfies ActiveBackendRun),
            nextRunId: latest.nextRunId + 1,
          },
        ]);

        const finalizeRun = Effect.fn("desktop.backendInstance.finalizeRun")(function* (
          reason: string,
        ) {
          yield* mutex.withPermits(1)(
            Effect.gen(function* () {
              const { isCurrentRun, nextState, pid, exitObserved, stopRequested, wasReady } =
                yield* Ref.modify(
                  state,
                  (
                    latest,
                  ): readonly [
                    {
                      readonly isCurrentRun: boolean;
                      readonly nextState: BackendManagerState;
                      readonly pid: Option.Option<number>;
                      readonly exitObserved: boolean;
                      readonly stopRequested: boolean;
                      readonly wasReady: boolean;
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
                          exitObserved: false,
                          stopRequested: false,
                          wasReady: false,
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
                        exitObserved: currentRun.exitObserved,
                        stopRequested: currentRun.stopRequested,
                        wasReady: latest.ready,
                      },
                      next,
                    ] as const;
                  },
                );

              if (isCurrentRun) {
                yield* desktopTelemetryPublisher.removeControlSource(spec.id);
                if (Option.isSome(pid)) {
                  if (exitObserved && !stopRequested) {
                    yield* backendOutputLog.persistFailure({
                      details: `pid=${pid.value} ${reason}`,
                    });
                  } else {
                    yield* backendOutputLog.discardSession;
                  }
                }
                if (wasReady) {
                  yield* spec.onShutdown?.() ?? Effect.void;
                }
              }

              if (isCurrentRun && nextState.desiredRunning) {
                yield* scheduleRestart(reason);
              }
            }),
          );
        });

        const program = runBackendProcess({
          ...config.value,
          desktopTelemetryStream: desktopTelemetryPublisher.encoded,
          onDesktopTelemetryControl: (message) =>
            desktopTelemetryPublisher.handleControlForSource(spec.id, message),
          onStarted: Effect.fn("desktop.backendInstance.onStarted")(function* (pid) {
            yield* updateActiveRun(runId, (run) => ({
              ...run,
              pid: Option.some(pid),
            }));
            yield* backendOutputLog.beginSession({
              details: `pid=${pid} port=${config.value.bootstrap.port} cwd=${config.value.cwd}`,
            });
          }),
          onExitObserved: () =>
            updateActiveRun(runId, (run) => ({
              ...run,
              exitObserved: true,
            })),
          onReady: Effect.fn("desktop.backendInstance.onReady")(function* () {
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
                },
              ] as const;
            });
            if (!isCurrentRun) {
              return;
            }

            yield* spec.onReady?.(config.value.httpBaseUrl) ?? Effect.void;
          }),
          onReadinessFailure: Effect.fn("desktop.backendInstance.onReadinessFailure")(
            function* (error) {
              yield* logInstanceWarning("backend readiness check failed during bootstrap", {
                error: error.message,
              });
              yield* backendOutputLog.persistFailureSnapshot({
                details: error.message,
              });
            },
          ),
          onOutput: (streamName, chunk) => backendOutputLog.writeOutputChunk(streamName, chunk),
        }).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(HttpClient.HttpClient, httpClient),
          Scope.provide(runScope),
          Effect.matchEffect({
            onFailure: (error) => finalizeRun(error.message),
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
  ).pipe(Effect.withSpan("desktop.backendInstance.start", { attributes: { id: spec.id } }));

  const scheduleRestart = Effect.fn("desktop.backendInstance.scheduleRestart")(function* (
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
      onSome: Effect.fn("desktop.backendInstance.scheduleRestartFiber")(function* (delay) {
        yield* logInstanceError("backend exited unexpectedly; restart scheduled", {
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
            Effect.catchCause((cause) =>
              logInstanceError("desktop backend restart fiber failed", {
                cause: Cause.pretty(cause),
              }),
            ),
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

  const stop = Effect.fn("desktop.backendInstance.stop")(function* (options?: {
    readonly timeout?: Duration.Duration;
  }) {
    const { active, restartFiber, notifyShutdown } = yield* mutex.withPermits(1)(
      Effect.gen(function* () {
        const result = yield* Ref.modify(state, (latest) => {
          const active = Option.map(latest.active, (run) =>
            run.exitObserved ? run : { ...run, stopRequested: true },
          );
          return [
            {
              active,
              restartFiber: latest.restartFiber,
              notifyShutdown: latest.ready,
            },
            {
              ...latest,
              desiredRunning: false,
              ready: false,
              active,
              restartFiber: Option.none<Fiber.Fiber<void, never>>(),
            },
          ] as const;
        });
        return result;
      }),
    );

    if (notifyShutdown) {
      yield* (spec.onShutdown?.() ?? Effect.void).pipe(Effect.ignore);
    }
    yield* Option.match(restartFiber, {
      onNone: () => Effect.void,
      onSome: (fiber) => Fiber.interrupt(fiber).pipe(Effect.asVoid),
    });
    yield* Option.match(active, {
      onNone: () => Effect.void,
      onSome: (run) =>
        Effect.gen(function* () {
          const closed = yield* closeRun(run, parentScope, options);
          if (!closed) {
            return;
          }
          const cleanup = yield* mutex.withPermits(1)(
            Ref.modify(
              state,
              (
                latest,
              ): readonly [
                {
                  readonly needsCleanup: boolean;
                  readonly shouldStart: boolean;
                },
                BackendManagerState,
              ] => {
                const current = Option.getOrUndefined(latest.active);
                if (current?.id !== run.id) {
                  return [
                    {
                      needsCleanup: false,
                      shouldStart:
                        latest.desiredRunning &&
                        Option.isNone(latest.active) &&
                        Option.isNone(latest.restartFiber),
                    },
                    latest,
                  ];
                }
                return [
                  {
                    needsCleanup: true,
                    shouldStart: latest.desiredRunning,
                  },
                  {
                    ...latest,
                    active: Option.none<ActiveBackendRun>(),
                  },
                ];
              },
            ),
          );
          if (cleanup.needsCleanup) {
            yield* desktopTelemetryPublisher.removeControlSource(spec.id);
            yield* backendOutputLog.discardSession;
          }
          if (cleanup.shouldStart) {
            yield* start;
          }
        }),
    });
  });

  const waitForReady = (timeout: Duration.Duration): Effect.Effect<boolean> =>
    Effect.gen(function* () {
      const current = yield* Ref.get(state);
      // Return false early if an external `stop()` flipped desiredRunning off
      // — no point polling for a backend that is being torn down.
      if (!current.desiredRunning) return { done: true, ready: false };
      return current.ready ? { done: true, ready: true } : { done: false, ready: false };
    }).pipe(
      Effect.repeat({
        until: (status) => status.done,
        schedule: Schedule.spaced(Duration.millis(100)),
      }),
      Effect.map((status) => status.ready),
      Effect.timeoutOption(timeout),
      Effect.map(Option.getOrElse(() => false)),
    );

  yield* Effect.addFinalizer(() => stop());

  return {
    id: spec.id,
    label: spec.label,
    start,
    stop,
    currentConfig,
    snapshot,
    waitForReady,
  } satisfies DesktopBackendInstance;
});
