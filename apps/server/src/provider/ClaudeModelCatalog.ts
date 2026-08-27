import {
  type ModelCapabilities,
  type ModelSelection,
  ProviderDriverKind,
  type ServerProviderModel,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import {
  getModelSelectionStringOptionValue,
  getProviderOptionCurrentValue,
  getProviderOptionDescriptors,
  normalizeCustomModelSlug,
} from "@t3tools/shared/model";
import { compareSemverVersions } from "@t3tools/shared/semver";

import {
  type ClaudeCodeCompatibility,
  type ClaudeCodeProfile,
  decodeClaudeModelAdapter,
  decodeClaudeProfileAdapter,
} from "./ClaudeModelManifest.ts";
import {
  BUNDLED_MODEL_MANIFEST,
  type ModelManifestData,
  resolveProviderCatalog,
} from "./ModelManifest.ts";

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

function tryResolveClaudeModelCatalog(manifest: ModelManifestData): ClaudeModelCatalog | null {
  const resolved = resolveProviderCatalog(manifest, CLAUDE);
  if (!resolved) return null;

  const models: Array<ClaudeCatalogModel> = [];
  for (const entry of resolved.models) {
    const profile = decodeClaudeProfileAdapter(entry.profileAdapter ?? {});
    const adapter = decodeClaudeModelAdapter(entry.adapter ?? {});
    if (Option.isNone(profile) || Option.isNone(adapter)) return null;
    models.push({
      model: entry.model,
      runtime: profile.value.claudeCode ?? {},
      compatibility: adapter.value.claudeCode ?? {},
    });
  }

  return {
    models,
  };
}

export function resolveClaudeModelCatalog(manifest: ModelManifestData): ClaudeModelCatalog {
  return (
    tryResolveClaudeModelCatalog(manifest) ??
    tryResolveClaudeModelCatalog(BUNDLED_MODEL_MANIFEST) ?? {
      models: [],
    }
  );
}

export const BUNDLED_CLAUDE_MODEL_CATALOG = resolveClaudeModelCatalog(BUNDLED_MODEL_MANIFEST);

/** Keeps custom model aliases opaque while preserving canonical built-in models and capabilities. */
export function scopeClaudeModelCatalog(
  catalog: ClaudeModelCatalog,
  customModels: ReadonlyArray<string>,
): ClaudeModelCatalog {
  const customAliases = new Set(
    customModels.flatMap((model) => {
      const slug = normalizeCustomModelSlug(model);
      return slug ? [slug.toLowerCase()] : [];
    }),
  );
  if (customAliases.size === 0) return catalog;

  return {
    models: catalog.models.map((entry) => {
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
    }),
  };
}

export function resolveClaudeCatalogModel(
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

export function resolveClaudeCatalogContextWindow(
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

/**
 * Claude Code auto-enables the 1M-token context window for every model with a
 * native 1M window, so a bare model slug does not select 200k — the CLI only
 * holds a session at 200k when `CLAUDE_CODE_DISABLE_1M_CONTEXT` is set, and a
 * user or project settings file may already set it (live-test finding). State
 * the window the catalog resolved in both directions, so the session runs the
 * window T3 displays — for a fixed-window model as much as for a picked option.
 * Managed policy settings still outrank this; the CLI's own usage report then
 * corrects the meter. Models without catalog token data are left to the
 * user's configuration.
 */
export function resolveClaudeCatalogContextWindowEnv(
  catalog: ClaudeModelCatalog,
  modelSelection: ModelSelection | undefined,
): Record<string, string> | undefined {
  const tokens = resolveClaudeCatalogContextWindowTokens(catalog, modelSelection);
  if (tokens === undefined) return undefined;
  return { CLAUDE_CODE_DISABLE_1M_CONTEXT: tokens <= 200_000 ? "1" : "0" };
}
