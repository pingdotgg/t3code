/**
 * Resolves the transcript directories the usage scan walks.
 *
 * Every configured provider instance contributes its own directory. A second
 * Claude instance pointed at `~/.claude-work` writes transcripts there, not
 * under `~/.claude`, so scanning only the default instance under-reports.
 * Instances that resolve to the same directory collapse to one entry so a
 * shared home is never counted twice.
 *
 * @module usageTranscriptDirs
 */
import {
  ClaudeSettings,
  CodexSettings,
  ProviderDriverKind,
  type ServerSettings,
  type UsageProviderKind,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { resolveClaudeHomePath } from "../provider/Drivers/ClaudeHome.ts";
import { resolveCodexHomeLayout } from "../provider/Drivers/CodexHomeLayout.ts";
import { deriveProviderInstanceConfigMap } from "../provider/Layers/ProviderInstanceRegistryHydration.ts";

export interface UsageTranscriptDir {
  readonly provider: UsageProviderKind;
  readonly dir: string;
}

const CLAUDE_DRIVER_KIND = ProviderDriverKind.make("claudeAgent");
const CODEX_DRIVER_KIND = ProviderDriverKind.make("codex");

const decodeClaudeSettings = Schema.decodeUnknownOption(ClaudeSettings);
const decodeCodexSettings = Schema.decodeUnknownOption(CodexSettings);

/**
 * Claude's config dir is the home itself when overridden, but a default
 * install nests transcripts under `~/.claude/projects`. Probe both.
 */
const resolveClaudeTranscriptDir = Effect.fn("resolveClaudeTranscriptDir")(function* (
  homePath: string,
): Effect.fn.Return<string, never, Path.Path | FileSystem.FileSystem> {
  const path = yield* Path.Path;
  const fileSystem = yield* FileSystem.FileSystem;
  const nested = path.join(homePath, ".claude", "projects");
  const nestedExists = yield* fileSystem
    .exists(nested)
    .pipe(Effect.catchCause(() => Effect.succeed(false)));
  return nestedExists ? nested : path.join(homePath, "projects");
});

/**
 * One transcript directory per distinct provider home. Walks the same merged
 * instance map the registry hydrates from, so explicit `providerInstances`
 * entries and the legacy `providers.<kind>` mirrors are both covered.
 * Instances whose config fails to decode are skipped; the registry already
 * reports those as unavailable.
 */
export const resolveUsageTranscriptDirs = Effect.fn("resolveUsageTranscriptDirs")(function* (
  settings: ServerSettings,
): Effect.fn.Return<ReadonlyArray<UsageTranscriptDir>, never, Path.Path | FileSystem.FileSystem> {
  const path = yield* Path.Path;
  const dirs: UsageTranscriptDir[] = [];
  const seen = new Set<string>();
  const add = (provider: UsageProviderKind, dir: string) => {
    const key = `${provider}\0${dir}`;
    if (seen.has(key)) return;
    seen.add(key);
    dirs.push({ provider, dir });
  };

  for (const instance of Object.values(deriveProviderInstanceConfigMap(settings))) {
    if (instance.driver === CLAUDE_DRIVER_KIND) {
      const config = decodeClaudeSettings(instance.config ?? {});
      if (Option.isNone(config)) continue;
      const homePath = yield* resolveClaudeHomePath(config.value);
      add("claude", yield* resolveClaudeTranscriptDir(homePath));
    } else if (instance.driver === CODEX_DRIVER_KIND) {
      const config = decodeCodexSettings(instance.config ?? {});
      if (Option.isNone(config)) continue;
      const layout = yield* resolveCodexHomeLayout(config.value);
      add("codex", path.join(layout.sharedHomePath, "sessions"));
    }
  }

  return dirs;
});
