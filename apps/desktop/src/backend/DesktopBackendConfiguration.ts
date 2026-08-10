import * as NodeOS from "node:os";

import { parsePersistedServerObservabilitySettings } from "@t3tools/shared/serverSettings";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as SynchronizedRef from "effect/SynchronizedRef";

import serverPackageJson from "../../../server/package.json" with { type: "json" };

import * as DesktopBackendManager from "./DesktopBackendManager.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopServerExposure from "./DesktopServerExposure.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopWslEnvironment from "../wsl/DesktopWslEnvironment.ts";

export type WslBackendPortStrategy = "fixed" | "wsl-auto";

export class DesktopBackendObservabilitySettingsReadError extends Schema.TaggedErrorClass<DesktopBackendObservabilitySettingsReadError>()(
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
    // Build the Windows-native primary backend's start config. Reads the
    // primary's port/host/exposure from DesktopServerExposure. Can fail
    // with PlatformError because bootstrap token generation now uses
    // crypto.randomBytes under the hood (post Effect 4 migration).
    readonly resolvePrimary: Effect.Effect<
      DesktopBackendManager.DesktopBackendStartConfig,
      PlatformError.PlatformError
    >;
    // Build a WSL backend start config for the given distro on the given
    // port. The WSL backend is private to the desktop app: WSL2 NAT mode binds
    // only the distro's concrete IPv4 address, while mirrored/fallback mode
    // binds loopback. It never binds every Linux interface. Distro=null means
    // "WSL default distro" and is resolved to one concrete distro in preflight.
    readonly resolveWsl: (input: {
      readonly port: number;
      readonly distro: string | null;
      // `fixed` is used by the WSL-only primary because the production
      // desktop protocol is registered against the configured primary port.
      // `wsl-auto` is used by dual-mode secondary backends: the preferred
      // number is tested inside Linux and WSL may fall back to a kernel-chosen
      // ephemeral port when it is occupied there.
      readonly portStrategy?: WslBackendPortStrategy;
    }) => Effect.Effect<
      DesktopBackendManager.DesktopBackendStartConfig,
      PlatformError.PlatformError
    >;
    // The renderer-facing label for the primary instance, derived from the
    // same decision resolvePrimary makes (including the WSL-availability
    // fall-back to Windows), so the env switcher can't show "WSL" for a
    // backend that actually resolved to Windows.
    readonly resolvePrimaryLabel: Effect.Effect<string>;
  }
>()("@t3tools/desktop/backend/DesktopBackendConfiguration") {}

interface BackendObservabilitySettings {
  readonly otlpTracesUrl: Option.Option<string>;
  readonly otlpMetricsUrl: Option.Option<string>;
}

const emptyBackendObservabilitySettings: BackendObservabilitySettings = {
  otlpTracesUrl: Option.none(),
  otlpMetricsUrl: Option.none(),
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

// Sensitive env vars that the WSL backend needs but Windows process.env won't
// forward across the wsl.exe boundary without WSLENV. The dev-server URL is
// handled separately via a `--dev-url` CLI flag because WSLENV translation of
// URL-shaped values (colons / slashes) is unreliable.
const WSL_FORWARDED_ENV_NAMES = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"] as const;

const WSL_SERVER_SYSTEM_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

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

  // Names already declared, so we don't forward a duplicate. We parse the
  // existing value only for this membership test — the string itself is
  // preserved verbatim below rather than re-serialized.
  const seenNames = new Set(
    existing
      .split(":")
      .map((entry) => getWslEnvEntryName(entry.trim()))
      .filter((name) => name.length > 0),
  );

  const additions = forwardedEnvNames.filter((name) => !seenNames.has(name));

  // Preserve the user's WSLENV exactly as Windows handed it to us — empty
  // "::" segments and duplicate entries are harmless no-ops to WSL and not
  // ours to normalize — and only append the secrets we need to forward
  // across the wsl.exe boundary.
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
    Effect.map(Option.some),
    Effect.catchTags({
      PlatformError: (cause) =>
        cause.reason._tag === "NotFound"
          ? Effect.succeed(Option.none())
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
  };
});

interface SharedBootstrapInput {
  readonly bootstrapToken: string;
  readonly observabilitySettings: BackendObservabilitySettings;
}

