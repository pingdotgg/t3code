import * as NodeOs from "node:os";
import type {
  CursorSettings,
  ModelCapabilities,
  ProviderOptionSelection,
  ServerProvider,
  ServerProviderAuth,
  ServerProviderModel,
  ServerProviderState,
} from "@t3tools/contracts";
import { ProviderDriverKind } from "@t3tools/contracts";
import type * as EffectAcpSchema from "effect-acp/schema";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import { HttpClient } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import {
  createModelCapabilities,
  getProviderOptionBooleanSelectionValue,
  getProviderOptionStringSelectionValue,
} from "@t3tools/shared/model";

import {
  buildBooleanOptionDescriptor,
  buildSelectOptionDescriptor,
  buildServerProvider,
  collectStreamAsString,
  isCommandMissingCause,
  providerModelsFromSettings,
  type CommandResult,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  type ProviderMaintenanceCapabilities,
} from "../providerMaintenance.ts";
import { AcpSessionRuntime } from "../acp/AcpSessionRuntime.ts";

const PROVIDER = ProviderDriverKind.make("cursor");
const CURSOR_PRESENTATION = {
  displayName: "Cursor",
  badgeLabel: "Early Access",
  showInteractionModeToggle: true,
} as const;
const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

const CURSOR_ACP_MODEL_DISCOVERY_TIMEOUT_MS = 15_000;
const CURSOR_ACP_MODEL_CAPABILITY_TIMEOUT = "4 seconds";
const CURSOR_ACP_MODEL_DISCOVERY_CONCURRENCY = 4;
const CURSOR_PARAMETERIZED_MODEL_PICKER_MIN_VERSION_DATE = 2026_04_08;
export const CURSOR_PARAMETERIZED_MODEL_PICKER_CAPABILITIES = {
  _meta: {
    parameterizedModelPicker: true,
  },
} satisfies NonNullable<EffectAcpSchema.InitializeRequest["clientCapabilities"]>;

export function buildInitialCursorProviderSnapshot(
  cursorSettings: CursorSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = getCursorFallbackModels(cursorSettings);

    if (!cursorSettings.enabled) {
      return buildServerProvider({
        presentation: CURSOR_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Cursor is disabled in T3 Code settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: CURSOR_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Checking Cursor Agent availability...",
      },
    });
  });
}

interface CursorSessionSelectOption {
  readonly value: string;
  readonly name: string;
}

interface CursorAcpDiscoveredModel {
  readonly slug: string;
  readonly name: string;
  readonly capabilities: ModelCapabilities;
}

function flattenSessionConfigSelectOptions(
  configOption: EffectAcpSchema.SessionConfigOption | undefined,
): ReadonlyArray<CursorSessionSelectOption> {
  if (!configOption || configOption.type !== "select") {
    return [];
  }
  return configOption.options.flatMap((entry) =>
    "value" in entry
      ? [
          {
            value: entry.value.trim(),
            name: entry.name.trim(),
          } satisfies CursorSessionSelectOption,
        ]
      : entry.options.map(
          (option) =>
            ({
              value: option.value.trim(),
              name: option.name.trim(),
            }) satisfies CursorSessionSelectOption,
        ),
  );
}

function normalizeCursorReasoningValue(value: string | null | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  switch (normalized) {
    case "low":
    case "medium":
    case "high":
    case "max":
      return normalized;
    case "xhigh":
    case "extra-high":
    case "extra high":
      return "xhigh";
    default:
      return undefined;
  }
}

function findCursorModelConfigOption(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
): EffectAcpSchema.SessionConfigOption | undefined {
  return configOptions.find((option) => option.category === "model");
}

function getCursorConfigOptionCategory(option: EffectAcpSchema.SessionConfigOption): string {
  return option.category?.trim().toLowerCase() ?? "";
}

function isCursorEffortConfigOption(option: EffectAcpSchema.SessionConfigOption): boolean {
  const id = option.id.trim().toLowerCase();
  const name = option.name.trim().toLowerCase();
  return (
    id === "effort" ||
    id === "reasoning" ||
    name === "effort" ||
    name === "reasoning" ||
    name.includes("effort") ||
    name.includes("reasoning")
  );
}

function findCursorEffortConfigOption(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
): EffectAcpSchema.SessionConfigOption | undefined {
  const candidates = configOptions.filter(
    (option) => option.type === "select" && isCursorEffortConfigOption(option),
  );
  return (
    candidates.find((option) => getCursorConfigOptionCategory(option) === "model_option") ??
    candidates.find((option) => option.id.trim().toLowerCase() === "effort") ??
    candidates.find((option) => getCursorConfigOptionCategory(option) === "thought_level") ??
    candidates[0]
  );
}

function isCursorContextConfigOption(option: EffectAcpSchema.SessionConfigOption): boolean {
  const id = option.id.trim().toLowerCase();
  const name = option.name.trim().toLowerCase();
  return id === "context" || id === "context_size" || name.includes("context");
}

