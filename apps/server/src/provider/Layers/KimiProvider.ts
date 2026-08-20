import type {
  KimiSettings,
  ModelCapabilities,
  ProviderOptionDescriptor,
  ServerProvider,
  ServerProviderModel,
  ServerProviderSlashCommand,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import { causeErrorTag } from "@t3tools/shared/observability";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";
import type * as EffectAcpSchema from "effect-acp/schema";
import * as EffectAcpErrors from "effect-acp/errors";

import { makeKimiEnvironment } from "../Drivers/KimiHome.ts";
import { discoverKimiSkills } from "../Drivers/KimiSkills.ts";
import {
  getKimiCliCompatibilityIssue,
  parseKimiCliVersion,
  runKimiVersionCommand,
} from "../Drivers/KimiVersion.ts";
import { makeKimiAcpRuntime } from "../acp/KimiAcpSupport.ts";
import {
  buildBooleanOptionDescriptor,
  buildSelectOptionDescriptor,
  buildServerProvider,
  isCommandMissingCause,
  providerModelsFromSettings,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  type ProviderMaintenanceCapabilities,
} from "../providerMaintenance.ts";

const KIMI_PRESENTATION = {
  displayName: "Kimi",
  badgeLabel: "Early Access",
  showInteractionModeToggle: false,
  requiresNewThreadForModelChange: false,
} as const;

const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({ optionDescriptors: [] });
const VERSION_PROBE_TIMEOUT_MS = 4_000;
const KIMI_ACP_DISCOVERY_TIMEOUT_MS = 15_000;

interface KimiAcpDiscovery {
  readonly currentModelId: string | undefined;
  readonly availableModels: ReadonlyArray<EffectAcpSchema.ModelInfo>;
  readonly configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>;
  readonly capabilitiesByModel: ReadonlyMap<string, ModelCapabilities>;
  readonly commands: ReadonlyArray<EffectAcpSchema.AvailableCommand>;
  readonly supportsPlanMode: boolean;
}

type KimiAcpFailure = "unauthenticated" | "unsupported" | "failure";

interface KimiAcpAuthProbeState {
  readonly started: Ref.Ref<boolean>;
  readonly succeeded: Ref.Ref<boolean>;
}

export function buildInitialKimiProviderSnapshot(
  kimiSettings: KimiSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = getKimiFallbackModels(kimiSettings);
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

export function kimiModelCapabilitiesFromConfigOptions(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
): ModelCapabilities {
  if (!configOptions) {
    return EMPTY_CAPABILITIES;
  }
  const optionDescriptors: Array<ProviderOptionDescriptor> = [];
  for (const option of configOptions) {
    const id = option.id.trim();
    const label = option.name.trim();
    if (!id || !label || option.category === "model" || option.category === "mode") {
      continue;
    }
    if (option.type === "boolean") {
      optionDescriptors.push(
        typeof option.currentValue === "boolean"
          ? buildBooleanOptionDescriptor({ id, label, currentValue: option.currentValue })
          : buildBooleanOptionDescriptor({ id, label }),
      );
      continue;
    }
    const options: Array<{ value: string; label: string; isDefault?: boolean }> = [];
    for (const entry of option.options) {
      const values = "value" in entry ? [entry] : entry.options;
      for (const valueOption of values) {
        const value = valueOption.value.trim();
        if (!value) {
          continue;
        }
        options.push({
          value,
          label: valueOption.name.trim() || value,
          ...(option.currentValue?.trim() === value ? { isDefault: true } : {}),
        });
      }
    }
    if (options.length > 0) {
      optionDescriptors.push(buildSelectOptionDescriptor({ id, label, options }));
    }
  }
  return createModelCapabilities({ optionDescriptors });
}

export function kimiModelStateFromSessionSetup(input: {
  readonly models?: EffectAcpSchema.SessionModelState | null | undefined;
  readonly configOptions?: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined;
}): {
  readonly currentModelId: string | undefined;
  readonly availableModels: ReadonlyArray<EffectAcpSchema.ModelInfo>;
} {
  const modelOption = input.configOptions?.find(
    (option) => option.category === "model" && option.type === "select",
  );
  if (modelOption?.type === "select") {
    const seen = new Set<string>();
    const availableModels: Array<EffectAcpSchema.ModelInfo> = [];
    for (const entry of modelOption.options) {
      const valueOptions = "value" in entry ? [entry] : entry.options;
      for (const valueOption of valueOptions) {
        const modelId = valueOption.value.trim();
        if (!modelId || seen.has(modelId)) continue;
        seen.add(modelId);
        availableModels.push({
          modelId,
          name: valueOption.name.trim() || modelId,
        });
      }
    }
    if (availableModels.length > 0) {
      return {
        currentModelId: modelOption.currentValue?.trim() || undefined,
        availableModels,
      };
    }
  }
  return {
    currentModelId: input.models?.currentModelId.trim() || undefined,
    availableModels: input.models?.availableModels ?? [],
  };
}

function getKimiFallbackModels(
  kimiSettings: Pick<KimiSettings, "customModels">,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings([], kimiSettings.customModels, EMPTY_CAPABILITIES);
}

function discoveredKimiModels(input: {
  readonly currentModelId: string | undefined;
  readonly availableModels: ReadonlyArray<EffectAcpSchema.ModelInfo>;
  readonly capabilitiesByModel: ReadonlyMap<string, ModelCapabilities>;
}): ReadonlyArray<ServerProviderModel> {
  const currentModelId = input.currentModelId?.trim();
  const seen = new Set<string>();
  return input.availableModels.flatMap((model) => {
    const slug = model.modelId.trim();
    if (!slug || seen.has(slug)) {
      return [];
    }
    seen.add(slug);
    return [
      {
        slug,
        name: model.name.trim() || slug,
        isCustom: false,
        ...(currentModelId === slug ? { isDefault: true } : {}),
        capabilities: input.capabilitiesByModel.get(slug) ?? EMPTY_CAPABILITIES,
      } satisfies ServerProviderModel,
    ];
  });
}

function kimiSlashCommands(
  commands: ReadonlyArray<EffectAcpSchema.AvailableCommand>,
): ReadonlyArray<ServerProviderSlashCommand> {
  const seen = new Set<string>();
  return commands.flatMap((command) => {
    const name = command.name.trim();
    if (!name || seen.has(name)) {
      return [];
    }
    seen.add(name);
    const description = command.description.trim();
    const hint = command.input?.hint.trim();
    return [
      {
        name,
        ...(description ? { description } : {}),
        ...(hint ? { input: { hint } } : {}),
      } satisfies ServerProviderSlashCommand,
    ];
  });
}

const discoverKimiViaAcp = (
  settings: KimiSettings,
  environment: NodeJS.ProcessEnv,
  cwd: string,
  authProbeState: KimiAcpAuthProbeState,
) =>
  Effect.gen(function* () {
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const runtime = yield* makeKimiAcpRuntime({
      kimiSettings: settings,
      environment,
      childProcessSpawner,
      cwd,
      clientInfo: { name: "t3-code-provider-probe", version: "0.0.0" },
      requestLogger: (event) =>
        event.method !== "authenticate"
          ? Effect.void
          : event.status === "started"
            ? Ref.set(authProbeState.started, true)
            : event.status === "succeeded"
              ? Ref.set(authProbeState.succeeded, true)
              : Effect.void,
    });
    yield* runtime.getEvents().pipe(
      Stream.runForEach((event) =>
        event._tag === "EventStreamBarrier"
          ? Deferred.succeed(event.acknowledge, undefined).pipe(Effect.asVoid)
          : Effect.void,
      ),
      Effect.forkScoped,
    );
    const started = yield* runtime.start();
    yield* runtime.drainEvents;
    const initialConfigOptions = yield* runtime.getConfigOptions;
    const { currentModelId, availableModels } = kimiModelStateFromSessionSetup({
      models: started.sessionSetupResult.models,
      configOptions: initialConfigOptions,
    });
    const capabilitiesByModel = new Map<string, ModelCapabilities>();
    for (const model of availableModels) {
      const modelId = model.modelId.trim();
      if (!modelId) continue;
      if (modelId === currentModelId) {
        capabilitiesByModel.set(
          modelId,
          kimiModelCapabilitiesFromConfigOptions(initialConfigOptions),
        );
        continue;
      }
      const modelConfigOptions = yield* runtime.setModel(modelId).pipe(
        Effect.andThen(runtime.getConfigOptions),
        Effect.orElseSucceed((): ReadonlyArray<EffectAcpSchema.SessionConfigOption> => []),
      );
      capabilitiesByModel.set(modelId, kimiModelCapabilitiesFromConfigOptions(modelConfigOptions));
    }
    if (
      currentModelId &&
      availableModels.some((model) => model.modelId.trim() === currentModelId)
    ) {
      yield* runtime.setModel(currentModelId).pipe(Effect.ignore);
    }
    const modeState = yield* runtime.getModeState;
    return {
      currentModelId,
      availableModels,
      configOptions: initialConfigOptions,
      capabilitiesByModel,
      commands: yield* runtime.getAvailableCommands,
      supportsPlanMode:
        modeState?.availableModes.some((mode) =>
          ["plan", "architect"].includes(mode.id.trim().toLowerCase()),
        ) ?? false,
    } satisfies KimiAcpDiscovery;
  }).pipe(Effect.scoped);

function classifyKimiAcpFailure(
  cause: Cause.Cause<unknown>,
  authProbe: { readonly started: boolean; readonly succeeded: boolean },
): KimiAcpFailure {
  if (authProbe.started && !authProbe.succeeded) {
    return "unauthenticated";
  }
  const requestErrors = cause.reasons.flatMap((reason) => {
    if (Cause.isFailReason(reason) && isAcpRequestError(reason.error)) {
      return [reason.error];
    }
    if (Cause.isDieReason(reason) && isAcpRequestError(reason.defect)) {
      return [reason.defect];
    }
    return [];
  });
  if (
    requestErrors.some(
      (error) =>
        error.method === "authenticate" ||
        error.code === -32000 ||
        /auth|login|credential/i.test(error.errorMessage),
    )
  ) {
    return "unauthenticated";
  }
  if (
    requestErrors.some(
      (error) =>
        error.code === -32601 || /unsupported|protocol|method not found/i.test(error.errorMessage),
    )
  ) {
    return "unsupported";
  }
  return "failure";
}

const isAcpRequestError = Schema.is(EffectAcpErrors.AcpRequestError);

export const checkKimiProviderStatus = Effect.fn("checkKimiProviderStatus")(function* (
  settings: KimiSettings,
  baseEnvironment: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto | FileSystem.FileSystem | Path.Path
> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = getKimiFallbackModels(settings);
  if (!settings.enabled) {
    return yield* buildInitialKimiProviderSnapshot(settings);
  }
  const environment = yield* makeKimiEnvironment(settings, baseEnvironment);
  const versionResult = yield* runKimiVersionCommand(settings, environment).pipe(
    Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
    Effect.result,
  );
  if (Result.isFailure(versionResult)) {
    const error = versionResult.failure;
    yield* Effect.logWarning("Kimi CLI health check failed.", { errorTag: error._tag });
    return buildServerProvider({
      presentation: KIMI_PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? "Kimi CLI (`kimi`) is not installed or not on PATH."
          : "Failed to execute Kimi CLI health check.",
      },
    });
  }
  if (Option.isNone(versionResult.success)) {
    return buildServerProvider({
      presentation: KIMI_PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Kimi CLI is installed but timed out while running `kimi --version`.",
      },
    });
  }
  const versionOutput = versionResult.success.value;
  const version = parseKimiCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
  if (versionOutput.code !== 0) {
    return buildServerProvider({
      presentation: KIMI_PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "Kimi CLI is installed but failed to run.",
      },
    });
  }
  const compatibilityIssue = getKimiCliCompatibilityIssue(version);
  if (compatibilityIssue !== null) {
    return buildServerProvider({
      presentation: KIMI_PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: compatibilityIssue,
      },
    });
  }
  const authProbeState = {
    started: yield* Ref.make(false),
    succeeded: yield* Ref.make(false),
  } satisfies KimiAcpAuthProbeState;
  const discoveryExit = yield* Effect.exit(
    discoverKimiViaAcp(settings, environment, cwd, authProbeState).pipe(
      Effect.timeoutOption(KIMI_ACP_DISCOVERY_TIMEOUT_MS),
    ),
  );
  if (Exit.isFailure(discoveryExit)) {
    const failure = classifyKimiAcpFailure(discoveryExit.cause, {
      started: yield* Ref.get(authProbeState.started),
      succeeded: yield* Ref.get(authProbeState.succeeded),
    });
    yield* Effect.logWarning("Kimi ACP discovery failed.", {
      errorTag: causeErrorTag(discoveryExit.cause),
    });
    const message =
      failure === "unauthenticated"
        ? "Kimi is not authenticated. Run `kimi login` and try again."
        : failure === "unsupported"
          ? "Kimi CLI is installed but does not support the ACP protocol."
          : "Kimi CLI is installed but ACP startup failed. Check server logs for details.";
    return buildServerProvider({
      presentation: KIMI_PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: failure === "unauthenticated" ? { status: "unauthenticated" } : { status: "unknown" },
        message,
      },
    });
  }
  if (Option.isNone(discoveryExit.value)) {
    return buildServerProvider({
      presentation: KIMI_PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: `Kimi ACP discovery timed out after ${KIMI_ACP_DISCOVERY_TIMEOUT_MS}ms.`,
      },
    });
  }
  const discovery = discoveryExit.value.value;
  const customModelCapabilities = kimiModelCapabilitiesFromConfigOptions(discovery.configOptions);
  const discoveredModels = discoveredKimiModels(discovery);
  const models = providerModelsFromSettings(
    discoveredModels,
    settings.customModels,
    customModelCapabilities,
  );
  const skills = yield* discoverKimiSkills(settings, cwd, environment);
  return buildServerProvider({
    presentation: {
      ...KIMI_PRESENTATION,
      showInteractionModeToggle: discovery.supportsPlanMode,
    },
    enabled: true,
    checkedAt,
    models: models.length > 0 ? models : fallbackModels,
    slashCommands: kimiSlashCommands(discovery.commands),
    skills,
    probe: {
      installed: true,
      version,
      status: "ready",
      auth: { status: "authenticated" },
    },
  });
});

export const enrichKimiSnapshot = (input: {
  readonly settings: KimiSettings;
  readonly snapshot: ServerProvider;
  readonly maintenanceCapabilities: ProviderMaintenanceCapabilities;
  readonly enableProviderUpdateChecks?: boolean;
  readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
  readonly httpClient: HttpClient.HttpClient;
}): Effect.Effect<void> => {
  if (!input.settings.enabled || input.snapshot.auth.status === "unauthenticated") {
    return Effect.void;
  }
  return enrichProviderSnapshotWithVersionAdvisory(input.snapshot, input.maintenanceCapabilities, {
    enableProviderUpdateChecks: input.enableProviderUpdateChecks,
  }).pipe(
    Effect.provideService(HttpClient.HttpClient, input.httpClient),
    Effect.flatMap(input.publishSnapshot),
    Effect.catchCause((cause) =>
      Effect.logWarning("Kimi version advisory enrichment failed", {
        errorTag: causeErrorTag(cause),
      }),
    ),
    Effect.asVoid,
  );
};
