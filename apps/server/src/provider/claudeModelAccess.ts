import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

// Entries are decoded one at a time, as Claude Code does, so an odd entry
// costs only itself.
const AccountConfig = Schema.fromJsonString(
  Schema.Struct({ modelAccessCache: Schema.optional(Schema.Array(Schema.Unknown)) }),
);
const decodeAccountConfig = Schema.decodeUnknownOption(AccountConfig);
const ModelAccessEntry = Schema.Struct({ apiName: Schema.String, entitled: Schema.Boolean });
const decodeModelAccessEntry = Schema.decodeUnknownOption(ModelAccessEntry);

/**
 * Cache entries and requested models name API ids, which for older models carry a
 * release date (`claude-haiku-4-5-20251001`) that catalog slugs omit. Claude Code
 * drops it, and a `[1m]` suffix, before matching.
 */
export const toCatalogSlug = (apiName: string) =>
  apiName
    .trim()
    .toLowerCase()
    .replace(/\[1m\]$/, "")
    .replace(/-\d{8}$/, "");

/**
 * Catalog slugs the organization turned off, from Claude Code's `modelAccessCache` (the SDK has no
 * equivalent). The CLI rewrites it shortly after starting, so a read after a probe sees the previous
 * run's fetch. Fails open: only an explicit `entitled: false` turns a model off.
 */
export const readClaudeRestrictedModels = Effect.fn("readClaudeRestrictedModels")(function* (
  accountConfigPath: string,
): Effect.fn.Return<ReadonlySet<string>, never, FileSystem.FileSystem> {
  const fileSystem = yield* FileSystem.FileSystem;
  const contents = yield* fileSystem
    .readFileString(accountConfigPath)
    .pipe(Effect.orElseSucceed(() => undefined));
  const config = contents === undefined ? Option.none() : decodeAccountConfig(contents);
  const restricted = new Set<string>();
  if (Option.isNone(config)) return restricted;
  for (const entry of config.value.modelAccessCache ?? []) {
    const decoded = decodeModelAccessEntry(entry);
    if (Option.isSome(decoded) && !decoded.value.entitled) {
      restricted.add(toCatalogSlug(decoded.value.apiName));
    }
  }
  return restricted;
});