function isCursorFastConfigOption(option: EffectAcpSchema.SessionConfigOption): boolean {
  const id = option.id.trim().toLowerCase();
  const name = option.name.trim().toLowerCase();
  return id === "fast" || name === "fast" || name.includes("fast mode");
}

function isCursorThinkingConfigOption(option: EffectAcpSchema.SessionConfigOption): boolean {
  const id = option.id.trim().toLowerCase();
  const name = option.name.trim().toLowerCase();
  return id === "thinking" || name.includes("thinking");
}

function isBooleanLikeConfigOption(option: EffectAcpSchema.SessionConfigOption): boolean {
  if (option.type === "boolean") {
    return true;
  }
  if (option.type !== "select") {
    return false;
  }
  const values = new Set(
    flattenSessionConfigSelectOptions(option).map((entry) => entry.value.trim().toLowerCase()),
  );
  return values.has("true") && values.has("false");
}

function getBooleanCurrentValue(
  option: EffectAcpSchema.SessionConfigOption | undefined,
): boolean | undefined {
  if (!option) {
    return undefined;
  }
  if (option.type === "boolean") {
    return option.currentValue;
  }
  if (option.type !== "select") {
    return undefined;
  }
  const normalized = option.currentValue?.trim().toLowerCase();
  if (normalized === "true") {
    return true;
  }
  if (normalized === "false") {
    return false;
  }
  return undefined;
}

export function buildCursorCapabilitiesFromConfigOptions(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
): ModelCapabilities {
  if (!configOptions || configOptions.length === 0) {
    return EMPTY_CAPABILITIES;
  }

  const reasoningConfig = findCursorEffortConfigOption(configOptions);
  const reasoningEffortLevels =
    reasoningConfig?.type === "select"
      ? flattenSessionConfigSelectOptions(reasoningConfig).flatMap((entry) => {
          const normalizedValue = normalizeCursorReasoningValue(entry.value);
          if (!normalizedValue) {
            return [];
          }
          return [
            {
              value: normalizedValue,
              label: entry.name,
              ...(normalizeCursorReasoningValue(reasoningConfig.currentValue) === normalizedValue
                ? { isDefault: true }
                : {}),
            },
          ];
        })
      : [];

  const contextOption = configOptions.find(
    (option) => option.category === "model_config" && isCursorContextConfigOption(option),
  );
  const contextWindowOptions =
    contextOption?.type === "select"
      ? flattenSessionConfigSelectOptions(contextOption).map((entry) => {
          if (contextOption.currentValue === entry.value) {
            return {
              value: entry.value,
              label: entry.name,
              isDefault: true,
            };
          }
          return {
            value: entry.value,
            label: entry.name,
          };
        })
      : [];

  const fastOption = configOptions.find(
    (option) => option.category === "model_config" && isCursorFastConfigOption(option),
  );
  const thinkingOption = configOptions.find(
    (option) => option.category === "model_config" && isCursorThinkingConfigOption(option),
  );
  const fastCurrentValue = getBooleanCurrentValue(fastOption);
  const thinkingCurrentValue = getBooleanCurrentValue(thinkingOption);
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
    ...(contextWindowOptions.length > 0
      ? [
          buildSelectOptionDescriptor({
            id: "contextWindow",
            label: contextOption?.name?.trim() || "Context Window",
            options: contextWindowOptions,
          }),
        ]
      : []),
    ...(fastOption && isBooleanLikeConfigOption(fastOption)
      ? [
          typeof fastCurrentValue === "boolean"
            ? buildBooleanOptionDescriptor({
                id: "fastMode",
                label: fastOption.name?.trim() || "Fast Mode",
                currentValue: fastCurrentValue,
              })
            : buildBooleanOptionDescriptor({
                id: "fastMode",
                label: fastOption.name?.trim() || "Fast Mode",
              }),
        ]
      : []),
    ...(thinkingOption && isBooleanLikeConfigOption(thinkingOption)
      ? [
          typeof thinkingCurrentValue === "boolean"
            ? buildBooleanOptionDescriptor({
                id: "thinking",
                label: thinkingOption.name?.trim() || "Thinking",
                currentValue: thinkingCurrentValue,
              })
            : buildBooleanOptionDescriptor({
                id: "thinking",
                label: thinkingOption.name?.trim() || "Thinking",
              }),
        ]
      : []),
  ];

  return createModelCapabilities({
    optionDescriptors,
  });
}

function buildCursorDiscoveredModels(
  discoveredModels: ReadonlyArray<CursorAcpDiscoveredModel>,
): ReadonlyArray<ServerProviderModel> {
  const seen = new Set<string>();
  return discoveredModels.flatMap((model) => {
    if (!model.slug || seen.has(model.slug)) {
      return [];
    }
    seen.add(model.slug);
    return [
      {
        slug: model.slug,
        name: model.name,
        isCustom: false,
        capabilities: model.capabilities,
      } satisfies ServerProviderModel,
    ];
  });
}

