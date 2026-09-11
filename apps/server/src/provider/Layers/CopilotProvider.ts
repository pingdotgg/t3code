// @effect-diagnostics nodeBuiltinImport:off globalFetchInEffect:off globalDateInEffect:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import {
  type CopilotSettings,
  type ModelCapabilities,
  type ProviderOptionSelection,
  ProviderDriverKind,
  type ServerProvider,
  type ServerProviderModel,
  type ServerProviderUsageWindow,
} from "@t3tools/contracts";
import type * as EffectAcpSchema from "effect-acp/schema";
import { causeErrorTag } from "@t3tools/shared/observability";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { HttpClient } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import {
  createModelCapabilities,
  getProviderOptionStringSelectionValue,
  normalizeModelSlug,
} from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import {
  buildSelectOptionDescriptor,
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
import { makeUsageLimits, makeUnavailableUsageLimits } from "../providerUsageLimits.ts";
import { makeCopilotAcpRuntime } from "../acp/CopilotAcpSupport.ts";

const COPILOT_DRIVER_KIND = ProviderDriverKind.make("copilot");

export const COPILOT_PRESENTATION = {
  displayName: "GitHub Copilot",
  badgeLabel: "Preview",
  showInteractionModeToggle: false,
  requiresNewThreadForModelChange: true,
} as const;

const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

const VERSION_PROBE_TIMEOUT_MS = 4_000;
const COPILOT_ACP_MODEL_DISCOVERY_TIMEOUT_MS = 15_000;

export const COPILOT_BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  { slug: "gpt-5.6-sol", name: "GPT-5.6 Sol", isCustom: false, capabilities: EMPTY_CAPABILITIES },
  {
    slug: "gpt-5.6-terra",
    name: "GPT-5.6 Terra",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
  { slug: "gpt-5.6-luna", name: "GPT-5.6 Luna", isCustom: false, capabilities: EMPTY_CAPABILITIES },
  {
    slug: "claude-sonnet-5",
    name: "Claude Sonnet 5",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
  {
    slug: "claude-opus-5",
    name: "Claude Opus 5",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
  {
    slug: "claude-haiku-4.5",
    name: "Claude Haiku 4.5",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
  {
    slug: "gemini-3.8-flash",
    name: "Gemini 3.8 Flash",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
  { slug: "auto", name: "Auto", isCustom: false, capabilities: EMPTY_CAPABILITIES },
];

export function resolveCopilotAcpBaseModelId(model: string | null | undefined): string {
  const trimmed = model?.trim();
  const base = trimmed && trimmed.length > 0 ? trimmed : "gpt-5.6-sol";
  return normalizeModelSlug(base, COPILOT_DRIVER_KIND) ?? "gpt-5.6-sol";
}

function flattenSessionConfigSelectOptions(
  option: EffectAcpSchema.SessionConfigOption,
): ReadonlyArray<{ readonly value: string; readonly name: string }> {
  if (option.type !== "select") return [];
  const entries: Array<{ readonly value: string; readonly name: string }> = [];
  for (const entry of option.options) {
    if ("value" in entry && typeof entry.value === "string") {
      entries.push({ value: entry.value, name: entry.name || entry.value });
    }
  }
  return entries;
}

export function buildCopilotCapabilitiesFromConfigOptions(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
): ModelCapabilities {
  if (!configOptions || configOptions.length === 0) {
    return EMPTY_CAPABILITIES;
  }
  const reasoningConfig = configOptions.find(
    (opt) => opt.id === "reasoning_effort" || opt.category === "thought_level",
  );
  const reasoningEffortLevels =
    reasoningConfig?.type === "select"
      ? flattenSessionConfigSelectOptions(reasoningConfig).map((entry) => ({
          value: entry.value,
          label: entry.name,
          ...(reasoningConfig.currentValue === entry.value ? { isDefault: true } : {}),
        }))
      : [];

  const optionDescriptors = [
    ...(reasoningEffortLevels.length > 0
      ? [
          buildSelectOptionDescriptor({
            id: "reasoning",
            label: reasoningConfig?.name?.trim() || "Reasoning",
            options: reasoningEffortLevels,
          }),
        ]
      : []),
  ];

  return createModelCapabilities({
    optionDescriptors,
  });
}

export function resolveCopilotAcpConfigUpdates(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
  selections: ReadonlyArray<ProviderOptionSelection> | null | undefined,
): ReadonlyArray<{
  readonly configId: string;
  readonly value: string | boolean;
}> {
  if (!configOptions || configOptions.length === 0) {
    return [];
  }
  const updates: Array<{
    readonly configId: string;
    readonly value: string | boolean;
  }> = [];

  const reasoningOption = configOptions.find(
    (opt) => opt.id === "reasoning_effort" || opt.category === "thought_level",
  );
  const requestedReasoning = getProviderOptionStringSelectionValue(selections, "reasoning");
  if (reasoningOption && requestedReasoning) {
    updates.push({ configId: reasoningOption.id, value: requestedReasoning.trim() });
  }

  return updates;
}

function readLocalCopilotAuth(processEnv?: Record<string, string | undefined>): {
  status: "authenticated" | "unknown";
  label?: string;
  email?: string;
  token?: string;
} {
  try {
    const copilotHome =
      processEnv?.["COPILOT_HOME"] ??
      process.env["COPILOT_HOME"] ??
      NodePath.join(NodeOS.homedir(), ".copilot");
    const configPath = NodePath.join(copilotHome, "config.json");
    if (NodeFS.existsSync(configPath)) {
      const content = NodeFS.readFileSync(configPath, "utf-8");
      const cleaned = content.replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, "");
      const raw = JSON.parse(cleaned);
      const login = raw?.lastLoggedInUser?.login;
      const tokens = raw?.copilotTokens ?? {};
      const token =
        (typeof login === "string" && tokens[`https://github.com:${login}`]) ||
        (typeof tokens === "object" && tokens !== null ? Object.values(tokens)[0] : undefined);
      if (typeof login === "string" && login.length > 0) {
        return {
          status: "authenticated",
          label: `GitHub (${login})`,
          email: login,
          ...(typeof token === "string" ? { token } : {}),
        };
      }
    }
  } catch {
    // Ignore error reading local config
  }
  return { status: "unknown" };
}

function fetchCopilotRateLimitWindows(
  token: string | undefined,
): Effect.Effect<ReadonlyArray<ServerProviderUsageWindow>, never, never> {
  const empty: ReadonlyArray<ServerProviderUsageWindow> = [];
  if (!token) {
    return Effect.succeed(empty);
  }
  return Effect.tryPromise(async () => {
    const response = await fetch("https://api.github.com/rate_limit", {
      headers: {
        Authorization: `Bearer ${token}`,
        "User-Agent": "T3Code",
        Accept: "application/vnd.github+json",
      },
    });
    if (!response.ok) return empty;
    const data = (await response.json()) as {
      rate?: { limit: number; remaining: number; reset: number };
    };
    if (!data?.rate || typeof data.rate.limit !== "number" || data.rate.limit <= 0) return empty;
    const { limit, remaining, reset } = data.rate;
    const used = Math.max(0, limit - remaining);
    const usedPercent = Math.min(100, Math.max(0, Math.round((used / limit) * 100)));
    const windows: ReadonlyArray<ServerProviderUsageWindow> = [
      {
        id: "github-api-quota",
        kind: "session",
        label: "GitHub API Quota",
        usedPercent,
        resetsAt: new Date(reset * 1000).toISOString(),
        windowDurationMins: 60,
      },
    ];
    return windows;
  }).pipe(
    Effect.orElseSucceed(() => empty),
    Effect.timeoutOrElse({
      duration: "3 seconds",
      orElse: () => Effect.succeed(empty),
    }),
  );
}

export function buildInitialCopilotProviderSnapshot(
  copilotSettings: CopilotSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = copilotModelsFromSettings(copilotSettings.customModels);

    if (!copilotSettings.enabled) {
      return buildServerProvider({
        presentation: COPILOT_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "GitHub Copilot is disabled in T3 Code settings.",
          usageLimits: makeUnavailableUsageLimits({
            checkedAt,
            reason: "probeFailed",
            message: "GitHub Copilot is disabled in T3 Code settings.",
          }),
        },
      });
    }

    return buildServerProvider({
      presentation: COPILOT_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Checking GitHub Copilot CLI availability...",
        usageLimits: makeUnavailableUsageLimits({
          checkedAt,
          reason: "probeFailed",
          message: "Checking GitHub Copilot CLI availability...",
        }),
      },
    });
  });
}

