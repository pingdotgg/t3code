import {
  type CopilotSettings,
  type ModelCapabilities,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import { causeErrorTag } from "@t3tools/shared/observability";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import { HttpClient } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import type * as EffectAcpSchema from "effect-acp/schema";

import { makeCopilotAcpRuntime, resolveCopilotModelId } from "../acp/CopilotAcpSupport.ts";
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
import { resolveSpawnCommand } from "@t3tools/shared/shell";

const COPILOT_PRESENTATION = {
  displayName: "GitHub Copilot",
  badgeLabel: "Early Access",
  showInteractionModeToggle: false,
  requiresNewThreadForModelChange: false,
} as const;
const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({ optionDescriptors: [] });
const VERSION_PROBE_TIMEOUT_MS = 4_000;
const ACP_DISCOVERY_TIMEOUT_MS = 15_000;

const FALLBACK_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "auto",
    name: "Auto",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
];

export function buildCopilotProviderModels(
  customModels: ReadonlyArray<string> | undefined,
  builtInModels: ReadonlyArray<ServerProviderModel> = FALLBACK_MODELS,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(
    builtInModels.length > 0 ? builtInModels : FALLBACK_MODELS,
    customModels ?? [],
    EMPTY_CAPABILITIES,
  );
}

function selectOptions(
  option: EffectAcpSchema.SessionConfigOption | undefined,
): ReadonlyArray<{ value: string; label: string; isDefault?: boolean }> {
  if (!option || option.type !== "select") return [];
  return option.options.flatMap((entry) =>
    "value" in entry
      ? [
          {
            value: entry.value,
            label: entry.name,
            ...(entry.value === option.currentValue ? { isDefault: true } : {}),
          },
        ]
      : entry.options.map((nested) => ({
          value: nested.value,
          label: nested.name,
          ...(nested.value === option.currentValue ? { isDefault: true } : {}),
        })),
  );
}

export function buildCopilotModelCapabilities(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
): ModelCapabilities {
  const reasoning = configOptions?.find((option) => option.id === "reasoning_effort");
  const options = selectOptions(reasoning);
  return createModelCapabilities({
    optionDescriptors:
      options.length === 0
        ? []
        : [
            buildSelectOptionDescriptor({
              id: "reasoningEffort",
              label: reasoning?.name.trim() || "Reasoning",
              options,
            }),
          ],
  });
}

export function buildCopilotDiscoveredModels(
  modelState: EffectAcpSchema.SessionModelState | null | undefined,
  configOptions?: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
): ReadonlyArray<ServerProviderModel> {
  if (!modelState || modelState.availableModels.length === 0) return [];
  const capabilities = buildCopilotModelCapabilities(configOptions);
  const seen = new Set<string>();
  return modelState.availableModels.flatMap((model) => {
    const slug = resolveCopilotModelId(model.modelId);
    if (seen.has(slug)) return [];
    seen.add(slug);
    return [
      {
        slug,
        name: model.name.trim() || slug,
        isCustom: false,
        capabilities,
      } satisfies ServerProviderModel,
    ];
  });
}

export function isCopilotAuthFailure(value: unknown): boolean {
  const seen = new Set<unknown>();
  const collect = (current: unknown, depth: number): string => {
    if (depth > 6 || current === null || current === undefined || seen.has(current)) return "";
    seen.add(current);
    if (typeof current === "string") return current;
    if (current instanceof Error) return `${current.message} ${collect(current.cause, depth + 1)}`;
    if (!Predicate.isObject(current)) return String(current);
    return ["message", "detail", "errorMessage", "cause", "error", "data"]
      .map((key) => collect(current[key], depth + 1))
      .join(" ");
  };
  return /(?:not authenticated|unauthenticated|authentication|unauthorized|log(?:ged)? in|login|credential|(?:access|auth(?:entication)?|refresh|id|bearer|gh|github|copilot)[ _-]?token|gh auth)/i.test(
    collect(value, 0),
  );
}

export function buildInitialCopilotProviderSnapshot(
  settings: CopilotSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    const models = buildCopilotProviderModels(settings.customModels);
    return buildServerProvider({
      presentation: COPILOT_PRESENTATION,
      enabled: settings.enabled,
      checkedAt,
      models,
      probe: settings.enabled
        ? {
            installed: true,
            version: null,
            status: "warning",
            auth: { status: "unknown" },
            message: "Checking GitHub Copilot CLI availability...",
          }
        : {
            installed: false,
            version: null,
            status: "warning",
            auth: { status: "unknown" },
            message: "GitHub Copilot is disabled in T3 Code settings.",
          },
    });
  });
}

