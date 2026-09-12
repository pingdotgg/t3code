import { MUSE_REASONING_EFFORT_OPTIONS, type ModelCapabilities } from "@t3tools/contracts";
import { createModelCapabilities, getProviderOptionDescriptors } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

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
export const readMuseModelEfforts = Effect.fn("readMuseModelEfforts")(function* (
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
