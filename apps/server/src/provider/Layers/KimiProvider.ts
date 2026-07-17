import {
  type KimiSettings,
  type ModelCapabilities,
  ProviderDriverKind,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { HttpClient } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import type * as EffectAcpErrors from "effect-acp/errors";

import {
  getKimiAcpModelOptions,
  isKimiModelCatalogEmpty,
  KIMI_AUTH_REQUIRED_MESSAGE,
  makeKimiAcpRuntime,
  resolveKimiAcpBaseModelId,
  resolveKimiBinaryPath,
} from "../acp/KimiAcpSupport.ts";
import { type ProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import {
  buildServerProvider,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import {
  enrichCliProviderSnapshotAdvisory,
  runCliProviderStatusProbe,
} from "../providerStatusProbe.ts";

const KIMI_PRESENTATION = {
  displayName: "Kimi Code",
  badgeLabel: "Early Access",
  showInteractionModeToggle: true,
} as const;
const PROVIDER = ProviderDriverKind.make("kimi");
const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

// The Kimi CLI is a large single binary; cold starts on Windows (first spawn
// after boot, antivirus scanning) can far exceed the ~1s warm-path latency.
const VERSION_PROBE_TIMEOUT_MS = 15_000;
const KIMI_ACP_MODEL_DISCOVERY_TIMEOUT_MS = 15_000;

// Shown when the ACP session carried no "model" config option at all (as
// opposed to an empty option list, which is the signed-out signal). This
// points at an incompatible or malformed CLI rather than an auth problem, so
// telling the user to "run kimi login" would only mislead them.
const KIMI_MODELS_UNAVAILABLE_MESSAGE =
  "Kimi Code CLI is installed but returned no models. The installed CLI may be incompatible or misconfigured; check server logs for details.";

export const KIMI_BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "kimi-for-coding",
    name: "Kimi for Coding",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
  {
    slug: "kimi-for-coding-highspeed",
    name: "Kimi for Coding Highspeed",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
];

export function buildInitialKimiProviderSnapshot(
  kimiSettings: KimiSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = kimiModelsFromSettings(kimiSettings.customModels);

    if (!kimiSettings.enabled) {
      return buildServerProvider({
        presentation: KIMI_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Kimi Code is disabled in T3 Code settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: KIMI_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Checking Kimi Code CLI availability...",
      },
    });
  });
}

function kimiModelsFromSettings(
  customModels: ReadonlyArray<string> | undefined,
  builtInModels: ReadonlyArray<ServerProviderModel> = KIMI_BUILT_IN_MODELS,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(
    builtInModels,
    PROVIDER,
    customModels ?? [],
    EMPTY_CAPABILITIES,
  );
}

export function buildKimiDiscoveredModelsFromConfigOptions(
  configOptions: Parameters<typeof getKimiAcpModelOptions>[0],
): ReadonlyArray<ServerProviderModel> {
  const seen = new Set<string>();
  return getKimiAcpModelOptions(configOptions).flatMap((model) => {
    const slug = resolveKimiAcpBaseModelId(model.value);
    if (!slug || seen.has(slug)) {
      return [];
    }
    seen.add(slug);
    return [
      {
        slug,
        name: model.name || slug,
        isCustom: false,
        capabilities: EMPTY_CAPABILITIES,
      } satisfies ServerProviderModel,
    ];
  });
}

export interface KimiAcpDiscoveryResult {
  readonly models: ReadonlyArray<ServerProviderModel>;
  /**
   * True when the CLI reported a "model" config option whose option list is
   * empty — Kimi's signed-out signal. Distinguished from a response that
   * carries no "model" option at all (an incompatible or malformed CLI), which
   * also yields zero models but is not an authentication problem.
   */
  readonly catalogEmpty: boolean;
}

/**
 * Map an ACP model-discovery result to a terminal provider snapshot. The three
 * outcomes are kept distinct on purpose:
 *  - models present     → ready / authenticated
 *  - empty catalog      → unauthenticated ("run kimi login")
 *  - no model option    → discovery error (incompatible/malformed CLI)
 *
 * Collapsing the last two — as a plain `models.length === 0` check would — tells
 * users to log in even when authentication is fine, masking the real fault.
 */
export function buildKimiDiscoveredProviderSnapshot(input: {
  readonly kimiSettings: KimiSettings;
  readonly checkedAt: string;
  readonly fallbackModels: ReadonlyArray<ServerProviderModel>;
  readonly version: string | null;
  readonly discovery: KimiAcpDiscoveryResult;
}): ServerProviderDraft {
  const { kimiSettings, checkedAt, fallbackModels, version, discovery } = input;

  if (discovery.models.length > 0) {
    return buildServerProvider({
      presentation: KIMI_PRESENTATION,
      enabled: kimiSettings.enabled,
      checkedAt,
      models: kimiModelsFromSettings(kimiSettings.customModels, discovery.models),
      probe: {
        installed: true,
        version,
        status: "ready",
        auth: { status: "authenticated" },
      },
    });
  }

  if (discovery.catalogEmpty) {
    return buildServerProvider({
      presentation: KIMI_PRESENTATION,
      enabled: kimiSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unauthenticated" },
        message: KIMI_AUTH_REQUIRED_MESSAGE,
      },
    });
  }

  return buildServerProvider({
    presentation: KIMI_PRESENTATION,
    enabled: kimiSettings.enabled,
    checkedAt,
    models: fallbackModels,
    probe: {
      installed: true,
      version,
      status: "error",
      auth: { status: "unknown" },
      message: KIMI_MODELS_UNAVAILABLE_MESSAGE,
    },
  });
}

