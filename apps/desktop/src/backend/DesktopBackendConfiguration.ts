import { parsePersistedServerObservabilitySettings } from "@t3tools/shared/serverSettings";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Random from "effect/Random";
import * as Ref from "effect/Ref";

import serverPackageJson from "../../../server/package.json" with { type: "json" };

import * as DesktopBackendManager from "./DesktopBackendManager.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopObservability from "../app/DesktopObservability.ts";
import * as DesktopServerExposure from "./DesktopServerExposure.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopWslEnvironment from "../wsl/DesktopWslEnvironment.ts";

export interface DesktopBackendConfigurationShape {
  readonly resolve: Effect.Effect<DesktopBackendManager.DesktopBackendStartConfig>;
}

export class DesktopBackendConfiguration extends Context.Service<
  DesktopBackendConfiguration,
  DesktopBackendConfigurationShape
>()("t3/desktop/BackendConfiguration") {}

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
  const entries: string[] = [];
  const seenNames = new Set<string>();

  for (const rawEntry of existingWslEnv?.split(":") ?? []) {
    const entry = rawEntry.trim();
    if (entry.length === 0) continue;

    const name = getWslEnvEntryName(entry);
    if (name.length === 0 || seenNames.has(name)) continue;

    seenNames.add(name);
    entries.push(entry);
  }

  for (const name of forwardedEnvNames) {
    if (seenNames.has(name)) continue;

    seenNames.add(name);
    entries.push(name);
  }

  return entries.length > 0 ? entries.join(":") : undefined;
};

const { logWarning: logBackendConfigurationWarning } = DesktopObservability.makeComponentLogger(
  "desktop-backend-configuration",
);

const readPersistedBackendObservabilitySettings: Effect.Effect<
  BackendObservabilitySettings,
  never,
  FileSystem.FileSystem | DesktopEnvironment.DesktopEnvironment
> = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const exists = yield* fileSystem
    .exists(environment.serverSettingsPath)
    .pipe(Effect.orElseSucceed(() => false));
  if (!exists) {
    return emptyBackendObservabilitySettings;
  }

  const raw = yield* fileSystem.readFileString(environment.serverSettingsPath).pipe(Effect.option);
  if (Option.isNone(raw)) {
    yield* logBackendConfigurationWarning(
      "failed to read persisted backend observability settings",
    );
    return emptyBackendObservabilitySettings;
  }

  const parsed = parsePersistedServerObservabilitySettings(raw.value);
  return {
    otlpTracesUrl: Option.fromNullishOr(parsed.otlpTracesUrl),
    otlpMetricsUrl: Option.fromNullishOr(parsed.otlpMetricsUrl),
  };
});

const getOrCreateBootstrapToken = Effect.fn("desktop.backendConfiguration.bootstrapToken")(
  function* (tokenRef: Ref.Ref<Option.Option<string>>) {
    const existing = yield* Ref.get(tokenRef);
    if (Option.isSome(existing)) {
      return existing.value;
    }

    let token = "";
    while (token.length < 48) {
      token += (yield* Random.nextUUIDv4).replace(/-/g, "");
    }
    token = token.slice(0, 48);
    yield* Ref.set(tokenRef, Option.some(token));
    return token;
  },
);

interface ResolveBackendStartConfigInput {
  readonly bootstrapToken: string;
  readonly observabilitySettings: BackendObservabilitySettings;
  readonly wslMode: "local" | "wsl";
  readonly wslDistro: string | null;
}

interface WslPreflightOutcome {
  readonly _tag: "Ready";
  readonly linuxEntryPath: string;
}

interface WslPreflightFailure {
  readonly _tag: "Failed";
  readonly reason: string;
}

const runWslPreflight = Effect.fn("desktop.backendConfiguration.wslPreflight")(function* (input: {
  readonly distro: string | null;
  readonly windowsEntryPath: string;
  readonly windowsRepoRoot: string;
  readonly allowBuild: boolean;
}): Effect.fn.Return<
  WslPreflightOutcome | WslPreflightFailure,
  never,
  DesktopWslEnvironment.DesktopWslEnvironment | FileSystem.FileSystem
> {
  const wslEnv = yield* DesktopWslEnvironment.DesktopWslEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;

  const wslAvailable = yield* wslEnv.isAvailable;
  if (!wslAvailable) {
    return { _tag: "Failed", reason: "WSL is not available on this system" } as const;
  }

  const entryExists = yield* fileSystem
    .exists(input.windowsEntryPath)
    .pipe(Effect.orElseSucceed(() => false));
  if (!entryExists) {
    return {
      _tag: "Failed",
      reason: `missing server entry at ${input.windowsEntryPath}`,
    } as const;
  }

  const linuxEntry = yield* wslEnv.windowsToWslPath(input.distro, input.windowsEntryPath);
  if (Option.isNone(linuxEntry)) {
    return {
      _tag: "Failed",
      reason: `wslpath conversion failed for ${input.windowsEntryPath}`,
    } as const;
  }

  const nodePtyResult = yield* wslEnv.ensureNodePty(input.distro, input.windowsRepoRoot, {
    allowBuild: input.allowBuild,
    nodeEngineRange: serverPackageJson.engines.node,
  });
  if (!nodePtyResult.ok) {
    return {
      _tag: "Failed",
      reason: `WSL node-pty unavailable: ${nodePtyResult.reason}`,
    } as const;
  }

  return { _tag: "Ready", linuxEntryPath: linuxEntry.value } as const;
});

