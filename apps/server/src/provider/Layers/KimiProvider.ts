import {
  type KimiSettings,
  type ModelCapabilities,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";
import type * as EffectAcpSchema from "effect-acp/schema";
import { causeErrorTag } from "@t3tools/shared/observability";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { HttpClient } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import {
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  type ProviderMaintenanceCapabilities,
} from "../providerMaintenance.ts";
import {
  isKimiAuthRequiredError,
  kimiModelStateFromSessionSetup,
  makeKimiAcpRuntime,
  probeKimiAcpAuthentication,
  resolveKimiAcpBaseModelId,
  resolveKimiHomePath,
} from "../acp/KimiAcpSupport.ts";

const KIMI_PRESENTATION = {
  displayName: "Kimi",
  badgeLabel: "Early Access",
  showInteractionModeToggle: false,
  requiresNewThreadForModelChange: false,
} as const;
const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

export const KIMI_VERSION_PROBE_TIMEOUT_MS = 10_000;
export const KIMI_ACP_AUTH_PROBE_TIMEOUT_MS = 10_000;
export const KIMI_ACP_MODEL_DISCOVERY_TIMEOUT_MS = 20_000;

export type KimiProbeStage = "version" | "authentication" | "discovery";

export type KimiProbeClassification =
  | { readonly _tag: "disabled" }
  | { readonly _tag: "healthy"; readonly modelSource: "cache" | "discovery" }
  | { readonly _tag: "command-missing" }
  | { readonly _tag: "auth-required" }
  | { readonly _tag: "non-zero-exit"; readonly exitCode: number }
  | { readonly _tag: "acp-failure"; readonly stage: KimiProbeStage; readonly errorTag: string }
  | {
      readonly _tag: "transient-timeout";
      readonly stage: KimiProbeStage;
      readonly timeoutMs: number;
    }
  | {
      readonly _tag: "transient-process-failure";
      readonly stage: KimiProbeStage;
      readonly errorTag: string;
    };

export interface KimiModelDiscoveryCache {
  readonly key: string;
  readonly models: ReadonlyArray<ServerProviderModel>;
}

export interface KimiProviderProbeResult<Snapshot = ServerProviderDraft> {
  readonly classification: KimiProbeClassification;
  readonly snapshot: Snapshot;
  readonly discoveryCache?: KimiModelDiscoveryCache;
}

export function isTransientKimiProbeClassification(
  classification: KimiProbeClassification,
): boolean {
  return (
    classification._tag === "transient-timeout" ||
    classification._tag === "transient-process-failure"
  );
}

export const KIMI_NOT_SIGNED_IN_MESSAGE =
  "Kimi CLI is installed but not signed in. Use Sign in with Kimi in Settings or run `kimi login`.";

// Static fallback matching current kimi-cli builds. Live ACP discovery
// replaces this list whenever the CLI is installed and signed in.
const KIMI_BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "k3",
    name: "Kimi K3",
    isCustom: false,
    isDefault: true,
    capabilities: EMPTY_CAPABILITIES,
  },
  {
    slug: "kimi-for-coding",
    name: "Kimi K2.7 Coding",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
  {
    slug: "kimi-for-coding-highspeed",
    name: "Kimi K2.7 Coding Highspeed",
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
          message: "Kimi is disabled in T3 Code settings.",
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
        message: "Checking Kimi CLI availability...",
      },
    });
  });
}

function kimiModelsFromSettings(
  customModels: ReadonlyArray<string> | undefined,
  builtInModels: ReadonlyArray<ServerProviderModel> = KIMI_BUILT_IN_MODELS,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(builtInModels, customModels ?? [], EMPTY_CAPABILITIES);
}

export function buildKimiDiscoveredModelsFromSessionModelState(
  modelState: EffectAcpSchema.SessionModelState | null | undefined,
): ReadonlyArray<ServerProviderModel> {
  if (!modelState || modelState.availableModels.length === 0) {
    return [];
  }
  const currentBaseModelId = modelState.currentModelId
    ? resolveKimiAcpBaseModelId(modelState.currentModelId)
    : undefined;
  const seen = new Set<string>();
  return modelState.availableModels
    .map((model): ServerProviderModel | undefined => {
      const slug = resolveKimiAcpBaseModelId(model.modelId);
      if (!slug || seen.has(slug)) {
        return undefined;
      }
      seen.add(slug);
      return {
        slug,
        name: model.name.trim() || slug,
        isCustom: false,
        ...(slug === currentBaseModelId ? { isDefault: true } : {}),
        capabilities: EMPTY_CAPABILITIES,
      };
    })
    .filter((model): model is ServerProviderModel => model !== undefined);
}

