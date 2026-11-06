import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as LogLevel from "effect/LogLevel";
import * as Path from "effect/Path";
import type * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import type { OtlpEndpointSource } from "@t3tools/contracts";
import { sweepStalePendingAttachments } from "./attachmentStore.ts";
import {
  DEFAULT_SIGNAL_EXPORT,
  nodeProcessRuntimeAttributes,
  processServiceInstanceId,
  type SignalExport,
} from "@t3tools/shared/observability";
import * as OtelEnvironment from "@t3tools/shared/otelEnvironment";
import { type ReleaseChannel, releaseResourceAttributes } from "@t3tools/shared/releaseResource";
import packageJson from "../package.json" with { type: "json" };

// Official release workflows set this telemetry channel; other builds report dev.
// Unlike __T3CODE_BUILD_CHANNEL__, this is not the sign-in page's latest/nightly channel.
declare const __T3CODE_TELEMETRY_CHANNEL__: ReleaseChannel | undefined;
export const telemetryChannel: ReleaseChannel =
  typeof __T3CODE_TELEMETRY_CHANNEL__ === "undefined" ? "dev" : __T3CODE_TELEMETRY_CHANNEL__;

export const DEFAULT_PORT = 3773;

export const RuntimeMode = Schema.Literals(["web", "desktop"]);
export type RuntimeMode = typeof RuntimeMode.Type;

export const StartupPresentation = Schema.Literals(["browser", "headless"]);
export type StartupPresentation = typeof StartupPresentation.Type;

export interface ServerDerivedPaths {
  readonly stateDir: string;
  readonly dbPath: string;
  readonly keybindingsConfigPath: string;
  readonly settingsPath: string;
  readonly environmentThemesDir: string;
  readonly providerStatusCacheDir: string;
  readonly worktreesDir: string;
  readonly attachmentsDir: string;
  readonly browserArtifactsDir: string;
  readonly logsDir: string;
  readonly serverTracePath: string;
  readonly providerLogsDir: string;
  readonly providerEventLogPath: string;
  readonly terminalLogsDir: string;
  readonly anonymousIdPath: string;
  readonly environmentIdPath: string;
  readonly serverRuntimeStatePath: string;
  readonly secretsDir: string;
}

export interface DeriveServerPathsOptions {
  readonly baseDirIsExplicit?: boolean;
}

export class ServerConfig extends Context.Service<
  ServerConfig,
  ServerDerivedPaths & {
    readonly logLevel: LogLevel.LogLevel;
    readonly traceMinLevel: LogLevel.LogLevel;
    readonly traceTimingEnabled: boolean;
    readonly traceBatchWindowMs: number;
    readonly traceMaxBytes: number;
    readonly traceMaxFiles: number;
    readonly otlpTracesUrl: string | undefined;
    readonly otlpMetricsUrl: string | undefined;
    readonly otlpLogsUrl: string | undefined;
    readonly otlpTracesExport: SignalExport;
    readonly otlpMetricsExport: SignalExport;
    readonly otlpLogsExport: SignalExport;
    readonly otlpTracesSource?: OtlpEndpointSource;
    readonly otlpTracesVariable?: string;
    readonly otlpMetricsSource?: OtlpEndpointSource;
    readonly otlpMetricsVariable?: string;
    readonly otlpLogsSource?: OtlpEndpointSource;
    readonly otlpLogsVariable?: string;
    readonly otelEnvironment: OtelEnvironment.OtelEnvironment;
    readonly mode: RuntimeMode;
    readonly port: number;
    readonly host: string | undefined;
    /** Set when the host was defaulted to a private-network listener for the service. */
    readonly privateNetworkOnly?: boolean | undefined;
    readonly cwd: string;
    readonly baseDir: string;
    readonly staticDir: string | undefined;
    readonly devUrl: URL | undefined;
    readonly devAuthToken?: Redacted.Redacted<string> | undefined;
    readonly devAllowedOrigins: ReadonlyArray<string>;
    readonly noBrowser: boolean;
    readonly startupPresentation: StartupPresentation;
    readonly desktopBootstrapToken: string | undefined;
    readonly desktopBootstrapSecret?: string | undefined;
    readonly shellEnvironmentPrepared?: boolean | undefined;
    readonly desktopTelemetryFd?: number | undefined;
    readonly desktopTelemetryControlFd?: number | undefined;
    readonly desktopBrowserFd?: number | undefined;
    readonly desktopBrowserControlFd?: number | undefined;
    readonly resourceMonitorPath?: string | undefined;
    readonly autoBootstrapProjectFromCwd: boolean;
    readonly logWebSocketEvents: boolean;
    readonly tailscaleServeEnabled: boolean;
    readonly tailscaleServePort: number;
  }