const resolveBackendStartConfig = Effect.fn("desktop.backendConfiguration.resolveStartConfig")(
  function* (
    input: ResolveBackendStartConfigInput,
  ): Effect.fn.Return<
    DesktopBackendManager.DesktopBackendStartConfig,
    never,
    | DesktopEnvironment.DesktopEnvironment
    | DesktopServerExposure.DesktopServerExposure
    | DesktopWslEnvironment.DesktopWslEnvironment
    | FileSystem.FileSystem
  > {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const serverExposure = yield* DesktopServerExposure.DesktopServerExposure;
    const backendExposure = yield* serverExposure.backendConfig;

    const useWsl = input.wslMode === "wsl" && environment.platform === "win32";

    const bootstrap = {
      mode: "desktop" as const,
      noBrowser: true,
      port: backendExposure.port,
      // Omit t3Home for WSL mode so the Linux backend uses its own home dir
      // instead of the Windows-side baseDir (which would be a /mnt/c path).
      ...(useWsl ? {} : { t3Home: environment.baseDir }),
      host: backendExposure.bindHost,
      desktopBootstrapToken: input.bootstrapToken,
      tailscaleServeEnabled: backendExposure.tailscaleServeEnabled,
      tailscaleServePort: backendExposure.tailscaleServePort,
      ...Option.match(input.observabilitySettings.otlpTracesUrl, {
        onNone: () => ({}),
        onSome: (otlpTracesUrl) => ({ otlpTracesUrl }),
      }),
      ...Option.match(input.observabilitySettings.otlpMetricsUrl, {
        onNone: () => ({}),
        onSome: (otlpMetricsUrl) => ({ otlpMetricsUrl }),
      }),
    };

    if (!useWsl) {
      return {
        executablePath: process.execPath,
        args: [environment.backendEntryPath, "--bootstrap-fd", "3"],
        entryPath: environment.backendEntryPath,
        cwd: environment.backendCwd,
        env: {
          ...backendChildEnvPatch(),
          ELECTRON_RUN_AS_NODE: "1",
        },
        // Local mode wants process.env (PATH, dev-runner's T3CODE_HOME, etc.).
        extendEnv: true,
        bootstrap,
        bootstrapDelivery: "fd3",
        httpBaseUrl: backendExposure.httpBaseUrl,
        captureOutput: true,
        preflightFailure: Option.none(),
      } satisfies DesktopBackendManager.DesktopBackendStartConfig;
    }

    const preflight = yield* runWslPreflight({
      distro: input.wslDistro,
      windowsEntryPath: environment.backendEntryPath,
      windowsRepoRoot: environment.appRoot,
      allowBuild: !environment.isPackaged,
    });

    const distroArgs = input.wslDistro ? ["-d", input.wslDistro] : [];
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
    // exports the Windows-side base dir for the local backend; if it leaks
    // into the WSL backend the Linux side ends up sharing C:\Users\...\.t3
    // via /mnt/c, which means both backends are reading/writing the same
    // database and the env-id never differs across the swap).
    const parentEnvWithoutT3Home: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (key === "T3CODE_HOME") continue;
      parentEnvWithoutT3Home[key] = value;
    }
    const wslEnv = mergeWslEnv(parentEnvWithoutT3Home.WSLENV, forwardedEnvNames);

    const baseConfig = {
      executablePath: "wsl.exe",
      entryPath: environment.backendEntryPath,
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
      httpBaseUrl: backendExposure.httpBaseUrl,
      captureOutput: true,
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
      return {
        ...baseConfig,
        args: [...distroArgs, "--", "node", "--version"],
        preflightFailure: Option.some(preflight.reason),
      } satisfies DesktopBackendManager.DesktopBackendStartConfig;
    }

    return {
      ...baseConfig,
      args: [
        ...distroArgs,
        "--",
        "node",
        preflight.linuxEntryPath,
        "--bootstrap-fd",
        "0",
        ...devUrlArgs,
      ],
      preflightFailure: Option.none(),
    } satisfies DesktopBackendManager.DesktopBackendStartConfig;
  },
);

export const layer = Layer.effect(
  DesktopBackendConfiguration,
  Effect.gen(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const fileSystem = yield* FileSystem.FileSystem;
    const serverExposure = yield* DesktopServerExposure.DesktopServerExposure;
    const appSettings = yield* DesktopAppSettings.DesktopAppSettings;
    const wslEnvironment = yield* DesktopWslEnvironment.DesktopWslEnvironment;
    const tokenRef = yield* Ref.make(Option.none<string>());

    return DesktopBackendConfiguration.of({
      resolve: Effect.gen(function* () {
        const bootstrapToken = yield* getOrCreateBootstrapToken(tokenRef);
        const observabilitySettings = yield* readPersistedBackendObservabilitySettings.pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(DesktopEnvironment.DesktopEnvironment, environment),
        );
        const settings = yield* appSettings.get;
        return yield* resolveBackendStartConfig({
          bootstrapToken,
          observabilitySettings,
          wslMode: settings.wslMode,
          wslDistro: settings.wslDistro,
        }).pipe(
          Effect.provideService(DesktopEnvironment.DesktopEnvironment, environment),
          Effect.provideService(DesktopServerExposure.DesktopServerExposure, serverExposure),
          Effect.provideService(DesktopWslEnvironment.DesktopWslEnvironment, wslEnvironment),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
        );
      }).pipe(Effect.withSpan("desktop.backendConfiguration.resolve")),
    });
  }),
);
