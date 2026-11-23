import {
  AuthAdministrativeClientScopes,
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
const ATTACHED_SESSION_TTL = "30d";

export interface AttachedBackgroundService {
  readonly pid: number;
  readonly port: number;
  readonly httpBaseUrl: URL;
  readonly serverVersion: string | undefined;
  readonly label: string;
}

export class DesktopBackgroundServiceError extends Schema.TaggedError<DesktopBackgroundServiceError>()(
  "DesktopBackgroundServiceError",
  {
    operation: Schema.Literals(["status", "issue-token"]),
    message: Schema.String,
  },
) {}

const isDesktopBackgroundServiceError = Schema.is(DesktopBackgroundServiceError);

export class DesktopBackgroundService extends Context.Service<
  DesktopBackgroundService,
  {
    readonly attached: Effect.Effect<Option.Option<AttachedBackgroundService>>;
    readonly tryAttach: Effect.Effect<Option.Option<AttachedBackgroundService>>;
    readonly clearAttached: Effect.Effect<void>;
    readonly issueBearerToken: Effect.Effect<string, DesktopBackgroundServiceError>;
    readonly status: Effect.Effect<DesktopBackgroundServiceState>;
  }
>()("@t3tools/desktop/backend/DesktopBackgroundService") {}

const primaryLabelForPlatform = (platform: NodeJS.Platform): string =>
  platform === "win32" ? "Windows" : "Local environment";

/** @public */
export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const appSettings = yield* DesktopAppSettings.DesktopAppSettings;
  const httpClient = yield* HttpClient.HttpClient;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const attachedRef = yield* Ref.make(Option.none<AttachedBackgroundService>());

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

  const probeHealthyService = (httpBaseUrl: URL) =>
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
          times: ENVIRONMENT_PROBE_MAX_RETRIES,
        }),
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      );

  const readRunningServiceOwner = Effect.gen(function* () {
    const locked = yield* DesktopHomeOwner.isHomeOwnershipLocked().pipe(
      Effect.provideContext(homeOwnerContext),
    );
    if (!locked) return Option.none<DesktopHomeOwner.HomeOwner>();
    const owner = yield* DesktopHomeOwner.readLiveHomeOwner().pipe(
      Effect.provideContext(homeOwnerContext),
    );
    return Option.filter(owner, (candidate) => candidate.serviceManaged === true);
  });

  const tryAttach = Effect.gen(function* () {
    const owner = yield* readRunningServiceOwner;
    if (Option.isNone(owner)) {
      yield* Ref.set(attachedRef, Option.none());
      return Option.none<AttachedBackgroundService>();
    }
    const httpBaseUrl = DesktopHomeOwner.resolveHomeOwnerHttpBaseUrl(owner.value);
    const healthy = yield* probeHealthyService(httpBaseUrl);
    if (!healthy) {
      yield* logWarning(
        "background service holds the T3 home lock but did not answer health probe",
        {
          pid: owner.value.pid,
          httpBaseUrl: httpBaseUrl.href,
        },
      );
      yield* Ref.set(attachedRef, Option.none());
      return Option.none<AttachedBackgroundService>();
    }
    const attached: AttachedBackgroundService = {
      pid: owner.value.pid,
      port: owner.value.port,
      httpBaseUrl,
      serverVersion: owner.value.serverVersion,
      label: primaryLabelForPlatform(environment.platform),
    };
    yield* Ref.set(attachedRef, Option.some(attached));
    yield* logInfo("attached to local background service", {
      pid: attached.pid,
      port: attached.port,
      httpBaseUrl: attached.httpBaseUrl.href,
      serverVersion: attached.serverVersion ?? null,
    });
    return Option.some(attached);
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
        message: "The local background service did not return a desktop session token.",
      });
    }
    return token;
  }).pipe(Effect.withSpan("desktop.backgroundService.issueBearerToken"));

  const status = Effect.gen(function* () {
    const [settings, attached, runningOwner] = yield* Effect.all([
      appSettings.get,
      Ref.get(attachedRef),
      readRunningServiceOwner,
    ]);
    const externalService = Option.isSome(runningOwner);
    return {
      supported: true,
      enabled: settings.backgroundServiceEnabled || externalService,
      running: externalService,
      attached: Option.isSome(attached),
      externalService,
      version: Option.getOrUndefined(runningOwner)?.serverVersion ?? null,
    } satisfies DesktopBackgroundServiceState;
  }).pipe(Effect.withSpan("desktop.backgroundService.status"));

  return DesktopBackgroundService.of({
    attached: Ref.get(attachedRef),
    tryAttach,
    clearAttached: Ref.set(attachedRef, Option.none()),
    issueBearerToken,
    status,
  });
});

export const layer = Layer.effect(DesktopBackgroundService, make);