function hasCursorModelCapabilities(model: Pick<ServerProviderModel, "capabilities">): boolean {
  return (model.capabilities?.optionDescriptors?.length ?? 0) > 0;
}

export function buildCursorDiscoveredModelsFromConfigOptions(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
): ReadonlyArray<ServerProviderModel> {
  if (!configOptions || configOptions.length === 0) {
    return [];
  }

  const modelOption = findCursorModelConfigOption(configOptions);
  const modelChoices = flattenSessionConfigSelectOptions(modelOption);
  if (!modelOption || modelChoices.length === 0) {
    return [];
  }

  const currentModelValue =
    modelOption.type === "select" ? modelOption.currentValue?.trim() || undefined : undefined;
  const currentModelCapabilities = buildCursorCapabilitiesFromConfigOptions(configOptions);

  return buildCursorDiscoveredModels(
    modelChoices.map((modelChoice) => ({
      slug: modelChoice.value.trim(),
      name: modelChoice.name.trim(),
      capabilities:
        currentModelValue === modelChoice.value.trim()
          ? currentModelCapabilities
          : EMPTY_CAPABILITIES,
    })),
  );
}

const makeCursorAcpProbeRuntime = (
  cursorSettings: CursorSettings,
  environment: NodeJS.ProcessEnv = process.env,
) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        spawn: {
          command: cursorSettings.binaryPath,
          args: [
            ...(cursorSettings.apiEndpoint ? (["-e", cursorSettings.apiEndpoint] as const) : []),
            "acp",
          ],
          cwd: process.cwd(),
          env: environment,
        },
        cwd: process.cwd(),
        clientInfo: { name: "t3-code-provider-probe", version: "0.0.0" },
        authMethodId: "cursor_login",
        clientCapabilities: CURSOR_PARAMETERIZED_MODEL_PICKER_CAPABILITIES,
      }).pipe(Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner))),
    );
    return yield* Effect.service(AcpSessionRuntime).pipe(Effect.provide(acpContext));
  });

const withCursorAcpProbeRuntime = <A, E, R>(
  cursorSettings: CursorSettings,
  useRuntime: (acp: AcpSessionRuntime["Service"]) => Effect.Effect<A, E, R>,
  environment: NodeJS.ProcessEnv = process.env,
) =>
  makeCursorAcpProbeRuntime(cursorSettings, environment).pipe(
    Effect.flatMap(useRuntime),
    Effect.scoped,
  );

function normalizeCursorConfigOptionToken(value: string | null | undefined): string {
  return (
    value
      ?.trim()
      .toLowerCase()
      .replace(/[\s_-]+/g, "-") ?? ""
  );
}

function findCursorSelectOptionValue(
  configOption: EffectAcpSchema.SessionConfigOption | undefined,
  matcher: (option: CursorSessionSelectOption) => boolean,
): string | undefined {
  return flattenSessionConfigSelectOptions(configOption).find(matcher)?.value;
}

function findCursorBooleanConfigValue(
  configOption: EffectAcpSchema.SessionConfigOption | undefined,
  requested: boolean,
): string | boolean | undefined {
  if (!configOption) {
    return undefined;
  }
  if (configOption.type === "boolean") {
    return requested;
  }
  return findCursorSelectOptionValue(
    configOption,
    (option) => normalizeCursorConfigOptionToken(option.value) === String(requested),
  );
}

export function resolveCursorAcpBaseModelId(model: string | null | undefined): string {
  const trimmed = model?.trim();
  const base = trimmed && trimmed.length > 0 ? trimmed : "default";
  return base.includes("[") ? base.slice(0, base.indexOf("[")) : base;
}

