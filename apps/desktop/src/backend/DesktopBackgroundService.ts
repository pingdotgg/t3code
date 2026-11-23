// @effect-diagnostics nodeBuiltinImport:off -- Spawns a detached headless server that outlives the desktop window.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";

import {
  AuthAdministrativeClientScopes,
  DESKTOP_UPDATE_RESTART_MARKER_FILE,
  type DesktopBackgroundServiceState,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopObservability from "../app/DesktopObservability.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopHomeOwner from "./DesktopHomeOwner.ts";

const { logInfo, logWarning } = DesktopObservability.makeComponentLogger(
  "desktop-background-service",
);

const ENVIRONMENT_PROBE_PATH = "/.well-known/t3/environment";
const ENVIRONMENT_PROBE_REQUEST_TIMEOUT = Duration.millis(1_500);
const ENVIRONMENT_PROBE_RETRY_INTERVAL = Duration.millis(250);
const ENVIRONMENT_PROBE_MAX_RETRIES = 20;
const STARTUP_PROBE_MAX_RETRIES = 60;
const STOP_POLL_INTERVAL = Duration.millis(150);
const STOP_GRACE_TIMEOUT = Duration.seconds(5);
const ATTACHED_SESSION_TTL = "30d";
const DESKTOP_BACKGROUND_LOG_FILE = "background-server.log";
const DESKTOP_BACKGROUND_STOP_FILE = "desktop-background-stop";

export interface AttachedBackgroundService {
  readonly pid: number;
  readonly port: number;
  readonly httpBaseUrl: URL;
  readonly serverVersion: string | undefined;
  readonly label: string;
  readonly managedByDesktop: boolean;
}

export interface StartDetachedBackgroundServerOptions {
  readonly port: number;
  readonly bindHost: string;
  readonly tailscaleServeEnabled: boolean;
  readonly tailscaleServePort: number;
  readonly attach?: boolean;
}

export class DesktopBackgroundServiceError extends Schema.TaggedError<DesktopBackgroundServiceError>()(
  "DesktopBackgroundServiceError",
  {
    operation: Schema.Literals(["status", "start", "stop", "issue-token"]),
    message: Schema.String,
  },
) {}

const isDesktopBackgroundServiceError = Schema.is(DesktopBackgroundServiceError);

const isProcessAlive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
};

export class DesktopBackgroundService extends Context.Service<
  DesktopBackgroundService,
  {
    readonly attached: Effect.Effect<Option.Option<AttachedBackgroundService>>;
    readonly tryAttach: Effect.Effect<Option.Option<AttachedBackgroundService>>;
    readonly clearAttached: Effect.Effect<void>;
    readonly issueBearerToken: Effect.Effect<string, DesktopBackgroundServiceError>;
    readonly status: Effect.Effect<DesktopBackgroundServiceState>;
    readonly startDetached: (
      options: StartDetachedBackgroundServerOptions,
    ) => Effect.Effect<Option.Option<AttachedBackgroundService>, DesktopBackgroundServiceError>;
    readonly stopDetached: (options?: { readonly preserveRelay?: boolean }) => Effect.Effect<void>;
  }
>()("@t3tools/desktop/backend/DesktopBackgroundService") {}

const primaryLabelForPlatform = (platform: NodeJS.Platform): string =>
  platform === "win32" ? "Windows" : "Local environment";

const isAttachableOwner = (owner: DesktopHomeOwner.HomeOwner): boolean =>
  owner.serviceManaged === true || owner.desktopBackgroundManaged === true;

const isDesktopManagedOwner = (owner: DesktopHomeOwner.HomeOwner): boolean =>
  owner.desktopBackgroundManaged === true && owner.serviceManaged !== true;

