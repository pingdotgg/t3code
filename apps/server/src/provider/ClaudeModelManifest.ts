import { TrimmedNonEmptyString } from "@t3tools/contracts";
import { compareSemverVersions, parseSemver } from "@t3tools/shared/semver";
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

const ClaudeVersionSchema = TrimmedNonEmptyString.pipe(
  Schema.check(
    Schema.makeFilter((version) => parseSemver(version) !== null, {
      expected: "a supported semantic version",
    }),
  ),
);

const ClaudeCodeCompatibilitySchema = Schema.Struct({
  minVersion: Schema.optional(ClaudeVersionSchema),
  maxVersionExclusive: Schema.optional(ClaudeVersionSchema),
}).pipe(
  Schema.check(
    Schema.makeFilter(
      ({ minVersion, maxVersionExclusive }) =>
        minVersion === undefined ||
        maxVersionExclusive === undefined ||
        compareSemverVersions(minVersion, maxVersionExclusive) < 0,
      { expected: "a minimum version below the exclusive maximum version" },
    ),
  ),
);

export const ClaudeModelAdapterSchema = Schema.Struct({
  claudeCode: Schema.optional(ClaudeCodeCompatibilitySchema),
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