export const discoverCopilotModelsViaAcp = (
  settings: CopilotSettings,
  environment: NodeJS.ProcessEnv = process.env,
) =>
  Effect.gen(function* () {
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const acp = yield* makeCopilotAcpRuntime({
      copilotSettings: settings,
      environment,
      childProcessSpawner,
      cwd: process.cwd(),
      clientInfo: { name: "t3-code-provider-probe", version: "0.0.0" },
    });
    const started = yield* acp.start();
    return buildCopilotDiscoveredModels(
      started.sessionSetupResult.models,
      yield* acp.getConfigOptions,
    );
  }).pipe(Effect.scoped);

const runCopilotVersionCommand = (
  settings: CopilotSettings,
  environment: NodeJS.ProcessEnv = process.env,
) =>
  Effect.gen(function* () {
    const command = settings.binaryPath || "copilot";
    const spawnCommand = yield* resolveSpawnCommand(command, ["--version", "--no-auto-update"], {
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
  settings: CopilotSettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto
> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = buildCopilotProviderModels(settings.customModels);
  if (!settings.enabled) return yield* buildInitialCopilotProviderSnapshot(settings);

  const versionResult = yield* runCopilotVersionCommand(settings, environment).pipe(
    Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
    Effect.result,
  );
  if (Result.isFailure(versionResult)) {
    const missing = isCommandMissingCause(versionResult.failure);
    return buildServerProvider({
      presentation: COPILOT_PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: !missing,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: missing
          ? "GitHub Copilot CLI (`copilot`) is not installed or not on PATH."
          : "Failed to execute the GitHub Copilot CLI health check.",
      },
    });
  }
  if (Option.isNone(versionResult.success)) {
    return buildServerProvider({
      presentation: COPILOT_PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "GitHub Copilot CLI timed out while running `copilot --version`.",
      },
    });
  }

  const output = versionResult.success.value;
  const version = parseGenericCliVersion(`${output.stdout}\n${output.stderr}`);
  if (output.code !== 0) {
    return buildServerProvider({
      presentation: COPILOT_PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "GitHub Copilot CLI is installed but failed to run.",
      },
    });
  }

  const discoveryExit = yield* discoverCopilotModelsViaAcp(settings, environment).pipe(
    Effect.timeoutOption(ACP_DISCOVERY_TIMEOUT_MS),
    Effect.exit,
  );
  if (Exit.isFailure(discoveryExit)) {
    const failure = Cause.squash(discoveryExit.cause);
    const unauthenticated = isCopilotAuthFailure(failure);
    yield* Effect.logWarning("GitHub Copilot ACP discovery failed", {
      errorTag: causeErrorTag(discoveryExit.cause),
    });
    return buildServerProvider({
      presentation: COPILOT_PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: unauthenticated ? "unauthenticated" : "unknown" },
        message: unauthenticated
          ? "GitHub Copilot CLI is not authenticated. Run `copilot login` and try again."
          : "GitHub Copilot ACP session startup failed. Check server logs for details.",
      },
    });
  }
  if (Option.isNone(discoveryExit.value)) {
    return buildServerProvider({
      presentation: COPILOT_PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: `GitHub Copilot ACP session startup timed out after ${ACP_DISCOVERY_TIMEOUT_MS}ms.`,
      },
    });
  }

  const discoveredModels = discoveryExit.value.value;
  return buildServerProvider({
    presentation: COPILOT_PRESENTATION,
    enabled: true,
    checkedAt,
    models: buildCopilotProviderModels(settings.customModels, discoveredModels),
    probe: {
      installed: true,
      version,
      status: "ready",
      auth: { status: "authenticated" },
    },
  });
});

export const enrichCopilotSnapshot = (input: {
  readonly snapshot: ServerProvider;
  readonly maintenanceCapabilities: ProviderMaintenanceCapabilities;
  readonly enableProviderUpdateChecks?: boolean;
  readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
  readonly httpClient: HttpClient.HttpClient;
}): Effect.Effect<void> =>
  enrichProviderSnapshotWithVersionAdvisory(input.snapshot, input.maintenanceCapabilities, {
    enableProviderUpdateChecks: input.enableProviderUpdateChecks,
  }).pipe(
    Effect.provideService(HttpClient.HttpClient, input.httpClient),
    Effect.flatMap(input.publishSnapshot),
    Effect.catchCause((cause) =>
      Effect.logWarning("GitHub Copilot version advisory enrichment failed", {
        errorTag: causeErrorTag(cause),
      }),
    ),
    Effect.asVoid,
  );
