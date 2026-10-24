import {
  type CustomModelSetting,
  type ModelCapabilities,
  type ModelSelection,
  ProviderDriverKind,
  type ServerProviderModel,
  type ServerProviderUpdateRequiredModel,
} from "@t3tools/contracts";
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
    models.push({
      model: ModelCatalog.catalogServerModel(resolved, entry),
      runtime: profile.value.claudeCode ?? {},
      compatibility: adapter.value.claudeCode ?? {},
    });
  }

  return {
    models,
  };
}

const BUNDLED_CLAUDE_PROVIDER_CATALOG =
  resolveProviderCatalog(BUNDLED_MODEL_MANIFEST, CLAUDE) ?? undefined;

export function resolveClaudeModelCatalog(
  catalog: ModelCatalog.ProviderCatalog | undefined,
): ClaudeModelCatalog {
  return (
    tryResolveClaudeModelCatalog(catalog) ??
    tryResolveClaudeModelCatalog(BUNDLED_CLAUDE_PROVIDER_CATALOG) ?? {
      models: [],
    }
  );
}

export const BUNDLED_CLAUDE_MODEL_CATALOG = resolveClaudeModelCatalog(
  BUNDLED_CLAUDE_PROVIDER_CATALOG,
);

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
        capabilities: entry.capabilities,
      },
      runtime: {},
      compatibility: {},
    });
  }

  return { models: [...builtInModels, ...customCatalogModels] };
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