function copilotModelsFromSettings(
  customModels: ReadonlyArray<string> | undefined,
  builtInModels: ReadonlyArray<ServerProviderModel> = COPILOT_BUILT_IN_MODELS,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(builtInModels, customModels ?? [], EMPTY_CAPABILITIES);
}

function buildCopilotDiscoveredModelsFromSessionState(
  modelState: EffectAcpSchema.SessionModelState | null | undefined,
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
): ReadonlyArray<ServerProviderModel> {
  if (!modelState || modelState.availableModels.length === 0) {
    return [];
  }
  const capabilities = buildCopilotCapabilitiesFromConfigOptions(configOptions);
  const seen = new Set<string>();
  return modelState.availableModels
    .map((model): ServerProviderModel | undefined => {
      const slug = resolveCopilotAcpBaseModelId(model.modelId);
      if (!slug || seen.has(slug)) {
        return undefined;
      }
      seen.add(slug);
      return {
        slug,
        name: model.name.trim() || slug,
        isCustom: false,
        capabilities,
      };
    })
    .filter((model): model is ServerProviderModel => model !== undefined);
}

const discoverCopilotModelsViaAcp = (
  copilotSettings: CopilotSettings,
  environment: NodeJS.ProcessEnv = process.env,
) =>
  Effect.gen(function* () {
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const acp = yield* makeCopilotAcpRuntime({
      copilotSettings,
      environment,
      childProcessSpawner,
      cwd: process.cwd(),
      clientInfo: { name: "t3-code-provider-probe", version: "0.0.0" },
    });
    const started = yield* acp.start();
    return buildCopilotDiscoveredModelsFromSessionState(
      started.sessionSetupResult.models,
      started.sessionSetupResult.configOptions,
    );
  }).pipe(Effect.scoped);

