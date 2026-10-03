import {
  MUSE_REASONING_EFFORT_OPTIONS,
  type MuseSettings,
  type ServerProviderModel,
  type ModelCapabilities,
} from "@t3tools/contracts";
import { createModelCapabilities, getProviderOptionDescriptors } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { createMuseSdkHost, createMuseSdkHostEffect, type MuseSdkHost } from "./museSdk.ts";

const ReasoningEffortVariant = Schema.Struct({
  tier: Schema.String,
  description: Schema.optional(Schema.NullOr(Schema.String)),
});
type ReasoningEffortVariant = typeof ReasoningEffortVariant.Type;

const CachedModelCatalog = Schema.Struct({
  schema_version: Schema.Literal(1),
  provider_id: Schema.Literal("meta"),
  profile_id: Schema.NullOr(Schema.String),
  source: Schema.Literal("provider_catalog"),
  rows: Schema.Array(
    Schema.Struct({
      model_id: Schema.String,
      provider_id: Schema.String,
      profile_id: Schema.NullOr(Schema.String),
      visibility: Schema.String,
      reasoning_effort_variants: Schema.optional(
        Schema.NullOr(Schema.Array(ReasoningEffortVariant)),
      ),
    }),
  ),
});
const decodeCachedCatalog = Schema.decodeUnknownEffect(Schema.fromJsonString(CachedModelCatalog));

/** Apply the advertised model choices to saved, remembered and implicit efforts at dispatch. */
export function resolveMuseReasoningEffort(
  capabilities: ModelCapabilities | null | undefined,
  effort: string | undefined,
): string | undefined {
  if (!capabilities) return effort;
  const descriptor = getProviderOptionDescriptors({
    caps: capabilities,
    selections: effort ? [{ id: "reasoningEffort", value: effort }] : undefined,
  }).find((descriptor) => descriptor.id === "reasoningEffort");
  if (descriptor?.type !== "select") return undefined;
  return descriptor.options.find((option) => option.id === descriptor.currentValue)?.id;
}

/** MSP model/list omits efforts through Muse 1.1.1. Enrich it from Muse's own catalog,
 * scoped to the initialized host and active profile; cache format changes fall back safely. */
const readMuseModelEfforts = Effect.fn("readMuseModelEfforts")(function* (
  museHome: string,
  profileId: string | null,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = path.join(museHome, "model-catalog");
  const files = yield* fs.readDirectory(directory).pipe(Effect.orElseSucceed(() => []));
  const efforts = new Map<string, ReadonlyArray<ReasoningEffortVariant>>();
  for (const file of files.filter((file) => file.endsWith(".json")).sort()) {
    const catalog = yield* fs.readFileString(path.join(directory, file)).pipe(
      Effect.flatMap(decodeCachedCatalog),
      Effect.orElseSucceed(() => null),
    );
    if (!catalog || catalog.profile_id !== profileId) continue;
    for (const row of catalog.rows) {
      if (
        row.provider_id === "meta" &&
        row.profile_id === profileId &&
        row.visibility === "visible" &&
        row.reasoning_effort_variants != null
      ) {
        efforts.set(row.model_id, row.reasoning_effort_variants);
      }
    }
  }
  return efforts;
});

export function museModelCapabilities(
  modelId: string,
  variants?: ReadonlyArray<ReasoningEffortVariant>,
) {
  // Contributor supports Max. Older Spark 1.2 fallbacks stay capped until its catalog enables more.
  const cappedAtXhigh = modelId === "muse-spark-1.2" || modelId === "muse-spark-1.2-contributor";
  const available = MUSE_REASONING_EFFORT_OPTIONS.filter((option) =>
    variants !== undefined
      ? variants.some((variant) => variant.tier === option.id)
      : ["low", "medium", "high", "xhigh", ...(cappedAtXhigh ? [] : ["max"])].includes(option.id),
  );
  const defaultValue =
    available.find((option) => option.id === "max")?.id ??
    available.find((option) => option.id === "medium")?.id ??
    available[0]?.id;
  return createModelCapabilities({
    optionDescriptors: defaultValue
      ? [
          {
            id: "reasoningEffort",
            label: "Reasoning",
            type: "select",
            currentValue: defaultValue,
            options: available.map(({ id, label }) => {
              const description = variants?.find((variant) => variant.tier === id)?.description;
              return {
                id,
                label,
                ...(id === defaultValue ? { isDefault: true } : {}),
                ...(description ? { description } : {}),
              };
            }),
          },
        ]
      : [],
  });
}

const MUSE_MODEL_NAMES = new Map([
  ["muse-spark-1.3", "Muse Spark 1.3"],
  ["muse-spark-1.3-contributor", "Muse Spark 1.3 Contributor"],
  ["muse-spark-1.2", "Muse Spark 1.2"],
  ["muse-spark-1.2-contributor", "Muse Spark 1.2 Contributor"],
]);

function museModelName(modelId: string, displayLabel: string) {
  const label = displayLabel.trim();
  return label && label !== modelId ? label : (MUSE_MODEL_NAMES.get(modelId) ?? modelId);
}

const ModelCatalog = Schema.Struct({
  providerId: Schema.String,
  profileId: Schema.optional(Schema.NullOr(Schema.String)),
  source: Schema.optional(Schema.String),
  models: Schema.Array(
    Schema.Struct({
      modelId: Schema.NonEmptyString,
      displayLabel: Schema.String,
      providerId: Schema.String,
      profileId: Schema.optional(Schema.NullOr(Schema.String)),
      isDefault: Schema.Boolean,
    }),
  ),
});
const decodeModelCatalog = Schema.decodeUnknownEffect(ModelCatalog);

class MuseCatalogError extends Schema.TaggedError<MuseCatalogError>()("MuseCatalogError", {
  detail: Schema.String,
}) {}

export const discoverMuseModels = Effect.fn("discoverMuseModels")(function* (
  settings: MuseSettings,
  environment: NodeJS.ProcessEnv,
  cwd?: string,
  createHost: typeof createMuseSdkHost = createMuseSdkHost,
) {
  const host = yield* Effect.acquireRelease(
    createMuseSdkHostEffect(
      {
        binaryPath: settings.binaryPath,
        environment,
        ...(cwd ? { cwd } : {}),
        readOnly: true,
        startupTimeoutMs: 8_000,
      },
      createHost,
    ),
    (host: MuseSdkHost) => Effect.promise(() => host.close()),
    { interruptible: true },
  );
  const result = yield* Effect.tryPromise(() => host.connection.request("model/list", {}));
  const catalog = yield* decodeModelCatalog(result);
  if (catalog.providerId !== "meta") {
    return yield* new MuseCatalogError({ detail: "Muse returned a catalog for another provider." });
  }
  const efforts =
    catalog.source === "providerCatalog" && catalog.profileId !== undefined
      ? yield* readMuseModelEfforts(host.initializeResult.museHome, catalog.profileId)
      : undefined;
  const seen = new Set<string>();
  return catalog.models.flatMap((model): ServerProviderModel[] => {
    if (model.providerId !== "meta" || seen.has(model.modelId)) return [];
    seen.add(model.modelId);
    return [
      {
        slug: model.modelId,
        name: museModelName(model.modelId, model.displayLabel),
        isCustom: false,
        isDefault: model.isDefault,
        capabilities: museModelCapabilities(
          model.modelId,
          model.profileId === catalog.profileId ? efforts?.get(model.modelId) : undefined,
        ),
      },
    ];
  });
});