interface WslPreflightSuccess {
  readonly _tag: "Ready";
  readonly runningDistro: string;
  readonly linuxEntryPath: string;
  // Absolute path to the node binary the preflight validated after the shared
  // remote resolver repaired PATH. The launch must use this exact path so it
  // doesn't fall through to a different/old node than the one node-pty was
  // built against.
  readonly nodePath: string;
  // PATH captured from the same login shell after the shared resolver loaded
  // version managers. The launch forwards this value directly without a shell.
  readonly resolvedPath: string;
}

interface WslPreflightFailure {
  readonly _tag: "Failed";
  readonly reason: string;
  // Fatal: the WSL distro is misconfigured (no node, wrong version, missing
  // build tools) and retrying won't help — surface it and (wsl-only) fall back
  // to Windows. Non-fatal: transient (WSL not ready yet, wslpath while it
  // boots), with a bounded window for self-healing before fallback.
  readonly fatal: boolean;
  readonly retryLimit?: number;
}

const WSL_TRANSIENT_PREFLIGHT_RETRY_LIMIT = 12;
const WSL_PORT_ALLOCATION_RETRY_LIMIT = 3;

const runWslPreflight = Effect.fn("desktop.backendConfiguration.wslPreflight")(function* (input: {
  readonly distro: string | null;
  readonly windowsEntryPath: string;
  readonly windowsRepoRoot: string;
  readonly allowBuild: boolean;
  readonly bundledNodeWindowsPath?: string | null;
}): Effect.fn.Return<
  WslPreflightSuccess | WslPreflightFailure,
  never,
  DesktopWslEnvironment.DesktopWslEnvironment | FileSystem.FileSystem
> {
  const wslEnv = yield* DesktopWslEnvironment.DesktopWslEnvironment;
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
  const runningDistroRecord = input.distro
    ? (installedDistros.find(
        (installed) => installed.name.toLowerCase() === input.distro?.toLowerCase(),
      ) ?? null)
    : (installedDistros.find((installed) => installed.isDefault) ?? null);
  if (runningDistroRecord === null) {
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

  // The desktop transport below relies on WSL2 networking semantics. WSL1
  // shares the Windows network stack differently and does not provide the
  // distro-address contract used for direct host-to-guest backend access.
  // Fail closed before touching paths or native modules so a WSL1 install
  // never enters a half-working/restart-loop state.
  if (runningDistroRecord.version !== 2) {
    return {
      _tag: "Failed",
      reason: `WSL distro "${runningDistroRecord.name}" is using WSL 1, which T3 Code does not support. Convert it to WSL 2 with \`wsl.exe --set-version "${runningDistroRecord.name}" 2\`, then retry.`,
      fatal: true,
    } as const;
  }
  const runningDistro = runningDistroRecord.name;

  const entryExists = yield* fileSystem
    .exists(input.windowsEntryPath)
    .pipe(Effect.orElseSucceed(() => false));
  if (!entryExists) {
    return {
      _tag: "Failed",
      reason: `missing server entry at ${input.windowsEntryPath}`,
      fatal: true,
    } as const;
  }

  if (input.bundledNodeWindowsPath) {
    const bundledNodeExists = yield* fileSystem
      .exists(input.bundledNodeWindowsPath)
      .pipe(Effect.orElseSucceed(() => false));
    if (!bundledNodeExists) {
      return {
        _tag: "Failed",
        reason: `missing packaged WSL Node runtime at ${input.bundledNodeWindowsPath}`,
        fatal: true,
      } as const;
    }
  }

  const linuxEntry = yield* wslEnv.windowsToWslPath(runningDistro, input.windowsEntryPath);
  if (Option.isNone(linuxEntry)) {
    return {
      _tag: "Failed",
      reason: `wslpath conversion failed for ${input.windowsEntryPath}`,
      fatal: false,
    } as const;
  }

  const nodePtyResult = yield* wslEnv.ensureNodePty(runningDistro, input.windowsRepoRoot, {
    allowBuild: input.allowBuild,
    nodeEngineRange: serverPackageJson.engines.node,
    bundledNodeWindowsPath: input.bundledNodeWindowsPath,
  });
  if (!nodePtyResult.ok) {
    return {
      _tag: "Failed",
      reason: `WSL node-pty unavailable: ${nodePtyResult.reason}`,
      fatal: nodePtyResult.fatal,
      ...(nodePtyResult.retryLimit === undefined ? {} : { retryLimit: nodePtyResult.retryLimit }),
    } as const;
  }

  return {
    _tag: "Ready",
    runningDistro,
    linuxEntryPath: linuxEntry.value,
    nodePath: nodePtyResult.nodePath,
    resolvedPath: nodePtyResult.resolvedPath,
  } as const;
});

// True when the given IPv4 belongs to a Windows-side network
// interface. In WSL2 mirrored mode the distro's eth0 IP equals the
// host's, which is the signature we use to detect that mode and
// switch the renderer URL to loopback.
const isLocalHostIpv4 = (ip: string): boolean => {
  const interfaces = NodeOS.networkInterfaces();
  for (const list of Object.values(interfaces)) {
    if (!list) continue;
    for (const entry of list) {
      // os.networkInterfaces() reports IPv4 `family` as the string "IPv4" on
      // the Node build Electron ships (41 / Node 22, verified), but some Node
      // builds report the numeric 4. Normalize to a string so a future runtime
      // bump can't silently break mirrored-mode detection and leave the
      // renderer pointed at the distro IP instead of loopback.
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
});

const resolvePrimaryStartConfig = Effect.fn("desktop.backendConfiguration.resolvePrimary")(
  function* (
    input: SharedBootstrapInput & {
      readonly resourceMonitorPath: Option.Option<string>;
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
      tailscaleServeEnabled: backendExposure.tailscaleServeEnabled,
      tailscaleServePort: backendExposure.tailscaleServePort,
      desktopTelemetryFd: 4,
      desktopTelemetryControlFd: 5,
      ...Option.match(input.resourceMonitorPath, {
        onNone: () => ({}),
        onSome: (resourceMonitorPath) => ({ resourceMonitorPath }),
      }),
      ...buildObservabilityFragment(input.observabilitySettings),
    };

    return {
      executablePath: process.execPath,
      args: [environment.backendEntryPath, "--bootstrap-fd", "3"],
      entryPath: environment.backendEntryPath,
      cwd: environment.backendCwd,
      env: {
        ...backendChildEnvPatch(),
        ELECTRON_RUN_AS_NODE: "1",
      },
      // Primary wants process.env (PATH, dev-runner's T3CODE_HOME, etc.).
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
    readonly portStrategy?: WslBackendPortStrategy;
  },
): Effect.fn.Return<
  DesktopBackendManager.DesktopBackendStartConfig,
  never,
  | DesktopEnvironment.DesktopEnvironment
  | DesktopWslEnvironment.DesktopWslEnvironment
  | FileSystem.FileSystem
> {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const wslEnvironment = yield* DesktopWslEnvironment.DesktopWslEnvironment;

  // In packaged builds environment.appRoot is .../resources/app.asar — an
  // archive FILE. The Windows primary reads its entry through
  // ELECTRON_RUN_AS_NODE (asar-aware), but processes launched through WSL cannot
  // read inside an asar. electron-builder therefore unpacks the server bundle +
  // node_modules to the app.asar.unpacked sibling; the Linux Node executable is
  // staged separately under resources/wsl-node and cached into the distro during
  // preflight. In dev appRoot is already a real directory, so this is a no-op.
  const wslAppRoot = environment.isPackaged
    ? environment.path.join(environment.resourcesPath, "app.asar.unpacked")
    : environment.appRoot;
  const wslEntryPath = environment.path.join(wslAppRoot, "apps/server/dist/bin.mjs");
  const bundledNodeWindowsPath = environment.isPackaged
    ? environment.path.join(environment.resourcesPath, "wsl-node", "bin", "node")
    : null;

  const preflight = yield* runWslPreflight({
    distro: input.distro,
    windowsEntryPath: wslEntryPath,
    windowsRepoRoot: wslAppRoot,
    // Packaged builds ship a prebuilt Linux node-pty (built on Linux in CI and
    // attached to the Windows artifact — see build-desktop-artifact.ts), so the
    // WSL backend never needs a compiler, node-gyp, or network on first launch.
    // Compiling from source is a dev-only convenience: a checkout has no shipped
    // prebuilt, and developers have the toolchain. In packaged builds we instead
    // surface a clear diagnostic if the prebuilt can't load (unsupported
    // arch/distro), rather than silently dropping into a fragile runtime build.
    allowBuild: !environment.isPackaged,
    bundledNodeWindowsPath,
  });

  // Every operation after preflight uses the same concrete distro. In
  // default-tracking mode this closes the race where the system default
  // changes between probing and spawning the backend.
  const runningDistro = preflight._tag === "Ready" ? preflight.runningDistro : null;
  const distroForConfig = runningDistro ?? input.distro;

  // Resolve the selected distro's IPv4 address only after a successful WSL2
  // preflight. In NAT mode Windows can reach that concrete distro address, so
  // bind exactly that interface rather than 0.0.0.0. In mirrored mode the
  // distro reports a Windows-owned address; bind loopback because both sides
  // share localhost semantics. If address probing fails, fall back to loopback
  // instead of broadening exposure to every Linux interface.
  const distroIp =
    preflight._tag === "Ready"
      ? yield* wslEnvironment.getDistroIp(preflight.runningDistro)
      : Option.none<string>();
  const usesSharedNetworkStack = Option.match(distroIp, {
    onNone: () => false,
    onSome: (ip) => isLocalHostIpv4(ip),
  });
  const wslPrivateHost = usesSharedNetworkStack
    ? "127.0.0.1"
    : Option.getOrElse(distroIp, () => "127.0.0.1");
  const portStrategy = input.portStrategy ?? "fixed";
  const portAllocation =
    preflight._tag === "Ready"
      ? yield* wslEnvironment.allocateTcpPort({
          distro: preflight.runningDistro,
          nodePath: preflight.nodePath,
          host: wslPrivateHost,
          preferredPort: input.port,
          fallbackToEphemeral: portStrategy === "wsl-auto",
        })
      : null;
  const effectivePort = portAllocation?.ok === true ? portAllocation.port : input.port;
  const httpBaseUrl = new URL(`http://${wslPrivateHost}:${effectivePort}`);

  const bootstrap = {
    mode: "desktop" as const,
    noBrowser: true,
    port: effectivePort,
    // Omit t3Home so the Linux backend uses its own home dir instead of
    // the Windows-side baseDir (which would be a /mnt/c path and share
    // the SQLite file with the primary).
    host: wslPrivateHost,
    desktopBootstrapToken: input.bootstrapToken,
    // PortSchema rejects 0, so when tailscale serve is disabled we still
    // need a valid number in this slot. The backend reads tailscaleServePort
    // only when tailscaleServeEnabled is true, so the actual value here is
    // inert.
    tailscaleServeEnabled: false,
    tailscaleServePort: 443,
    // The packaged sidecar is a Windows executable and cannot run inside the
    // Linux WSL backend. Keep the field absent instead of passing an unusable
    // `/mnt/.../*.exe` path; WSL resource telemetry is reported unavailable.
    // See docs/architecture/resource-telemetry.md.
    ...buildObservabilityFragment(input.observabilitySettings),
  };

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

  // Build an explicit copy of process.env minus T3CODE_HOME (dev-runner
  // exports the Windows-side base dir for the primary; if it leaks into
  // the WSL backend the Linux side ends up sharing C:\Users\...\.t3 via
  // /mnt/c, which means both backends read/write the same database and
  // their env-ids collide).
  const parentEnvWithoutT3Home: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key === "T3CODE_HOME") continue;
    parentEnvWithoutT3Home[key] = value;
  }
  const wslEnv = mergeWslEnv(parentEnvWithoutT3Home.WSLENV, forwardedEnvNames);

  const baseConfig = {
    executablePath: "wsl.exe",
    entryPath: wslEntryPath,
    cwd: environment.backendCwd,
    env: {
      ...parentEnvWithoutT3Home,
      ...backendChildEnvPatch(),
      ...forwardedEnv,
      ...(wslEnv !== undefined ? { WSLENV: wslEnv } : {}),
    },
    // env is already a complete process.env minus T3CODE_HOME; pass it
    // verbatim instead of letting the spawner re-merge process.env on top.
    extendEnv: false,
    bootstrap,
    bootstrapDelivery: "stdin" as const,
    httpBaseUrl,
    captureOutput: true,
    ...(runningDistro !== null ? { runningDistro } : {}),
    ...(preflight._tag === "Ready" ? { wslNodePath: preflight.nodePath } : {}),
  };

  // Forward the dev-server URL as an explicit CLI flag so the WSL backend's
  // config resolution lands in dev/ instead of userdata/. Inheriting through
  // WSLENV is unreliable in practice (URL-shaped values with colons /
  // slashes get translated unpredictably depending on flags), and the
  // packaged build leaves devServerUrl as None anyway.
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

  if (portAllocation?.ok === false) {
    const fixedPortHint =
      portStrategy === "fixed"
        ? ` The required WSL-only primary port ${input.port} must be free inside ${preflight.runningDistro}; stop the Linux process using it or switch back to the Windows backend.`
        : "";
    return {
      ...baseConfig,
      args: [...distroArgs, "--", "node", "--version"],
      preflightFailure: Option.some({
        reason: `WSL backend could not allocate TCP port ${input.port} on ${wslPrivateHost} inside ${preflight.runningDistro}: ${portAllocation.reason}${fixedPortHint}`,
        fatal: false,
        retryLimit: WSL_PORT_ALLOCATION_RETRY_LIMIT,
      }),
    } satisfies DesktopBackendManager.DesktopBackendStartConfig;
  }

  if (portAllocation?.ok === true && portAllocation.usedEphemeralFallback) {
    yield* Effect.logInfo("WSL backend preferred port was occupied inside Linux; using ephemeral port", {
      distro: preflight.runningDistro,
      preferredPort: input.port,
      allocatedPort: portAllocation.port,
      host: wslPrivateHost,
    });
  }

  // The WSL server spawns commands its providers reference by name. Put the exact
  // preflight Node runtime first — packaged builds use T3 Code's per-distro cached
  // Linux Node, while development can still use a version-manager Node — then add
  // the distro system/login PATH for user-installed package managers/provider CLIs.
  // Bundling Node removes the server-start dependency on distro Node; npm/pnpm/bun
  // remain provider-tooling concerns and are intentionally resolved from user PATH.
  // Every dynamic
  // value is a separate argv entry under `wsl.exe --exec`; no shell command is
  // involved, so Windows cannot mangle nested quotes and stdin remains reserved
  // for the bootstrap envelope.
  const lastSlash = preflight.nodePath.lastIndexOf("/");
  const nodeBinDir = lastSlash > 0 ? preflight.nodePath.slice(0, lastSlash) : "/usr/bin";
  const launchPath = `${nodeBinDir}:${WSL_SERVER_SYSTEM_PATH}:${preflight.resolvedPath}`;

  return {
    ...baseConfig,
    args: [
      ...distroArgs,
      "--exec",
      "env",
      `PATH=${launchPath}`,
      preflight.nodePath,
      preflight.linuxEntryPath,
      "--bootstrap-fd",
      "0",
      ...devUrlArgs,
    ],
    preflightFailure: Option.none(),
  } satisfies DesktopBackendManager.DesktopBackendStartConfig;
});