>()("t3/config/ServerConfig") {
  static readonly layerTest = (
    cwd: string,
    baseDirOrPrefix: string | { readonly prefix: string },
  ) => layerTest(cwd, baseDirOrPrefix);
}

export const make = (config: ServerConfig["Service"]) => ServerConfig.of(config);

export const otlpResource = (
  config: Pick<ServerConfig["Service"], "mode" | "otelEnvironment">,
  hostName: string,
) => ({
  serviceName: "t3code-server",
  serviceVersion: packageJson.version,
  attributes: {
    "service.namespace": "t3code",
    "service.runtime": "t3-server",
    "t3code.server.managed_by": config.mode === "desktop" ? "desktop" : "standalone",
    "service.instance.id": processServiceInstanceId(config.otelEnvironment.resourceAttributes),
    ...releaseResourceAttributes(telemetryChannel, config.otelEnvironment.resourceAttributes),
    "host.name": config.otelEnvironment.resourceAttributes["host.name"] || hostName,
    ...nodeProcessRuntimeAttributes(),
  },
});

export const layer = (config: ServerConfig["Service"]) => Layer.succeed(ServerConfig, make(config));

export const deriveServerPaths = Effect.fn(function* (
  baseDir: ServerConfig["Service"]["baseDir"],
  devUrl: ServerConfig["Service"]["devUrl"],
  options: DeriveServerPathsOptions = {},
): Effect.fn.Return<ServerDerivedPaths, never, Path.Path> {
  const { join } = yield* Path.Path;
  const stateDir = join(
    baseDir,
    devUrl !== undefined && !options.baseDirIsExplicit ? "dev" : "userdata",
  );
  const dbPath = join(stateDir, "statev2.sqlite");
  const attachmentsDir = join(stateDir, "attachments");
  const logsDir = join(stateDir, "logs");
  const providerLogsDir = join(logsDir, "provider");
  const providerStatusCacheDir = join(baseDir, "caches");
  return {
    stateDir,
    dbPath,
    keybindingsConfigPath: join(stateDir, "keybindings.json"),
    settingsPath: join(stateDir, "settings.json"),
    environmentThemesDir: join(stateDir, "themes"),
    providerStatusCacheDir,
    worktreesDir: join(baseDir, "worktrees"),
    attachmentsDir,
    browserArtifactsDir: join(stateDir, "browser-artifacts"),
    logsDir,
    serverTracePath: join(logsDir, "server.trace.ndjson"),
    providerLogsDir,
    providerEventLogPath: join(providerLogsDir, "events.log"),
    terminalLogsDir: join(logsDir, "terminals"),
    anonymousIdPath: join(stateDir, "anonymous-id"),
    environmentIdPath: join(stateDir, "environment-id"),
    serverRuntimeStatePath: join(stateDir, "server-runtime.json"),
    secretsDir: join(stateDir, "secrets"),
  };
});