export function resolveCursorAcpConfigUpdates(
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

  const reasoningOption = findCursorEffortConfigOption(configOptions);
  const requestedReasoning = normalizeCursorReasoningValue(
    getProviderOptionStringSelectionValue(selections, "reasoning"),
  );
  if (reasoningOption && requestedReasoning) {
    const value = findCursorSelectOptionValue(reasoningOption, (option) => {
      const normalizedValue = normalizeCursorReasoningValue(option.value);
      const normalizedName = normalizeCursorReasoningValue(option.name);
      return normalizedValue === requestedReasoning || normalizedName === requestedReasoning;
    });
    if (value) {
      updates.push({ configId: reasoningOption.id, value });
    }
  }

  const contextOption = configOptions.find(
    (option) => option.category === "model_config" && isCursorContextConfigOption(option),
  );
  const requestedContextWindow = getProviderOptionStringSelectionValue(selections, "contextWindow");
  if (contextOption && requestedContextWindow) {
    const value = findCursorSelectOptionValue(
      contextOption,
      (option) =>
        normalizeCursorConfigOptionToken(option.value) ===
          normalizeCursorConfigOptionToken(requestedContextWindow) ||
        normalizeCursorConfigOptionToken(option.name) ===
          normalizeCursorConfigOptionToken(requestedContextWindow),
    );
    if (value) {
      updates.push({ configId: contextOption.id, value });
    }
  }

  const fastOption = configOptions.find(
    (option) => option.category === "model_config" && isCursorFastConfigOption(option),
  );
  const requestedFastMode = getProviderOptionBooleanSelectionValue(selections, "fastMode");
  if (fastOption && typeof requestedFastMode === "boolean") {
    const value = findCursorBooleanConfigValue(fastOption, requestedFastMode);
    if (value !== undefined) {
      updates.push({ configId: fastOption.id, value });
    }
  }

  const thinkingOption = configOptions.find(
    (option) => option.category === "model_config" && isCursorThinkingConfigOption(option),
  );
  const requestedThinking = getProviderOptionBooleanSelectionValue(selections, "thinking");
  if (thinkingOption && typeof requestedThinking === "boolean") {
    const value = findCursorBooleanConfigValue(thinkingOption, requestedThinking);
    if (value !== undefined) {
      updates.push({ configId: thinkingOption.id, value });
    }
  }

  return updates;
}

export const discoverCursorModelsViaAcp = (
  cursorSettings: CursorSettings,
  environment: NodeJS.ProcessEnv = process.env,
) =>
  withCursorAcpProbeRuntime(
    cursorSettings,
    (acp) =>
      Effect.map(acp.start(), (started) =>
        buildCursorDiscoveredModelsFromConfigOptions(
          started.sessionSetupResult.configOptions ?? [],
        ),
      ),
    environment,
  );

export const discoverCursorModelCapabilitiesViaAcp = (
  cursorSettings: CursorSettings,
  existingModels: ReadonlyArray<ServerProviderModel>,
  environment: NodeJS.ProcessEnv = process.env,
) =>
  withCursorAcpProbeRuntime(
    cursorSettings,
    (acp) =>
      Effect.gen(function* () {
        const started = yield* acp.start();
        const initialConfigOptions = started.sessionSetupResult.configOptions ?? [];
        const modelOption = findCursorModelConfigOption(initialConfigOptions);
        const modelChoices = flattenSessionConfigSelectOptions(modelOption);
        if (!modelOption || modelChoices.length === 0) {
          return [];
        }

        const currentModelValue =
          modelOption.type === "select" ? modelOption.currentValue?.trim() || undefined : undefined;
        const capabilitiesBySlug = new Map<string, ModelCapabilities>();
        if (currentModelValue) {
          capabilitiesBySlug.set(
            currentModelValue,
            buildCursorCapabilitiesFromConfigOptions(initialConfigOptions),
          );
        }

        const targetModelSlugs = new Set(
          existingModels
            .filter((model) => !model.isCustom && !hasCursorModelCapabilities(model))
            .map((model) => model.slug),
        );
        if (targetModelSlugs.size === 0) {
          return buildCursorDiscoveredModels(
            modelChoices.map((modelChoice) => ({
              slug: modelChoice.value.trim(),
              name: modelChoice.name.trim(),
              capabilities: capabilitiesBySlug.get(modelChoice.value.trim()) ?? EMPTY_CAPABILITIES,
            })),
          );
        }

        const probedCapabilities = yield* Effect.forEach(
          modelChoices,
          (modelChoice) => {
            const modelSlug = modelChoice.value.trim();
            if (
              !modelSlug ||
              !targetModelSlugs.has(modelSlug) ||
              capabilitiesBySlug.has(modelSlug)
            ) {
              return Effect.void.pipe(
                Effect.as<readonly [string, ModelCapabilities] | undefined>(undefined),
              );
            }

            return withCursorAcpProbeRuntime(
              cursorSettings,
              (probeAcp) =>
                Effect.gen(function* () {
                  const probeStarted = yield* probeAcp.start();
                  const probeConfigOptions = probeStarted.sessionSetupResult.configOptions ?? [];
                  const probeModelOption = findCursorModelConfigOption(probeConfigOptions);
                  const probeCurrentModelValue =
                    probeModelOption?.type === "select"
                      ? probeModelOption.currentValue?.trim() || undefined
                      : undefined;
                  yield* Effect.annotateCurrentSpan({
                    "cursor.acp.model.value": modelSlug,
                    "cursor.acp.model.currentValue": probeCurrentModelValue,
                    "cursor.acp.config_option_id": probeModelOption?.id ?? modelOption.id,
                  });
                  const nextConfigOptions =
                    probeCurrentModelValue === modelSlug
                      ? probeConfigOptions
                      : yield* probeAcp
                          .setConfigOption(probeModelOption?.id ?? modelOption.id, modelSlug)
                          .pipe(
                            Effect.map((response) => response.configOptions ?? probeConfigOptions),
                          );
                  return [
                    modelSlug,
                    buildCursorCapabilitiesFromConfigOptions(nextConfigOptions),
                  ] as const;
                }),
              environment,
            ).pipe(
              Effect.timeout(CURSOR_ACP_MODEL_CAPABILITY_TIMEOUT),
              Effect.retry({ times: 3 }),
              Effect.withSpan("cursor-acp-model-capability-probe"),
              Effect.catchCause((cause) =>
                Effect.logWarning("Cursor ACP capability probe failed", {
                  modelSlug,
                  cause: Cause.pretty(cause),
                }),
              ),
            );
          },
          { concurrency: CURSOR_ACP_MODEL_DISCOVERY_CONCURRENCY },
        );

        for (const entry of probedCapabilities) {
          if (!entry) {
            continue;
          }
          capabilitiesBySlug.set(entry[0], entry[1]);
        }

        return buildCursorDiscoveredModels(
          modelChoices.map((modelChoice) => ({
            slug: modelChoice.value.trim(),
            name: modelChoice.name.trim(),
            capabilities: capabilitiesBySlug.get(modelChoice.value.trim()) ?? EMPTY_CAPABILITIES,
          })),
        );
      }).pipe(Effect.withSpan("cursor-acp-model-capability-discovery", {})),
    environment,
  );

