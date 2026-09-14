import type {
  OmpSettings,
  ModelCapabilities,
  ProviderOptionSelection,
  ServerProvider,
  ServerProviderAuth,
  ServerProviderModel,
  ServerProviderSkill,
  ServerProviderSlashCommand,
  ServerProviderState,
  ServerProviderUsageLimits,
} from "@t3tools/contracts";
import type * as EffectAcpSchema from "effect-acp/schema";
import { causeErrorTag } from "@t3tools/shared/observability";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { HttpClient } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import {
  createModelCapabilities,
  getProviderOptionStringSelectionValue,
  readCustomModelEntries,
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
import * as AcpSessionRuntime from "../acp/AcpSessionRuntime.ts";
import { probeOmpUsage } from "../Drivers/OmpUsage.ts";
import { discoverOmpCommandCatalog, type OmpRpcCatalog } from "../Drivers/OmpCommands.ts";
import { normalizeOmpReasoningValue, titleCaseSlug } from "../Drivers/OmpModelCatalog.ts";

const OMP_PRESENTATION = {
  displayName: "Oh My Pi",
  badgeLabel: "Early Access",
  showInteractionModeToggle: true,
  // The adapter streams ACP `usage_update` token ticks, so a started thread
  // has a live context meter once its activities load.
  reportsContextWindow: true,
} as const;
const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

const VERSION_PROBE_TIMEOUT_MS = 4_000;
const OMP_ACP_MODEL_DISCOVERY_TIMEOUT_MS = 15_000;
// omp's RPC startup covers config, skills, extensions and MCP, so it is
// slower than a version probe but still has to fail rather than hang: the
// health check waits on it before the ACP fallback gets its own budget.
const OMP_RPC_CATALOG_TIMEOUT_MS = 20_000;
const OMP_CLI_DOCS_URL = "https://github.com/can1357/oh-my-pi";
const OMP_ACP_MODEL_DISCOVERY_FAILED_MESSAGE = [
  "Oh My Pi ACP model discovery failed.",
  "The omp CLI setup may be incomplete; install or enable the omp CLI, restart T3 Code, and try again.",
  `See ${OMP_CLI_DOCS_URL}.`,
  "Check server logs for ACP details.",
].join(" ");

export function buildInitialOmpProviderSnapshot(
  ompSettings: OmpSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = getOmpFallbackModels(ompSettings);

    if (!ompSettings.enabled) {
      return buildServerProvider({
        presentation: OMP_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Oh My Pi is disabled in T3 Code settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: OMP_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Checking Oh My Pi availability...",
      },
    });
  });
}

interface OmpSessionSelectOption {
  readonly value: string;
  readonly name: string;
}

export function flattenSessionConfigSelectOptions(
  configOption: EffectAcpSchema.SessionConfigOption | undefined,
): ReadonlyArray<OmpSessionSelectOption> {
  if (!configOption || configOption.type !== "select") {
    return [];
  }
  return configOption.options.flatMap((entry) =>
    "value" in entry
      ? [
          {
            value: entry.value.trim(),
            name: entry.name.trim(),
          } satisfies OmpSessionSelectOption,
        ]
      : entry.options.map(
          (option) =>
            ({
              value: option.value.trim(),
              name: option.name.trim(),
            }) satisfies OmpSessionSelectOption,
        ),
  );
}

function getOmpConfigOptionCategory(option: EffectAcpSchema.SessionConfigOption): string {
  return option.category?.trim().toLowerCase() ?? "";
}

function isOmpEffortConfigOption(option: EffectAcpSchema.SessionConfigOption): boolean {
  if (getOmpConfigOptionCategory(option) === "thought_level") {
    return true;
  }
  const id = option.id.trim().toLowerCase();
  const name = option.name.trim().toLowerCase();
  return (
    id === "effort" ||
    id === "reasoning" ||
    id === "thinking" ||
    name === "effort" ||
    name === "reasoning" ||
    name.includes("effort") ||
    name.includes("reasoning")
  );
}

