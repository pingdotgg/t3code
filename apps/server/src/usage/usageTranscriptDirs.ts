/**
 * Resolves which transcript directories the usage scan walks.
 *
 * A driver can be configured many times over — one `providerInstances` entry
 * per account, each pointed at its own `CLAUDE_CONFIG_DIR` / `CODEX_HOME` — and
 * every one of those homes keeps its own transcripts. Reading only the legacy
 * `providers.<kind>` blob reports the default profile's usage and silently
 * omits every other one.
 *
 * The legacy-versus-instance precedence mirrors
 * `deriveProviderInstanceConfigMap`: the legacy blob is a mirror of the
 * driver's default instance slot, so it is dropped once an explicit entry
 * claims that id.
 *
 * @module usageTranscriptDirs
 */
import {
  ClaudeSettings,
  CodexSettings,
  defaultInstanceIdForDriver,
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

export interface UsageTranscriptDir {
  readonly provider: UsageProviderKind;
  readonly dir: string;
}

const CLAUDE_DRIVER = ProviderDriverKind.make("claudeAgent");
const CODEX_DRIVER = ProviderDriverKind.make("codex");

const decodeClaudeSettings = Schema.decodeUnknownOption(ClaudeSettings);
const decodeCodexSettings = Schema.decodeUnknownOption(CodexSettings);

/**
 * Every config configured for one driver, in a stable order: the legacy blob
 * first when it still owns the driver's default slot, then each explicit
 * instance in settings-author order.
 *
 * Instances whose config envelope fails to decode are skipped — the provider
 * registry already reports those as unavailable, and guessing a home for one
 * would attribute a stranger's transcripts to it.
 */
function collectDriverConfigs<A>(
  settings: ServerSettings,
  driver: ProviderDriverKind,
  legacyConfig: A,
  decode: (input: unknown) => Option.Option<A>,
): readonly A[] {
  const defaultInstanceId = defaultInstanceIdForDriver(driver);
  const configs: A[] = defaultInstanceId in settings.providerInstances ? [] : [legacyConfig];

  for (const instance of Object.values(settings.providerInstances)) {
    if (instance.driver !== driver) continue;
    const decoded = decode(instance.config ?? {});
    if (Option.isSome(decoded)) configs.push(decoded.value);
  }

  return configs;
}

/**
 * Claude's config dir is the home itself when overridden, but a default
 * install nests transcripts under `~/.claude/projects`. Probe both.
 */
const resolveClaudeTranscriptDir = Effect.fn("resolveClaudeTranscriptDir")(function* (
  homePath: string,
): Effect.fn.Return<string, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const nested = path.join(homePath, ".claude", "projects");
  const nestedExists = yield* fileSystem
    .exists(nested)
    .pipe(Effect.catchCause(() => Effect.succeed(false)));
  return nestedExists ? nested : path.join(homePath, "projects");
});

/**
 * Transcript directory for every configured provider profile, de-duplicated by
 * resolved path. Two instances routinely resolve to one directory — Codex
 * shadow homes share their `CODEX_HOME` by design — and scanning such a
 * directory twice would double count every token in it.
 */
export const resolveUsageTranscriptDirs = Effect.fn("resolveUsageTranscriptDirs")(function* (
  settings: ServerSettings,
): Effect.fn.Return<readonly UsageTranscriptDir[], never, FileSystem.FileSystem | Path.Path> {
  const path = yield* Path.Path;

  const dirs: UsageTranscriptDir[] = [];
  const seen = new Set<string>();
  const add = (provider: UsageProviderKind, dir: string): void => {
    const key = `${provider}\0${dir}`;
    if (seen.has(key)) return;
    seen.add(key);
    dirs.push({ provider, dir });
  };

  const claudeConfigs = collectDriverConfigs(
    settings,
    CLAUDE_DRIVER,
    settings.providers.claudeAgent,
    decodeClaudeSettings,
  );
  for (const config of claudeConfigs) {
    const homePath = yield* resolveClaudeHomePath(config);
    add("claude", yield* resolveClaudeTranscriptDir(homePath));
  }

  const codexConfigs = collectDriverConfigs(
    settings,
    CODEX_DRIVER,
    settings.providers.codex,
    decodeCodexSettings,
  );
  for (const config of codexConfigs) {
    const layout = yield* resolveCodexHomeLayout(config);
    add("codex", path.join(layout.sharedHomePath, "sessions"));
  }

  return dirs;
});