export function getCursorFallbackModels(
  cursorSettings: Pick<CursorSettings, "customModels">,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings([], PROVIDER, cursorSettings.customModels, EMPTY_CAPABILITIES);
}

/** Timeout for `agent about` — it's slower than a simple `--version` probe. */
const ABOUT_TIMEOUT_MS = 8_000;

/** Strip ANSI escape sequences so we can parse plain key-value lines. */
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*[A-Za-z]|\x1b\].*?\x07/g, "");
}

/**
 * Extract a value from `agent about` key-value output.
 * Lines look like: `CLI Version         2026.03.20-44cb435`
 */
function extractAboutField(plain: string, key: string): string | undefined {
  const regex = new RegExp(`^${key}\\s{2,}(.+)$`, "mi");
  const match = regex.exec(plain);
  return match?.[1]?.trim();
}

export interface CursorAboutResult {
  readonly version: string | null;
  readonly status: Exclude<ServerProviderState, "disabled">;
  readonly auth: ServerProviderAuth;
  readonly message?: string;
}

function joinProviderMessages(...messages: ReadonlyArray<string | undefined>): string | undefined {
  const parts = messages
    .map((message) => message?.trim())
    .filter((message): message is string => Boolean(message));
  return parts.length > 0 ? parts.join(" ") : undefined;
}

export function buildCursorProviderSnapshot(input: {
  readonly checkedAt: string;
  readonly cursorSettings: CursorSettings;
  readonly parsed: CursorAboutResult;
  readonly discoveredModels?: ReadonlyArray<ServerProviderModel>;
  readonly discoveryWarning?: string;
}): ServerProviderDraft {
  const message = joinProviderMessages(input.parsed.message, input.discoveryWarning);
  return buildServerProvider({
    presentation: CURSOR_PRESENTATION,
    enabled: input.cursorSettings.enabled,
    checkedAt: input.checkedAt,
    models: providerModelsFromSettings(
      input.discoveredModels ?? [],
      PROVIDER,
      input.cursorSettings.customModels,
      EMPTY_CAPABILITIES,
    ),
    probe: {
      installed: true,
      version: input.parsed.version,
      status:
        input.discoveryWarning && input.parsed.status === "ready" ? "warning" : input.parsed.status,
      auth: input.parsed.auth,
      ...(message ? { message } : {}),
    },
  });
}

interface CursorAboutJsonPayload {
  readonly cliVersion?: unknown;
  readonly subscriptionTier?: unknown;
  readonly userEmail?: unknown;
}

export function parseCursorVersionDate(version: string | null | undefined): number | undefined {
  const match = version?.trim().match(/^(\d{4})\.(\d{2})\.(\d{2})(?:\b|-|$)/);
  if (!match) {
    return undefined;
  }
  const [, year, month, day] = match;
  return Number(`${year}${month}${day}`);
}

