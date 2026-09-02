/**
 * ModelManifest — remote provider-model metadata with a bundled offline
 * fallback.
 *
 * Provider catalogs and legacy classification live in `model-manifest.json`.
 * The bundled copy ships with every release; at runtime the service refreshes
 * it from the same file on `main`. Preference order is remote, then the last
 * successful on-disk copy, then the bundle. A failed fetch never fails a
 * provider check.
 *
 * Providers with authoritative discovery can use only the classification
 * overlay. Providers with static catalogs can resolve presentation and
 * capabilities from `providers`, then decode their own allowlisted adapter
 * payload separately.
 */
import {
  ModelCapabilities,
  TrimmedNonEmptyString,
  type ProviderDriverKind,
  type ServerProviderModel,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import { ServerConfig } from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import { hasValidClaudeManifestAdapters } from "./ClaudeModelManifest.ts";
import bundledManifestJson from "./model-manifest.json" with { type: "json" };
import type { ServerProviderDraft } from "./providerSnapshot.ts";

const MODEL_MANIFEST_URL =
  "https://raw.githubusercontent.com/pingdotgg/t3code/main/apps/server/src/provider/model-manifest.json";

/** How long a fetched manifest stays fresh before the next probe re-fetches. */
const MANIFEST_TTL_MS = 60 * 60 * 1000;

/** Minimum gap between fetch attempts after a failure, so an offline server
 * does not pay a network timeout on every provider check. */
const MANIFEST_RETRY_MS = 5 * 60 * 1000;

const FETCH_TIMEOUT_MS = 10_000;

const ManifestModelStatus = Schema.Literals(["current", "legacy"]);

const ManifestModelProfile = Schema.Struct({
  capabilities: Schema.optional(ModelCapabilities),
  adapter: Schema.optional(Schema.Unknown),
});

const ManifestProviderModel = Schema.Struct({
  slug: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  shortName: Schema.optional(TrimmedNonEmptyString),
  subProvider: Schema.optional(TrimmedNonEmptyString),
  aliases: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  status: ManifestModelStatus,
  badge: Schema.optional(Schema.Literal("new")),
  profile: Schema.optional(TrimmedNonEmptyString),
  adapter: Schema.optional(Schema.Unknown),
});

const ManifestProviderCatalog = Schema.Struct({
  defaults: Schema.optional(
    Schema.Struct({
      chat: Schema.optional(TrimmedNonEmptyString),
    }),
  ),
  profiles: Schema.Record(Schema.String, ManifestModelProfile),
  models: Schema.Array(ManifestProviderModel),
});

/**
 * `version` gates breaking schema changes. Provider catalogs are additive so
 * clients that only understand `currentModels` keep accepting this v1 file.
 */
const ModelManifestEnvelopeSchema = Schema.Struct({
  version: Schema.Literal(1),
  currentModels: Schema.Record(Schema.String, Schema.Array(Schema.String)),
  providers: Schema.optional(Schema.Record(Schema.String, ManifestProviderCatalog)),
});

const hasValidProviderCatalogReferences = (
  manifest: typeof ModelManifestEnvelopeSchema.Type,
): boolean =>
  Object.values(manifest.providers ?? {}).every((catalog) => {
    const slugs = new Set<string>();
    const modelsAreValid = catalog.models.every((model) => {
      if (slugs.has(model.slug)) return false;
      slugs.add(model.slug);
      return model.profile === undefined || catalog.profiles[model.profile] !== undefined;
    });
    return (
      modelsAreValid && (catalog.defaults?.chat === undefined || slugs.has(catalog.defaults.chat))
    );
  });

const ModelManifestSchema = ModelManifestEnvelopeSchema.pipe(
  Schema.check(
    Schema.makeFilter(hasValidProviderCatalogReferences, {
      expected: "unique model slugs and existing model and profile references",
    }),
    Schema.makeFilter(hasValidClaudeManifestAdapters, {
      expected: "valid Claude adapter metadata",
    }),
  ),
);
export type ModelManifestData = typeof ModelManifestSchema.Type;

export interface ResolvedManifestModel {
  readonly model: ServerProviderModel;
  readonly adapter: unknown;
  readonly profileAdapter: unknown;
}

export interface ResolvedProviderCatalog {
  readonly models: ReadonlyArray<ResolvedManifestModel>;
  readonly defaults: {
    readonly chat: string | undefined;
  };
}

const decodeManifest = Schema.decodeUnknownEffect(ModelManifestSchema);

export const BUNDLED_MODEL_MANIFEST: ModelManifestData =
  Schema.decodeUnknownSync(ModelManifestSchema)(bundledManifestJson);

/** Resolve provider-neutral model presentation and capability data. */
export function resolveProviderCatalog(
  manifest: ModelManifestData,
  driverKind: ProviderDriverKind,
): ResolvedProviderCatalog | null {
  const catalog = manifest.providers?.[driverKind];
  if (!catalog) return null;

  const seen = new Set<string>();
  const models: Array<ResolvedManifestModel> = [];
  for (const entry of catalog.models) {
    if (seen.has(entry.slug)) return null;
    seen.add(entry.slug);

    const profile = entry.profile ? catalog.profiles[entry.profile] : undefined;
    if (entry.profile && !profile) return null;

    models.push({
      model: {
        slug: entry.slug,
        name: entry.name,
        ...(entry.shortName ? { shortName: entry.shortName } : {}),
        ...(entry.subProvider ? { subProvider: entry.subProvider } : {}),
        ...(entry.aliases ? { aliases: entry.aliases } : {}),
        ...(entry.badge ? { badge: entry.badge } : {}),
        isCustom: false,
        ...(catalog.defaults?.chat === entry.slug ? { isDefault: true } : {}),
        ...(entry.status === "legacy" ? { isLegacy: true } : {}),
        capabilities: profile?.capabilities ?? null,
      },
      adapter: entry.adapter,
      profileAdapter: profile?.adapter,
    });
  }

  if (catalog.defaults?.chat !== undefined && !seen.has(catalog.defaults.chat)) return null;

  return {
    models,
    defaults: {
      chat: catalog.defaults?.chat,
    },
  };
}

/** On-disk shape of the last successfully fetched manifest. */
const ManifestCacheFile = Schema.Struct({
  fetchedAtMs: Schema.Number,
  manifest: ModelManifestSchema,
});
const decodeManifestCache = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    ManifestCacheFile as unknown as Schema.Codec<typeof ManifestCacheFile.Type>,
  ),
);
const encodeManifestCache = Schema.encodeEffect(
  Schema.fromJsonString(
    ManifestCacheFile as unknown as Schema.Codec<typeof ManifestCacheFile.Type>,
  ),
);

