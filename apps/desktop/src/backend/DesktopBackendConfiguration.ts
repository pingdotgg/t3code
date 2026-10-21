import * as NodeOS from "node:os";

import { parsePersistedServerObservabilitySettings } from "@t3tools/shared/serverSettings";
import { currentDesktopBootstrapToken } from "@t3tools/shared/desktopBootstrapToken";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as SynchronizedRef from "effect/SynchronizedRef";

import serverPackageJson from "../../../server/package.json" with { type: "json" };

import * as DesktopBackendManager from "./DesktopBackendManager.ts";
import * as DesktopCliShim from "../app/DesktopCliShim.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopServerExposure from "./DesktopServerExposure.ts";
import * as DesktopShellEnvironment from "../shell/DesktopShellEnvironment.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopWslEnvironment from "../wsl/DesktopWslEnvironment.ts";
import * as DesktopWslServerTree from "../wsl/DesktopWslServerTree.ts";

export class DesktopBackendObservabilitySettingsReadError extends Schema.TaggedError<DesktopBackendObservabilitySettingsReadError>()(
  "DesktopBackendObservabilitySettingsReadError",
  {
    settingsPath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to read persisted backend observability settings at ${this.settingsPath}.`;
  }
}

export class DesktopBackendConfiguration extends Context.Service<
  DesktopBackendConfiguration,
  {
    readonly resolvePrimary: Effect.Effect<
      DesktopBackendManager.DesktopBackendStartConfig,
      PlatformError.PlatformError
    >;
    readonly resolveWsl: (input: {
      readonly port: number;
      readonly distro: string | null;
    }) => Effect.Effect<
      DesktopBackendManager.DesktopBackendStartConfig,
      PlatformError.PlatformError
    >;
    readonly resolvePrimaryLabel: Effect.Effect<string>;
    readonly currentBootstrapToken: Effect.Effect<string, PlatformError.PlatformError>;
  }
>()("@t3tools/desktop/backend/DesktopBackendConfiguration") {}

interface BackendObservabilitySettings {
  readonly otlpTracesUrl: Option.Option<string>;
  readonly otlpMetricsUrl: Option.Option<string>;
  readonly otlpLogsUrl: Option.Option<string>;
}

const emptyBackendObservabilitySettings: BackendObservabilitySettings = {
  otlpTracesUrl: Option.none(),
  otlpMetricsUrl: Option.none(),
  otlpLogsUrl: Option.none(),
};

const DESKTOP_BACKEND_ENV_NAMES = [
  "T3CODE_PORT",
  "T3CODE_MODE",
  "T3CODE_NO_BROWSER",
  "T3CODE_HOST",
  "T3CODE_DESKTOP_WS_URL",
  "T3CODE_DESKTOP_LAN_ACCESS",
  "T3CODE_DESKTOP_LAN_HOST",
  "T3CODE_DESKTOP_HTTPS_ENDPOINTS",
  "T3CODE_TAILSCALE_SERVE",
  "T3CODE_TAILSCALE_SERVE_PORT",
] as const;

// Windows forwards these variables into WSL only through WSLENV.
const WSL_FORWARDED_ENV_NAMES = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "T3CODE_TELEMETRY_ENABLED",
  // Otherwise the WSL server keeps exporting to endpoints from the bootstrap.
  "T3CODE_OTEL_SDK_DISABLED",
  "OTEL_SDK_DISABLED",
  "T3CODE_OTLP_HEADERS",
  "T3CODE_OTLP_PROTOCOL",
  // Untranslated T3 URLs must override bootstrap endpoints inside WSL, as they do on Windows.
  "T3CODE_OTLP_TRACES_URL",
  "T3CODE_OTLP_METRICS_URL",
  "T3CODE_OTLP_LOGS_URL",
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
  "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
  "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
  "OTEL_EXPORTER_OTLP_HEADERS",
  "OTEL_EXPORTER_OTLP_TRACES_HEADERS",
  "OTEL_EXPORTER_OTLP_METRICS_HEADERS",
  "OTEL_EXPORTER_OTLP_LOGS_HEADERS",
  "OTEL_EXPORTER_OTLP_PROTOCOL",
  "OTEL_EXPORTER_OTLP_TRACES_PROTOCOL",
  "OTEL_EXPORTER_OTLP_METRICS_PROTOCOL",
  "OTEL_EXPORTER_OTLP_LOGS_PROTOCOL",
  "OTEL_TRACES_EXPORTER",
  "OTEL_METRICS_EXPORTER",
  "OTEL_LOGS_EXPORTER",
] as const;

const WSL_SERVER_SYSTEM_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

const nodeBinDirOf = (nodePath: string): string => {
  const lastSlash = nodePath.lastIndexOf("/");
  return lastSlash > 0 ? nodePath.slice(0, lastSlash) : "/usr/bin";
};

const backendChildEnvPatch = (): Record<string, string | undefined> =>
  Object.fromEntries(DESKTOP_BACKEND_ENV_NAMES.map((name) => [name, undefined]));

const getWslEnvEntryName = (entry: string): string => {
  const slashIndex = entry.indexOf("/");
  return slashIndex === -1 ? entry : entry.slice(0, slashIndex);
};

const mergeWslEnv = (
  existingWslEnv: string | undefined,
  forwardedEnvNames: ReadonlyArray<string>,
): string | undefined => {
  const existing = existingWslEnv?.trim() ?? "";

  const seenNames = new Set(
    existing
      .split(":")
      .map((entry) => getWslEnvEntryName(entry.trim()))
      .filter((name) => name.length > 0),
  );

  const additions = forwardedEnvNames.filter((name) => !seenNames.has(name));

  // Preserve empty segments and duplicates in the user's WSLENV; only append required variables.
  const parts = [existing, ...additions].filter((part) => part.length > 0);
  return parts.length > 0 ? parts.join(":") : undefined;
};

const logBackendObservabilitySettingsReadFailure = (
  settingsPath: string,
  cause: PlatformError.PlatformError,
) => {
  const error = new DesktopBackendObservabilitySettingsReadError({ settingsPath, cause });
  return Effect.logWarning(error).pipe(
    Effect.annotateLogs({
      component: "desktop-backend-configuration",
      error,
    }),
  );
};

function resourceMonitorBinaryName(platform: NodeJS.Platform): string {
  return platform === "win32" ? "t3-resource-monitor.exe" : "t3-resource-monitor";
}

const resolveResourceMonitorPath = Effect.fn(
  "desktop.backendConfiguration.resolveResourceMonitorPath",
)(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const binaryName = resourceMonitorBinaryName(environment.platform);
  const candidates = environment.isDevelopment
    ? [
        environment.path.join(
          environment.rootDir,
          "native/resource-monitor/target/release",
          binaryName,
        ),
        environment.path.join(
          environment.rootDir,
          "native/resource-monitor/target/debug",
          binaryName,
        ),
      ]
    : environment.isPackaged
      ? [environment.path.join(environment.resourcesPath, "resource-monitor", binaryName)]
      : environment.resolveResourcePathCandidates(
          environment.path.join("resource-monitor", binaryName),
        );

  for (const candidate of candidates) {
    if (yield* fileSystem.exists(candidate).pipe(Effect.orElseSucceed(() => false))) {
      return Option.some(candidate);
    }
  }

  return Option.none<string>();
});

const readPersistedBackendObservabilitySettings = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const raw = yield* fileSystem.readFileString(environment.serverSettingsPath).pipe(
    Effect.asSome,
    Effect.catchTags({
      PlatformError: (cause) =>
        cause.reason._tag === "NotFound"
          ? Effect.succeedNone
          : logBackendObservabilitySettingsReadFailure(environment.serverSettingsPath, cause).pipe(
              Effect.as(Option.none()),
            ),
    }),
  );
  if (Option.isNone(raw)) {
    return emptyBackendObservabilitySettings;
  }

  const parsed = parsePersistedServerObservabilitySettings(raw.value);
  return {
    otlpTracesUrl: Option.fromNullishOr(parsed.otlpTracesUrl),
    otlpMetricsUrl: Option.fromNullishOr(parsed.otlpMetricsUrl),
    otlpLogsUrl: Option.fromNullishOr(parsed.otlpLogsUrl),
  };
});

const readBackendObservabilitySettings = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const persisted = yield* readPersistedBackendObservabilitySettings;
  return {
    otlpTracesUrl: Option.orElse(environment.otlpTracesUrl, () => persisted.otlpTracesUrl),
    otlpMetricsUrl: Option.orElse(environment.otlpMetricsUrl, () => persisted.otlpMetricsUrl),
    otlpLogsUrl: Option.orElse(environment.otlpLogsUrl, () => persisted.otlpLogsUrl),
  } satisfies BackendObservabilitySettings;
});

interface SharedBootstrapInput {
  readonly bootstrapToken: string;
  readonly bootstrapSecret: string;
  readonly observabilitySettings: BackendObservabilitySettings;
}

type WslPreflightRuntime =
  | {
      readonly kind: "executable";
      readonly entryPath: string;
    }
  | {
      readonly kind: "node-script";
      // Launch the exact Node path probed with node-pty, even if later PATH lookup would resolve another version.
      readonly nodePath: string;
      readonly linuxEntryPath: string;
    };

interface WslPreflightSuccess {
  readonly _tag: "Ready";
  readonly runningDistro: string;
  readonly windowsEntryPath: string;
  readonly runtime: WslPreflightRuntime;
  readonly resolvedPath: string;
  readonly runtimeId?: string;
}

interface WslPreflightFailure {
  readonly _tag: "Failed";
  readonly reason: string;
  readonly fatal: boolean;
  readonly retryLimit?: number;
}

const WSL_TRANSIENT_PREFLIGHT_RETRY_LIMIT = 12;
const WSL_RUNTIME_ARCHIVE_NAME = "wsl-runtime.tar.gz";
const WSL_RUNTIME_ARCHIVE_HASH_NAME = `${WSL_RUNTIME_ARCHIVE_NAME}.sha256`;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/i;

const parseWslRuntimeArchiveHash = (value: string): string | null => {
  const trimmed = value.trim();
  return SHA256_HEX_PATTERN.test(trimmed) ? trimmed.toLowerCase() : null;
};

type FailedNodePtyResult = Extract<
  DesktopWslEnvironment.EnsureWslNodePtyResult,
  { readonly ok: false }
>;

const runWslPreflight = Effect.fn("desktop.backendConfiguration.wslPreflight")(function* (input: {
  readonly distro: string | null;
  readonly runtimeArchive: DesktopWslEnvironment.WslRuntimeArchive | null;
  readonly allowBuild: boolean;
}): Effect.fn.Return<
  WslPreflightSuccess | WslPreflightFailure,
  never,
  | DesktopEnvironment.DesktopEnvironment
  | DesktopWslEnvironment.DesktopWslEnvironment
  | DesktopWslServerTree.DesktopWslServerTree
  | FileSystem.FileSystem
> {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const wslEnv = yield* DesktopWslEnvironment.DesktopWslEnvironment;
  const wslServerTree = yield* DesktopWslServerTree.DesktopWslServerTree;
  const fileSystem = yield* FileSystem.FileSystem;

  const wslAvailable = yield* wslEnv.isAvailable;
  if (!wslAvailable) {
    return {
      _tag: "Failed",
      reason: "WSL is not available on this system",
      fatal: false,
    } as const;
  }

  const distroProbe = yield* wslEnv.probeDistros.pipe(
    Effect.map((distros) => ({ _tag: "Success", distros }) as const),
    Effect.catch((error) => Effect.succeed({ _tag: "Failure", error } as const)),
  );
  if (distroProbe._tag === "Failure") {
    return {
      _tag: "Failed",
      reason: `Unable to list WSL distributions: ${distroProbe.error.message}`,
      fatal: false,
    } as const;
  }

  const installedDistros = distroProbe.distros;
  const runningDistro = input.distro
    ? (installedDistros.find(
        (installed) => installed.name.toLowerCase() === input.distro?.toLowerCase(),
      )?.name ?? null)
    : (installedDistros.find((installed) => installed.isDefault)?.name ?? null);
  if (runningDistro === null) {
    return {
      _tag: "Failed",
      reason: input.distro
        ? `WSL distro is not installed: ${input.distro}`
        : installedDistros.length === 0
          ? "WSL has no installed distributions"
          : "WSL has no default distribution",
      fatal: true,
    } as const;
  }

  const nodePtyOptions = {
    allowBuild: input.allowBuild,
    nodeEngineRange: serverPackageJson.engines.node,
  };
  const failedNodePty = (result: FailedNodePtyResult) =>
    ({
      _tag: "Failed",
      reason: `WSL node-pty unavailable: ${result.reason}`,
      fatal: result.fatal,
      ...(result.retryLimit === undefined ? {} : { retryLimit: result.retryLimit }),
    }) as const;

  const resolveMountedAppRoot = Effect.gen(function* () {
    const serverTree = yield* wslServerTree.ensure;
    if (!serverTree.ok) {
      return { ok: false, reason: serverTree.reason, fatal: serverTree.fatal } as const;
    }
    const windowsEntryPath = environment.path.join(serverTree.root, "apps/server/dist/bin.mjs");
    const entryExists = yield* fileSystem
      .exists(windowsEntryPath)
      .pipe(Effect.orElseSucceed(() => false));
    if (!entryExists) {
      return {
        ok: false,
        reason: `missing server entry at ${windowsEntryPath}`,
        fatal: true,
      } as const;
    }
    const mountedAppRoot = yield* wslEnv.windowsToWslPath(runningDistro, serverTree.root);
    return Option.isNone(mountedAppRoot)
      ? ({
          ok: false,
          reason: `wslpath conversion failed for ${serverTree.root}`,
          fatal: false,
        } as const)
      : ({ ok: true, windowsEntryPath, linuxAppRoot: mountedAppRoot.value } as const);
  });

  let stagedFailure: { readonly runtimeId?: string; readonly reason: string } | undefined;
  const failedStaged = (failure: { readonly reason: string }) =>
    ({
      _tag: "Failed",
      reason: `WSL runtime unavailable: ${failure.reason}`,
      fatal: true,
    }) as const;

  if (input.runtimeArchive !== null) {
    const runtime = yield* wslEnv.prepareRuntime(runningDistro, input.runtimeArchive);
    if (runtime.ok) {
      // Staged runtimes bundle Node and node-pty; provider PATH discovery must not require them.
      const stagedProbe = yield* wslEnv.probeRuntime(runningDistro, runtime.linuxAppRoot);
      if (stagedProbe.ok) {
        yield* wslServerTree.cleanupLegacy;
        return {
          _tag: "Ready",
          runningDistro,
          windowsEntryPath: environment.backendEntryPath,
          runtime: { kind: "executable", entryPath: `${runtime.linuxAppRoot}/t3` },
          resolvedPath: stagedProbe.resolvedPath,
          runtimeId: input.runtimeArchive.runtimeId,
        } as const;
      }
      yield* Effect.logWarning(
        "The staged WSL runtime did not start; retrying from the mounted server tree.",
        { reason: stagedProbe.reason },
      );
      stagedFailure = { runtimeId: input.runtimeArchive.runtimeId, reason: stagedProbe.reason };
    } else {
      stagedFailure = { reason: runtime.reason };
      yield* Effect.logWarning(
        "Could not stage the WSL runtime; launching from the mounted server tree instead.",
        { reason: runtime.reason },
      );
    }
  }

  const mounted = yield* resolveMountedAppRoot;
  if (!mounted.ok) {
    return stagedFailure && mounted.fatal
      ? failedStaged(stagedFailure)
      : ({ _tag: "Failed", reason: mounted.reason, fatal: mounted.fatal } as const);
  }

  const nodePtyResult = yield* wslEnv.ensureNodePty(
    runningDistro,
    mounted.linuxAppRoot,
    nodePtyOptions,
  );
  if (!nodePtyResult.ok) {
    // Only substitute a staged failure for a fatal mounted failure; transient /mnt failures must remain retryable.
    return stagedFailure && nodePtyResult.fatal
      ? failedStaged(stagedFailure)
      : failedNodePty(nodePtyResult);
  }

  if (stagedFailure?.runtimeId) {
    yield* wslEnv.invalidateRuntime(runningDistro, stagedFailure.runtimeId);
  }

  return {
    _tag: "Ready",
    runningDistro,
    windowsEntryPath: mounted.windowsEntryPath,
    runtime: {
      kind: "node-script",
      nodePath: nodePtyResult.nodePath,
      linuxEntryPath: `${mounted.linuxAppRoot}/apps/server/dist/bin.mjs`,
    },
    resolvedPath: nodePtyResult.resolvedPath,
  } as const;
});

// In WSL2 mirrored mode, eth0 matches a host IP; use loopback for the renderer.
const isLocalHostIpv4 = (ip: string): boolean => {
  const interfaces = NodeOS.networkInterfaces();
  for (const list of Object.values(interfaces)) {
    if (!list) continue;
    for (const entry of list) {
      const family = String(entry.family);
      if ((family === "IPv4" || family === "4") && entry.address === ip) return true;
    }
  }
  return false;
};

const buildObservabilityFragment = (observabilitySettings: BackendObservabilitySettings) => ({
  ...Option.match(observabilitySettings.otlpTracesUrl, {
    onNone: () => ({}),
    onSome: (otlpTracesUrl) => ({ otlpTracesUrl }),
  }),
  ...Option.match(observabilitySettings.otlpMetricsUrl, {
    onNone: () => ({}),
    onSome: (otlpMetricsUrl) => ({ otlpMetricsUrl }),
  }),
  ...Option.match(observabilitySettings.otlpLogsUrl, {
    onNone: () => ({}),
    onSome: (otlpLogsUrl) => ({ otlpLogsUrl }),
  }),
});

const resolvePrimaryStartConfig = Effect.fn("desktop.backendConfiguration.resolvePrimary")(
  function* (
    input: SharedBootstrapInput & {
      readonly resourceMonitorPath: Option.Option<string>;
      readonly cliPath: Option.Option<string>;
      readonly shellEnvironmentPrepared: boolean;
    },
  ): Effect.fn.Return<
    DesktopBackendManager.DesktopBackendStartConfig,
    never,
    DesktopEnvironment.DesktopEnvironment | DesktopServerExposure.DesktopServerExposure
  > {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const serverExposure = yield* DesktopServerExposure.DesktopServerExposure;
    const backendExposure = yield* serverExposure.backendConfig;

    const bootstrap = {
      mode: "desktop" as const,
      noBrowser: true,
      port: backendExposure.port,
      t3Home: environment.baseDir,
      host: backendExposure.bindHost,
      desktopBootstrapToken: input.bootstrapToken,
      desktopBootstrapSecret: input.bootstrapSecret,
      shellEnvironmentPrepared: input.shellEnvironmentPrepared,
      tailscaleServeEnabled: backendExposure.tailscaleServeEnabled,
      tailscaleServePort: backendExposure.tailscaleServePort,
      desktopTelemetryFd: 4,
      desktopTelemetryControlFd: 5,
      desktopBrowserFd: 6,
      desktopBrowserControlFd: 7,
      ...Option.match(input.resourceMonitorPath, {
        onNone: () => ({}),
        onSome: (resourceMonitorPath) => ({ resourceMonitorPath }),
      }),
      ...buildObservabilityFragment(input.observabilitySettings),
    };

    return {
      executablePath: process.execPath,
      // Packaged builds have a separate cache; --require prevents cache settings leaking to provider subprocesses.
      args: [
        ...(environment.isPackaged ? ["--require", environment.compileCachePath] : []),
        environment.backendEntryPath,
        "--bootstrap-fd",
        "3",
      ],
      entryPath: environment.backendEntryPath,
      cwd: environment.backendCwd,
      env: {
        ...backendChildEnvPatch(),
        ELECTRON_RUN_AS_NODE: "1",
        T3CODE_CLI_PATH: Option.getOrUndefined(input.cliPath),
      },
      extendEnv: true,
      bootstrap,
      bootstrapDelivery: "fd3",
      httpBaseUrl: backendExposure.httpBaseUrl,
      captureOutput: true,
      preflightFailure: Option.none(),
    } satisfies DesktopBackendManager.DesktopBackendStartConfig;
  },
);

const resolveWslStartConfig = Effect.fn("desktop.backendConfiguration.resolveWsl")(function* (
  input: SharedBootstrapInput & {
    readonly port: number;
    readonly distro: string | null;
  },
): Effect.fn.Return<
  DesktopBackendManager.DesktopBackendStartConfig,
  never,
  | DesktopEnvironment.DesktopEnvironment
  | DesktopWslEnvironment.DesktopWslEnvironment
  | DesktopWslServerTree.DesktopWslServerTree
  | FileSystem.FileSystem
> {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const wslEnvironment = yield* DesktopWslEnvironment.DesktopWslEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;

  // wslhost loopback forwarding is unreliable on some Windows hosts; advertise the WSL IP instead.
  const wslBindHost = "0.0.0.0";

  const bootstrap = {
    mode: "desktop" as const,
    noBrowser: true,
    port: input.port,
    // Omit t3Home to keep the Linux backend from sharing the primary's Windows SQLite file.
    host: wslBindHost,
    desktopBootstrapToken: input.bootstrapToken,
    desktopBootstrapSecret: input.bootstrapSecret,
    // PortSchema rejects 0 even when Tailscale Serve is disabled.
    tailscaleServeEnabled: false,
    tailscaleServePort: 443,
    ...buildObservabilityFragment(input.observabilitySettings),
  };

  const archivePath = environment.path.join(environment.resourcesPath, WSL_RUNTIME_ARCHIVE_NAME);
  const archiveHashPath = environment.path.join(
    environment.resourcesPath,
    WSL_RUNTIME_ARCHIVE_HASH_NAME,
  );

  const hasArchive = environment.isPackaged
    ? yield* fileSystem.exists(archivePath).pipe(Effect.orElseSucceed(() => false))
    : false;
  const archiveHash = hasArchive
    ? yield* fileSystem.readFileString(archiveHashPath).pipe(
        Effect.map(parseWslRuntimeArchiveHash),
        Effect.orElseSucceed(() => null),
      )
    : null;
  if (hasArchive && archiveHash === null) {
    yield* Effect.logWarning(
      "Ignoring the WSL runtime archive because its SHA-256 identity is missing or invalid; launching from the mounted server tree instead.",
      { hashPath: archiveHashPath },
    );
  }

  const preflight = yield* runWslPreflight({
    distro: input.distro,
    runtimeArchive:
      archiveHash === null
        ? null
        : {
            windowsPath: archivePath,
            runtimeId: `sha256-${archiveHash}`,
            sha256: archiveHash,
          },
    allowBuild: !environment.isPackaged,
  });

  // Pin the preflight distro so a default change cannot race backend startup.
  const runningDistro = preflight._tag === "Ready" ? preflight.runningDistro : null;
  const distroForConfig = runningDistro ?? input.distro;

  const distroIp = yield* wslEnvironment.getDistroIp(distroForConfig);
  const usesSharedNetworkStack = Option.match(distroIp, {
    onNone: () => false,
    onSome: (ip) => isLocalHostIpv4(ip),
  });
  const rendererHost = usesSharedNetworkStack
    ? "127.0.0.1"
    : Option.getOrElse(distroIp, () => "127.0.0.1");
  const httpBaseUrl = new URL(`http://${rendererHost}:${input.port}`);

  const distroArgs = distroForConfig ? ["-d", distroForConfig] : [];
  const forwardedEnv: Record<string, string> = {};
  const forwardedEnvNames: string[] = [];
  for (const name of WSL_FORWARDED_ENV_NAMES) {
    const value = process.env[name];
    if (value !== undefined && value.length > 0) {
      forwardedEnv[name] = value;
      forwardedEnvNames.push(name);
    }
  }

  const parentEnvWithoutT3Home: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key === "T3CODE_HOME") continue;
    parentEnvWithoutT3Home[key] = value;
  }
  const wslEnv = mergeWslEnv(parentEnvWithoutT3Home.WSLENV, forwardedEnvNames);

  const baseConfig = {
    executablePath: "wsl.exe",
    entryPath:
      preflight._tag === "Ready" ? preflight.windowsEntryPath : environment.backendEntryPath,
    cwd: environment.backendCwd,
    env: {
      ...parentEnvWithoutT3Home,
      ...backendChildEnvPatch(),
      ...forwardedEnv,
      ...(wslEnv !== undefined ? { WSLENV: wslEnv } : {}),
    },
    // env already excludes T3CODE_HOME; merging process.env would restore it.
    extendEnv: false,
    bootstrap,
    bootstrapDelivery: "stdin" as const,
    httpBaseUrl,
    captureOutput: true,
    ...(runningDistro !== null ? { runningDistro } : {}),
  };

  // Explicit --dev-url keeps WSL state in dev/ rather than userdata/.
  const devUrlArgs = Option.match(environment.devServerUrl, {
    onNone: () => [] as ReadonlyArray<string>,
    onSome: (url) => ["--dev-url", url.href],
  });

  if (preflight._tag === "Failed") {
    const retryLimit =
      preflight.retryLimit ?? (preflight.fatal ? undefined : WSL_TRANSIENT_PREFLIGHT_RETRY_LIMIT);
    return {
      ...baseConfig,
      args: [...distroArgs, "--", "node", "--version"],
      preflightFailure: Option.some({
        reason: preflight.reason,
        fatal: preflight.fatal,
        ...(retryLimit === undefined ? {} : { retryLimit }),
      }),
    } satisfies DesktopBackendManager.DesktopBackendStartConfig;
  }

  // wsl.exe --exec omits the login-shell PATH needed to find provider CLIs and npm.
  const runtime = preflight.runtime;
  const launchPath =
    runtime.kind === "executable"
      ? `${WSL_SERVER_SYSTEM_PATH}:${preflight.resolvedPath}`
      : `${nodeBinDirOf(runtime.nodePath)}:${WSL_SERVER_SYSTEM_PATH}:${preflight.resolvedPath}`;
  const command =
    runtime.kind === "executable"
      ? [runtime.entryPath]
      : [runtime.nodePath, runtime.linuxEntryPath];

  return {
    ...baseConfig,
    args: [
      ...distroArgs,
      "--exec",
      "env",
      `PATH=${launchPath}`,
      ...command,
      "--bootstrap-fd",
      "0",
      ...devUrlArgs,
    ],
    preflightFailure: Option.none(),
    ...(preflight.runtimeId === undefined ? {} : { wslRuntimeId: preflight.runtimeId }),
  } satisfies DesktopBackendManager.DesktopBackendStartConfig;
});