export function parseCursorCliConfigChannel(raw: string): string | undefined {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "channel" in parsed &&
      typeof parsed.channel === "string"
    ) {
      const channel = parsed.channel.trim().toLowerCase();
      return channel.length > 0 ? channel : undefined;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function toTitleCaseWords(value: string): string {
  return value
    .split(/[\s_-]+/g)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

function cursorSubscriptionLabel(subscriptionType: string | undefined): string | undefined {
  const normalized = subscriptionType?.toLowerCase().replace(/[\s_-]+/g, "");
  if (!normalized) return undefined;

  switch (normalized) {
    case "team":
      return "Team";
    case "pro":
      return "Pro";
    case "free":
      return "Free";
    case "business":
      return "Business";
    case "enterprise":
      return "Enterprise";
    default:
      return toTitleCaseWords(subscriptionType!);
  }
}

function cursorAuthMetadata(
  subscriptionType: string | undefined,
): Pick<ServerProviderAuth, "label" | "type"> | undefined {
  if (!subscriptionType) {
    return undefined;
  }
  const subscriptionLabel = cursorSubscriptionLabel(subscriptionType);
  return {
    type: subscriptionType,
    label: `Cursor ${subscriptionLabel ?? toTitleCaseWords(subscriptionType)} Subscription`,
  };
}

function parseCursorAboutJsonPayload(raw: string): CursorAboutJsonPayload | undefined {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{")) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }
    return parsed as CursorAboutJsonPayload;
  } catch {
    return undefined;
  }
}

function hasOwn(record: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function isCursorAboutJsonFormatUnsupported(result: CommandResult): boolean {
  const lowerOutput = `${result.stdout}\n${result.stderr}`.toLowerCase();
  return (
    lowerOutput.includes("unknown option '--format'") ||
    lowerOutput.includes("unexpected argument '--format'") ||
    lowerOutput.includes("unrecognized option '--format'") ||
    lowerOutput.includes("unknown argument '--format'")
  );
}

const readCursorCliConfigChannel = Effect.fn("readCursorCliConfigChannel")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const configPath = path.join(NodeOs.homedir(), ".cursor", "cli-config.json");
  const raw = yield* fileSystem.readFileString(configPath).pipe(Effect.orElseSucceed(() => ""));
  return parseCursorCliConfigChannel(raw);
});

export function getCursorParameterizedModelPickerUnsupportedMessage(input: {
  readonly version: string | null | undefined;
  readonly channel: string | null | undefined;
}): string | undefined {
  const reasons: Array<string> = [];
  const versionDate = parseCursorVersionDate(input.version);
  if (
    versionDate !== undefined &&
    versionDate < CURSOR_PARAMETERIZED_MODEL_PICKER_MIN_VERSION_DATE
  ) {
    reasons.push(
      `Cursor Agent CLI version ${input.version} is too old for Cursor ACP parameterized model picker`,
    );
  }

  const normalizedChannel = input.channel?.trim().toLowerCase();
  if (
    normalizedChannel !== undefined &&
    normalizedChannel.length > 0 &&
    normalizedChannel !== "lab"
  ) {
    reasons.push(
      `Cursor Agent CLI channel is ${JSON.stringify(input.channel)}, but parameterized model picker is only available on the lab channel`,
    );
  }

  if (reasons.length === 0) {
    return undefined;
  }

  return `${reasons.join(". ")}. Run \`agent set-channel lab && agent update\` and use Cursor Agent CLI 2026.04.08 or newer.`;
}

/**
 * Parse the output of `agent about` to extract version and authentication
 * status in a single probe.
 *
 * Example output (logged in):
 * ```
 * About Cursor CLI
 *
 * CLI Version         2026.03.20-44cb435
 * User Email          user@example.com
 * ```
 *
 * Example output (logged out):
 * ```
 * About Cursor CLI
 *
 * CLI Version         2026.03.20-44cb435
 * User Email          Not logged in
 * ```
 */
export function parseCursorAboutOutput(result: CommandResult): CursorAboutResult {
  const jsonPayload = parseCursorAboutJsonPayload(result.stdout);
  if (jsonPayload) {
    const version =
      typeof jsonPayload.cliVersion === "string" ? jsonPayload.cliVersion.trim() : null;
    const hasUserEmailField = hasOwn(jsonPayload, "userEmail");
    const userEmail =
      typeof jsonPayload.userEmail === "string" ? jsonPayload.userEmail.trim() : undefined;
    const subscriptionType =
      typeof jsonPayload.subscriptionTier === "string"
        ? jsonPayload.subscriptionTier.trim()
        : undefined;
    const authMetadata = cursorAuthMetadata(subscriptionType);

    if (hasUserEmailField && jsonPayload.userEmail == null) {
      return {
        version,
        status: "error",
        auth: { status: "unauthenticated" },
        message: "Cursor Agent is not authenticated. Run `agent login` and try again.",
      };
    }

    if (!userEmail) {
      if (result.code === 0) {
        return {
          version,
          status: "ready",
          auth: {
            status: "unknown",
            ...authMetadata,
          },
        };
      }
      return {
        version,
        status: "warning",
        auth: { status: "unknown" },
        message: "Could not verify Cursor Agent authentication status.",
      };
    }

    const lowerEmail = userEmail.toLowerCase();
    if (
      lowerEmail === "not logged in" ||
      lowerEmail.includes("login required") ||
      lowerEmail.includes("authentication required")
    ) {
      return {
        version,
        status: "error",
        auth: { status: "unauthenticated" },
        message: "Cursor Agent is not authenticated. Run `agent login` and try again.",
      };
    }

    return {
      version,
      status: "ready",
      auth: {
        status: "authenticated",
        email: userEmail,
        ...authMetadata,
      },
    };
  }

  const combined = `${result.stdout}\n${result.stderr}`;
  const lowerOutput = combined.toLowerCase();

  // If the command itself isn't recognised, we're on an old CLI version.
  if (
    lowerOutput.includes("unknown command") ||
    lowerOutput.includes("unrecognized command") ||
    lowerOutput.includes("unexpected argument")
  ) {
    return {
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: "The `agent about` command is unavailable in this version of the Cursor Agent CLI.",
    };
  }

  const plain = stripAnsi(combined);
  const version = extractAboutField(plain, "CLI Version") ?? null;
  const userEmail = extractAboutField(plain, "User Email");

  // Determine auth from the User Email field.
  if (userEmail === undefined) {
    // Field missing entirely — can't determine auth.
    if (result.code === 0) {
      return { version, status: "ready", auth: { status: "unknown" } };
    }
    return {
      version,
      status: "warning",
      auth: { status: "unknown" },
      message: "Could not verify Cursor Agent authentication status.",
    };
  }

  const lowerEmail = userEmail.toLowerCase();
  if (
    lowerEmail === "not logged in" ||
    lowerEmail.includes("login required") ||
    lowerEmail.includes("authentication required")
  ) {
    return {
      version,
      status: "error",
      auth: { status: "unauthenticated" },
      message: "Cursor Agent is not authenticated. Run `agent login` and try again.",
    };
  }

  // Any non-empty email value means authenticated.
  return {
    version,
    status: "ready",
    auth: { status: "authenticated", email: userEmail },
  };
}

const runCursorCommand = (
  cursorSettings: CursorSettings,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv = process.env,
) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const command = ChildProcess.make(cursorSettings.binaryPath, [...args], {
      env: environment,
      shell: process.platform === "win32",
    });

    const child = yield* spawner.spawn(command);
    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        collectStreamAsString(child.stdout),
        collectStreamAsString(child.stderr),
        child.exitCode.pipe(Effect.map(Number)),
      ],
      { concurrency: "unbounded" },
    );

    return { stdout, stderr, code: exitCode } satisfies CommandResult;
  }).pipe(Effect.scoped);