export type KimiVersionProbeResult =
  | {
      readonly _tag: "success";
      readonly version: string | null;
      readonly resolvedBinaryPath: string;
    }
  | { readonly _tag: "command-missing" }
  | { readonly _tag: "non-zero-exit"; readonly exitCode: number; readonly version: string | null }
  | { readonly _tag: "transient-timeout"; readonly timeoutMs: number }
  | { readonly _tag: "transient-process-failure"; readonly errorTag: string };

export type KimiAcpProbeResult<A> =
  | { readonly _tag: "success"; readonly value: A }
  | { readonly _tag: "auth-required" }
  | { readonly _tag: "failure"; readonly errorTag: string }
  | { readonly _tag: "transient-timeout"; readonly timeoutMs: number }
  | { readonly _tag: "transient-process-failure"; readonly errorTag: string };

type KimiProbeEnvironment = ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto;

export interface KimiProviderProbeOperations {
  readonly probeVersion: (
    kimiSettings: KimiSettings,
    environment: NodeJS.ProcessEnv,
  ) => Effect.Effect<KimiVersionProbeResult, never, KimiProbeEnvironment>;
  readonly probeAuthentication: (
    kimiSettings: KimiSettings,
    environment: NodeJS.ProcessEnv,
  ) => Effect.Effect<KimiAcpProbeResult<void>, never, KimiProbeEnvironment>;
  readonly discoverModels: (
    kimiSettings: KimiSettings,
    environment: NodeJS.ProcessEnv,
  ) => Effect.Effect<
    KimiAcpProbeResult<ReadonlyArray<ServerProviderModel>>,
    never,
    KimiProbeEnvironment
  >;
}

const discoverKimiModelsViaAcp = (
  kimiSettings: KimiSettings,
  environment: NodeJS.ProcessEnv = process.env,
) =>
  Effect.gen(function* () {
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const acp = yield* makeKimiAcpRuntime({
      kimiSettings,
      environment,
      childProcessSpawner,
      cwd: process.cwd(),
      clientInfo: { name: "t3-code-provider-probe", version: "0.0.0" },
    });
    const started = yield* acp.start();
    return buildKimiDiscoveredModelsFromSessionModelState(
      kimiModelStateFromSessionSetup(started.sessionSetupResult),
    );
  }).pipe(Effect.scoped);

const runKimiVersionCommand = (
  kimiSettings: KimiSettings,
  environment: NodeJS.ProcessEnv = process.env,
) =>
  Effect.gen(function* () {
    const command = kimiSettings.binaryPath || "kimi";
    const homePath = resolveKimiHomePath(kimiSettings);
    const env = homePath ? { ...environment, KIMI_CODE_HOME: homePath } : environment;
    const spawnCommand = yield* resolveSpawnCommand(command, ["--version"], {
      env,
    });
    const result = yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env,
        shell: spawnCommand.shell,
      }),
    );
    return { ...result, resolvedBinaryPath: spawnCommand.command };
  });

function errorTag(error: unknown): string {
  if (typeof error !== "object" || error === null || !("_tag" in error)) {
    return "Unknown";
  }
  return typeof error._tag === "string" ? error._tag : "Unknown";
}

function isTransientKimiAcpError(error: unknown): boolean {
  return [
    "AcpSpawnError",
    "AcpProcessExitedError",
    "AcpTransportError",
    "AcpInputStreamEndedError",
  ].includes(errorTag(error));
}

function classifyKimiAcpExit<A>(
  exit: Exit.Exit<Option.Option<A>, unknown>,
  timeoutMs: number,
): KimiAcpProbeResult<A> {
  if (Exit.isFailure(exit)) {
    const failure = Cause.findErrorOption(exit.cause);
    if (Option.isSome(failure) && isKimiAuthRequiredError(failure.value)) {
      return { _tag: "auth-required" };
    }
    const classifiedErrorTag = causeErrorTag(exit.cause);
    return Option.isSome(failure) && isTransientKimiAcpError(failure.value)
      ? { _tag: "transient-process-failure", errorTag: classifiedErrorTag }
      : { _tag: "failure", errorTag: classifiedErrorTag };
  }
  if (Option.isNone(exit.value)) {
    return { _tag: "transient-timeout", timeoutMs };
  }
  return { _tag: "success", value: exit.value.value };
}