/** True when the manifest classifies `slug` as legacy for `driverKind`. */
export function isLegacyModel(
  manifest: ModelManifestData,
  driverKind: ProviderDriverKind,
  slug: string,
): boolean {
  const catalogModel = manifest.providers?.[driverKind]?.models.find(
    (model) => model.slug === slug,
  );
  if (catalogModel) return catalogModel.status === "legacy";
  const currentModels = manifest.currentModels[driverKind];
  if (!currentModels) return false;
  return !currentModels.includes(slug);
}

/**
 * Reclassifies every built-in model on a snapshot draft against the manifest.
 * Custom models are user-defined and never reclassified.
 */
export function applyModelManifest(
  draft: ServerProviderDraft,
  manifest: ModelManifestData,
  driverKind: ProviderDriverKind,
): ServerProviderDraft {
  return { ...draft, models: classifyModels(draft.models, manifest, driverKind) };
}

/** Model-level half of `applyModelManifest`, exported for focused tests. */
export function classifyModels(
  models: ReadonlyArray<ServerProviderModel>,
  manifest: ModelManifestData,
  driverKind: ProviderDriverKind,
): ReadonlyArray<ServerProviderModel> {
  return models.map((model) => {
    if (model.isCustom) return model;
    if (isLegacyModel(manifest, driverKind, model.slug)) {
      return model.isLegacy ? model : { ...model, isLegacy: true };
    }
    if (!model.isLegacy) return model;
    const { isLegacy: _isLegacy, ...rest } = model;
    return rest;
  });
}

