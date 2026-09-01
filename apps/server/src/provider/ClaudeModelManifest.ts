import { TrimmedNonEmptyString } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export const ClaudeCodeProfileSchema = Schema.Struct({
  effortMap: Schema.optional(
    Schema.Record(TrimmedNonEmptyString, Schema.NullOr(TrimmedNonEmptyString)),
  ),
  modelSuffixes: Schema.optional(
    Schema.Record(
      TrimmedNonEmptyString,
      Schema.Record(TrimmedNonEmptyString, TrimmedNonEmptyString),
    ),
  ),
  contextWindowTokens: Schema.optional(Schema.Record(TrimmedNonEmptyString, Schema.Number)),
  fixedContextWindowTokens: Schema.optional(Schema.Number),
});

export const ClaudeProfileAdapterSchema = Schema.Struct({
  claudeCode: Schema.optional(ClaudeCodeProfileSchema),
});

export const ClaudeModelAdapterSchema = Schema.Struct({
  claudeCode: Schema.optional(
    Schema.Struct({
      minVersion: Schema.optional(TrimmedNonEmptyString),
      maxVersionExclusive: Schema.optional(TrimmedNonEmptyString),
    }),
  ),
});

export type ClaudeCodeProfile = typeof ClaudeCodeProfileSchema.Type;
export type ClaudeCodeCompatibility = NonNullable<typeof ClaudeModelAdapterSchema.Type.claudeCode>;

export const decodeClaudeProfileAdapter = Schema.decodeUnknownOption(ClaudeProfileAdapterSchema);
export const decodeClaudeModelAdapter = Schema.decodeUnknownOption(ClaudeModelAdapterSchema);

interface ClaudeManifestAdapterInput {
  readonly providers?:
    | Readonly<
        Record<
          string,
          | {
              readonly profiles: Readonly<Record<string, { readonly adapter?: unknown }>>;
              readonly models: ReadonlyArray<{ readonly adapter?: unknown }>;
            }
          | undefined
        >
      >
    | undefined;
}

export function hasValidClaudeManifestAdapters(manifest: ClaudeManifestAdapterInput): boolean {
  const catalog = manifest.providers?.claudeAgent;
  if (!catalog) return true;

  return (
    Object.values(catalog.profiles).every((profile) =>
      Option.isSome(decodeClaudeProfileAdapter(profile.adapter ?? {})),
    ) &&
    catalog.models.every((model) => Option.isSome(decodeClaudeModelAdapter(model.adapter ?? {})))
  );
}
