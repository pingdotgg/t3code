import {
  type CustomModelSetting,
  type ModelCapabilities,
  type ModelSelection,
  ProviderDriverKind,
  type ServerProviderModel,
  type ServerProviderUpdateRequiredModel,
} from "@t3tools/contracts";
import {
  resolveSettings as resolveClaudeSettings,
  type SettingSource,
  type Settings as ClaudeSdkSettings,
} from "@anthropic-ai/claude-agent-sdk";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
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

/** A row of Claude Code's own model list, as initialization reports it. */
export interface ClaudeCodeReportedModel {
  readonly value: string;
  readonly resolvedModel?: string | undefined;
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

const CLAUDE_CODE_MODEL_SUFFIX = /\[[^\]]*\]$/;

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
  reportedModels: ReadonlyArray<ClaudeCodeReportedModel>,
): ClaudeModelCatalog {
  const apiModels = new Map<string, string>();
  for (const reported of reportedModels) {
    if (reported.value === "default") continue;
    const wireModel = (reported.resolvedModel ?? reported.value).replace(
      CLAUDE_CODE_MODEL_SUFFIX,
      "",
    );
    const firstPartyModel = stripClaudeBackendDecoration(wireModel);
    if (firstPartyModel === wireModel) continue;
    const entry = resolveClaudeCatalogModel(catalog, firstPartyModel);
    if (!entry || apiModels.has(entry.model.slug)) continue;
    apiModels.set(entry.model.slug, reported.value.replace(CLAUDE_CODE_MODEL_SUFFIX, ""));
  }
  if (apiModels.size === 0) return catalog;
  return {
    models: catalog.models.map((entry) => {
      const apiModel = apiModels.get(entry.model.slug);
      return apiModel ? { ...entry, apiModel } : entry;
    }),
  };
}

// Env names that pick the backend, its region, or the model a family alias resolves to.
const MODEL_SETTINGS_ENV_PREFIXES = [
  "ANTHROPIC_",
  "CLAUDE_CODE_USE_",
  "AWS_",
  "CLOUD_ML_",
  "VERTEX_",
];

/** Equal keys mean Claude Code resolves model ids the same way under both settings. */
function claudeModelSettingsKey(settings: ClaudeSdkSettings): string {
  const sortedEntries = (record: Readonly<Record<string, string | undefined>> | undefined) =>
    Object.entries(record ?? {}).toSorted(([a], [b]) => a.localeCompare(b));
  return JSON.stringify([
    settings.availableModels ?? null,
    sortedEntries(settings.modelOverrides),
    sortedEntries(settings.env).filter(([name]) =>
      MODEL_SETTINGS_ENV_PREFIXES.some((prefix) => name.startsWith(prefix)),
    ),
  ]);
}

export const resolveClaudeModelSettingsKey = Effect.fn("resolveClaudeModelSettingsKey")(function* (
  settingSources: ReadonlyArray<SettingSource>,
  cwd: string | null,
) {
  return yield* Effect.tryPromise(() =>
    resolveClaudeSettings({
      ...(cwd === null ? {} : { cwd }),
      settingSources: [...settingSources],
    }),
  ).pipe(
    Effect.map(({ effective }) => claudeModelSettingsKey(effective)),
    Effect.orElseSucceed(() => undefined),
  );
});

export interface ClaudeCodeModelRoutes {
  /** Keeps a successful probe's model list with the settings key of the cwd it ran in. */
  readonly record: (
    models: ReadonlyArray<ClaudeCodeReportedModel>,
    probeCwd: string,
  ) => Effect.Effect<void>;
  /** Releases turns waiting for the first probe, whatever its outcome. */
  readonly settle: Effect.Effect<void>;
  readonly catalogFor: (cwd: string | null) => Effect.Effect<ClaudeModelCatalog>;
}

export const makeClaudeCodeModelRoutes = Effect.fn("makeClaudeCodeModelRoutes")(function* (
  catalog: Effect.Effect<ClaudeModelCatalog>,
  settingsKey: (cwd: string | null) => Effect.Effect<string | undefined>,
) {
  const firstProbeSettled = yield* Deferred.make<void>();
  const reported = yield* Ref.make<{
    readonly models: ReadonlyArray<ClaudeCodeReportedModel>;
    readonly settingsKey: string | undefined;
  }>({ models: [], settingsKey: undefined });
  return {
    record: Effect.fn("ClaudeCodeModelRoutes.record")(function* (models, probeCwd) {
      yield* Ref.set(reported, { models, settingsKey: yield* settingsKey(probeCwd) });
    }),
    settle: Deferred.succeed(firstProbeSettled, undefined).pipe(Effect.asVoid),
    catalogFor: Effect.fn("ClaudeCodeModelRoutes.catalogFor")(function* (cwd) {
      yield* Deferred.await(firstProbeSettled);
      const base = yield* catalog;
      const { models, settingsKey: probeKey } = yield* Ref.get(reported);
      const routed = withClaudeCodeModelRoutes(base, models);
      // Project settings can point an alias at another model, so routes hold only where the
      // cwd resolves the same model settings as the probe's.
      if (routed === base || probeKey === undefined) return base;
      return (yield* settingsKey(cwd)) === probeKey ? routed : base;
    }),
  } satisfies ClaudeCodeModelRoutes;
});

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
