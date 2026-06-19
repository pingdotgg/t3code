import {
  type GrokBuildSettings,
  type ModelCapabilities,
  ProviderDriverKind,
  type ServerProvider,
  type ServerProviderAuth,
  type ServerProviderModel,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { createModelCapabilities } from "@t3tools/shared/model";
import type * as EffectAcpSchema from "effect-acp/schema";

import {
  buildGrokCliProcessEnv,
  extractGrokAcpAvailableModels,
  mapGrokAcpModelIdToSlug,
  parseEnvJson,
  probeGrokBuildViaAcp,
  type GrokAcpAvailableModel,
  type GrokAcpProbeResult,
} from "../acp/GrokAcpSupport.ts";
import {
  buildServerProvider,
  detailFromResult,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ProviderProbeResult,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import {
  createProviderVersionAdvisory,
  type ProviderMaintenanceCapabilities,
} from "../providerMaintenance.ts";

const DRIVER_KIND = ProviderDriverKind.make("grok-build");
const GROK_ACP_PROBE_TIMEOUT_MS = 15_000;
const GROK_UPDATE_CHECK_TIMEOUT_MS = 8_000;

const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

const DEFAULT_PRESENTATION = {
  displayName: "Grok Build" as const,
  showInteractionModeToggle: false,
};

const BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "grok-build",
    name: "Grok Build",
    shortName: "Grok Build",
    isCustom: false,
    capabilities: null,
  },
  {
    slug: "composer-2.5",
    name: "Composer 2.5",
    shortName: "Composer 2.5",
    isCustom: false,
    capabilities: null,
  },
];

const GrokUpdateCheckResponse = Schema.Struct({
  currentVersion: Schema.optional(Schema.String),
  latestVersion: Schema.optional(Schema.String),
  updateAvailable: Schema.optional(Schema.Boolean),
});
const decodeGrokUpdateCheckResponse = Schema.decodeUnknownEffect(
  Schema.fromJsonString(GrokUpdateCheckResponse),
);

export interface GrokBuildPresentation {
  readonly displayName: "Grok Build";
  readonly showInteractionModeToggle: boolean;
}

export interface GrokModelsCliResult {
  readonly auth: ServerProviderAuth;
  readonly models: ReadonlyArray<GrokAcpAvailableModel>;
}

function isModeConfigOption(option: EffectAcpSchema.SessionConfigOption): boolean {
  const category = option.category?.trim().toLowerCase() ?? "";
  const id = option.id.trim().toLowerCase();
  return category === "mode" || id === "mode";
}

export function buildGrokBuildPresentationFromProbe(input: {
  readonly configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>;
  readonly sessionSetupResult?: GrokAcpProbeResult["sessionSetupResult"];
}): GrokBuildPresentation {
  const hasModes =
    input.configOptions.some(isModeConfigOption) ||
    (input.sessionSetupResult?.modes?.availableModes.length ?? 0) > 0;
  return {
    displayName: "Grok Build",
    showInteractionModeToggle: hasModes,
  };
}

