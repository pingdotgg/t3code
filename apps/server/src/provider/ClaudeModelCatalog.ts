import {
  type CustomModelSetting,
  type ModelCapabilities,
  type ModelSelection,
  ProviderDriverKind,
  type ServerProviderModel,
  type ServerProviderUpdateRequiredModel,
} from "@t3tools/contracts";
import type { ModelInfo as ClaudeModelInfo } from "@anthropic-ai/claude-agent-sdk";
import * as Option from "effect/Option";
import {
  getModelSelectionStringOptionValue,
  getProviderOptionCurrentValue,
  getProviderOptionDescriptors,
  readCustomModelEntries,
} from "@t3tools/shared/model";
import { compareSemverVersions } from "@t3tools/shared/semver";

import {
  type ClaudeCodeCompatibility,
  type ClaudeCodeProfile,
  decodeClaudeModelAdapter,
  decodeClaudeProfileAdapter,
} from "./ClaudeModelManifest.ts";
import * as ModelCatalog from "@t3tools/provider-core/server/ModelCatalog";
import { BUNDLED_MODEL_MANIFEST, resolveProviderCatalog } from "./ModelManifest.ts";

const CLAUDE = ProviderDriverKind.make("claudeAgent");
const EMPTY_CAPABILITIES: ModelCapabilities = { optionDescriptors: [] };

export interface ClaudeCatalogModel {
  readonly model: ServerProviderModel;
  readonly runtime: ClaudeCodeProfile;
  readonly compatibility: ClaudeCodeCompatibility;
  /** What to send Claude Code instead of the slug, from its own model list. */
  readonly apiModel?: string;
}

export interface ClaudeModelCatalog {
  readonly models: ReadonlyArray<ClaudeCatalogModel>;
}

function tryResolveClaudeModelCatalog(
  resolved: ModelCatalog.ProviderCatalog | undefined,
): ClaudeModelCatalog | null {
  if (!resolved) return null;

  const models: Array<ClaudeCatalogModel> = [];
  for (const entry of resolved.models) {
    const profile = decodeClaudeProfileAdapter(entry.profileAdapter ?? {});
    const adapter = decodeClaudeModelAdapter(entry.adapter ?? {});
    if (Option.isNone(profile) || Option.isNone(adapter)) return null;
    const model = ModelCatalog.catalogServerModel(resolved, entry);
    models.push({
      model: { ...model, capabilities: withUltracodeToggle(model.capabilities) },
      runtime: profile.value.claudeCode ?? {},
      compatibility: adapter.value.claudeCode ?? {},
    });
  }

  return {
    models,
  };
}

// The manifest keeps Ultracode as an effort level because released servers read it from main.
export function withUltracodeToggle(
  capabilities: ModelCapabilities | null,
): ModelCapabilities | null {
  const descriptors = capabilities?.optionDescriptors ?? [];
  const effortIndex = descriptors.findIndex(
    (descriptor) =>
      descriptor.id === "effort" &&
      descriptor.type === "select" &&
      descriptor.options.some((option) => option.id === "ultracode"),
  );
  const effort = descriptors[effortIndex];
  if (effort?.type !== "select") return capabilities;
  const ultracodeByDefault =
    (effort.currentValue ?? effort.options.find((option) => option.isDefault)?.id) === "ultracode";
  const hasXhigh = effort.options.some((option) => option.id === "xhigh");
  // Ultracode ran at xhigh, so a model that offered it keeps xhigh, and its default moves there.
  const options = effort.options.flatMap(({ isDefault, ...option }) => {
    if (option.id === "ultracode") {
      return hasXhigh
        ? []
        : [{ id: "xhigh", label: "Extra High", ...(isDefault ? { isDefault } : {}) }];
    }
    if (ultracodeByDefault && option.id === "xhigh") return [{ ...option, isDefault: true }];
    return [isDefault && !ultracodeByDefault ? { ...option, isDefault } : option];
  });
  return {
    optionDescriptors: descriptors.toSpliced(
      effortIndex,
      1,
      {
        ...effort,
        ...(effort.currentValue === "ultracode" ? { currentValue: "xhigh" } : {}),
        options,
      },
      {
        id: "ultracode",
        label: "Ultracode",
        type: "boolean",
        ...(ultracodeByDefault ? { currentValue: true } : {}),
      },
    ),
  };
}