export function resolveClaudeModelSlug(catalog: ClaudeModelCatalog, slugOrAlias: string): string {
  return resolveClaudeCatalogModel(catalog, slugOrAlias)?.model.slug ?? slugOrAlias;
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

/** Claude Code's effort levels, lowest first. */
export const CLAUDE_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type ClaudeEffortLevel = (typeof CLAUDE_EFFORT_LEVELS)[number];

function claudeEffortRank(level: string | undefined): number {
  return CLAUDE_EFFORT_LEVELS.indexOf(level as ClaudeEffortLevel);
}

/** One settings source's effort caps, with `modelSettings` keys as the user wrote them. */
export interface ClaudeEffortCapSource {
  readonly maxEffortLevel?: ClaudeEffortLevel;
  readonly modelMaxEffortLevels?: ReadonlyMap<string, ClaudeEffortLevel>;
}

const CLAUDE_1M_SUFFIX = "[1m]";
const CLAUDE_CODE_FAMILY_ALIASES: ReadonlySet<string> = new Set([
  "opus",
  "sonnet",
  "haiku",
  "fable",
]);

/**
 * Names the model a `modelSettings` key caps the way Claude Code does, which is narrower than the
 * catalog's aliases: only a family alias (optionally `[1m]`) resolves as an alias, and any other key
 * names the most specific model id it contains, so `claude-opus-5-5-20260101` and Bedrock ids match
 * while `claude-opus-5.5` matches nothing.
 */
function resolveClaudeModelSettingsKey(
  catalog: ClaudeModelCatalog,
  key: string,
): string | undefined {
  const lowered = key.trim().toLowerCase();
  const unsuffixed = lowered.endsWith(CLAUDE_1M_SUFFIX)
    ? lowered.slice(0, -CLAUDE_1M_SUFFIX.length)
    : lowered;
  if (CLAUDE_CODE_FAMILY_ALIASES.has(unsuffixed)) {
    return catalog.models.find(
      (entry) => !entry.model.isCustom && entry.model.aliases?.includes(unsuffixed),
    )?.model.slug;
  }
  let match: string | undefined;
  for (const { model } of catalog.models) {
    if (!model.isCustom && lowered.includes(model.slug) && model.slug.length > (match?.length ?? 0))
      match = model.slug;
  }
  return match;
}

/** Keys `modelSettings` caps by canonical slug, keeping the lowest cap when several keys name one model. */
function resolveClaudeModelMaxEffortLevels(
  catalog: ClaudeModelCatalog,
  levels: ReadonlyMap<string, ClaudeEffortLevel> | undefined,
): ReadonlyMap<string, ClaudeEffortLevel> {
  const resolved = new Map<string, ClaudeEffortLevel>();
  for (const [key, level] of levels ?? []) {
    const slug = resolveClaudeModelSettingsKey(catalog, key);
    if (!slug) continue;
    const current = resolved.get(slug);
    if (!current || claudeEffortRank(level) < claudeEffortRank(current)) resolved.set(slug, level);
  }
  return resolved;
}

/**
 * Claude Code clamps every effort above settings.json `maxEffortLevel` to the highest level the
 * model supports at or below it, so a model without Extra High runs Max at High under an `xhigh`
 * cap. Each descriptor's effective cap is therefore its highest plain-level option at or below the
 * configured cap. Options above it are relabelled rather than removed: a stored selection that no longer matched any option
 * would fall back to the descriptor default and run below the cap. An option counts as above the
 * cap only when both the level it reads as and the level the CLI is sent are, so an `effortMap`
 * that already sends Max as High keeps its label, and values that map to no level (prompt-injected
 * Ultrathink) are never capped.
 *
 * The cap is resolved like Claude Code does: within each settings source, the lowest
 * `modelSettings.<model>.maxEffortLevel` naming the model replaces that source's top-level cap and
 * `max` means no cap; across sources the lowest cap wins. The merged settings cannot express this,
 * since a per-model `max` in one file would hide another file's top-level cap.
 */
export function capClaudeCatalogEffort(
  catalog: ClaudeModelCatalog,
  models: ReadonlyArray<ServerProviderModel>,
  sources: ReadonlyArray<ClaudeEffortCapSource>,
): ReadonlyArray<ServerProviderModel> {
  if (sources.length === 0) return models;
  const resolvedSources = sources.map((source) => ({
    maxEffortLevel: source.maxEffortLevel,
    modelMaxEffortLevels: resolveClaudeModelMaxEffortLevels(catalog, source.modelMaxEffortLevels),
  }));
  return models.map((model) => {
    // Custom model labels are user-authored, so they are left alone.
    if (model.isCustom || !model.capabilities?.optionDescriptors) return model;
    const modelMaxEffortLevel = resolvedSources.reduce<ClaudeEffortLevel | undefined>(
      (lowest, source) => {
        const level = source.modelMaxEffortLevels.get(model.slug) ?? source.maxEffortLevel;
        return level &&
          level !== "max" &&
          (!lowest || claudeEffortRank(level) < claudeEffortRank(lowest))
          ? level
          : lowest;
      },
      undefined,
    );
    if (!modelMaxEffortLevel) return model;
    const capRank = claudeEffortRank(modelMaxEffortLevel);
    return {
      ...model,
      capabilities: {
        ...model.capabilities,
        optionDescriptors: model.capabilities.optionDescriptors.map((descriptor) => {
          if (descriptor.id !== "effort" || descriptor.type !== "select") return descriptor;
          const cap = descriptor.options.reduce<{ rank: number; label: string } | undefined>(
            (best, option) => {
              const rank = claudeEffortRank(option.id);
              return rank >= 0 && rank <= capRank && rank > (best?.rank ?? -1)
                ? { rank, label: option.label }
                : best;
            },
            undefined,
          );
          if (!cap) return descriptor;
          return {
            ...descriptor,
            options: descriptor.options.map((option) => {
              const idRank = claudeEffortRank(option.id);
              const sentRank = claudeEffortRank(
                normalizeClaudeCatalogEffort(catalog, option.id, model.slug),
              );
              const displayedRank = idRank >= 0 ? idRank : sentRank;
              const runsRank = sentRank >= 0 ? sentRank : idRank;
              return displayedRank > cap.rank && runsRank > cap.rank
                ? { ...option, label: `${option.label} (capped to ${cap.label})` }
                : option;
            }),
          };
        }),
      },
    };
  });
}

export function resolveClaudeCatalogEffort(
  catalog: ClaudeModelCatalog,
  model: string | null | undefined,
  raw: string | null | undefined,
): string | undefined {
  if (!resolveClaudeCatalogModel(catalog, model)) {
    const effort = raw?.trim();
    return effort && (CLAUDE_EFFORT_LEVELS as ReadonlyArray<string>).includes(effort)
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

export function isClaudeCatalogUltracodeEffort(effort: string | null | undefined): boolean {
  return effort === "ultracode";
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
  const slug = entry?.model.slug ?? modelSelection.model;
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