/** @public */
export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const appSettings = yield* DesktopAppSettings.DesktopAppSettings;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const httpClient = yield* HttpClient.HttpClient;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const attachedRef = yield* Ref.make(Option.none<AttachedBackgroundService>());
  const operationMutex = yield* Semaphore.make(1);

  const homeOwnerContext = yield* Effect.context<
    FileSystem.FileSystem | Path.Path | DesktopEnvironment.DesktopEnvironment
  >();

  const runBundledCli = Effect.fn("desktop.backgroundService.runBundledCli")(function* (
    operation: DesktopBackgroundServiceError["operation"],
    args: ReadonlyArray<string>,
  ) {
    const command = ChildProcess.make(process.execPath, [environment.backendEntryPath, ...args], {
      cwd: environment.backendCwd,
      env: {
        ELECTRON_RUN_AS_NODE: "1",
        T3CODE_HOME: environment.baseDir,
      },
      extendEnv: true,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      shell: false,
    });
    return yield* Effect.gen(function* () {
      const handle = yield* spawner.spawn(command);
      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
          handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
          handle.exitCode,
        ],
        { concurrency: "unbounded" },
      );
      if (Number(exitCode) !== 0) {
        const detail = stderr.trim() || stdout.trim() || `CLI exited with code ${exitCode}.`;
        return yield* new DesktopBackgroundServiceError({
          operation,
          message: detail,
        });
      }
      return stdout;
    }).pipe(
      Effect.scoped,
      Effect.mapError((error) =>
        isDesktopBackgroundServiceError(error)
          ? error
          : new DesktopBackgroundServiceError({
              operation,
              message: error instanceof Error ? error.message : String(error),
            }),
      ),
    );
  });

  const probeHealthyService = (httpBaseUrl: URL, maxRetries: number) =>
    httpClient
      .execute(HttpClientRequest.get(new URL(ENVIRONMENT_PROBE_PATH, httpBaseUrl).href))
      .pipe(
        Effect.timeout(ENVIRONMENT_PROBE_REQUEST_TIMEOUT),
        Effect.flatMap((response) =>
          response.status >= 200 && response.status < 300
            ? Effect.void
            : Effect.fail(
                new DesktopBackgroundServiceError({
                  operation: "status",
                  message: `Unexpected probe status ${response.status}`,
                }),
              ),
        ),
        Effect.retry({
          schedule: Schedule.spaced(ENVIRONMENT_PROBE_RETRY_INTERVAL),
          times: maxRetries,
        }),
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      );

  const readRunningBackgroundOwner = Effect.gen(function* () {
    const locked = yield* DesktopHomeOwner.isHomeOwnershipLocked().pipe(
      Effect.provideContext(homeOwnerContext),
    );
    if (!locked) return Option.none<DesktopHomeOwner.HomeOwner>();
    const owner = yield* DesktopHomeOwner.readLiveHomeOwner().pipe(
      Effect.provideContext(homeOwnerContext),
    );
    return Option.filter(owner, isAttachableOwner);
  });

  const attachToOwner = Effect.fn("desktop.backgroundService.attachToOwner")(function* (
    owner: DesktopHomeOwner.HomeOwner,
    maxRetries: number,
  ) {
    const httpBaseUrl = DesktopHomeOwner.resolveHomeOwnerHttpBaseUrl(owner);
    const healthy = yield* probeHealthyService(httpBaseUrl, maxRetries);
    if (!healthy) {
      yield* logWarning(
        "background server holds the T3 home lock but did not answer health probe",
        {
          pid: owner.pid,
          httpBaseUrl: httpBaseUrl.href,
        },
      );
      yield* Ref.set(attachedRef, Option.none());
      return Option.none<AttachedBackgroundService>();
    }
    const attached: AttachedBackgroundService = {
      pid: owner.pid,
      port: owner.port,
      httpBaseUrl,
      serverVersion: owner.serverVersion,
      label: primaryLabelForPlatform(environment.platform),
      managedByDesktop: isDesktopManagedOwner(owner),
    };
    yield* Ref.set(attachedRef, Option.some(attached));
    yield* logInfo("attached to local background server", {
      pid: attached.pid,
      port: attached.port,
      httpBaseUrl: attached.httpBaseUrl.href,
      managedByDesktop: attached.managedByDesktop,
      serverVersion: attached.serverVersion ?? null,
    });
    return Option.some(attached);
  });

  const tryAttach = Effect.gen(function* () {
    const owner = yield* readRunningBackgroundOwner;
    if (Option.isNone(owner)) {
      yield* Ref.set(attachedRef, Option.none());
      return Option.none<AttachedBackgroundService>();
    }
    return yield* attachToOwner(owner.value, ENVIRONMENT_PROBE_MAX_RETRIES);
  }).pipe(Effect.withSpan("desktop.backgroundService.tryAttach"));

  const issueBearerToken = Effect.gen(function* () {
    const stdout = yield* runBundledCli("issue-token", [
      "auth",
      "session",
      "issue",
      "--base-dir",
      environment.baseDir,
      ...AuthAdministrativeClientScopes.flatMap((scope) => ["--scope", scope]),
      "--label",
      "T3 Code Desktop",
      "--subject",
      "desktop-service",
      "--ttl",
      ATTACHED_SESSION_TTL,
      "--token-only",
    ]);
    const token = stdout.trim();
    if (token.length === 0) {
      return yield* new DesktopBackgroundServiceError({
        operation: "issue-token",
        message: "The local background server did not return a desktop session token.",
      });
    }
    return token;
  }).pipe(Effect.withSpan("desktop.backgroundService.issueBearerToken"));

  const status = Effect.gen(function* () {
    const [settings, attached, runningOwner] = yield* Effect.all([
      appSettings.get,
      Ref.get(attachedRef),
      readRunningBackgroundOwner,
    ]);
    const externalService =
      Option.isSome(runningOwner) && runningOwner.value.serviceManaged === true;
    return {
      supported: true,
      enabled: settings.backgroundServiceEnabled || externalService,
      running: Option.isSome(runningOwner),
      attached: Option.isSome(attached),
      externalService,
      version: Option.getOrUndefined(runningOwner)?.serverVersion ?? null,
    } satisfies DesktopBackgroundServiceState;
  }).pipe(Effect.withSpan("desktop.backgroundService.status"));

  const runtimeDir = path.join(environment.baseDir, "runtime");
  const stopFilePath = path.join(runtimeDir, DESKTOP_BACKGROUND_STOP_FILE);
  const restartMarkerPath = path.join(runtimeDir, DESKTOP_UPDATE_RESTART_MARKER_FILE);

  const startDetached = Effect.fn("desktop.backgroundService.startDetached")(function* (
    options: StartDetachedBackgroundServerOptions,
  ) {
    return yield* operationMutex.withPermits(1)(
      Effect.gen(function* () {
        yield* fileSystem
          .makeDirectory(environment.logDir, { recursive: true })
          .pipe(Effect.ignore);
        yield* fileSystem.remove(stopFilePath, { force: true }).pipe(Effect.ignore);

        const logPath = path.join(environment.logDir, DESKTOP_BACKGROUND_LOG_FILE);
        const args = [
          ...(environment.isPackaged ? ["--require", environment.compileCachePath] : []),
          environment.backendEntryPath,
          "serve",
          "--mode",
          "desktop",
          "--no-browser",
          "--base-dir",
          environment.baseDir,
          "--port",
          String(options.port),
          "--host",
          options.bindHost,
          ...(options.tailscaleServeEnabled
            ? ["--tailscale-serve", "--tailscale-serve-port", String(options.tailscaleServePort)]
            : []),
        ];

        const spawnedPid = yield* Effect.try({
          try: () => {
            const logFd = NodeFS.openSync(logPath, "a");
            try {
              const child = NodeChildProcess.spawn(process.execPath, args, {
                cwd: environment.backendCwd,
                detached: true,
                windowsHide: true,
                stdio: ["ignore", logFd, logFd],
                env: {
                  ...process.env,
                  ELECTRON_RUN_AS_NODE: "1",
                  T3CODE_HOME: environment.baseDir,
                  T3CODE_DESKTOP_BACKGROUND_SERVER: "1",
                  T3CODE_NO_BROWSER: "1",
                },
              });
              child.unref();
              if (child.pid === undefined) {
                throw new Error("Detached background server did not report a PID.");
              }
              return child.pid;
            } finally {
              NodeFS.closeSync(logFd);
            }
          },
          catch: (cause) =>
            new DesktopBackgroundServiceError({
              operation: "start",
              message: cause instanceof Error ? cause.message : String(cause),
            }),
        });

        yield* logInfo("spawned detached background server", {
          pid: spawnedPid,
          port: options.port,
          bindHost: options.bindHost,
          attach: options.attach === true,
        });

        if (options.attach !== true) {
          return Option.none<AttachedBackgroundService>();
        }

        const expectedBaseUrl = new URL(`http://127.0.0.1:${options.port}`);
        const ready = yield* probeHealthyService(expectedBaseUrl, STARTUP_PROBE_MAX_RETRIES);
        if (!ready) {
          return yield* new DesktopBackgroundServiceError({
            operation: "start",
            message: "Detached background server did not become ready in time.",
          });
        }
        const owner = yield* readRunningBackgroundOwner;
        if (Option.isSome(owner)) {
          return yield* attachToOwner(owner.value, ENVIRONMENT_PROBE_MAX_RETRIES);
        }
        const fallbackAttached: AttachedBackgroundService = {
          pid: spawnedPid,
          port: options.port,
          httpBaseUrl: expectedBaseUrl,
          serverVersion: environment.appVersion,
          label: primaryLabelForPlatform(environment.platform),
          managedByDesktop: true,
        };
        yield* Ref.set(attachedRef, Option.some(fallbackAttached));
        return Option.some(fallbackAttached);
      }),
    );
  });

  const stopDetached = Effect.fn("desktop.backgroundService.stopDetached")(function* (options?: {
    readonly preserveRelay?: boolean;
  }) {
    yield* operationMutex.withPermits(1)(
      Effect.gen(function* () {
        const owner = yield* readRunningBackgroundOwner;
        const attached = yield* Ref.get(attachedRef);
        const targetPid = Option.isSome(owner)
          ? isDesktopManagedOwner(owner.value)
            ? owner.value.pid
            : undefined
          : Option.isSome(attached) && attached.value.managedByDesktop
            ? attached.value.pid
            : undefined;
        yield* Ref.set(attachedRef, Option.none());
        if (targetPid === undefined || !isProcessAlive(targetPid)) {
          return;
        }

        if (options?.preserveRelay === true) {
          yield* fileSystem.makeDirectory(runtimeDir, { recursive: true }).pipe(Effect.ignore);
          yield* fileSystem
            .writeFileString(restartMarkerPath, "", { mode: 0o600 })
            .pipe(Effect.ignore);
        }

        yield* logInfo("stopping desktop-managed background server", {
          pid: targetPid,
          preserveRelay: options?.preserveRelay === true,
        });

        if (environment.platform === "win32") {
          yield* fileSystem.makeDirectory(runtimeDir, { recursive: true }).pipe(Effect.ignore);
          yield* fileSystem
            .writeFileString(stopFilePath, `${targetPid}\n`, { mode: 0o600 })
            .pipe(Effect.ignore);
        } else {
          yield* Effect.sync(() => {
            try {
              process.kill(targetPid, "SIGTERM");
            } catch {}
          });
        }

        const stoppedGracefully = yield* Effect.gen(function* () {
          while (
            isProcessAlive(targetPid) &&
            (yield* DesktopHomeOwner.isHomeOwnershipLocked().pipe(
              Effect.provideContext(homeOwnerContext),
            ))
          ) {
            yield* Effect.sleep(STOP_POLL_INTERVAL);
          }
          return true;
        }).pipe(
          Effect.timeoutOrElse({
            duration: STOP_GRACE_TIMEOUT,
            orElse: () => Effect.succeed(false),
          }),
        );

        if (!stoppedGracefully && isProcessAlive(targetPid)) {
          yield* logWarning("background server did not exit gracefully; terminating", {
            pid: targetPid,
          });
          yield* Effect.sync(() => {
            try {
              process.kill(targetPid, environment.platform === "win32" ? "SIGTERM" : "SIGKILL");
            } catch {}
          });
        }
        yield* fileSystem.remove(stopFilePath, { force: true }).pipe(Effect.ignore);
      }),
    );
  });

  return DesktopBackgroundService.of({
    attached: Ref.get(attachedRef),
    tryAttach,
    clearAttached: Ref.set(attachedRef, Option.none()),
    issueBearerToken,
    status,
    startDetached,
    stopDetached,
  });
});

export const layer = Layer.effect(DesktopBackgroundService, make);