export function parseGrokModelsCliOutput(output: string): GrokModelsCliResult {
  const lines = output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  let auth: ServerProviderAuth = { status: "unknown" };
  const models: GrokAcpAvailableModel[] = [];

  for (const line of lines) {
    const loggedInMatch = /^you are logged in with\s+(.+)$/i.exec(line);
    if (loggedInMatch) {
      const identity = loggedInMatch[1]?.trim().replace(/\.+$/, "");
      auth = {
        status: "authenticated",
        ...(identity
          ? {
              label: identity,
              type: identity,
            }
          : {}),
      };
      continue;
    }
    if (/^you are not logged in/i.test(line) || /^not logged in/i.test(line)) {
      auth = { status: "unauthenticated" };
      continue;
    }

    const modelMatch = /^[*-]\s+([^\s(]+)(?:\s+\(default\))?$/i.exec(line);
    if (modelMatch) {
      const modelId = modelMatch[1]?.trim();
      if (modelId) {
        models.push({
          modelId,
          name: mapGrokAcpModelIdToSlug(modelId) === "composer-2.5" ? "Composer 2.5" : modelId,
        });
      }
    }
  }

  return { auth, models };
}

export function buildGrokModelsFromAcpProbe(
  probe: GrokAcpProbeResult,
): ReadonlyArray<ServerProviderModel> {
  const availableModels = extractGrokAcpAvailableModels(probe);
  if (availableModels.length === 0) {
    return [];
  }
  return availableModels.map((model) => ({
    slug: mapGrokAcpModelIdToSlug(model.modelId),
    name: model.name,
    shortName: model.name,
    isCustom: false,
    capabilities: null,
  }));
}

export function buildGrokModelsFromCliModels(
  models: ReadonlyArray<GrokAcpAvailableModel>,
): ReadonlyArray<ServerProviderModel> {
  if (models.length === 0) {
    return [];
  }
  return models.map((model) => ({
    slug: mapGrokAcpModelIdToSlug(model.modelId),
    name: model.name,
    shortName: model.name,
    isCustom: false,
    capabilities: null,
  }));
}

function resolveGrokBuildModels(
  settings: GrokBuildSettings,
  discoveredModels: ReadonlyArray<ServerProviderModel>,
): ReadonlyArray<ServerProviderModel> {
  const baseModels = discoveredModels.length > 0 ? discoveredModels : BUILT_IN_MODELS;
  return providerModelsFromSettings(
    baseModels,
    DRIVER_KIND,
    settings.customModels ?? [],
    EMPTY_CAPABILITIES,
  );
}

function buildGrokProbeSnapshot(input: {
  readonly settings: GrokBuildSettings;
  readonly checkedAt: string;
  readonly presentation?: GrokBuildPresentation;
  readonly models?: ReadonlyArray<ServerProviderModel>;
  readonly probe: ProviderProbeResult;
}): ServerProviderDraft {
  return buildServerProvider({
    driver: DRIVER_KIND,
    presentation: input.presentation ?? DEFAULT_PRESENTATION,
    enabled: input.settings.enabled,
    checkedAt: input.checkedAt,
    models: resolveGrokBuildModels(input.settings, input.models ?? []),
    probe: input.probe,
  });
}

const runGrokModelsCliCheck = (
  command: string,
  cliEnv: NodeJS.ProcessEnv,
): Effect.Effect<GrokModelsCliResult, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    const modelsCliCheck = yield* spawnAndCollect(
      command,
      ChildProcess.make(command, ["models"], {
        env: cliEnv,
        shell: process.platform === "win32",
      }),
    ).pipe(Effect.result);

    if (modelsCliCheck._tag !== "Success" || modelsCliCheck.success.code !== 0) {
      return { auth: { status: "unknown" as const }, models: [] };
    }

    return parseGrokModelsCliOutput(
      `${modelsCliCheck.success.stdout}\n${modelsCliCheck.success.stderr}`,
    );
  });

const runGrokAcpDiscovery = (
  settings: GrokBuildSettings,
  env: NodeJS.ProcessEnv,
  envOverrides: Record<string, string>,
): Effect.Effect<
  | {
      readonly presentation: GrokBuildPresentation;
      readonly models: ReadonlyArray<ServerProviderModel>;
    }
  | undefined,
  never,
  ChildProcessSpawner.ChildProcessSpawner
> =>
  Effect.gen(function* () {
    const probeExit = yield* Effect.exit(
      probeGrokBuildViaAcp(settings, env, envOverrides).pipe(
        Effect.timeoutOption(GROK_ACP_PROBE_TIMEOUT_MS),
      ),
    );
    if (Exit.isFailure(probeExit)) {
      yield* Effect.logWarning("Grok Build ACP capability probe failed", {
        cause: Cause.pretty(probeExit.cause),
      });
      return undefined;
    }
    if (Option.isNone(probeExit.value)) {
      return undefined;
    }
    const probe = probeExit.value.value;
    const acpModels = buildGrokModelsFromAcpProbe(probe);
    return {
      presentation: buildGrokBuildPresentationFromProbe({
        configOptions: probe.configOptions,
        sessionSetupResult: probe.sessionSetupResult,
      }),
      models: acpModels,
    };
  });

export const buildInitialGrokBuildProviderSnapshot = (
  settings: GrokBuildSettings,
): Effect.Effect<ServerProviderDraft> =>
  Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    return buildGrokProbeSnapshot({
      settings,
      checkedAt,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Checking for Grok Build CLI...",
      },
    });
  });