function findOmpEffortConfigOption(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
): EffectAcpSchema.SessionConfigOption | undefined {
  const candidates = configOptions.filter(
    (option) => option.type === "select" && isOmpEffortConfigOption(option),
  );
  return (
    candidates.find((option) => getOmpConfigOptionCategory(option) === "thought_level") ??
    candidates.find((option) => option.id.trim().toLowerCase() === "effort") ??
    candidates.find((option) => getOmpConfigOptionCategory(option) === "model_option") ??
    candidates[0]
  );
}

export function buildOmpCapabilitiesFromConfigOptions(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
): ModelCapabilities {
  if (!configOptions || configOptions.length === 0) {
    return EMPTY_CAPABILITIES;
  }
  const reasoningConfig = findOmpEffortConfigOption(configOptions);
  // Aliased raw values (none/off, extra-high/xhigh) normalize to one picker
  // id; first wins so the descriptor never offers duplicate ids for one slot.
  const seenReasoningValues = new Set<string>();
  const reasoningEffortLevels =
    reasoningConfig?.type === "select"
      ? flattenSessionConfigSelectOptions(reasoningConfig).flatMap((entry) => {
          const normalizedValue = normalizeOmpReasoningValue(entry.value);
          if (!normalizedValue || seenReasoningValues.has(normalizedValue)) {
            return [];
          }
          seenReasoningValues.add(normalizedValue);
          return [
            {
              value: normalizedValue,
              label: entry.name,
              ...(normalizeOmpReasoningValue(reasoningConfig.currentValue) === normalizedValue
                ? { isDefault: true }
                : {}),
            },
          ];
        })
      : [];

  // omp's `session/new` advertises exactly `mode`, `model` and `thinking`
  // (verified on omp/18.1.18 for an adaptive, a `requiresEffort` and a
  // non-reasoning model), so there is nothing else to map: a `context_size`
  // or `fast` descriptor would offer the picker a control omp rejects.
  const optionDescriptors =
    reasoningEffortLevels.length > 0
      ? [
          buildSelectOptionDescriptor({
            id: "reasoning",
            label: reasoningConfig?.name?.trim() || "Reasoning",
            options: reasoningEffortLevels,
          }),
        ]
      : [];

  return createModelCapabilities({
    optionDescriptors,
  });
}

/**
 * Existence probe without the select guard: ACP permits a boolean option
 * named `model`, and callers that write model values must distinguish
 * "no model option at all" from "a model option that cannot accept a slug".
 */
export function findOmpModelConfigOptionAny(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
): EffectAcpSchema.SessionConfigOption | undefined {
  return (
    configOptions.find((option) => getOmpConfigOptionCategory(option) === "model") ??
    configOptions.find((option) => option.id.trim().toLowerCase() === "model")
  );
}

export function findOmpModelConfigOption(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
): EffectAcpSchema.SessionConfigOption | undefined {
  return (
    configOptions.find(
      (option) => option.type === "select" && getOmpConfigOptionCategory(option) === "model",
    ) ??
    configOptions.find(
      (option) => option.type === "select" && option.id.trim().toLowerCase() === "model",
    )
  );
}

/**
 * Oh My Pi is a meta provider (like OpenCode): model ids advertised through
 * the ACP `model` config option are `provider/model` pairs routed to upstream
 * providers the user configured inside omp. Mirror OpenCode's presentation
 * by surfacing the upstream provider as `subProvider` and sorting the catalog
 * by display name so the picker stays usable with 100+ entries.
 */
function buildOmpDiscoveredModelsFromConfigOptions(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
): ReadonlyArray<ServerProviderModel> {
  const modelOption = findOmpModelConfigOption(configOptions ?? []);
  if (!modelOption) {
    return [];
  }
  // Capability-truthfulness rule: omp re-validates dependent options per model
  // and ACP offers no per-model probe, so only the probe session's current
  // model carries capabilities (exactly the option set its session advertised).
  // Every other entry reports null (unknown) so the UI never offers reasoning
  // levels omp would reject; the adapter re-reads options per model at
  // selection time. No ACP session is ever spawned per model.
  const currentModelId =
    modelOption.type === "select" ? modelOption.currentValue?.trim() : undefined;
  const probedCapabilities = buildOmpCapabilitiesFromConfigOptions(configOptions);
  const seen = new Set<string>();
  const models = flattenSessionConfigSelectOptions(modelOption).flatMap((entry) => {
    if (!entry.value || seen.has(entry.value)) {
      return [];
    }
    seen.add(entry.value);
    const slashIndex = entry.value.indexOf("/");
    const subProvider =
      slashIndex > 0 ? titleCaseSlug(entry.value.slice(0, slashIndex)) : undefined;
    return [
      {
        slug: entry.value,
        name: entry.name || entry.value,
        ...(subProvider ? { subProvider } : {}),
        isCustom: false,
        capabilities: entry.value === currentModelId ? probedCapabilities : null,
      } satisfies ServerProviderModel,
    ];
  });
  return models.toSorted((left, right) => left.name.localeCompare(right.name));
}