export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const serverExposure = yield* DesktopServerExposure.DesktopServerExposure;
  const wslEnvironment = yield* DesktopWslEnvironment.DesktopWslEnvironment;
  const settings = yield* DesktopAppSettings.DesktopAppSettings;
  const crypto = yield* Crypto.Crypto;
  // SynchronizedRef (not a plain Ref) so the read-generate-write is atomic.
  // crypto.randomBytes is a yield point, and resolvePrimary + resolveWsl can
  // resolve concurrently; with a plain Ref both could observe None, generate
  // distinct tokens, and one would overwrite the other — leaving the two
  // backends holding mismatched tokens and breaking the shared-token
  // invariant the renderer relies on. modifyEffect serializes the whole
  // get-or-create so the first caller wins and the rest reuse its token.
  const tokenRef = yield* SynchronizedRef.make(Option.none<string>());
  const getOrCreateBootstrapToken = SynchronizedRef.modifyEffect(tokenRef, (current) =>
    Option.match(current, {
      onSome: (token) => Effect.succeed([token, current] as const),
      onNone: () =>
        crypto.randomBytes(24).pipe(
          Effect.map((bytes) => {
            const token = Encoding.encodeHex(bytes);
            return [token, Option.some(token)] as const;
          }),
        ),
    }),
  );

  // Both resolvers share the same bootstrap token: the renderer holds a
  // single token and uses it against whichever backend it's currently
  // talking to. Observability settings get re-read each resolve so a
  // hot-swap of the server-settings file is picked up on the next
  // restart cycle without having to bounce the desktop process.
  const sharedInputs = Effect.gen(function* () {
    const bootstrapToken = yield* getOrCreateBootstrapToken;
    const observabilitySettings = yield* readPersistedBackendObservabilitySettings.pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(DesktopEnvironment.DesktopEnvironment, environment),
    );
    return { bootstrapToken, observabilitySettings } satisfies SharedBootstrapInput;
  });

  const buildWslPrimaryConfig = Effect.gen(function* () {
    // wsl-only mode pipes the WSL backend through the same port the
    // Windows primary would normally take. That way the renderer
    // still loads from the local-only endpoint advertised by
    // DesktopServerExposure, and primary-aware code paths (cookie
    // auth, the env switcher's "primary" id) keep working without
    // a parallel "secondary" registration.
    const backendExposure = yield* serverExposure.backendConfig;
    const persistedSettings = yield* settings.get;
    const shared = yield* sharedInputs;
    yield* wslEnvironment.preWarm(persistedSettings.wslDistro);
    return yield* resolveWslStartConfig({
      ...shared,
      port: backendExposure.port,
      distro: persistedSettings.wslDistro,
      portStrategy: "fixed",
    }).pipe(
      Effect.provideService(DesktopEnvironment.DesktopEnvironment, environment),
      Effect.provideService(DesktopWslEnvironment.DesktopWslEnvironment, wslEnvironment),
      Effect.provideService(FileSystem.FileSystem, fileSystem),
    );
  });

  const buildWindowsPrimaryConfig = Effect.gen(function* () {
    const shared = yield* sharedInputs;
    const resourceMonitorPath = yield* resolveResourceMonitorPath().pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(DesktopEnvironment.DesktopEnvironment, environment),
    );
    return yield* resolvePrimaryStartConfig({ ...shared, resourceMonitorPath }).pipe(
      Effect.provideService(DesktopEnvironment.DesktopEnvironment, environment),
      Effect.provideService(DesktopServerExposure.DesktopServerExposure, serverExposure),
    );
  });

  // Single source of truth for what the primary actually runs as. Both
  // the start-config dispatch and the renderer-facing label derive from
  // this, so they can't disagree — e.g. the label reading "WSL" while the
  // config silently fell back to Windows because WSL is unavailable.
  // Dispatch happens at resolve time so toggling wsl-only between restarts
  // is picked up on the next start cycle (the pool's primary instance is
  // created once at layer init, but configResolve fires on each restart).
  const describePrimary = Effect.gen(function* () {
    const persistedSettings = yield* settings.get;
    const wslRequested = persistedSettings.wslOnly && persistedSettings.wslBackendEnabled;
    // Only honor wsl-only when WSL is actually usable. If the user
    // persisted wsl-only but WSL has since become unavailable (wsl.exe
    // removed, no distro), fall back to the Windows primary instead of
    // looping forever on preflight failures: the Connections backend
    // control is hidden while WSL is unavailable, so a stuck WSL primary
    // would otherwise leave no in-app way back to Windows.
    const useWsl = wslRequested && (yield* wslEnvironment.isAvailable);
    return { useWsl, wslRequested, distro: persistedSettings.wslDistro };
  });

  return DesktopBackendConfiguration.of({
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
    resolveWsl: (input) =>
      Effect.gen(function* () {
        const shared = yield* sharedInputs;
        return yield* resolveWslStartConfig({ ...shared, ...input }).pipe(
          Effect.provideService(DesktopEnvironment.DesktopEnvironment, environment),
          Effect.provideService(DesktopWslEnvironment.DesktopWslEnvironment, wslEnvironment),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
        );
      }).pipe(
        Effect.withSpan("desktop.backendConfiguration.resolveWsl", {
          attributes: {
            port: input.port,
            portStrategy: input.portStrategy ?? "fixed",
            distro: input.distro ?? null,
          },
        }),
      ),
  });
});

export const layer = Layer.effect(DesktopBackendConfiguration, make);
