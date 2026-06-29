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
    // port. The WSL backend is always loopback-only (the primary owns LAN
    // exposure when the user opts in), so this takes the port directly and
    // hardcodes 127.0.0.1. Distro=null means "WSL default distro" and is
    // forwarded to wsl.exe with no -d flag.
    readonly resolveWsl: (input: {
      readonly port: number;
      readonly distro: string | null;
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

const runWslPreflight = Effect.fn("desktop.backendConfiguration.wslPreflight")(function* (input: {
  readonly distro: string | null;
  readonly windowsEntryPath: string;
  readonly windowsRepoRoot: string;
  readonly allowBuild: boolean;
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
    input: SharedBootstrapInput,
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

  // Bind to 0.0.0.0 inside WSL so the backend is reachable both via
  // WSL2's automatic localhost forwarding (wslhost: Windows 127.0.0.1
  // -> WSL 127.0.0.1) AND via the distro's eth0 IP directly from
  // Windows. wslhost forwarding is unreliable on some Windows hosts:
  // the desktop's readiness probe and the renderer's saved-env-style
  // fetch both saw "Failed to fetch" when the backend only bound to
  // 127.0.0.1 inside WSL. Binding to 0.0.0.0 plus advertising the
  // WSL IP as the renderer-visible URL avoids that dependency.
  // Security-wise this is acceptable for the local-only WSL backend:
  // the network it exposes on is the WSL-vEthernet network, not the
  // LAN; the primary owns LAN exposure when the user opts in.
  const wslBindHost = "0.0.0.0";

  const bootstrap = {
    mode: "desktop" as const,
    noBrowser: true,
    port: input.port,
    // Omit t3Home so the Linux backend uses its own home dir instead of
    // the Windows-side baseDir (which would be a /mnt/c path and share
    // the SQLite file with the primary).
    host: wslBindHost,
    desktopBootstrapToken: input.bootstrapToken,
    // PortSchema rejects 0, so when tailscale serve is disabled we still
    // need a valid number in this slot. The backend reads tailscaleServePort
    // only when tailscaleServeEnabled is true, so the actual value here is
    // inert.
    tailscaleServeEnabled: false,
    tailscaleServePort: 443,
    ...buildObservabilityFragment(input.observabilitySettings),
  };

  // In packaged builds environment.appRoot is .../resources/app.asar — an
  // archive FILE. The Windows primary reads its entry through
  // ELECTRON_RUN_AS_NODE (asar-aware), but the WSL backend launches plain
  // `wsl.exe -- node`, which can't read inside an asar. electron-builder unpacks
  // the server bundle + node-pty (see asarUnpack in build-desktop-artifact.ts)
  // to the app.asar.unpacked sibling, so point WSL there. In dev appRoot is
  // already a real directory, so this is a no-op.
  const wslAppRoot = environment.isPackaged
    ? environment.path.join(environment.resourcesPath, "app.asar.unpacked")
    : environment.appRoot;
  const wslEntryPath = environment.path.join(wslAppRoot, "apps/server/dist/bin.mjs");

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
  });

  // Every operation after preflight uses the same concrete distro. In
  // default-tracking mode this closes the race where the system default
  // changes between probing and spawning the backend.
  const runningDistro = preflight._tag === "Ready" ? preflight.runningDistro : null;
  const distroForConfig = runningDistro ?? input.distro;

  // Resolve the selected distro's IPv4 address. In mirrored mode the distro
  // reports a host interface, so use loopback instead; a failed probe also
  // falls back to loopback and preserves the previous behavior.
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
  };

  // Forward the dev-server URL as an explicit CLI flag so the WSL backend's
  // config resolution lands in dev/ instead of userdata-v2/. Inheriting through
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

  // The WSL server spawns commands its providers reference by name — `npm`/`npx`
  // for provider updates, and the installed CLIs themselves (e.g. `codex`). Those
  // live in the resolved Node's bin dir, which `wsl.exe -- node` does NOT put on
  // the process PATH, so `npm install -g ...` fails with NotFound. Pass the
  // user PATH entries captured by the login-shell preflight. Every dynamic
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
    return yield* resolveWslStartConfig({
      ...shared,
      port: backendExposure.port,
      distro: persistedSettings.wslDistro,
    }).pipe(
      Effect.provideService(DesktopEnvironment.DesktopEnvironment, environment),
      Effect.provideService(DesktopWslEnvironment.DesktopWslEnvironment, wslEnvironment),
      Effect.provideService(FileSystem.FileSystem, fileSystem),
    );
  });

  const buildWindowsPrimaryConfig = Effect.gen(function* () {
    const shared = yield* sharedInputs;
    return yield* resolvePrimaryStartConfig(shared).pipe(
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
          attributes: { port: input.port, distro: input.distro ?? null },
        }),
      ),
  });
});

export const layer = Layer.effect(DesktopBackendConfiguration, make);