function countOmpUpstreamProviders(models: ReadonlyArray<ServerProviderModel>): number {
  const prefixes = new Set<string>();
  for (const model of models) {
    const slashIndex = model.slug.indexOf("/");
    if (slashIndex > 0) {
      prefixes.add(model.slug.slice(0, slashIndex));
    }
  }
  return prefixes.size;
}

const makeOmpAcpProbeRuntime = (ompSettings: OmpSettings, environment?: NodeJS.ProcessEnv) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        spawn: {
          command: ompSettings.binaryPath || "omp",
          args: ["acp"],
          cwd: process.cwd(),
          ...(environment ? { env: environment } : {}),
        },
        cwd: process.cwd(),
        clientInfo: { name: "t3-code-provider-probe", version: "0.0.0" },
        authMethodId: "agent",
      }).pipe(Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner))),
    );
    return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
      Effect.provide(acpContext),
    );
  });

export const discoverOmpModelsViaAcp = (
  ompSettings: OmpSettings,
  environment?: NodeJS.ProcessEnv,
) =>
  makeOmpAcpProbeRuntime(ompSettings, environment).pipe(
    Effect.flatMap((acp) =>
      Effect.map(acp.start(), (started) =>
        buildOmpDiscoveredModelsFromConfigOptions(started.sessionSetupResult.configOptions),
      ),
    ),
    Effect.scoped,
  );

/**
 * Bare custom slugs were never probe-validated, so stamping the driver's
 * empty default descriptor set on them would falsely assert "no options".
 * Report unknown (null) instead; entries that declare their own capabilities
 * keep them.
 */
function withUnknownBareCustomCapabilities(
  models: ReadonlyArray<ServerProviderModel>,
  customModels: Pick<OmpSettings, "customModels">["customModels"],
): ReadonlyArray<ServerProviderModel> {
  const declaredBySlug = new Map(
    readCustomModelEntries(customModels).map((entry) => [entry.slug, entry.capabilities] as const),
  );
  return models.map((model) => {
    if (!model.isCustom || declaredBySlug.get(model.slug) !== null) {
      return model;
    }
    return { ...model, capabilities: null };
  });
}

/**
 * Mirrors the adapter's write guard: `applyOmpAcpModelSelection` skips the
 * model write when the requested base id is absent from the live catalog and
 * the turn is answered by the session's kept model instead. The snapshot can
 * predict that divergence for configured custom models, so it names them
 * rather than leaving the user silently answered by a different model. With
 * no discovered catalog there is nothing to check against, so no warning.
 */
function buildUnadvertisedCustomModelMessage(
  discoveredModels: ReadonlyArray<ServerProviderModel> | undefined,
  customModels: Pick<OmpSettings, "customModels">["customModels"],
): string | undefined {
  if (!discoveredModels || discoveredModels.length === 0) {
    return undefined;
  }
  const advertised = new Set(discoveredModels.map((model) => model.slug));
  const unadvertised: Array<string> = [];
  for (const entry of readCustomModelEntries(customModels)) {
    // Same base-id comparison as the adapter: bracket traits
    // (`model[fast=true]`) are stripped before the catalog lookup.
    const base = entry.slug.includes("[")
      ? entry.slug.slice(0, entry.slug.indexOf("[")).trim()
      : entry.slug;
    if (base.length > 0 && !advertised.has(base) && !unadvertised.includes(entry.slug)) {
      unadvertised.push(entry.slug);
    }
  }
  if (unadvertised.length === 0) {
    return undefined;
  }
  const names = unadvertised.map((slug) => `"${slug}"`).join(", ");
  return unadvertised.length === 1
    ? `Custom model ${names} is not advertised by omp; turns that request it will be answered by omp's configured model instead.`
    : `Custom models ${names} are not advertised by omp; turns that request them will be answered by omp's configured model instead.`;
}