export const ensureServerDirectories = Effect.fn(function* (derivedPaths: ServerDerivedPaths) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  yield* Effect.all(
    [
      fs.makeDirectory(derivedPaths.stateDir, { recursive: true }),
      fs.makeDirectory(derivedPaths.logsDir, { recursive: true }),
      fs.makeDirectory(derivedPaths.providerLogsDir, { recursive: true }),
      fs.makeDirectory(derivedPaths.terminalLogsDir, { recursive: true }),
      fs.makeDirectory(derivedPaths.attachmentsDir, { recursive: true }),
      fs.makeDirectory(derivedPaths.worktreesDir, { recursive: true }),
      fs.makeDirectory(path.dirname(derivedPaths.keybindingsConfigPath), { recursive: true }),
      fs.makeDirectory(path.dirname(derivedPaths.settingsPath), { recursive: true }),
      fs.makeDirectory(derivedPaths.providerStatusCacheDir, { recursive: true }),
      fs.makeDirectory(path.dirname(derivedPaths.anonymousIdPath), { recursive: true }),
      fs.makeDirectory(path.dirname(derivedPaths.serverRuntimeStatePath), { recursive: true }),
    ],
    { concurrency: "unbounded" },
  );
  // Logs, traces and the database are written with the process umask; keep them owner-only.
  yield* fs
    .chmod(derivedPaths.stateDir, 0o700)
    .pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Could not restrict state directory permissions.", { cause }),
      ),
    );

  const swept = sweepStalePendingAttachments({
    attachmentsDir: derivedPaths.attachmentsDir,
    nowMs: yield* Clock.currentTimeMillis,
  });
  if (swept.deleted > 0) {
    yield* Effect.logInfo("Removed expired attachment uploads.", { deleted: swept.deleted });
  }
});

const makeTest = Effect.fn("ServerConfig.makeTest")(function* (
  cwd: string,
  baseDirOrPrefix: string | { readonly prefix: string },
) {
  const devUrl = undefined;
  const fs = yield* FileSystem.FileSystem;
  const baseDir =
    typeof baseDirOrPrefix === "string"
      ? baseDirOrPrefix
      : // macOS temp dirs live under the /var -> /private/var symlink; storage cleanup's
        // symlink guards compare resolved paths, so generated test dirs must be real paths.
        yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: baseDirOrPrefix.prefix }));
  const derivedPaths = yield* deriveServerPaths(baseDir, devUrl);
  yield* ensureServerDirectories(derivedPaths);

  return ServerConfig.of({
    logLevel: "Error",
    traceMinLevel: "Info",
    traceTimingEnabled: true,
    traceBatchWindowMs: 200,
    traceMaxBytes: 10 * 1024 * 1024,
    traceMaxFiles: 10,
    otlpTracesUrl: undefined,
    otlpMetricsUrl: undefined,
    otlpLogsUrl: undefined,
    otlpTracesExport: DEFAULT_SIGNAL_EXPORT,
    otlpMetricsExport: DEFAULT_SIGNAL_EXPORT,
    otlpLogsExport: DEFAULT_SIGNAL_EXPORT,
    otelEnvironment: OtelEnvironment.none,
    cwd,
    baseDir,
    ...derivedPaths,
    mode: "web",
    autoBootstrapProjectFromCwd: false,
    logWebSocketEvents: false,
    tailscaleServeEnabled: false,
    tailscaleServePort: 443,
    port: 0,
    host: undefined,
    desktopBootstrapToken: undefined,
    desktopTelemetryFd: undefined,
    desktopTelemetryControlFd: undefined,
    desktopBrowserFd: undefined,
    desktopBrowserControlFd: undefined,
    resourceMonitorPath: undefined,
    staticDir: undefined,
    devUrl,
    devAllowedOrigins: [],
    noBrowser: false,
    startupPresentation: "browser",
  });
});

export const layerTest = (cwd: string, baseDirOrPrefix: string | { readonly prefix: string }) =>
  Layer.effect(ServerConfig, makeTest(cwd, baseDirOrPrefix));

export const resolveStaticDir = Effect.fn(function* () {
  const { join, resolve } = yield* Path.Path;
  const { exists } = yield* FileSystem.FileSystem;
  const bundledClient = resolve(join(import.meta.dirname, "client"));
  const bundledStat = yield* exists(join(bundledClient, "index.html")).pipe(
    Effect.orElseSucceed(() => false),
  );
  if (bundledStat) {
    return bundledClient;
  }

  const monorepoClient = resolve(join(import.meta.dirname, "../../web/dist"));
  const monorepoStat = yield* exists(join(monorepoClient, "index.html")).pipe(
    Effect.orElseSucceed(() => false),
  );
  if (monorepoStat) {
    return monorepoClient;
  }
  return undefined;
});
