/**
 * ClaudeEntitlements — reads which models the account's organization allows.
 *
 * Enterprise and team organizations can disallow individual models. Claude
 * Code records the resolved per-model entitlements in its config file under
 * `modelAccessCache`, the same list its own `/model` picker greys rows out
 * from, and falls back to the org default when a disallowed model is
 * requested — emitting only an `informational` notice mid-turn, after the
 * user already picked it.
 *
 * The Agent SDK init handshake is not a usable substitute here: its model
 * catalog is the CLI's curated picker list, so a model can be missing from it
 * and still run (`claude-opus-4-8` is absent yet answers normally). Absence
 * therefore cannot be read as "disallowed", while `entitled: false` can.
 *
 * Reading is best effort in both directions: an unreadable, malformed, or
 * absent cache yields no restrictions, so the picker degrades to today's
 * behavior rather than hiding models the org actually allows.
 *
 * @module provider/Drivers/ClaudeEntitlements
 */
import * as NodeOS from "node:os";

import type { ClaudeSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { expandHomePath } from "../../pathExpansion.ts";

/**
 * Resolve the `.claude.json` the spawned CLI would read, matching the
 * precedence in {@link makeClaudeEnvironment}: the instance's `homePath`
 * (exported as `CLAUDE_CONFIG_DIR`), then a `CLAUDE_CONFIG_DIR` already in the
 * process environment, then `~/.claude.json`.
 *
 * Note this is the config *file* beside the `.claude` directory, not inside
 * it, so it does not share `ClaudeSkills`' config-dir resolution.
 */
const resolveClaudeConfigFilePath = Effect.fn("resolveClaudeConfigFilePath")(function* (
  config: Pick<ClaudeSettings, "homePath">,
  environment: NodeJS.ProcessEnv,
  cwd?: string,
): Effect.fn.Return<string, never, Path.Path> {
  const path = yield* Path.Path;
  const homePath = config.homePath.trim();
  if (homePath.length > 0) {
    return path.join(path.resolve(expandHomePath(homePath)), ".claude.json");
  }
  // No tilde expansion: the spawned CLI receives this env var verbatim, so a
  // literal `~` must stay literal to land on the same file the runtime reads.
  const environmentConfigDir = environment.CLAUDE_CONFIG_DIR?.trim() ?? "";
  if (environmentConfigDir.length > 0) {
    const resolved = cwd
      ? path.resolve(cwd, environmentConfigDir)
      : path.resolve(environmentConfigDir);
    return path.join(resolved, ".claude.json");
  }
  return path.join(NodeOS.homedir(), ".claude.json");
});

/**
 * Model ids the organization has explicitly disallowed, as API model ids
 * (`claude-fable-5`). Entries the cache marks entitled, and models it does not
 * mention at all, are omitted — only an explicit `entitled: false` restricts.
 */
export const readClaudeRestrictedModels = Effect.fn("readClaudeRestrictedModels")(function* (
  config: Pick<ClaudeSettings, "homePath">,
  environment?: NodeJS.ProcessEnv,
  cwd?: string,
): Effect.fn.Return<ReadonlySet<string>, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const configFilePath = yield* resolveClaudeConfigFilePath(
    config,
    environment ?? process.env,
    cwd,
  );

  const contents = yield* fileSystem
    .readFileString(configFilePath)
    .pipe(Effect.orElseSucceed(() => ""));
  if (contents.length === 0) return new Set<string>();

  const parsed = yield* Effect.try(() => JSON.parse(contents) as unknown).pipe(
    Effect.orElseSucceed(() => undefined),
  );
  const modelAccessCache = (parsed as { readonly modelAccessCache?: unknown } | undefined)
    ?.modelAccessCache;
  if (!Array.isArray(modelAccessCache)) return new Set<string>();

  const restricted = new Set<string>();
  for (const entry of modelAccessCache) {
    if (typeof entry !== "object" || entry === null) continue;
    const { apiName, entitled } = entry as {
      readonly apiName?: unknown;
      readonly entitled?: unknown;
    };
    if (entitled !== false || typeof apiName !== "string") continue;
    const normalized = apiName.trim();
    if (normalized.length > 0) restricted.add(normalized);
  }
  return restricted;
});