export function getOmpFallbackModels(
  ompSettings: Pick<OmpSettings, "customModels">,
): ReadonlyArray<ServerProviderModel> {
  return withUnknownBareCustomCapabilities(
    providerModelsFromSettings([], ompSettings.customModels, EMPTY_CAPABILITIES),
    ompSettings.customModels,
  );
}

function findOmpSelectOptionValue(
  configOption: EffectAcpSchema.SessionConfigOption | undefined,
  matcher: (option: OmpSessionSelectOption) => boolean,
): string | undefined {
  return flattenSessionConfigSelectOptions(configOption).find(matcher)?.value;
}

export function resolveOmpAcpConfigUpdates(
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

  const reasoningOption = findOmpEffortConfigOption(configOptions);
  const requestedReasoning = normalizeOmpReasoningValue(
    getProviderOptionStringSelectionValue(selections, "reasoning"),
  );
  if (reasoningOption && requestedReasoning) {
    const value = findOmpSelectOptionValue(reasoningOption, (option) => {
      const normalizedValue = normalizeOmpReasoningValue(option.value);
      const normalizedName = normalizeOmpReasoningValue(option.name);
      return normalizedValue === requestedReasoning || normalizedName === requestedReasoning;
    });
    if (value) {
      updates.push({ configId: reasoningOption.id, value });
    }
  }

  return updates;
}

function joinProviderMessages(...messages: ReadonlyArray<string | undefined>): string | undefined {
  const parts: Array<string> = [];
  for (const message of messages) {
    const trimmed = message?.trim();
    if (trimmed) {
      parts.push(trimmed);
    }
  }
  return parts.length > 0 ? parts.join(" ") : undefined;
}

function buildOmpCliCommandMissingMessage(binaryPath: string): string {
  return [
    `Oh My Pi CLI command \`${binaryPath}\` was not found.`,
    `Install or enable the omp CLI, make sure \`${binaryPath}\` is on PATH, then restart T3 Code.`,
    `See ${OMP_CLI_DOCS_URL}.`,
  ].join(" ");
}

export function buildOmpProviderSnapshot(input: {
  readonly checkedAt: string;
  readonly ompSettings: OmpSettings;
  readonly version: string | null;
  readonly status?: Exclude<ServerProviderState, "disabled">;
  readonly message?: string;
  readonly discoveredModels?: ReadonlyArray<ServerProviderModel>;
  readonly discoveryWarning?: string;
  /**
   * The machine-level catalogs. Per-workspace snapshots stay the
   * project-scoped truth (a project can add skills and commands), but the
   * base snapshot is what `providerSupportsManualCompaction` reads to decide
   * whether to offer Compact, so it must carry omp's own `/compact` rather
   * than an empty list.
   */
  readonly skills?: ReadonlyArray<ServerProviderSkill>;
  readonly slashCommands?: ReadonlyArray<ServerProviderSlashCommand>;
  readonly auth?: ServerProviderAuth;
  readonly usageLimits?: ServerProviderUsageLimits;
}): ServerProviderDraft {
  const status = input.status ?? "ready";
  const unadvertisedModelMessage = buildUnadvertisedCustomModelMessage(
    input.discoveredModels,
    input.ompSettings.customModels,
  );
  const combinedWarning = joinProviderMessages(input.discoveryWarning, unadvertisedModelMessage);
  const message = joinProviderMessages(input.message, combinedWarning);
  return buildServerProvider({
    presentation: OMP_PRESENTATION,
    enabled: input.ompSettings.enabled,
    checkedAt: input.checkedAt,
    models: withUnknownBareCustomCapabilities(
      providerModelsFromSettings(
        input.discoveredModels ?? [],
        input.ompSettings.customModels,
        EMPTY_CAPABILITIES,
      ),
      input.ompSettings.customModels,
    ),
    ...(input.skills ? { skills: input.skills } : {}),
    ...(input.slashCommands ? { slashCommands: input.slashCommands } : {}),
    probe: {
      installed: true,
      version: input.version,
      status: combinedWarning && status === "ready" ? "warning" : status,
      auth: input.auth ?? { status: "unknown" },
      ...(message ? { message } : {}),
      ...(input.usageLimits ? { usageLimits: input.usageLimits } : {}),
    },
  });
}