/** Resolve the fallback on each read so its new-model badges can expire. */
export function resolveClaudeModelCatalog(
  catalog: ModelCatalog.ProviderCatalog | undefined,
): ClaudeModelCatalog {
  return (
    tryResolveClaudeModelCatalog(catalog) ??
    tryResolveClaudeModelCatalog(
      resolveProviderCatalog(BUNDLED_MODEL_MANIFEST, CLAUDE) ?? undefined,
    ) ?? {
      models: [],
    }
  );
}

export const BUNDLED_CLAUDE_MODEL_CATALOG = resolveClaudeModelCatalog(undefined);

export function scopeClaudeModelCatalog(
  catalog: ClaudeModelCatalog,
  customModels: ReadonlyArray<CustomModelSetting>,
): ClaudeModelCatalog {
  const customEntries = readCustomModelEntries(customModels);
  if (customEntries.length === 0) return catalog;
  const customAliases = new Set(customEntries.map((entry) => entry.slug.toLowerCase()));

  const builtInModels = catalog.models.map((entry) => {
    if (!entry.model.aliases?.some((alias) => customAliases.has(alias.toLowerCase()))) {
      return entry;
    }
    return {
      ...entry,
      model: {
        ...entry.model,
        aliases: entry.model.aliases.filter((alias) => !customAliases.has(alias.toLowerCase())),
      },
    };
  });
  const builtInSlugs = new Set(builtInModels.map((entry) => entry.model.slug));
  const customCatalogModels: Array<ClaudeCatalogModel> = [];
  for (const entry of customEntries) {
    if (!entry.capabilities || builtInSlugs.has(entry.slug)) continue;
    customCatalogModels.push({
      model: {
        slug: entry.slug,
        name: entry.name,
        isCustom: true,
        capabilities: withUltracodeToggle(entry.capabilities),
      },
      runtime: {},
      compatibility: {},
    });
  }

  return { models: [...builtInModels, ...customCatalogModels] };
}

const CLAUDE_EFFORT_LABELS: Readonly<Record<string, string>> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
};

function stripClaudeContextWindowSuffix(value: string): string {
  return value.replace(/\[[^\]]*\]$/, "").trim();
}

export function claudeReportedModels(
  catalog: ClaudeModelCatalog,
  customModels: ReadonlyArray<CustomModelSetting>,
  reported: ReadonlyArray<ClaudeModelInfo> | undefined,
): ReadonlyArray<ServerProviderModel> {
  if (!reported?.length) return [];
  const known = new Set(
    [
      ...catalog.models.flatMap(({ model }) => [model.slug, ...(model.aliases ?? [])]),
      ...readCustomModelEntries(customModels).map((entry) => entry.slug),
    ].map((id) => stripClaudeContextWindowSuffix(id).toLowerCase()),
  );
  const models: Array<ServerProviderModel> = [];
  for (const info of reported) {
    const slug = info.value.trim();
    // `default` is Claude Code's pointer at its own default model, not a model.
    if (!slug || slug === "default") continue;
    const ids = [slug, info.resolvedModel ?? ""]
      .map((id) => stripClaudeContextWindowSuffix(id).toLowerCase())
      .filter((id) => id.length > 0);
    if (ids.some((id) => known.has(id))) continue;
    for (const id of ids) known.add(id);
    const efforts = info.supportsEffort ? (info.supportedEffortLevels ?? []) : [];
    models.push({
      slug,
      name: info.displayName.trim() || slug,
      isCustom: false,
      capabilities: {
        optionDescriptors: efforts.length
          ? [
              {
                id: "effort",
                label: "Reasoning",
                type: "select",
                // `default` is not an effort, so choosing it sends none and Claude Code picks.
                options: [
                  { id: "default", label: "Default", isDefault: true },
                  ...efforts.map((id) => ({ id, label: CLAUDE_EFFORT_LABELS[id] ?? id })),
                ],
              },
            ]
          : [],
      },
    });
  }
  return models;
}

function resolveClaudeCatalogModel(
  catalog: ClaudeModelCatalog,
  slugOrAlias: string | null | undefined,
): ClaudeCatalogModel | undefined {
  const value = slugOrAlias?.trim();
  if (!value) return undefined;
  return (
    catalog.models.find((entry) => entry.model.slug === value) ??
    catalog.models.find((entry) =>
      entry.model.aliases?.some((alias) => alias.toLowerCase() === value.toLowerCase()),
    )
  );
}