/** @public */
export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const shellEnvironment = yield* DesktopShellEnvironment.DesktopShellEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const serverExposure = yield* DesktopServerExposure.DesktopServerExposure;
  const wslEnvironment = yield* DesktopWslEnvironment.DesktopWslEnvironment;
  const wslServerTree = yield* DesktopWslServerTree.DesktopWslServerTree;
  const settings = yield* DesktopAppSettings.DesktopAppSettings;
  const crypto = yield* Crypto.Crypto;
  // Random generation yields; serialize it so concurrent backends cannot capture distinct bootstrap secrets.
  const secretRef = yield* SynchronizedRef.make(Option.none<string>());
  const getOrCreateBootstrapSecret = SynchronizedRef.modifyEffect(secretRef, (current) =>
    Option.match(current, {
      onSome: (secret) => Effect.succeed([secret, current] as const),
      onNone: () =>
        crypto.randomBytes(32).pipe(
          Effect.map((bytes) => {
            const secret = Hex.encode(bytes);
            return [secret, Option.some(secret)] as const;
          }),
        ),
    }),
  );

  const sharedInputs = Effect.gen(function* () {
    const bootstrapSecret = yield* getOrCreateBootstrapSecret;
    const bootstrapToken = currentDesktopBootstrapToken(
      bootstrapSecret,
      yield* Clock.currentTimeMillis,
    );
    const observabilitySettings = yield* readBackendObservabilitySettings.pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(DesktopEnvironment.DesktopEnvironment, environment),
    );
    return {
      bootstrapToken,
      bootstrapSecret,
      observabilitySettings,
    } satisfies SharedBootstrapInput;
  });

  const buildWslPrimaryConfig = Effect.gen(function* () {
    const backendExposure = yield* serverExposure.backendConfig;
    const persistedSettings = yield* settings.get;
    const shared = yield* sharedInputs;
    yield* wslEnvironment.preWarm(persistedSettings.wslDistro);
    return yield* resolveWslStartConfig({
      ...shared,
      port: backendExposure.port,
      distro: persistedSettings.wslDistro,
    }).pipe(
      Effect.provideService(DesktopEnvironment.DesktopEnvironment, environment),
      Effect.provideService(DesktopWslEnvironment.DesktopWslEnvironment, wslEnvironment),
      Effect.provideService(DesktopWslServerTree.DesktopWslServerTree, wslServerTree),
      Effect.provideService(FileSystem.FileSystem, fileSystem),
    );
  });

  const buildWindowsPrimaryConfig = Effect.gen(function* () {
    const shared = yield* sharedInputs;
    const resourceMonitorPath = yield* resolveResourceMonitorPath().pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(DesktopEnvironment.DesktopEnvironment, environment),
    );
    const cliPath = yield* DesktopCliShim.install.pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(DesktopEnvironment.DesktopEnvironment, environment),
    );
    const shellEnvironmentPrepared = yield* shellEnvironment.installIntoProcess;
    return yield* resolvePrimaryStartConfig({
      ...shared,
      resourceMonitorPath,
      cliPath,
      shellEnvironmentPrepared,
    }).pipe(
      Effect.provideService(DesktopEnvironment.DesktopEnvironment, environment),
      Effect.provideService(DesktopServerExposure.DesktopServerExposure, serverExposure),
    );
  });

  // Resolve on each restart so toggling wsl-only takes effect without recreating the pool.
  const describePrimary = Effect.gen(function* () {
    const persistedSettings = yield* settings.get;
    const wslRequested = persistedSettings.wslOnly && persistedSettings.wslBackendEnabled;
    // When WSL is unavailable its controls are hidden; fall back to Windows to keep recovery possible.
    const useWsl = wslRequested && (yield* wslEnvironment.isAvailable);
    return { useWsl, wslRequested, distro: persistedSettings.wslDistro };
  });

  const currentBootstrapToken = Effect.gen(function* () {
    const secret = yield* getOrCreateBootstrapSecret;
    return currentDesktopBootstrapToken(secret, yield* Clock.currentTimeMillis);
  });

  return DesktopBackendConfiguration.of({
    currentBootstrapToken,
    resolvePrimary: Effect.gen(function* () {
      const { useWsl, wslRequested } = yield* describePrimary;
      if (useWsl) {
        return yield* buildWslPrimaryConfig;
      }
      if (wslRequested) {
        yield* Effect.logWarning(
          "WSL-only backend requested but WSL is unavailable; starting the Windows primary instead.",
        );
      }
      return yield* buildWindowsPrimaryConfig;
    }).pipe(Effect.withSpan("desktop.backendConfiguration.resolvePrimary")),
    resolvePrimaryLabel: Effect.gen(function* () {
      const { useWsl, distro } = yield* describePrimary;
      if (!useWsl) {
        return environment.platform === "win32" ? "Windows" : "Local environment";
      }
      return distro ? `WSL (${distro})` : "WSL";
    }).pipe(Effect.withSpan("desktop.backendConfiguration.resolvePrimaryLabel")),
    // The span options depend on each request's port and distro.
    resolveWsl: Effect.fnUntraced(
      function* (input) {
        const shared = yield* sharedInputs;
        return yield* resolveWslStartConfig({ ...shared, ...input }).pipe(
          Effect.provideService(DesktopEnvironment.DesktopEnvironment, environment),
          Effect.provideService(DesktopWslEnvironment.DesktopWslEnvironment, wslEnvironment),
          Effect.provideService(DesktopWslServerTree.DesktopWslServerTree, wslServerTree),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
        );
      },
      (effect, input) =>
        effect.pipe(
          Effect.withSpan("desktop.backendConfiguration.resolveWsl", {
            attributes: { port: input.port, distro: input.distro ?? null },
          }),
        ),
    ),
  });
});

export const layer = Layer.effect(DesktopBackendConfiguration, make);