export class ModelManifest extends Context.Service<
  ModelManifest,
  {
    /** Manifest already in memory (disk cache or bundle); never fetches.
     * Snapshot classification reads this, so it never waits on the network. */
    readonly current: Effect.Effect<ModelManifestData>;
    /** Manifest after a TTL-gated remote refresh; never fails. */
    readonly refresh: Effect.Effect<ModelManifestData>;
    /** Forks `refresh` into the service's own scope. Drivers call this from
     * provider checks: the fetch is process-shared state, so it must survive
     * the teardown of whichever instance happened to trigger it. */
    readonly refreshInBackground: Effect.Effect<void>;
  }
>()("t3/provider/ModelManifest") {}

/** Constant service for tests and callers that only need the bundled data. */
export const BundledOnlyModelManifest: ModelManifest["Service"] = {
  current: Effect.succeed(BUNDLED_MODEL_MANIFEST),
  refresh: Effect.succeed(BUNDLED_MODEL_MANIFEST),
  refreshInBackground: Effect.void,
};

export const layerTest = Layer.succeed(ModelManifest, BundledOnlyModelManifest);

export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const httpClient = yield* HttpClient.HttpClient;
  const serviceScope = yield* Effect.scope;

  const cachePath = path.join(config.stateDir, "model-manifest.json");
  let manifest = BUNDLED_MODEL_MANIFEST;
  let fetchedAtMs: number | null = null;
  let lastAttemptMs: number | null = null;
  const refreshSemaphore = yield* Semaphore.make(1);

  // `Effect.cached` makes concurrent first readers await the same disk load
  // rather than racing a "loaded" flag. Only `refreshed` takes the fetch
  // semaphore; `current` must never wait behind an in-flight network refresh.
  const ensureDiskCacheLoaded = yield* Effect.cached(
    Effect.gen(function* () {
      const fromDisk = yield* fileSystem.readFileString(cachePath).pipe(
        Effect.flatMap((raw) => decodeManifestCache(raw)),
        Effect.catchCause(() => Effect.succeed(null)),
      );
      if (fromDisk === null) return;
      // The disk copy is the last-seen remote manifest, so it outranks the
      // bundle even when stale: it is refreshed on the next successful fetch.
      manifest = fromDisk.manifest;
      fetchedAtMs = fromDisk.fetchedAtMs;
    }),
  );

  const refresh = Effect.fn("ModelManifest.refresh")(function* () {
    yield* ensureDiskCacheLoaded;
    const now = yield* Clock.currentTimeMillis;
    // A timestamp in the future means the wall clock moved backwards (the
    // disk cache crosses restarts, so monotonic time cannot cover it). Treat
    // it as expired: the refetch rewrites both timestamps and self-heals.
    const isWithin = (sinceMs: number | null, windowMs: number) =>
      sinceMs !== null && now >= sinceMs && now - sinceMs < windowMs;
    if (isWithin(fetchedAtMs, MANIFEST_TTL_MS)) return manifest;
    if (isWithin(lastAttemptMs, MANIFEST_RETRY_MS)) return manifest;

    // The same switch that gates provider CLI update checks. It stops network
    // fetches only: a manifest already cached on disk from an earlier fetch
    // stays in effect, since the setting is about phoning home, not about
    // discarding data the server already holds.
    const settings = yield* settingsService.getSettings.pipe(
      Effect.catchCause(() => Effect.succeed(null)),
    );
    if (settings !== null && !settings.enableProviderUpdateChecks) return manifest;

    lastAttemptMs = now;
    const fetched = yield* httpClient.get(MODEL_MANIFEST_URL).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap((response) => response.json),
      Effect.flatMap((json) => decodeManifest(json)),
      Effect.timeout(FETCH_TIMEOUT_MS),
      Effect.catchCause(() => Effect.succeed(null)),
    );
    if (fetched === null) return manifest;

    manifest = fetched;
    fetchedAtMs = now;
    yield* encodeManifestCache({ fetchedAtMs: now, manifest: fetched }).pipe(
      Effect.flatMap((serialized) => fileSystem.writeFileString(cachePath, serialized)),
      Effect.catchCause(() => Effect.void),
    );
    return manifest;
  });

  const guardedRefresh = refreshSemaphore.withPermits(1)(refresh());

  return ModelManifest.of({
    current: ensureDiskCacheLoaded.pipe(Effect.map(() => manifest)),
    refresh: guardedRefresh,
    refreshInBackground: Effect.forkIn(guardedRefresh, serviceScope).pipe(Effect.asVoid),
  });
});

export const layer = Layer.effect(ModelManifest, make);