// Cloud backends decorate first-party ids: Bedrock adds a region prefix and a
// version ("us.anthropic.claude-opus-4-6-v1"), Vertex adds "@<date>".
function stripClaudeBackendDecoration(wireModel: string): string {
  return wireModel
    .replace(/^(?:[a-z-]+\.)?anthropic\./, "")
    .replace(/-v\d+(?::\d+)?$/, "")
    .replace(/@[^@]*$/, "");
}

/**
 * On Bedrock, Vertex and similar backends Claude Code does not accept the first-party slug: it
 * either sends it verbatim or, when `availableModels` excludes it, silently runs the default
 * model instead. Its model list names the id that does work, often a family alias that
 * `ANTHROPIC_DEFAULT_*_MODEL` points at a backend id.
 */
export function withClaudeCodeModelRoutes(
  catalog: ClaudeModelCatalog,
  reportedModels: ReadonlyArray<Pick<ClaudeModelInfo, "value" | "resolvedModel">>,
): ClaudeModelCatalog {
  const apiModels = new Map<string, string>();
  for (const reported of reportedModels) {
    if (reported.value === "default") continue;
    const wireModel = stripClaudeContextWindowSuffix(reported.resolvedModel ?? reported.value);
    const firstPartyModel = stripClaudeBackendDecoration(wireModel);
    if (firstPartyModel === wireModel) continue;
    const entry = resolveClaudeCatalogModel(catalog, firstPartyModel);
    if (!entry || apiModels.has(entry.model.slug)) continue;
    apiModels.set(entry.model.slug, stripClaudeContextWindowSuffix(reported.value));
  }
  if (apiModels.size === 0) return catalog;
  return {
    models: catalog.models.map((entry) => {
      const apiModel = apiModels.get(entry.model.slug);
      return apiModel ? { ...entry, apiModel } : entry;
    }),
  };
}

export function resolveClaudeModelSlug(catalog: ClaudeModelCatalog, slugOrAlias: string): string {
  return resolveClaudeCatalogModel(catalog, slugOrAlias)?.model.slug ?? slugOrAlias;
}

/** Claude reports dated IDs, such as `claude-opus-4-5-20251101`, that the catalog may not list. */
export function resolveClaudeReportedModelSlug(
  catalog: ClaudeModelCatalog,
  reported: string,
): string {
  return (
    (
      resolveClaudeCatalogModel(catalog, reported) ??
      resolveClaudeCatalogModel(catalog, reported.replace(/-\d{8}$/, ""))
    )?.model.slug ?? reported
  );
}

export function getClaudeCatalogModelCapabilities(
  catalog: ClaudeModelCatalog,
  slugOrAlias: string | null | undefined,
): ModelCapabilities {
  return resolveClaudeCatalogModel(catalog, slugOrAlias)?.model.capabilities ?? EMPTY_CAPABILITIES;
}

function isVersionSupported(
  compatibility: ClaudeCodeCompatibility,
  version: string | null | undefined,
): boolean {
  if (!compatibility.minVersion && !compatibility.maxVersionExclusive) return true;
  if (!version) return false;
  if (compatibility.minVersion && compareSemverVersions(version, compatibility.minVersion) < 0) {
    return false;
  }
  return !(
    compatibility.maxVersionExclusive &&
    compareSemverVersions(version, compatibility.maxVersionExclusive) >= 0
  );
}

export function resolveClaudeModelsForVersion(
  catalog: ClaudeModelCatalog,
  version: string | null | undefined,
): ReadonlyArray<ClaudeCatalogModel["model"]> {
  return catalog.models
    .filter((entry) => isVersionSupported(entry.compatibility, version))
    .map((entry) => entry.model);
}

export function resolveClaudeUpdateRequiredModels(
  catalog: ClaudeModelCatalog,
  version: string | null | undefined,
): ReadonlyArray<ServerProviderUpdateRequiredModel> {
  if (!version) return [];
  return catalog.models.flatMap(({ model, compatibility }) => {
    const minVersion = compatibility.minVersion;
    if (model.isLegacy || !minVersion || compareSemverVersions(version, minVersion) >= 0) {
      return [];
    }
    return [
      {
        slug: model.slug,
        name: model.name,
        ...(model.badge ? { badge: model.badge } : {}),
        minVersion,
      },
    ];
  });
}