const runCursorAboutCommand = (
  cursorSettings: CursorSettings,
  environment: NodeJS.ProcessEnv = process.env,
) =>
  Effect.gen(function* () {
    const jsonResult = yield* runCursorCommand(
      cursorSettings,
      ["about", "--format", "json"],
      environment,
    );
    if (!isCursorAboutJsonFormatUnsupported(jsonResult)) {
      return jsonResult;
    }
    return yield* runCursorCommand(cursorSettings, ["about"], environment);
  });

export const checkCursorProviderStatus = Effect.fn("checkCursorProviderStatus")(function* (
  cursorSettings: CursorSettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = getCursorFallbackModels(cursorSettings);

  if (!cursorSettings.enabled) {
    return buildServerProvider({
      presentation: CURSOR_PRESENTATION,
      enabled: false,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Cursor is disabled in T3 Code settings.",
      },
    });
  }

  // Single `agent about` probe: returns version + auth status in one call.
  const aboutProbe = yield* runCursorAboutCommand(cursorSettings, environment).pipe(
    Effect.timeoutOption(ABOUT_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(aboutProbe)) {
    const error = aboutProbe.failure;
    return buildServerProvider({
      presentation: CURSOR_PRESENTATION,
      enabled: cursorSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? "Cursor Agent CLI (`agent`) is not installed or not on PATH."
          : `Failed to execute Cursor Agent CLI health check: ${error instanceof Error ? error.message : String(error)}.`,
      },
    });
  }

  if (Option.isNone(aboutProbe.success)) {
    return buildServerProvider({
      presentation: CURSOR_PRESENTATION,
      enabled: cursorSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Cursor Agent CLI is installed but timed out while running `agent about`.",
      },
    });
  }

  const parsed = parseCursorAboutOutput(aboutProbe.success.value);
  const cursorCliConfigChannel = yield* readCursorCliConfigChannel();
  const parameterizedModelPickerUnsupportedMessage =
    getCursorParameterizedModelPickerUnsupportedMessage({
      version: parsed.version,
      channel: cursorCliConfigChannel,
    });
  if (parameterizedModelPickerUnsupportedMessage) {
    return buildServerProvider({
      presentation: CURSOR_PRESENTATION,
      enabled: cursorSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: parsed.version,
        status: "error",
        auth: parsed.auth,
        message:
          parsed.auth.status === "unauthenticated" && parsed.message
            ? `${parameterizedModelPickerUnsupportedMessage} ${parsed.message}`
            : parameterizedModelPickerUnsupportedMessage,
      },
    });
  }
  let discoveredModels = Option.none<ReadonlyArray<ServerProviderModel>>();
  let discoveryWarning: string | undefined;
  if (parsed.auth.status !== "unauthenticated") {
    const discoveryExit = yield* Effect.exit(
      discoverCursorModelsViaAcp(cursorSettings, environment).pipe(
        Effect.timeoutOption(CURSOR_ACP_MODEL_DISCOVERY_TIMEOUT_MS),
      ),
    );
    if (Exit.isFailure(discoveryExit)) {
      yield* Effect.logWarning("Cursor ACP model discovery failed", {
        cause: Cause.pretty(discoveryExit.cause),
      });
      discoveryWarning = "Cursor ACP model discovery failed. Check server logs for details.";
    } else if (Option.isNone(discoveryExit.value)) {
      discoveryWarning = `Cursor ACP model discovery timed out after ${CURSOR_ACP_MODEL_DISCOVERY_TIMEOUT_MS}ms.`;
    } else if (discoveryExit.value.value.length === 0) {
      discoveryWarning = "Cursor ACP model discovery returned no built-in models.";
    } else {
      discoveredModels = discoveryExit.value;
    }
  }
  return buildCursorProviderSnapshot({
    checkedAt,
    cursorSettings,
    parsed,
    discoveredModels: Option.getOrElse(
      Option.filter(discoveredModels, (models) => models.length > 0),
      () => [] as const,
    ),
    ...(discoveryWarning ? { discoveryWarning } : {}),
  });
});