const runCopilotVersionCommand = (
  copilotSettings: CopilotSettings,
  environment: NodeJS.ProcessEnv = process.env,
) =>
  Effect.gen(function* () {
    const command = copilotSettings.binaryPath || "copilot";
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

export const checkCopilotProviderStatus = Effect.fn("checkCopilotProviderStatus")(function* (
  copilotSettings: CopilotSettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto
> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = copilotModelsFromSettings(copilotSettings.customModels);

  if (!copilotSettings.enabled) {
    return buildServerProvider({
      presentation: COPILOT_PRESENTATION,
      enabled: false,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "GitHub Copilot is disabled in T3 Code settings.",
        usageLimits: makeUnavailableUsageLimits({
          checkedAt,
          reason: "probeFailed",
          message: "GitHub Copilot is disabled in T3 Code settings.",
        }),
      },
    });
  }

  const versionResult = yield* runCopilotVersionCommand(copilotSettings, environment).pipe(
    Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionResult)) {
    const error = versionResult.failure;
    yield* Effect.logWarning("GitHub Copilot CLI health check failed.", {
      errorTag: error._tag,
    });
    return buildServerProvider({
      presentation: COPILOT_PRESENTATION,
      enabled: copilotSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? "GitHub Copilot CLI (`copilot`) is not installed or not on PATH."
          : "Failed to execute GitHub Copilot CLI health check.",
        usageLimits: makeUnavailableUsageLimits({
          checkedAt,
          reason: "probeFailed",
          message: isCommandMissingCause(error)
            ? "GitHub Copilot CLI (`copilot`) is not installed or not on PATH."
            : "Failed to execute GitHub Copilot CLI health check.",
        }),
      },
    });
  }

  if (Option.isNone(versionResult.success)) {
    return buildServerProvider({
      presentation: COPILOT_PRESENTATION,
      enabled: copilotSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "GitHub Copilot CLI is installed but timed out while running `copilot --version`.",
        usageLimits: makeUnavailableUsageLimits({
          checkedAt,
          reason: "probeFailed",
          message:
            "GitHub Copilot CLI is installed but timed out while running `copilot --version`.",
        }),
      },
    });
  }

  const versionOutput = versionResult.success.value;
  const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
  if (versionOutput.code !== 0) {
    yield* Effect.logWarning("GitHub Copilot CLI version probe exited with a non-zero status.", {
      exitCode: versionOutput.code,
      stdoutLength: versionOutput.stdout.length,
      stderrLength: versionOutput.stderr.length,
    });
    return buildServerProvider({
      presentation: COPILOT_PRESENTATION,
      enabled: copilotSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "GitHub Copilot CLI is installed but failed to run.",
        usageLimits: makeUnavailableUsageLimits({
          checkedAt,
          reason: "probeFailed",
          message: "GitHub Copilot CLI is installed but failed to run.",
        }),
      },
    });
  }

  const discoveryExit = yield* discoverCopilotModelsViaAcp(copilotSettings, environment).pipe(
    Effect.timeoutOption(COPILOT_ACP_MODEL_DISCOVERY_TIMEOUT_MS),
    Effect.exit,
  );
  if (Exit.isFailure(discoveryExit)) {
    yield* Effect.logWarning("GitHub Copilot ACP model discovery failed", {
      errorTag: causeErrorTag(discoveryExit.cause),
    });
    return buildServerProvider({
      presentation: COPILOT_PRESENTATION,
      enabled: copilotSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message:
          "GitHub Copilot CLI is installed but ACP startup failed. Check server logs for details.",
        usageLimits: makeUnavailableUsageLimits({
          checkedAt,
          reason: "probeFailed",
          message:
            "GitHub Copilot CLI is installed but ACP startup failed. Check server logs for details.",
        }),
      },
    });
  }
  if (Option.isNone(discoveryExit.value)) {
    yield* Effect.logWarning(
      `GitHub Copilot ACP model discovery timed out after ${COPILOT_ACP_MODEL_DISCOVERY_TIMEOUT_MS}ms.`,
    );
    return buildServerProvider({
      presentation: COPILOT_PRESENTATION,
      enabled: copilotSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: `GitHub Copilot CLI is installed but ACP startup timed out after ${COPILOT_ACP_MODEL_DISCOVERY_TIMEOUT_MS}ms.`,
        usageLimits: makeUnavailableUsageLimits({
          checkedAt,
          reason: "probeFailed",
          message: `GitHub Copilot CLI is installed but ACP startup timed out after ${COPILOT_ACP_MODEL_DISCOVERY_TIMEOUT_MS}ms.`,
        }),
      },
    });
  }
  const discoveredModels = discoveryExit.value.value;
  const models =
    discoveredModels.length > 0
      ? copilotModelsFromSettings(copilotSettings.customModels, discoveredModels)
      : fallbackModels;

  const localAuth = readLocalCopilotAuth(environment);
  const auth: ServerProvider["auth"] =
    localAuth.status === "authenticated"
      ? {
          status: "authenticated",
          type: "oauth-personal",
          label: localAuth.label ?? "GitHub Copilot",
          email: localAuth.email,
        }
      : { status: "unknown" };
  const windows =
    auth.status === "authenticated" && localAuth.token
      ? yield* fetchCopilotRateLimitWindows(localAuth.token)
      : [];
  const usageLimits =
    auth.status === "authenticated"
      ? makeUsageLimits({ checkedAt, windows })
      : makeUnavailableUsageLimits({
          checkedAt,
          reason: "probeFailed",
          message: "GitHub Copilot is not authenticated.",
        });

  return buildServerProvider({
    presentation: COPILOT_PRESENTATION,
    enabled: copilotSettings.enabled,
    checkedAt,
    models,
    probe: {
      installed: true,
      version,
      status: "ready",
      auth,
      usageLimits,
    },
  });
});

export const enrichCopilotSnapshot = (input: {
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
      Effect.logWarning("GitHub Copilot version advisory enrichment failed", {
        errorTag: causeErrorTag(cause),
      }),
    ),
    Effect.asVoid,
  );
};