const runOmpVersionCommand = (ompSettings: OmpSettings, environment?: NodeJS.ProcessEnv) =>
  Effect.gen(function* () {
    const command = ompSettings.binaryPath || "omp";
    const spawnCommand = yield* resolveSpawnCommand(
      command,
      ["--version"],
      environment ? { env: environment } : {},
    );
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        ...(environment ? { env: environment } : { extendEnv: true }),
        shell: spawnCommand.shell,
      }),
    );
  });

export const checkOmpProviderStatus = Effect.fn("checkOmpProviderStatus")(function* (
  ompSettings: OmpSettings,
  environment?: NodeJS.ProcessEnv,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto
> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = getOmpFallbackModels(ompSettings);

  if (!ompSettings.enabled) {
    return buildServerProvider({
      presentation: OMP_PRESENTATION,
      enabled: false,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Oh My Pi is disabled in T3 Code settings.",
      },
    });
  }

  const versionProbe = yield* runOmpVersionCommand(ompSettings, environment).pipe(
    Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionProbe)) {
    const error = versionProbe.failure;
    yield* Effect.logWarning("Oh My Pi CLI health check failed.", {
      errorTag: error._tag,
    });
    return buildServerProvider({
      presentation: OMP_PRESENTATION,
      enabled: ompSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? buildOmpCliCommandMissingMessage(ompSettings.binaryPath || "omp")
          : "Failed to execute Oh My Pi CLI health check.",
      },
    });
  }

  if (Option.isNone(versionProbe.success)) {
    return buildServerProvider({
      presentation: OMP_PRESENTATION,
      enabled: ompSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Oh My Pi CLI is installed but timed out while running `omp --version`.",
      },
    });
  }

  const versionOutput = versionProbe.success.value;
  const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
  if (versionOutput.code !== 0) {
    yield* Effect.logWarning("Oh My Pi CLI version probe exited with a non-zero status.", {
      exitCode: versionOutput.code,
      stdoutLength: versionOutput.stdout.length,
      stderrLength: versionOutput.stderr.length,
    });
    return buildServerProvider({
      presentation: OMP_PRESENTATION,
      enabled: ompSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "Oh My Pi CLI is installed but failed to run.",
      },
    });
  }

  // One RPC probe answers both catalogs: omp's own model metadata (real
  // context windows and per-model reasoning ladders, which an ACP `model`
  // select cannot express) and the command/skill catalog the composer needs
  // at machine level. The ACP session stays the fallback. The usage probe is
  // read-only and bounded by its own timeout, so it rides alongside instead
  // of stretching the health check; it never fails: every failure mode
  // degrades to unknown auth with no limits.
  const [rpcExit, usageProbe] = yield* Effect.all(
    [
      Effect.exit(
        discoverOmpCommandCatalog(ompSettings, environment ?? process.env).pipe(
          Effect.timeoutOption(OMP_RPC_CATALOG_TIMEOUT_MS),
        ),
      ),
      probeOmpUsage(ompSettings, checkedAt, environment),
    ],
    { concurrency: 2 },
  );
  let rpcCatalog: OmpRpcCatalog | undefined;
  if (Exit.isFailure(rpcExit)) {
    yield* Effect.logWarning("Oh My Pi RPC catalog probe failed", {
      errorTag: causeErrorTag(rpcExit.cause),
    });
  } else if (Option.isNone(rpcExit.value)) {
    yield* Effect.logWarning("Oh My Pi RPC catalog probe timed out", {
      timeoutMs: OMP_RPC_CATALOG_TIMEOUT_MS,
    });
  } else {
    rpcCatalog = rpcExit.value.value;
  }

  let discoveredModels = rpcCatalog?.models.models ?? [];
  let discoveryWarning: string | undefined;
  if (discoveredModels.length === 0) {
    // No metadata catalog: fall back to the ACP `model` select. Those entries
    // carry no context window and only the probe session's model reports
    // capabilities, so this is a degraded catalog, not an equivalent one.
    const discoveryExit = yield* Effect.exit(
      discoverOmpModelsViaAcp(ompSettings, environment).pipe(
        Effect.timeoutOption(OMP_ACP_MODEL_DISCOVERY_TIMEOUT_MS),
      ),
    );
    if (Exit.isFailure(discoveryExit)) {
      yield* Effect.logWarning("Oh My Pi ACP model discovery failed", {
        errorTag: causeErrorTag(discoveryExit.cause),
      });
      discoveryWarning = OMP_ACP_MODEL_DISCOVERY_FAILED_MESSAGE;
    } else if (Option.isNone(discoveryExit.value)) {
      discoveryWarning = `Oh My Pi ACP model discovery timed out after ${OMP_ACP_MODEL_DISCOVERY_TIMEOUT_MS}ms.`;
    } else if (discoveryExit.value.value.length === 0) {
      discoveryWarning = "Oh My Pi ACP model discovery returned no built-in models.";
    } else {
      discoveredModels = discoveryExit.value.value;
    }
  }
  // Meta-provider reporting (mirrors OpenCode): tell the user how many
  // upstream providers the discovered `provider/model` catalog routes to.
  const upstreamCount = countOmpUpstreamProviders(discoveredModels);
  return buildOmpProviderSnapshot({
    checkedAt,
    ompSettings,
    version,
    discoveredModels,
    ...(rpcCatalog && rpcCatalog.skills.length > 0 ? { skills: rpcCatalog.skills } : {}),
    ...(rpcCatalog && rpcCatalog.slashCommands.length > 0
      ? { slashCommands: rpcCatalog.slashCommands }
      : {}),
    ...(upstreamCount > 0
      ? {
          message: `${upstreamCount} upstream provider${upstreamCount === 1 ? "" : "s"} configured through Oh My Pi.`,
        }
      : {}),
    ...(discoveryWarning ? { discoveryWarning } : {}),
    auth: usageProbe.auth,
    ...(usageProbe.usageLimits ? { usageLimits: usageProbe.usageLimits } : {}),
  });
});