export function hasUncapturedCursorModels(snapshot: Pick<ServerProvider, "models">): boolean {
  return snapshot.models.some((model) => !model.isCustom && !hasCursorModelCapabilities(model));
}

/**
 * Background capability enrichment for a Cursor snapshot.
 *
 * Used by `CursorDriver` as the `makeManagedServerProvider.enrichSnapshot`
 * hook: runs the slow ACP per-model capability probe, and republishes the
 * snapshot through `publishSnapshot` when new capabilities arrive. Skips
 * the probe when the provider is disabled, unauthenticated, or has no
 * uncaptured models. Keeps `EMPTY_CAPABILITIES` and the `PROVIDER` literal
 * private to this module.
 */
export const enrichCursorSnapshot = (input: {
  readonly settings: CursorSettings;
  readonly environment?: NodeJS.ProcessEnv;
  readonly snapshot: ServerProvider;
  readonly maintenanceCapabilities: ProviderMaintenanceCapabilities;
  readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
  readonly stampIdentity?: (snapshot: ServerProvider) => ServerProvider;
  readonly httpClient: HttpClient.HttpClient;
}): Effect.Effect<void, never, ChildProcessSpawner.ChildProcessSpawner> => {
  const { settings, snapshot, publishSnapshot } = input;
  const stampIdentity = input.stampIdentity ?? ((value) => value);

  const enrichVersionAdvisory = enrichProviderSnapshotWithVersionAdvisory(
    snapshot,
    input.maintenanceCapabilities,
  ).pipe(
    Effect.provideService(HttpClient.HttpClient, input.httpClient),
    Effect.flatMap((enrichedSnapshot) =>
      publishSnapshot(stampIdentity(enrichedSnapshot)).pipe(Effect.as(enrichedSnapshot)),
    ),
    Effect.catchCause((cause) =>
      Effect.logWarning("Cursor version advisory enrichment failed", {
        cause: Cause.pretty(cause),
      }).pipe(Effect.as(snapshot)),
    ),
  );

  return enrichVersionAdvisory.pipe(
    Effect.flatMap((baseSnapshot) => {
      if (
        !settings.enabled ||
        baseSnapshot.auth.status === "unauthenticated" ||
        !hasUncapturedCursorModels(baseSnapshot)
      ) {
        return Effect.void;
      }

      return discoverCursorModelCapabilitiesViaAcp(
        settings,
        baseSnapshot.models,
        input.environment,
      ).pipe(
        Effect.flatMap((discoveredModels) => {
          if (discoveredModels.length === 0) {
            return Effect.void;
          }
          return publishSnapshot(
            stampIdentity({
              ...baseSnapshot,
              models: providerModelsFromSettings(
                discoveredModels,
                PROVIDER,
                settings.customModels,
                EMPTY_CAPABILITIES,
              ),
            }),
          );
        }),
        Effect.catchCause((cause) =>
          Effect.logWarning("Cursor ACP background capability enrichment failed", {
            models: baseSnapshot.models.map((model) => model.slug),
            cause: Cause.pretty(cause),
          }).pipe(Effect.asVoid),
        ),
      );
    }),
  );
};