const probeKimiVersion = (
  kimiSettings: KimiSettings,
  environment: NodeJS.ProcessEnv,
): Effect.Effect<KimiVersionProbeResult, never, KimiProbeEnvironment> =>
  runKimiVersionCommand(kimiSettings, environment).pipe(
    Effect.timeoutOption(KIMI_VERSION_PROBE_TIMEOUT_MS),
    Effect.result,
    Effect.map((result): KimiVersionProbeResult => {
      if (Result.isFailure(result)) {
        if (isCommandMissingCause(result.failure)) {
          return { _tag: "command-missing" };
        }
        return { _tag: "transient-process-failure", errorTag: errorTag(result.failure) };
      }
      if (Option.isNone(result.success)) {
        return { _tag: "transient-timeout", timeoutMs: KIMI_VERSION_PROBE_TIMEOUT_MS };
      }
      const output = result.success.value;
      const version = parseGenericCliVersion(`${output.stdout}\n${output.stderr}`);
      if (output.code !== 0) {
        return { _tag: "non-zero-exit", exitCode: output.code, version };
      }
      return { _tag: "success", version, resolvedBinaryPath: output.resolvedBinaryPath };
    }),
  );

const probeKimiAuthentication = (
  kimiSettings: KimiSettings,
  environment: NodeJS.ProcessEnv,
): Effect.Effect<KimiAcpProbeResult<void>, never, KimiProbeEnvironment> =>
  Effect.gen(function* () {
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    yield* probeKimiAcpAuthentication({
      kimiSettings,
      environment,
      childProcessSpawner,
      cwd: process.cwd(),
      clientInfo: { name: "t3-code-provider-probe", version: "0.0.0" },
    });
  }).pipe(
    Effect.scoped,
    Effect.timeoutOption(KIMI_ACP_AUTH_PROBE_TIMEOUT_MS),
    Effect.exit,
    Effect.map((exit) => classifyKimiAcpExit(exit, KIMI_ACP_AUTH_PROBE_TIMEOUT_MS)),
  );

const probeKimiModelDiscovery = (
  kimiSettings: KimiSettings,
  environment: NodeJS.ProcessEnv,
): Effect.Effect<
  KimiAcpProbeResult<ReadonlyArray<ServerProviderModel>>,
  never,
  KimiProbeEnvironment
> =>
  discoverKimiModelsViaAcp(kimiSettings, environment).pipe(
    Effect.timeoutOption(KIMI_ACP_MODEL_DISCOVERY_TIMEOUT_MS),
    Effect.exit,
    Effect.map((exit) => classifyKimiAcpExit(exit, KIMI_ACP_MODEL_DISCOVERY_TIMEOUT_MS)),
  );

const LIVE_KIMI_PROBE_OPERATIONS: KimiProviderProbeOperations = {
  probeVersion: probeKimiVersion,
  probeAuthentication: probeKimiAuthentication,
  discoverModels: probeKimiModelDiscovery,
};

export function buildKimiModelDiscoveryCacheKey(input: {
  readonly version: string | null;
  readonly resolvedBinaryPath: string;
  readonly kimiSettings: KimiSettings;
}): string {
  return JSON.stringify({
    version: input.version,
    binaryPath: input.resolvedBinaryPath,
    homePath: resolveKimiHomePath(input.kimiSettings) ?? null,
    settings: {
      binaryPath: input.kimiSettings.binaryPath,
      homePath: input.kimiSettings.homePath,
      customModels: input.kimiSettings.customModels,
    },
  });
}

export interface KimiProviderStatusProbeOptions {
  readonly discoveryCache?: KimiModelDiscoveryCache;
  readonly operations?: KimiProviderProbeOperations;
}