/**
 * Background maintenance enrichment for an Oh My Pi snapshot.
 *
 * Used by `OmpDriver` as the `makeManagedServerProvider.enrichSnapshot`
 * hook: republishes update/version advisory metadata without performing any
 * model or capability discovery. Oh My Pi model data comes from the RPC
 * catalog probe (or its ACP fallback) during provider status checks.
 */
export const enrichOmpSnapshot = (input: {
  readonly settings: OmpSettings;
  readonly snapshot: ServerProvider;
  readonly maintenanceCapabilities: ProviderMaintenanceCapabilities;
  readonly enableProviderUpdateChecks?: boolean;
  readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
  readonly stampIdentity?: (snapshot: ServerProvider) => ServerProvider;
  readonly httpClient: HttpClient.HttpClient;
}): Effect.Effect<void> => {
  const { settings, snapshot, publishSnapshot } = input;
  const stampIdentity = input.stampIdentity ?? ((value) => value);

  if (!settings.enabled || snapshot.auth.status === "unauthenticated") {
    return Effect.void;
  }

  return enrichProviderSnapshotWithVersionAdvisory(snapshot, input.maintenanceCapabilities, {
    enableProviderUpdateChecks: input.enableProviderUpdateChecks,
  }).pipe(
    Effect.provideService(HttpClient.HttpClient, input.httpClient),
    Effect.flatMap((enrichedSnapshot) =>
      publishSnapshot(stampIdentity(enrichedSnapshot)).pipe(Effect.as(enrichedSnapshot)),
    ),
    Effect.catchCause((cause) =>
      Effect.logWarning("Oh My Pi version advisory enrichment failed", {
        errorTag: causeErrorTag(cause),
      }).pipe(Effect.asVoid),
    ),
  );
};