export const checkGrokBuildProviderStatus = (
  settings: GrokBuildSettings,
  env: NodeJS.ProcessEnv,
): Effect.Effect<ServerProviderDraft, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const command = settings.command || "grok";

    const envOverridesResult = yield* Effect.result(
      Effect.try({
        try: () => parseEnvJson(settings.envJson),
        catch: (error) =>
          error instanceof Error ? error.message : "Invalid environment overrides JSON.",
      }),
    );
    if (Result.isFailure(envOverridesResult)) {
      return buildGrokProbeSnapshot({
        settings,
        checkedAt,
        probe: {
          installed: true,
          version: null,
          status: "error",
          auth: { status: "unknown" },
          message: envOverridesResult.failure,
        },
      });
    }
    const envOverrides = envOverridesResult.success;
    const cliEnv = buildGrokCliProcessEnv(env, envOverrides);

    const versionCheck = yield* spawnAndCollect(
      command,
      ChildProcess.make(command, ["--version"], {
        env: cliEnv,
        shell: process.platform === "win32",
      }),
    ).pipe(Effect.result);

    if (versionCheck._tag === "Failure") {
      const cause = versionCheck.failure;
      const message = isCommandMissingCause(cause)
        ? "Grok Build CLI not found.\nWindows: irm https://x.ai/cli/install.ps1 | iex\nmacOS/Linux: curl -fsSL https://x.ai/cli/install.sh | bash"
        : `Failed to execute Grok Build CLI health check: ${cause.message}`;
      return buildGrokProbeSnapshot({
        settings,
        checkedAt,
        probe: {
          installed: false,
          version: null,
          status: "error",
          auth: { status: "unknown" },
          message,
        },
      });
    }

    const versionResult = versionCheck.success;
    if (versionResult.code !== 0) {
      return buildGrokProbeSnapshot({
        settings,
        checkedAt,
        probe: {
          installed: true,
          version: null,
          status: "error",
          auth: { status: "unknown" },
          message:
            detailFromResult(versionResult) ??
            `Grok Build CLI health check exited with code ${versionResult.code}.`,
        },
      });
    }

    const version = parseGenericCliVersion(`${versionResult.stdout}\n${versionResult.stderr}`);

    const modelsCli = yield* runGrokModelsCliCheck(command, cliEnv);

    let presentation = DEFAULT_PRESENTATION;
    let discoveredModels = buildGrokModelsFromCliModels(modelsCli.models);
    let discoveryWarning: string | undefined;

    if (modelsCli.auth.status === "unauthenticated") {
      return buildGrokProbeSnapshot({
        settings,
        checkedAt,
        models: discoveredModels,
        probe: {
          installed: true,
          version: version ?? "available",
          status: "warning",
          auth: modelsCli.auth,
          message: "Run `grok login` to sign in.",
        },
      });
    }

    const acpDiscovery = yield* runGrokAcpDiscovery(settings, env, envOverrides);

    if (acpDiscovery) {
      presentation = acpDiscovery.presentation;
      if (acpDiscovery.models.length > 0) {
        discoveredModels = acpDiscovery.models;
      }
    } else {
      discoveryWarning = `Grok ACP capability probe failed or timed out after ${GROK_ACP_PROBE_TIMEOUT_MS}ms. Using CLI model list.`;
    }

    return buildGrokProbeSnapshot({
      settings,
      checkedAt,
      presentation,
      models: discoveredModels,
      probe: {
        installed: true,
        version: version ?? "available",
        status: discoveryWarning ? "warning" : "ready",
        auth: modelsCli.auth,
        ...(discoveryWarning ? { message: discoveryWarning } : {}),
      },
    });
  });

export const enrichGrokBuildSnapshot = (input: {
  readonly settings: GrokBuildSettings;
  readonly snapshot: ServerProvider;
  readonly maintenanceCapabilities: ProviderMaintenanceCapabilities;
  readonly enableProviderUpdateChecks?: boolean;
  readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
  readonly stampIdentity?: (snapshot: ServerProvider) => ServerProvider;
  readonly environment?: NodeJS.ProcessEnv;
}): Effect.Effect<void, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    const command = input.settings.command || "grok";
    const envOverridesResult = yield* Effect.result(
      Effect.try({
        try: () => parseEnvJson(input.settings.envJson),
        catch: (error) =>
          error instanceof Error ? error.message : "Invalid environment overrides JSON.",
      }),
    );
    if (Result.isFailure(envOverridesResult)) {
      return;
    }
    const cliEnv = buildGrokCliProcessEnv(input.environment, envOverridesResult.success);
    let latestVersion: string | null = null;
    if (input.enableProviderUpdateChecks !== false) {
      const updateCheck = yield* spawnAndCollect(
        command,
        ChildProcess.make(command, ["update", "--check", "--json"], {
          env: cliEnv,
          shell: process.platform === "win32",
        }),
      ).pipe(Effect.timeoutOption(GROK_UPDATE_CHECK_TIMEOUT_MS), Effect.result);

      if (updateCheck._tag === "Success" && Option.isSome(updateCheck.success)) {
        const result = updateCheck.success.value;
        if (result.code === 0) {
          const decoded = yield* decodeGrokUpdateCheckResponse(result.stdout.trim() || "{}").pipe(
            Effect.orElseSucceed(() => null),
          );
          latestVersion = decoded?.latestVersion?.trim() ?? null;
        }
      }
    }

    const enriched: ServerProvider = {
      ...input.snapshot,
      versionAdvisory: createProviderVersionAdvisory({
        driver: DRIVER_KIND,
        currentVersion: input.snapshot.version,
        latestVersion,
        checkedAt: DateTime.formatIso(yield* DateTime.now),
        maintenanceCapabilities: input.maintenanceCapabilities,
      }),
    };
    const stamped = input.stampIdentity ? input.stampIdentity(enriched) : enriched;
    yield* input.publishSnapshot(stamped);
  });