export const probeKimiProviderStatus = Effect.fn("probeKimiProviderStatus")(function* (
  kimiSettings: KimiSettings,
  environment: NodeJS.ProcessEnv = process.env,
  options: KimiProviderStatusProbeOptions = {},
): Effect.fn.Return<KimiProviderProbeResult, never, KimiProbeEnvironment> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = kimiModelsFromSettings(kimiSettings.customModels);
  const operations = options.operations ?? LIVE_KIMI_PROBE_OPERATIONS;

  if (!kimiSettings.enabled) {
    return {
      classification: { _tag: "disabled" },
      snapshot: buildServerProvider({
        presentation: KIMI_PRESENTATION,
        enabled: false,
        checkedAt,
        models: fallbackModels,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Kimi is disabled in T3 Code settings.",
        },
      }),
    };
  }

  const versionResult = yield* operations.probeVersion(kimiSettings, environment);
  if (versionResult._tag === "command-missing") {
    return {
      classification: { _tag: "command-missing" },
      snapshot: buildServerProvider({
        presentation: KIMI_PRESENTATION,
        enabled: true,
        checkedAt,
        models: fallbackModels,
        probe: {
          installed: false,
          version: null,
          status: "error",
          auth: { status: "unknown" },
          message:
            "Kimi CLI (`kimi`) is not installed or not on PATH. Install it from kimi.com/code or with `npm install -g @moonshot-ai/kimi-code`.",
        },
      }),
    };
  }
  if (versionResult._tag === "non-zero-exit") {
    yield* Effect.logWarning("Kimi CLI version probe exited with a non-zero status.", {
      exitCode: versionResult.exitCode,
    });
    return {
      classification: { _tag: "non-zero-exit", exitCode: versionResult.exitCode },
      snapshot: buildServerProvider({
        presentation: KIMI_PRESENTATION,
        enabled: true,
        checkedAt,
        models: fallbackModels,
        probe: {
          installed: true,
          version: versionResult.version,
          status: "error",
          auth: { status: "unknown" },
          message: "Kimi CLI is installed but failed to run.",
        },
      }),
    };
  }
  if (versionResult._tag === "transient-timeout") {
    yield* Effect.logWarning("Kimi CLI version probe timed out.", {
      timeoutMs: versionResult.timeoutMs,
    });
    return {
      classification: {
        _tag: "transient-timeout",
        stage: "version",
        timeoutMs: versionResult.timeoutMs,
      },
      snapshot: buildServerProvider({
        presentation: KIMI_PRESENTATION,
        enabled: true,
        checkedAt,
        models: fallbackModels,
        probe: {
          installed: true,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Kimi CLI health check timed out. T3 Code will retry automatically.",
        },
      }),
    };
  }
  if (versionResult._tag === "transient-process-failure") {
    yield* Effect.logWarning("Kimi CLI health check failed transiently.", {
      errorTag: versionResult.errorTag,
    });
    return {
      classification: {
        _tag: "transient-process-failure",
        stage: "version",
        errorTag: versionResult.errorTag,
      },
      snapshot: buildServerProvider({
        presentation: KIMI_PRESENTATION,
        enabled: true,
        checkedAt,
        models: fallbackModels,
        probe: {
          installed: true,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Kimi CLI health check failed temporarily. T3 Code will retry automatically.",
        },
      }),
    };
  }

  const { version, resolvedBinaryPath } = versionResult;
  const cacheKey = buildKimiModelDiscoveryCacheKey({
    version,
    resolvedBinaryPath,
    kimiSettings,
  });
  const cachedDiscovery =
    options.discoveryCache?.key === cacheKey ? options.discoveryCache : undefined;
  let acpResult: KimiAcpProbeResult<ReadonlyArray<ServerProviderModel>>;
  if (cachedDiscovery) {
    const authenticationResult = yield* operations.probeAuthentication(kimiSettings, environment);
    acpResult =
      authenticationResult._tag === "success"
        ? { _tag: "success", value: cachedDiscovery.models }
        : authenticationResult;
  } else {
    acpResult = yield* operations.discoverModels(kimiSettings, environment);
  }
  const acpStage: KimiProbeStage = cachedDiscovery ? "authentication" : "discovery";

  if (acpResult._tag === "auth-required") {
    return {
      classification: { _tag: "auth-required" },
      snapshot: buildServerProvider({
        presentation: KIMI_PRESENTATION,
        enabled: true,
        checkedAt,
        models: fallbackModels,
        probe: {
          installed: true,
          version,
          status: "error",
          auth: { status: "unauthenticated" },
          message: KIMI_NOT_SIGNED_IN_MESSAGE,
        },
      }),
    };
  }
  if (acpResult._tag === "failure") {
    yield* Effect.logWarning("Kimi ACP probe failed.", {
      stage: acpStage,
      errorTag: acpResult.errorTag,
    });
    return {
      classification: {
        _tag: "acp-failure",
        stage: acpStage,
        errorTag: acpResult.errorTag,
      },
      snapshot: buildServerProvider({
        presentation: KIMI_PRESENTATION,
        enabled: true,
        checkedAt,
        models: fallbackModels,
        probe: {
          installed: true,
          version,
          status: "error",
          auth: { status: "unknown" },
          message: "Kimi CLI is installed but ACP startup failed. Check server logs for details.",
        },
      }),
    };
  }
  if (acpResult._tag === "transient-timeout") {
    yield* Effect.logWarning("Kimi ACP probe timed out.", {
      stage: acpStage,
      timeoutMs: acpResult.timeoutMs,
    });
    return {
      classification: {
        _tag: "transient-timeout",
        stage: acpStage,
        timeoutMs: acpResult.timeoutMs,
      },
      snapshot: buildServerProvider({
        presentation: KIMI_PRESENTATION,
        enabled: true,
        checkedAt,
        models: fallbackModels,
        probe: {
          installed: true,
          version,
          status: "warning",
          auth: { status: "unknown" },
          message: "Kimi ACP health check timed out. T3 Code will retry automatically.",
        },
      }),
    };
  }
  if (acpResult._tag === "transient-process-failure") {
    yield* Effect.logWarning("Kimi ACP probe failed transiently.", {
      stage: acpStage,
      errorTag: acpResult.errorTag,
    });
    return {
      classification: {
        _tag: "transient-process-failure",
        stage: acpStage,
        errorTag: acpResult.errorTag,
      },
      snapshot: buildServerProvider({
        presentation: KIMI_PRESENTATION,
        enabled: true,
        checkedAt,
        models: fallbackModels,
        probe: {
          installed: true,
          version,
          status: "warning",
          auth: { status: "unknown" },
          message: "Kimi ACP health check failed temporarily. T3 Code will retry automatically.",
        },
      }),
    };
  }

  const discoveredModels = acpResult.value;
  const models =
    discoveredModels.length > 0
      ? kimiModelsFromSettings(kimiSettings.customModels, discoveredModels)
      : fallbackModels;
  const discoveryCache = cachedDiscovery ?? { key: cacheKey, models: discoveredModels };

  return {
    classification: {
      _tag: "healthy",
      modelSource: cachedDiscovery ? "cache" : "discovery",
    },
    snapshot: buildServerProvider({
      presentation: KIMI_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version,
        status: "ready",
        auth: { status: "authenticated" },
      },
    }),
    discoveryCache,
  };
});

export const checkKimiProviderStatus = Effect.fn("checkKimiProviderStatus")(function* (
  kimiSettings: KimiSettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<ServerProviderDraft, never, KimiProbeEnvironment> {
  return (yield* probeKimiProviderStatus(kimiSettings, environment)).snapshot;
});

export const enrichKimiSnapshot = (input: {
  readonly snapshot: ServerProvider;
  readonly maintenanceCapabilities: ProviderMaintenanceCapabilities;
  readonly enableProviderUpdateChecks?: boolean;
  readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
  readonly httpClient: HttpClient.HttpClient;
}): Effect.Effect<void> => {
  const { snapshot, publishSnapshot } = input;

  return enrichProviderSnapshotWithVersionAdvisory(snapshot, input.maintenanceCapabilities, {
    enableProviderUpdateChecks: input.enableProviderUpdateChecks,
  }).pipe(
    Effect.provideService(HttpClient.HttpClient, input.httpClient),
    Effect.flatMap((enrichedSnapshot) => publishSnapshot(enrichedSnapshot)),
    Effect.catchCause((cause) =>
      Effect.logWarning("Kimi version advisory enrichment failed", {
        errorTag: causeErrorTag(cause),
      }),
    ),
    Effect.asVoid,
  );
};