export function formatClaudeVersionUpgradeMessage(
  catalog: ClaudeModelCatalog,
  version: string | null,
): string | undefined {
  const unavailable = catalog.models
    .filter(
      (entry) =>
        entry.compatibility.minVersion &&
        (!version || compareSemverVersions(version, entry.compatibility.minVersion) < 0),
    )
    .toSorted((left, right) =>
      compareSemverVersions(left.compatibility.minVersion!, right.compatibility.minVersion!),
    )[0];
  if (!unavailable?.compatibility.minVersion) return undefined;
  const versionLabel = version ? `v${version}` : "the installed version";
  return `Claude Code ${versionLabel} is too old for ${unavailable.model.name}. Upgrade to v${unavailable.compatibility.minVersion} or newer to access it.`;
}

export function resolveClaudeCatalogEffort(
  catalog: ClaudeModelCatalog,
  model: string | null | undefined,
  raw: string | null | undefined,
): string | undefined {
  if (!resolveClaudeCatalogModel(catalog, model)) {
    const effort = raw?.trim();
    return effort && ["low", "medium", "high", "xhigh", "max"].includes(effort)
      ? effort
      : undefined;
  }

  const caps = getClaudeCatalogModelCapabilities(catalog, model);
  const descriptors = getProviderOptionDescriptors({
    caps,
    ...(raw ? { selections: [{ id: "effort", value: raw }] } : {}),
  });
  const descriptor = descriptors.find((candidate) => candidate.id === "effort");
  const value = getProviderOptionCurrentValue(descriptor);
  return typeof value === "string" ? value : undefined;
}

export function normalizeClaudeCatalogEffort(
  catalog: ClaudeModelCatalog,
  effort: string | null | undefined,
  model: string | null | undefined,
): string | undefined {
  if (!effort) return undefined;
  const effortMap = resolveClaudeCatalogModel(catalog, model)?.runtime.effortMap;
  if (!effortMap || !Object.prototype.hasOwnProperty.call(effortMap, effort)) return effort;
  return effortMap[effort] ?? undefined;
}

function resolveClaudeCatalogContextWindow(
  catalog: ClaudeModelCatalog,
  modelSelection: ModelSelection | undefined,
): string | undefined {
  const caps = getClaudeCatalogModelCapabilities(catalog, modelSelection?.model);
  const raw = getModelSelectionStringOptionValue(modelSelection, "contextWindow");
  const descriptors = getProviderOptionDescriptors({
    caps,
    ...(raw ? { selections: [{ id: "contextWindow", value: raw }] } : {}),
  });
  const descriptor = descriptors.find((candidate) => candidate.id === "contextWindow");
  const value = getProviderOptionCurrentValue(descriptor);
  return typeof value === "string" ? value : undefined;
}

export function resolveClaudeCatalogApiModelId(
  catalog: ClaudeModelCatalog,
  modelSelection: ModelSelection,
): string {
  const entry = resolveClaudeCatalogModel(catalog, modelSelection.model);
  const slug = entry?.apiModel ?? entry?.model.slug ?? modelSelection.model;
  const descriptors = getProviderOptionDescriptors({
    caps: entry?.model.capabilities ?? EMPTY_CAPABILITIES,
    selections: modelSelection.options,
  });
  for (const [optionId, suffixes] of Object.entries(entry?.runtime.modelSuffixes ?? {})) {
    const value = getProviderOptionCurrentValue(
      descriptors.find((descriptor) => descriptor.id === optionId),
    );
    if (typeof value === "string" && suffixes[value]) return `${slug}${suffixes[value]}`;
  }
  return slug;
}

export function resolveClaudeCatalogContextWindowTokens(
  catalog: ClaudeModelCatalog,
  modelSelection: ModelSelection | undefined,
): number | undefined {
  const entry = resolveClaudeCatalogModel(catalog, modelSelection?.model);
  if (!entry) return undefined;
  if (entry.runtime.fixedContextWindowTokens) return entry.runtime.fixedContextWindowTokens;
  const contextWindow = resolveClaudeCatalogContextWindow(catalog, modelSelection);
  return contextWindow ? entry.runtime.contextWindowTokens?.[contextWindow] : undefined;
}
