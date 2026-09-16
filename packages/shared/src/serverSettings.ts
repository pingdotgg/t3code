import {
  isProviderDriverKind,
  isProviderAvailable,
  resolveProviderInstanceEnabled,
  isProviderTextGenerationCapable,
  type ModelSelection,
  type ProjectId,
  type ProjectScopedServerSettingKey,
  type ProjectSettingsOverrides,
  type ProviderDriverKind,
  type ServerProvider,
  ServerSettings,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { deepMerge } from "./Struct.ts";
import { fromLenientJson } from "./schemaJson.ts";
import { createModelSelection } from "./model.ts";
import {
  getBackgroundActivityBaseProfile,
  normalizeBackgroundActivitySettings,
  normalizeServerBackgroundActivitySettings,
  resolveBackgroundActivitySettings,
} from "./backgroundActivitySettings.ts";

const ServerSettingsJson = fromLenientJson(ServerSettings);
const decodeServerSettingsJson = Schema.decodeUnknownOption(ServerSettingsJson);

/** @deprecated Read `resolveProjectSettings(...).settings.enableAgentBrowserAccess`. */
export function resolveProjectAgentBrowserAccess(
  settings: Pick<
    ServerSettings,
    "enableAgentBrowserAccess" | "projectAgentBrowserAccessOverrides" | "projectSettingsOverrides"
  >,
  projectId: ProjectId,
): boolean {
  return (
    settings.projectSettingsOverrides[projectId]?.enableAgentBrowserAccess ??
    settings.projectAgentBrowserAccessOverrides[projectId] ??
    settings.enableAgentBrowserAccess
  );
}

/** @deprecated Read `resolveProjectSettings(...).settings.defaultAutoPull`. */
export function resolveProjectAutoPull(
  settings: Pick<
    ServerSettings,
    "defaultAutoPull" | "projectAutoPullOverrides" | "projectSettingsOverrides"
  >,
  projectId: ProjectId,
  legacyAutoPull: boolean | undefined,
): boolean {
  // Existing opt-ins stay enabled until explicitly overridden or reset.
  return (
    settings.projectSettingsOverrides[projectId]?.defaultAutoPull ??
    settings.projectAutoPullOverrides[projectId] ??
    (legacyAutoPull === true || settings.defaultAutoPull)
  );
}

type LegacyProviderSettings = ServerSettings["providers"][keyof ServerSettings["providers"]];

const getLegacyProviderSettings = (
  settings: ServerSettings,
  provider: ProviderDriverKind,
): LegacyProviderSettings | undefined =>
  (settings.providers as Record<string, LegacyProviderSettings | undefined>)[provider];

export function isModelSelectionProviderEnabled(
  settings: ServerSettings,
  selection: ModelSelection,
): boolean {
  const instanceConfig = settings.providerInstances[selection.instanceId];
  if (instanceConfig !== undefined) {
    return resolveProviderInstanceEnabled(instanceConfig);
  }

  return (
    isProviderDriverKind(selection.instanceId) &&
    getLegacyProviderSettings(settings, selection.instanceId)?.enabled === true
  );
}

export function resolveSourceControlWriterModelSelection(
  settings: ServerSettings,
  providers?: ReadonlyArray<ServerProvider>,
): ModelSelection {
  const selection = settings.sourceControlWriterModelSelection;
  if (!selection || !isModelSelectionProviderEnabled(settings, selection)) {
    return settings.textGenerationModelSelection;
  }
  if (providers === undefined) {
    return selection;
  }

  const provider = providers.find((candidate) => candidate.instanceId === selection.instanceId);
  return provider?.enabled === true &&
    isProviderAvailable(provider) &&
    isProviderTextGenerationCapable(provider)
    ? selection
    : settings.textGenerationModelSelection;
}

export interface PersistedServerObservabilitySettings {
  readonly otlpTracesUrl: string | undefined;
  readonly otlpMetricsUrl: string | undefined;
}

function normalizePersistedServerSettingString(
  value: string | null | undefined,
): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function extractPersistedServerObservabilitySettings(input: {
  readonly observability?: {
    readonly otlpTracesUrl?: string;
    readonly otlpMetricsUrl?: string;
  };
}): PersistedServerObservabilitySettings {
  return {
    otlpTracesUrl: normalizePersistedServerSettingString(input.observability?.otlpTracesUrl),
    otlpMetricsUrl: normalizePersistedServerSettingString(input.observability?.otlpMetricsUrl),
  };
}

export function parsePersistedServerObservabilitySettings(
  raw: string,
): PersistedServerObservabilitySettings {
  const decoded = decodeServerSettingsJson(raw);
  if (Option.isSome(decoded)) {
    return extractPersistedServerObservabilitySettings(decoded.value);
  }
  return { otlpTracesUrl: undefined, otlpMetricsUrl: undefined };
}

function shouldReplaceTextGenerationModelSelection(
  patch: ServerSettingsPatch["textGenerationModelSelection"] | undefined,
): boolean {
  return Boolean(patch && (patch.instanceId !== undefined || patch.model !== undefined));
}

function mergeModelSelectionOptionsById(input: {
  current: ReadonlyArray<{ readonly id: string; readonly value: string | boolean }> | undefined;
  patch: ReadonlyArray<{ readonly id: string; readonly value: string | boolean }> | undefined;
}): Array<{ id: string; value: string | boolean }> | undefined {
  if (input.patch === undefined) {
    return input.current ? [...input.current] : undefined;
  }
  if (input.patch.length === 0) {
    return undefined;
  }

  const merged = new Map((input.current ?? []).map((selection) => [selection.id, selection.value]));
  for (const selection of input.patch) {
    merged.set(selection.id, selection.value);
  }
  return [...merged.entries()].map(([id, value]) => ({ id, value }));
}

/** Upsert each patched entry; `null` removes it. Entries the patch omits are untouched. */
function mergeSettingsEntries<Value>(
  current: Readonly<Record<string, Value>>,
  patch: Readonly<Record<string, Value | null>>,
): Record<string, Value> {
  const next = new Map(Object.entries(current));
  for (const [id, config] of Object.entries(patch)) {
    if (config === null) {
      next.delete(id);
    } else {
      next.set(id, config);
    }
  }
  return Object.fromEntries(next);
}

/**
 * Derived views of `projectSettingsOverrides` for clients that still read
 * the legacy per-key maps. Recomputed on every patch and load so they
 * cannot drift from the generic record.
 */
export function deriveLegacyProjectOverrides(
  settings: Pick<ServerSettings, "projectSettingsOverrides">,
): Pick<
  ServerSettings,
  "projectAgentBrowserAccessOverrides" | "projectAutoPullOverrides" | "projectScriptOverrides"
> {
  const projectAgentBrowserAccessOverrides: Record<string, boolean> = {};
  const projectAutoPullOverrides: Record<string, boolean> = {};
  const projectScriptOverrides: Record<string, ServerSettings["defaultProjectScripts"] | null> = {};
  for (const [projectId, entry] of Object.entries(settings.projectSettingsOverrides)) {
    if (entry.enableAgentBrowserAccess !== undefined) {
      projectAgentBrowserAccessOverrides[projectId] = entry.enableAgentBrowserAccess;
    }
    if (entry.defaultAutoPull !== undefined) {
      projectAutoPullOverrides[projectId] = entry.defaultAutoPull;
    }
    if (entry.defaultProjectScripts !== undefined) {
      projectScriptOverrides[projectId] = entry.defaultProjectScripts;
    }
  }
  return { projectAgentBrowserAccessOverrides, projectAutoPullOverrides, projectScriptOverrides };
}

/**
 * Rewrite a patch that still uses the legacy per-key project maps into
 * entries of `projectSettingsOverrides`, so older clients keep editing the
 * values the server actually reads. `null` in a legacy map clears that one
 * override.
 */
function translateLegacyProjectOverridePatch(
  current: Pick<ServerSettings, "projectSettingsOverrides">,
  patch: ServerSettingsPatch,
): ServerSettingsPatch {
  const {
    projectAgentBrowserAccessOverrides,
    projectAutoPullOverrides,
    projectScriptOverrides,
    ...rest
  } = patch;
  if (
    projectAgentBrowserAccessOverrides === undefined &&
    projectAutoPullOverrides === undefined &&
    projectScriptOverrides === undefined
  ) {
    return patch;
  }
  const currentEntries: Readonly<Record<string, ProjectSettingsOverrides>> =
    current.projectSettingsOverrides;
  const entries = new Map<string, ProjectSettingsOverrides | null>(
    Object.entries(rest.projectSettingsOverrides ?? {}),
  );
  // A canonical entry in the same patch is the newer representation; a legacy
  // map must not resurrect a key that entry deliberately omits.
  const canonicalProjectIds = new Set(Object.keys(rest.projectSettingsOverrides ?? {}));
  const applyKey = <K extends ProjectScopedServerSettingKey>(
    map: Readonly<Record<string, ProjectSettingsOverrides[K] | null>> | undefined,
    key: K,
  ) => {
    if (map === undefined) return;
    for (const [projectId, value] of Object.entries(map)) {
      if (canonicalProjectIds.has(projectId)) continue;
      const entry: ProjectSettingsOverrides = {
        ...(entries.get(projectId) ?? currentEntries[projectId] ?? {}),
      };
      if (value === null || value === undefined) {
        delete entry[key];
      } else {
        entry[key] = value;
      }
      entries.set(projectId, Object.keys(entry).length === 0 ? null : entry);
    }
  };
  applyKey(projectAgentBrowserAccessOverrides, "enableAgentBrowserAccess");
  applyKey(projectAutoPullOverrides, "defaultAutoPull");
  applyKey(projectScriptOverrides, "defaultProjectScripts");
  return {
    ...rest,
    projectSettingsOverrides: Object.fromEntries(entries),
  } as ServerSettingsPatch;
}

export function applyServerSettingsPatch(
  current: ServerSettings,
  rawPatch: ServerSettingsPatch,
): ServerSettings {
  const patch = translateLegacyProjectOverridePatch(current, rawPatch);
  const selectionPatch = patch.textGenerationModelSelection;
  const {
    automaticGitFetchInterval,
    providerHealthRefreshInterval,
    backgroundActivityProfile,
    backgroundActivity,
    // Merged per entry below; its `null` removals must not reach deepMerge.
    usageLimitSources: usageLimitSourcesPatch,
    usagePriceOverrides: usagePriceOverridesPatch,
    // Entry replacement: deepMerge would keep keys the client meant to clear.
    projectSettingsOverrides: projectSettingsOverridesPatch,
    // Already translated into `projectSettingsOverrides` above; the legacy
    // maps are derived views and must never be merged directly.
    projectAgentBrowserAccessOverrides: _legacyBrowserAccess,
    projectAutoPullOverrides: _legacyAutoPull,
    projectScriptOverrides: _legacyScripts,
    ...patchForMerge
  } = patch;
  const currentBackgroundActivity = normalizeServerBackgroundActivitySettings(current);
  const backgroundActivityPatch =
    backgroundActivityProfile !== undefined
      ? {
          schemaVersion: 1 as const,
          profile:
            automaticGitFetchInterval !== undefined || providerHealthRefreshInterval !== undefined
              ? ("custom" as const)
              : backgroundActivityProfile,
          ...(automaticGitFetchInterval !== undefined || providerHealthRefreshInterval !== undefined
            ? { baseProfile: backgroundActivityProfile }
            : {}),
          overrides: {
            ...(automaticGitFetchInterval !== undefined ? { automaticGitFetchInterval } : {}),
            ...(providerHealthRefreshInterval !== undefined
              ? { providerHealthRefreshInterval }
              : {}),
          },
        }
      : automaticGitFetchInterval !== undefined || providerHealthRefreshInterval !== undefined
        ? {
            schemaVersion: 1 as const,
            profile: "custom" as const,
            baseProfile: getBackgroundActivityBaseProfile(currentBackgroundActivity),
            overrides: {
              ...(currentBackgroundActivity.profile === "custom"
                ? currentBackgroundActivity.overrides
                : {}),
              ...(automaticGitFetchInterval !== undefined ? { automaticGitFetchInterval } : {}),
              ...(providerHealthRefreshInterval !== undefined
                ? { providerHealthRefreshInterval }
                : {}),
            },
          }
        : undefined;
  const next = deepMerge(current, patchForMerge);
  const nextWithReplacementsBase = {
    ...next,
    ...(backgroundActivity !== undefined
      ? {
          backgroundActivity: {
            ...deepMerge(currentBackgroundActivity, backgroundActivity),
            ...(backgroundActivity.overrides !== undefined
              ? { overrides: backgroundActivity.overrides }
              : {}),
          },
        }
      : { backgroundActivity: currentBackgroundActivity }),
    ...(backgroundActivity === undefined && backgroundActivityPatch !== undefined
      ? { backgroundActivity: backgroundActivityPatch }
      : {}),
    ...(patch.providerInstances !== undefined
      ? { providerInstances: patch.providerInstances }
      : {}),
    ...(projectSettingsOverridesPatch !== undefined
      ? {
          projectSettingsOverrides: Object.fromEntries(
            Object.entries(
              mergeSettingsEntries(current.projectSettingsOverrides, projectSettingsOverridesPatch),
            ).filter(([, entry]) => Object.keys(entry).length > 0),
          ),
        }
      : {}),
    ...(patch.defaultModelSelection !== undefined
      ? { defaultModelSelection: patch.defaultModelSelection }
      : {}),
    ...(patch.defaultProjectScripts !== undefined
      ? { defaultProjectScripts: patch.defaultProjectScripts }
      : {}),
    ...(usageLimitSourcesPatch !== undefined
      ? {
          usageLimitSources: mergeSettingsEntries(
            current.usageLimitSources,
            usageLimitSourcesPatch,
          ),
        }
      : {}),
    ...(usagePriceOverridesPatch !== undefined
      ? {
          usagePriceOverrides: mergeSettingsEntries(
            current.usagePriceOverrides,
            usagePriceOverridesPatch,
          ),
        }
      : {}),
    ...(patch.sourceControlWriterModelSelection !== undefined
      ? { sourceControlWriterModelSelection: patch.sourceControlWriterModelSelection }
      : {}),
    ...(automaticGitFetchInterval !== undefined ? { automaticGitFetchInterval } : {}),
    ...(providerHealthRefreshInterval !== undefined ? { providerHealthRefreshInterval } : {}),
  };
  const normalizedBackgroundActivity = normalizeBackgroundActivitySettings(
    nextWithReplacementsBase.backgroundActivity,
  );
  const resolvedBackgroundActivity = resolveBackgroundActivitySettings(
    normalizedBackgroundActivity,
  );
  const nextWithReplacements = {
    ...nextWithReplacementsBase,
    ...deriveLegacyProjectOverrides(nextWithReplacementsBase),
    backgroundActivity: normalizedBackgroundActivity,
    automaticGitFetchInterval: resolvedBackgroundActivity.automaticGitFetchInterval,
    providerHealthRefreshInterval: resolvedBackgroundActivity.providerHealthRefreshInterval,
    backgroundActivityProfile: resolvedBackgroundActivity.profile,
  };
  if (!selectionPatch) {
    return nextWithReplacements;
  }

  const instanceId = selectionPatch.instanceId ?? current.textGenerationModelSelection.instanceId;
  const model = selectionPatch.model ?? current.textGenerationModelSelection.model;
  const options = shouldReplaceTextGenerationModelSelection(selectionPatch)
    ? selectionPatch.options
    : mergeModelSelectionOptionsById({
        current: current.textGenerationModelSelection.options,
        patch: selectionPatch.options,
      });

  return {
    ...nextWithReplacements,
    textGenerationModelSelection: createModelSelection(instanceId, model, options),
  };
}
