/**
 * ClaudeEntitlements — reads which models the account's organization allows.
 *
 * Enterprise and team organizations can disallow individual models. Claude
 * Code records the resolved per-model entitlements in its global config file
 * under `modelAccessCache`, the list its own `/model` menu is built from, and
 * falls back to the org default when a disallowed model is requested —
 * emitting only an `informational` notice mid-turn, after the user already
 * picked it.
 *
 * The Agent SDK is not a usable substitute: its init model list is the CLI's
 * curated picker with restricted rows already dropped, so a model can be
 * absent from it and still run (`claude-opus-4-8` is absent yet answers
 * normally), and the field that would carry them is internal to the VS Code
 * extension.
 *
 * Reading is best effort in both directions: an unreadable, malformed, or
 * absent cache yields no restrictions, so the picker degrades to today's
 * behavior rather than hiding models the org actually allows.
 *
 * @module provider/Drivers/ClaudeEntitlements
 */
import * as NodeOS from "node:os";

import { TrimmedNonEmptyString } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

/**
 * The `.claude.json` the spawned CLI reads, given the environment it is
 * spawned with (see `makeClaudeEnvironment`, which exports an instance's
 * `homePath` as `CLAUDE_CONFIG_DIR`). Verified against the CLI: with
 * `CLAUDE_CONFIG_DIR` set it reads `$CLAUDE_CONFIG_DIR/.claude.json`; without
 * it, `~/.claude.json` beside the `~/.claude` directory rather than inside it.
 *
 * A relative `CLAUDE_CONFIG_DIR` or `HOME` resolves against each session's
 * own working directory, so no single file speaks for the whole environment;
 * `undefined` here means restrict nothing.
 */
function resolveClaudeConfigFilePath(
  path: Path.Path,
  environment: NodeJS.ProcessEnv,
): string | undefined {
  const configDir = environment.CLAUDE_CONFIG_DIR?.trim() ?? "";
  const home = environment.HOME?.trim() ?? "";
  const root = configDir.length > 0 ? configDir : home.length > 0 ? home : NodeOS.homedir();
  return path.isAbsolute(root) ? path.join(root, ".claude.json") : undefined;
}

// Entries are validated one at a time, as the CLI does, so a single odd entry
// costs only itself rather than every restriction in the list.
const ClaudeGlobalConfig = Schema.fromJsonString(
  Schema.Struct({ modelAccessCache: Schema.optional(Schema.Array(Schema.Unknown)) }),
);
const decodeClaudeGlobalConfig = Schema.decodeUnknownOption(ClaudeGlobalConfig);

const ModelAccessEntry = Schema.Struct({
  apiName: TrimmedNonEmptyString,
  entitled: Schema.Boolean,
});
const decodeModelAccessEntry = Schema.decodeUnknownOption(ModelAccessEntry);

/**
 * The cache names models by API id, which for older models carries a release
 * date (`claude-haiku-4-5-20251001`) that the catalog slug (`claude-haiku-4-5`)
 * does not. Dropping the date is the same normalization the CLI applies before
 * matching, and it is what lets the entry meet the slug.
 */
function toCatalogSlug(apiName: string): string {
  return apiName.replace(/-\d{8}$/, "");
}

/**
 * Model ids the organization has explicitly disallowed, as catalog slugs
 * (`claude-fable-5`), for the account the given environment spawns the CLI
 * as. Entries the cache marks entitled, and models it does not mention at
 * all, are omitted — only an explicit `entitled: false` restricts.
 */
export const readClaudeRestrictedModels = Effect.fn("readClaudeRestrictedModels")(function* (
  environment: NodeJS.ProcessEnv,
): Effect.fn.Return<ReadonlySet<string>, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const restricted = new Set<string>();

  const configFilePath = resolveClaudeConfigFilePath(path, environment);
  if (configFilePath === undefined) return restricted;

  const contents = yield* fileSystem
    .readFileString(configFilePath)
    .pipe(Effect.orElseSucceed(() => undefined));
  const parsed = contents === undefined ? Option.none() : decodeClaudeGlobalConfig(contents);
  if (Option.isNone(parsed)) return restricted;

  for (const entry of parsed.value.modelAccessCache ?? []) {
    const decoded = decodeModelAccessEntry(entry);
    if (Option.isSome(decoded) && !decoded.value.entitled) {
      restricted.add(toCatalogSlug(decoded.value.apiName));
    }
  }
  return restricted;
});
