import {
  DEFAULT_CBM_BINARY_PATH,
  DEFAULT_HEADROOM_PROXY_URL,
  normalizeHeadroomProxyUrl,
  type CbmProjectIndexStatus,
  OptimizerStartError,
  type OptimizerSavingsInterval,
  type OptimizerSavingsPoint,
  type OptimizerSavingsSummary,
  type OptimizerStatus,
  type OptimizerStatusSnapshot,
  type ServerSettingsError,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Scope from "effect/Scope";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { isWindowsCommandNotFound } from "@t3tools/provider-core/server/snapshotProbe";
import * as ProcessRunner from "../processRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import { CbmIndexService } from "./CbmIndexService.ts";
import { cpaHeadroomUpstream, readCpaRoutingState } from "./CpaRouting.ts";

const PROBE_TIMEOUT = Duration.seconds(4);
const REFRESH_COOLDOWN_MS = 5_000;
const HEADROOM_READY_TIMEOUT_MS = 10_000;
const HEADROOM_READY_POLL_MS = 100;

const RtkGain = Schema.Struct({
  summary: Schema.Struct({
    total_saved: Schema.Number,
  }),
});

const HeadroomStats = Schema.Struct({
  display_session: Schema.Unknown,
});

const HeadroomHealth = Schema.Struct({
  service: Schema.Literal("headroom-proxy"),
  status: Schema.Literals(["healthy", "unhealthy"]),
  version: Schema.optionalKey(Schema.String),
});

const HeadroomDisplaySession = Schema.Struct({ tokens_saved: Schema.optionalKey(Schema.Unknown) });
const HeadroomHistoryPoint = Schema.Struct({
  timestamp: Schema.String,
  tokens_saved: Schema.Unknown,
});
const HeadroomHistorySeries = Schema.Struct({
  hourly: Schema.optionalKey(Schema.Array(Schema.Unknown)),
  daily: Schema.optionalKey(Schema.Array(Schema.Unknown)),
  weekly: Schema.optionalKey(Schema.Array(Schema.Unknown)),
  monthly: Schema.optionalKey(Schema.Array(Schema.Unknown)),
});
const HeadroomHistory = Schema.Struct({ series: Schema.optionalKey(Schema.Unknown) });

const decodeRtkGain = Schema.decodeUnknownOption(Schema.fromJsonString(RtkGain));
const decodeHeadroomStats = Schema.decodeUnknownOption(HeadroomStats);
const decodeHeadroomHealth = Schema.decodeUnknownOption(HeadroomHealth);
const decodeHeadroomDisplaySession = Schema.decodeUnknownOption(HeadroomDisplaySession);
const decodeHeadroomHistory = Schema.decodeUnknownOption(HeadroomHistory);
const decodeHeadroomHistorySeries = Schema.decodeUnknownOption(HeadroomHistorySeries);
const decodeHeadroomHistoryPoint = Schema.decodeUnknownOption(HeadroomHistoryPoint);

interface OptimizerDiscoverySnapshot {
  readonly optimizers: ReadonlyArray<OptimizerStatus>;
  readonly savings: ReadonlyArray<OptimizerSavingsSummary>;
  readonly savingsHistory: ReadonlyArray<OptimizerSavingsPoint>;
}

export interface OptimizerProbeDependencies {
  readonly run: (
    input: ProcessRunner.ProcessRunInput,
  ) => Effect.Effect<ProcessRunner.ProcessRunOutput, ProcessRunner.ProcessRunError>;
  readonly isMissingResult: (result: ProcessRunner.ProcessRunOutput) => Effect.Effect<boolean>;
  readonly fetchHeadroomStats: (
    proxyUrl: string,
  ) => Effect.Effect<unknown, HeadroomStatsProbeError>;
  readonly fetchHeadroomHealth: (
    proxyUrl: string,
  ) => Effect.Effect<unknown, HeadroomStatsProbeError>;
  readonly fetchHeadroomHistory: (
    proxyUrl: string,
  ) => Effect.Effect<unknown, HeadroomStatsProbeError>;
  readonly spawnHeadroomProxy: (input: {
    readonly host: string;
    readonly port: number;
    readonly upstream: HeadroomUpstream;
    readonly scope: Scope.Scope;
  }) => Effect.Effect<OptimizerOwnedHeadroomProcess, OptimizerStartError>;
  /** Where a T3-owned Headroom forwards; empty means Headroom's own defaults. */
  readonly getHeadroomUpstream: Effect.Effect<HeadroomUpstream>;
  readonly getCbmBinaryPath: Effect.Effect<string, ServerSettingsError>;
  readonly getHeadroomProxyUrl: Effect.Effect<string, ServerSettingsError>;
  readonly listCbmIndexes: Effect.Effect<ReadonlyArray<CbmProjectIndexStatus>>;
  readonly now: Effect.Effect<string>;
  readonly nowMs: Effect.Effect<number>;
  readonly sleep: (milliseconds: number) => Effect.Effect<void>;
}

export interface HeadroomUpstream {
  readonly anthropic?: string;
  readonly openai?: string;
}

const sameUpstream = (left: HeadroomUpstream, right: HeadroomUpstream) =>
  left.anthropic === right.anthropic && left.openai === right.openai;

export interface OptimizerOwnedHeadroomProcess {
  readonly isRunning: Effect.Effect<boolean, OptimizerStartError>;
  readonly exitCode: Effect.Effect<number, OptimizerStartError>;
}

class HeadroomStatsProbeError extends Schema.TaggedError<HeadroomStatsProbeError>()(
  "HeadroomStatsProbeError",
  {},
) {}

export class OptimizerProbeService extends Context.Service<
  OptimizerProbeService,
  {
    /** Omitted refresh serves the shared cache; refresh coalesces concurrent probes. */
    readonly getStatus: (input: {
      readonly refresh?: boolean | undefined;
      readonly force?: boolean | undefined;
    }) => Effect.Effect<OptimizerStatusSnapshot>;
    /** Also restarts a T3-owned Headroom whose upstream no longer matches the CLI configs. */
    readonly startHeadroom: () => Effect.Effect<OptimizerStatusSnapshot, OptimizerStartError>;
    /** The upstream of the Headroom this server started, or null when it did not start one. */
    readonly ownedHeadroomUpstream: Effect.Effect<HeadroomUpstream | null>;
  }
>()("t3/optimizer/OptimizerProbeService") {}

const safeTokenCount = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;

function parseRtkSavings(stdout: string): number | null {
  const decoded = decodeRtkGain(stdout);
  return Option.isSome(decoded) ? safeTokenCount(decoded.value.summary.total_saved) : null;
}

export function parseHeadroomSavings(input: unknown): number | null {
  const stats = decodeHeadroomStats(input);
  if (Option.isNone(stats)) return null;

  const displaySession = decodeHeadroomDisplaySession(stats.value.display_session);
  return Option.isSome(displaySession) ? safeTokenCount(displaySession.value.tokens_saved) : null;
}

export function parseHeadroomSavingsHistory(input: unknown): ReadonlyArray<OptimizerSavingsPoint> {
  const history = decodeHeadroomHistory(input);
  if (Option.isNone(history)) return [];
  const series = decodeHeadroomHistorySeries(history.value.series);
  if (Option.isNone(series)) return [];

  const intervals: ReadonlyArray<
    readonly [OptimizerSavingsInterval, ReadonlyArray<unknown> | undefined]
  > = [
    ["hour", series.value.hourly],
    ["day", series.value.daily],
    ["week", series.value.weekly],
    ["month", series.value.monthly],
  ];
  const points: OptimizerSavingsPoint[] = [];
  for (const [interval, entries] of intervals) {
    for (const entry of entries ?? []) {
      const decoded = decodeHeadroomHistoryPoint(entry);
      if (Option.isNone(decoded)) continue;
      const timestamp = DateTime.make(decoded.value.timestamp);
      const tokensSaved = safeTokenCount(decoded.value.tokens_saved);
      if (Option.isNone(timestamp) || tokensSaved === null) continue;
      points.push({
        source: "headroom",
        scope: "environment",
        interval,
        timestamp: DateTime.formatIso(timestamp.value),
        tokensSaved,
      });
    }
  }
  return points;
}

const versionFromOutput = (output: string): string | null =>
  output.match(/\b(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/)?.[1] ?? null;

const failureDetail = (error: ProcessRunner.ProcessRunError): string => {
  if (error._tag === "ProcessTimeoutError") return "Version probe timed out.";
  return "Version probe failed.";
};

const isMissingRunError = (error: ProcessRunner.ProcessRunError): boolean =>
  error._tag === "ProcessSpawnError" &&
  error.cause instanceof PlatformError.PlatformError &&
  error.cause.reason._tag === "NotFound";

interface VersionProbe {
  readonly installed: boolean;
  readonly version: string | null;
  readonly detail?: string;
}

export const makeWith = Effect.fn("OptimizerProbeService.makeWith")(function* (
  dependencies: OptimizerProbeDependencies,
) {
  const cache = yield* Ref.make<{
    readonly revision: number;
    readonly snapshot: OptimizerDiscoverySnapshot | null;
    readonly cbmBinaryPath: string | null;
    readonly headroomProxyUrl: string | null;
    readonly refreshedAtMs: number | null;
  }>({
    revision: 0,
    snapshot: null,
    cbmBinaryPath: null,
    headroomProxyUrl: null,
    refreshedAtMs: null,
  });
  const refreshLock = yield* Semaphore.make(1);
  const startLock = yield* Semaphore.make(1);
  const proxyScope = yield* Effect.acquireRelease(Scope.make("sequential"), (scope) =>
    Scope.close(scope, Exit.void),
  );
  const ownedProcess = yield* Ref.make<{
    readonly proxyUrl: string;
    readonly upstream: HeadroomUpstream;
    readonly scope: Scope.Closeable;
    readonly process: OptimizerOwnedHeadroomProcess;
  } | null>(null);

  const versionProbe = Effect.fn("OptimizerProbeService.versionProbe")(function* (
    command: string,
  ): Effect.fn.Return<VersionProbe> {
    const attempt = yield* dependencies
      .run({
        command,
        args: ["--version"],
        timeout: PROBE_TIMEOUT,
        maxOutputBytes: 32 * 1024,
        outputMode: "truncate",
      })
      .pipe(
        Effect.match({
          onFailure: (left) => ({ _tag: "Left" as const, left }),
          onSuccess: (right) => ({ _tag: "Right" as const, right }),
        }),
      );
    if (attempt._tag === "Left") {
      return {
        installed: false,
        version: null,
        detail: isMissingRunError(attempt.left)
          ? "Command was not found."
          : failureDetail(attempt.left),
      };
    }
    if (yield* dependencies.isMissingResult(attempt.right)) {
      return { installed: false, version: null, detail: "Command was not found." };
    }
    const version = versionFromOutput(`${attempt.right.stdout}\n${attempt.right.stderr}`);
    if (attempt.right.timedOut) {
      return { installed: false, version: null, detail: "Version probe timed out." };
    }
    if (attempt.right.code !== 0) {
      return {
        installed: false,
        version,
        detail: `Version probe exited with code ${String(attempt.right.code)}.`,
      };
    }
    if (version === null) {
      return {
        installed: false,
        version: null,
        detail: "The installed version could not be parsed.",
      };
    }
    return { installed: true, version };
  });

  const discover = Effect.fn("OptimizerProbeService.discover")(function* (
    cbmBinaryPath: string,
    headroomProxyUrl: string,
  ) {
    const [
      rtk,
      cbm,
      headroomCli,
      headroomStatsResult,
      headroomHealthResult,
      headroomHistoryResult,
    ] = yield* Effect.all(
      [
        versionProbe("rtk"),
        versionProbe(cbmBinaryPath),
        versionProbe("headroom"),
        dependencies.fetchHeadroomStats(headroomProxyUrl).pipe(
          Effect.match({
            onFailure: (left) => ({ _tag: "Left" as const, left }),
            onSuccess: (right) => ({ _tag: "Right" as const, right }),
          }),
        ),
        dependencies.fetchHeadroomHealth(headroomProxyUrl).pipe(
          Effect.match({
            onFailure: (left) => ({ _tag: "Left" as const, left }),
            onSuccess: (right) => ({ _tag: "Right" as const, right }),
          }),
        ),
        dependencies.fetchHeadroomHistory(headroomProxyUrl).pipe(
          Effect.match({
            onFailure: (left) => ({ _tag: "Left" as const, left }),
            onSuccess: (right) => ({ _tag: "Right" as const, right }),
          }),
        ),
      ],
      { concurrency: "unbounded" },
    );
    const checkedAt = yield* dependencies.now;

    const headroomStats =
      headroomStatsResult._tag === "Right"
        ? decodeHeadroomStats(headroomStatsResult.right)
        : Option.none();
    const headroomHealth =
      headroomHealthResult._tag === "Right"
        ? decodeHeadroomHealth(headroomHealthResult.right)
        : Option.none();
    const headroomReportedUnhealthy =
      Option.isSome(headroomHealth) && headroomHealth.value.status === "unhealthy";
    const headroomRunning =
      !headroomReportedUnhealthy &&
      (Option.isSome(headroomStats) ||
        (Option.isSome(headroomHealth) && headroomHealth.value.status === "healthy"));
    const headroomSavings =
      headroomRunning && Option.isSome(headroomStats)
        ? parseHeadroomSavings(headroomStats.value)
        : null;
    const savingsHistory =
      headroomRunning && headroomHistoryResult._tag === "Right"
        ? parseHeadroomSavingsHistory(headroomHistoryResult.right)
        : [];

    const rtkSavings = rtk.installed
      ? yield* dependencies
          .run({
            command: "rtk",
            args: ["gain", "--all", "--format", "json"],
            timeout: PROBE_TIMEOUT,
            maxOutputBytes: 256 * 1024,
            outputMode: "truncate",
          })
          .pipe(
            Effect.map((result) => (result.code === 0 ? parseRtkSavings(result.stdout) : null)),
            Effect.catchCause(() => Effect.succeed(null)),
          )
      : null;

    const optimizers: OptimizerStatus[] = [
      {
        id: "rtk",
        installed: rtk.installed,
        version: rtk.version,
        mode: "cli-wrapper",
        checkedAt,
        ...(rtk.detail === undefined ? {} : { detail: rtk.detail }),
      },
      {
        id: "headroom",
        installed:
          headroomCli.installed || Option.isSome(headroomStats) || Option.isSome(headroomHealth),
        version:
          headroomCli.version ??
          (Option.isSome(headroomHealth)
            ? versionFromOutput(headroomHealth.value.version ?? "")
            : null),
        running: headroomRunning,
        mode: "detected-proxy",
        checkedAt,
        ...(headroomReportedUnhealthy
          ? { detail: "The configured Headroom proxy reported an unhealthy status." }
          : !headroomRunning && headroomHealthResult._tag === "Right"
            ? { detail: "The configured endpoint did not identify itself as a Headroom proxy." }
            : !headroomRunning && headroomCli.installed
              ? {
                  detail:
                    "Headroom is installed, but its configured local proxy is not responding.",
                }
              : !headroomRunning && headroomCli.detail !== undefined
                ? { detail: headroomCli.detail }
                : headroomRunning && Option.isNone(headroomStats)
                  ? { detail: "Headroom is running, but savings statistics are unavailable." }
                  : {}),
      },
      {
        id: "cbm",
        installed: cbm.installed,
        version: cbm.version,
        mode: "stdio-mcp",
        checkedAt,
        ...(cbm.detail === undefined ? {} : { detail: cbm.detail }),
      },
    ];
    const savings: OptimizerSavingsSummary[] = [
      ...(rtkSavings === null
        ? []
        : [
            {
              source: "rtk" as const,
              scope: "environment" as const,
              window: "all-time" as const,
              tokensSaved: rtkSavings,
            },
          ]),
      ...(headroomSavings === null
        ? []
        : [
            {
              source: "headroom" as const,
              scope: "environment" as const,
              window: "session" as const,
              tokensSaved: headroomSavings,
            },
          ]),
    ];
    return { optimizers, savings, savingsHistory } satisfies OptimizerDiscoverySnapshot;
  });

  const getStatus = Effect.fn("OptimizerProbeService.getStatus")(function* (
    input: Parameters<OptimizerProbeService["Service"]["getStatus"]>[0],
  ) {
    const cbmBinaryPath = yield* dependencies.getCbmBinaryPath.pipe(
      Effect.catchCause(() => Effect.succeed(DEFAULT_CBM_BINARY_PATH)),
    );
    const configuredHeadroomProxyUrl = yield* dependencies.getHeadroomProxyUrl.pipe(
      Effect.catchCause(() => Effect.succeed(DEFAULT_HEADROOM_PROXY_URL)),
    );
    const headroomProxyUrl =
      normalizeHeadroomProxyUrl(configuredHeadroomProxyUrl) ?? DEFAULT_HEADROOM_PROXY_URL;
    const nowMs = yield* dependencies.nowMs;
    const observedRevision = (yield* Ref.get(cache)).revision;
    const snapshot = yield* refreshLock.withPermit(
      Effect.gen(function* () {
        const current = yield* Ref.get(cache);
        const sameCbmBinary = current.cbmBinaryPath === cbmBinaryPath;
        const sameHeadroomProxy = current.headroomProxyUrl === headroomProxyUrl;
        const refreshIsCoolingDown =
          current.refreshedAtMs !== null && nowMs - current.refreshedAtMs < REFRESH_COOLDOWN_MS;
        if (
          current.snapshot !== null &&
          sameCbmBinary &&
          sameHeadroomProxy &&
          !input.force &&
          (!input.refresh || current.revision !== observedRevision || refreshIsCoolingDown)
        ) {
          return current.snapshot;
        }
        const next = yield* discover(cbmBinaryPath, headroomProxyUrl);
        yield* Ref.set(cache, {
          revision: current.revision + 1,
          snapshot: next,
          cbmBinaryPath,
          headroomProxyUrl,
          refreshedAtMs: nowMs,
        });
        return next;
      }),
    );
    const cbmIndexes = yield* dependencies.listCbmIndexes.pipe(
      Effect.catchCause(() => Effect.succeed([])),
    );
    return { ...snapshot, cbmIndexes, attachments: [] } satisfies OptimizerStatusSnapshot;
  });

  const waitForHeadroom = Effect.fn("OptimizerProbeService.waitForHeadroom")(function* (
    proxyUrl: string,
    process: OptimizerOwnedHeadroomProcess,
  ) {
    const startedAt = yield* dependencies.nowMs;
    const deadline = startedAt + HEADROOM_READY_TIMEOUT_MS;
    while (true) {
      if (!(yield* process.isRunning)) {
        const exitCode = yield* process.exitCode;
        return yield* new OptimizerStartError({
          message: `Headroom exited with code ${String(exitCode)} before its proxy became healthy. Check the server logs and configured port.`,
        });
      }

      const healthAttempt = yield* dependencies.fetchHeadroomHealth(proxyUrl).pipe(
        Effect.match({
          onFailure: () => Option.none(),
          onSuccess: decodeHeadroomHealth,
        }),
      );
      if (Option.isSome(healthAttempt)) {
        if (healthAttempt.value.status === "unhealthy") {
          return yield* new OptimizerStartError({
            message:
              "Headroom started, but its health endpoint reports unhealthy. Check the server logs.",
          });
        }
        return;
      }

      if ((yield* dependencies.nowMs) >= deadline) {
        return yield* new OptimizerStartError({
          message: `Headroom did not become healthy at ${proxyUrl} within 10 seconds. Check the server logs and ensure no other service is using this port.`,
        });
      }
      yield* dependencies.sleep(HEADROOM_READY_POLL_MS);
    }
  });

  const startHeadroom: OptimizerProbeService["Service"]["startHeadroom"] = () =>
    startLock.withPermit(
      Effect.gen(function* () {
        const configuredProxyUrl = yield* dependencies.getHeadroomProxyUrl.pipe(
          Effect.catchCause(() => Effect.succeed(DEFAULT_HEADROOM_PROXY_URL)),
        );
        const proxyUrl = normalizeHeadroomProxyUrl(configuredProxyUrl);
        if (proxyUrl === null) {
          return yield* new OptimizerStartError({
            message: "The configured Headroom URL must be an HTTP loopback origin.",
          });
        }

        const upstream = yield* dependencies.getHeadroomUpstream;
        const prior = yield* Ref.get(ownedProcess);
        if (prior !== null) {
          const isRunning = yield* prior.process.isRunning.pipe(Effect.orElseSucceed(() => false));
          if (
            !isRunning ||
            prior.proxyUrl !== proxyUrl ||
            !sameUpstream(prior.upstream, upstream)
          ) {
            yield* Scope.close(prior.scope, Exit.void);
            yield* Ref.set(ownedProcess, null);
          }
        }

        const existing = yield* getStatus({ refresh: true, force: true });
        const existingStatus = existing.optimizers.find((optimizer) => optimizer.id === "headroom");
        if (existingStatus?.running === true) return existing;

        const unhealthyOwnedProcess = yield* Ref.get(ownedProcess);
        if (unhealthyOwnedProcess !== null) {
          yield* Scope.close(unhealthyOwnedProcess.scope, Exit.void);
          yield* Ref.set(ownedProcess, null);
        }

        const cli = yield* versionProbe("headroom");
        if (!cli.installed) {
          return yield* new OptimizerStartError({
            message: cli.detail
              ? `Headroom is not available. ${cli.detail} Install the Headroom CLI, then try again.`
              : "Headroom is not installed. Install the Headroom CLI, then try again.",
          });
        }

        const processScope = yield* Scope.make("sequential");
        yield* Scope.addFinalizer(proxyScope, Scope.close(processScope, Exit.void));
        const endpoint = new URL(proxyUrl);
        const host = endpoint.hostname.startsWith("[")
          ? endpoint.hostname.slice(1, -1)
          : endpoint.hostname;
        const port = Number(endpoint.port || "80");
        const startup = Effect.gen(function* () {
          const spawned = yield* dependencies
            .spawnHeadroomProxy({
              host,
              port,
              upstream,
              scope: processScope,
            })
            .pipe(
              Effect.tap((process) =>
                Ref.set(ownedProcess, { proxyUrl, upstream, scope: processScope, process }),
              ),
            );
          yield* waitForHeadroom(proxyUrl, spawned);
          const snapshot = yield* getStatus({ refresh: true, force: true });
          const confirmed = snapshot.optimizers.find((optimizer) => optimizer.id === "headroom");
          if (confirmed?.running !== true) {
            return yield* new OptimizerStartError({
              message:
                "Headroom passed its startup check but did not remain healthy. Check the server logs.",
            });
          }
          return snapshot;
        });
        return yield* startup.pipe(
          Effect.onExit((exit) =>
            Exit.isSuccess(exit)
              ? Effect.void
              : Scope.close(processScope, Exit.void).pipe(
                  Effect.andThen(Ref.set(ownedProcess, null)),
                ),
          ),
        );
      }),
    );

  const ownedHeadroomUpstream = Effect.gen(function* () {
    const owned = yield* Ref.get(ownedProcess);
    if (owned === null) return null;
    const running = yield* owned.process.isRunning.pipe(Effect.orElseSucceed(() => false));
    return running ? owned.upstream : null;
  });

  return OptimizerProbeService.of({ getStatus, startHeadroom, ownedHeadroomUpstream });
});

const make = Effect.gen(function* () {
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const settings = yield* ServerSettings.ServerSettingsService;
  const cbmIndexes = yield* CbmIndexService;
  const httpClient = yield* HttpClient.HttpClient;
  const hostPlatform = yield* HostProcess.Platform;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  return yield* makeWith({
    run: processRunner.run,
    isMissingResult: (result) =>
      isWindowsCommandNotFound(Number(result.code), result.stderr).pipe(
        Effect.provideService(HostProcess.Platform, hostPlatform),
      ),
    fetchHeadroomStats: (proxyUrl) =>
      httpClient.get(`${proxyUrl}/stats`).pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap((response) => response.json),
        Effect.timeout(Duration.seconds(2)),
        Effect.mapError(() => new HeadroomStatsProbeError()),
      ),
    fetchHeadroomHealth: (proxyUrl) =>
      httpClient.get(`${proxyUrl}/health`).pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap((response) => response.json),
        Effect.timeout(Duration.seconds(2)),
        Effect.mapError(() => new HeadroomStatsProbeError()),
      ),
    fetchHeadroomHistory: (proxyUrl) =>
      httpClient.get(`${proxyUrl}/stats-history`).pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap((response) => response.json),
        Effect.timeout(Duration.seconds(2)),
        Effect.mapError(() => new HeadroomStatsProbeError()),
      ),
    spawnHeadroomProxy: ({ host, port, upstream, scope }) =>
      spawner
        .spawn(
          ChildProcess.make(
            "headroom",
            [
              "proxy",
              "--host",
              host,
              "--port",
              String(port),
              ...(upstream.anthropic ? ["--anthropic-api-url", upstream.anthropic] : []),
              ...(upstream.openai ? ["--openai-api-url", upstream.openai] : []),
            ],
            {
              extendEnv: true,
              detached: false,
              stdin: "ignore",
              stdout: "inherit",
              stderr: "inherit",
            },
          ),
        )
        .pipe(
          Scope.provide(scope),
          Effect.map((handle) => ({
            isRunning: handle.isRunning.pipe(
              Effect.mapError(
                () =>
                  new OptimizerStartError({ message: "Could not inspect the Headroom process." }),
              ),
            ),
            exitCode: handle.exitCode.pipe(
              Effect.map((code) => Number(code)),
              Effect.mapError(
                () =>
                  new OptimizerStartError({ message: "Could not inspect the Headroom process." }),
              ),
            ),
          })),
          Effect.mapError(
            () =>
              new OptimizerStartError({
                message:
                  "Could not start the Headroom CLI. Confirm it is installed and available on PATH.",
              }),
          ),
        ),
    getCbmBinaryPath: settings.getSettings.pipe(
      Effect.map((current) => current.optimizerBinaryPaths.cbm),
    ),
    getHeadroomProxyUrl: settings.getSettings.pipe(
      Effect.map((current) => current.headroomProxyUrl),
    ),
    getHeadroomUpstream: settings.getSettings.pipe(
      Effect.flatMap(readCpaRoutingState),
      Effect.map(cpaHeadroomUpstream),
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.orElseSucceed((): HeadroomUpstream => ({})),
    ),
    listCbmIndexes: cbmIndexes.listStatuses,
    now: DateTime.now.pipe(Effect.map(DateTime.formatIso)),
    nowMs: Clock.currentTimeMillis,
    sleep: (milliseconds) => Effect.sleep(Duration.millis(milliseconds)),
  });
});

export const layer = Layer.effect(OptimizerProbeService, make);