export const discoverKimiModelsViaAcp = (
  kimiSettings: KimiSettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.Effect<
  KimiAcpDiscoveryResult,
  EffectAcpErrors.AcpError,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto | FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const acp = yield* makeKimiAcpRuntime({
      kimiSettings,
      environment,
      childProcessSpawner,
      cwd: process.cwd(),
      clientInfo: { name: "t3-code-provider-probe", version: "0.0.0" },
    });
    yield* acp.start();
    const configOptions = yield* acp.getConfigOptions;
    return {
      models: buildKimiDiscoveredModelsFromConfigOptions(configOptions),
      catalogEmpty: isKimiModelCatalogEmpty(configOptions),
    };
  }).pipe(Effect.scoped);

const runKimiVersionCommand = (
  kimiSettings: KimiSettings,
  environment: NodeJS.ProcessEnv = process.env,
) =>
  Effect.gen(function* () {
    const command = yield* resolveKimiBinaryPath(kimiSettings, environment);
    const spawnCommand = yield* resolveSpawnCommand(command, ["--version"], {
      env: environment,
    });
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: environment,
        shell: spawnCommand.shell,
      }),
    );
  });

export const checkKimiProviderStatus = Effect.fn("checkKimiProviderStatus")(function* (
  kimiSettings: KimiSettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto | FileSystem.FileSystem | Path.Path
> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = kimiModelsFromSettings(kimiSettings.customModels);

  if (!kimiSettings.enabled) {
    return buildServerProvider({
      presentation: KIMI_PRESENTATION,
      enabled: false,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Kimi Code is disabled in T3 Code settings.",
      },
    });
  }

  return yield* runCliProviderStatusProbe({
    presentation: KIMI_PRESENTATION,
    enabled: kimiSettings.enabled,
    checkedAt,
    fallbackModels,
    versionProbeTimeoutMs: VERSION_PROBE_TIMEOUT_MS,
    discoveryTimeoutMs: KIMI_ACP_MODEL_DISCOVERY_TIMEOUT_MS,
    runVersionCommand: runKimiVersionCommand(kimiSettings, environment),
    discoverModels: discoverKimiModelsViaAcp(kimiSettings, environment),
    messages: {
      disabled: "Kimi Code is disabled in T3 Code settings.",
      commandMissing: "Kimi Code CLI command kimi is not installed or not on PATH.",
      healthCheckFailed: "Failed to execute Kimi Code CLI health check.",
      versionProbeTimeout: "Kimi Code CLI is installed but timed out while running kimi --version.",
      nonZeroExit: "Kimi Code CLI is installed but failed to run.",
      discoveryFailed:
        "Kimi Code CLI is installed but ACP startup failed. Check server logs for details.",
      discoveryTimeout:
        "Kimi Code CLI is installed but ACP startup timed out after " +
        KIMI_ACP_MODEL_DISCOVERY_TIMEOUT_MS +
        "ms.",
    },
    logMessages: {
      healthCheckFailed: "Kimi Code CLI health check failed.",
      nonZeroExit: "Kimi Code CLI version probe exited with a non-zero status.",
      discoveryFailed: "Kimi ACP model discovery failed",
      discoveryTimeout:
        "Kimi ACP model discovery timed out after " + KIMI_ACP_MODEL_DISCOVERY_TIMEOUT_MS + "ms.",
    },
    buildDiscoveredSnapshot: ({ version, discoveredModels }) =>
      buildKimiDiscoveredProviderSnapshot({
        kimiSettings,
        checkedAt,
        fallbackModels,
        version,
        discovery: discoveredModels,
      }),
  });
});

export const enrichKimiSnapshot = (input: {
  readonly settings: KimiSettings;
  readonly snapshot: ServerProvider;
  readonly maintenanceCapabilities: ProviderMaintenanceCapabilities;
  readonly enableProviderUpdateChecks?: boolean;
  readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
  readonly httpClient: HttpClient.HttpClient;
}): Effect.Effect<void> =>
  enrichCliProviderSnapshotAdvisory({
    snapshot: input.snapshot,
    maintenanceCapabilities: input.maintenanceCapabilities,
    enableProviderUpdateChecks: input.enableProviderUpdateChecks,
    publishSnapshot: input.publishSnapshot,
    httpClient: input.httpClient,
    warningLogMessage: "Kimi version advisory enrichment failed",
    skip: !input.settings.enabled || input.snapshot.auth.status === "unauthenticated",
  });
