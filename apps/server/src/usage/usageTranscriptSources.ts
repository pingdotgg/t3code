/**
 * Resolves every configured Codex and Claude Code transcript directory.
 *
 * Provider instances are the runtime source of truth. Legacy provider settings
 * remain a fallback for the built-in default slots, matching provider registry
 * hydration during the settings migration.
 *
 * @module usageTranscriptSources
 */
import * as NodeOS from "node:os";

import {
  ClaudeSettings,
  CodexSettings,
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  type ProviderInstanceConfig,
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
import { mergeProviderInstanceEnvironment } from "../provider/ProviderInstanceEnvironment.ts";

const CLAUDE_DRIVER = ProviderDriverKind.make("claudeAgent");
const CODEX_DRIVER = ProviderDriverKind.make("codex");

const decodeClaudeSettings = Schema.decodeUnknownOption(ClaudeSettings);
const decodeCodexSettings = Schema.decodeUnknownOption(CodexSettings);

export interface UsageTranscriptSource {
  readonly provider: UsageProviderKind;
  readonly dir: string;
}

/**
 * Builds the same relevant instance set as provider registry hydration:
 * explicit entries win, while an absent built-in default slot is synthesized
 * from its legacy provider settings.
 */
function configuredUsageInstances(settings: ServerSettings): readonly ProviderInstanceConfig[] {
  const instances = Object.entries(settings.providerInstances).map(([, instance]) => instance);

  const appendLegacyDefault = (
    driver: typeof CLAUDE_DRIVER | typeof CODEX_DRIVER,
    config: ServerSettings["providers"]["claudeAgent" | "codex"],
  ) => {
    const defaultInstanceId = defaultInstanceIdForDriver(driver);
    if (Object.hasOwn(settings.providerInstances, defaultInstanceId)) return;
    instances.push({ driver, config });
  };

  appendLegacyDefault(CLAUDE_DRIVER, settings.providers.claudeAgent);
  appendLegacyDefault(CODEX_DRIVER, settings.providers.codex);
  return instances;
}

/**
 * An explicit homePath wins because makeClaudeEnvironment exports it over any
 * existing CLAUDE_CONFIG_DIR. Otherwise use the merged per-instance/process
 * environment seen by the Claude subprocess, then the normal OS home.
 */
const resolveClaudeInstanceHome = Effect.fn("UsageTranscriptSources.resolveClaudeInstanceHome")(
  function* (
    config: ClaudeSettings,
    instance: ProviderInstanceConfig,
    baseEnvironment: NodeJS.ProcessEnv,
  ) {
    const path = yield* Path.Path;
    if (config.homePath.trim().length > 0) {
      return yield* resolveClaudeHomePath(config);
    }

    const environment = mergeProviderInstanceEnvironment(instance.environment, baseEnvironment);
    const environmentHome = environment.CLAUDE_CONFIG_DIR?.trim() ?? "";
    if (environmentHome.length > 0) {
      // Environment variables are passed directly to the subprocess and do
      // not receive shell-style tilde expansion.
      return path.resolve(environmentHome);
    }

    return path.resolve(NodeOS.homedir());
  },
);

/**
 * Claude's config dir is the home itself when overridden, but older/default
 * layouts nest transcripts under `<home>/.claude/projects`. Probe both.
 */
const resolveClaudeTranscriptDir = Effect.fn("UsageTranscriptSources.resolveClaudeTranscriptDir")(
  function* (homePath: string) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const nested = path.join(homePath, ".claude", "projects");
    const nestedExists = yield* fileSystem
      .exists(nested)
      .pipe(Effect.catchCause(() => Effect.succeed(false)));
    return nestedExists ? nested : path.join(homePath, "projects");
  },
);

/** Resolve unique transcript roots for every configured Claude/Codex instance. */
export const resolveUsageTranscriptSources = Effect.fn(
  "UsageTranscriptSources.resolveUsageTranscriptSources",
)(function* (settings: ServerSettings, baseEnvironment: NodeJS.ProcessEnv = process.env) {
  const path = yield* Path.Path;
  const sources: UsageTranscriptSource[] = [];
  const seen = new Set<string>();

  const append = (source: UsageTranscriptSource) => {
    const key = `${source.provider}\0${source.dir}`;
    if (seen.has(key)) return;
    seen.add(key);
    sources.push(source);
  };

  for (const instance of configuredUsageInstances(settings)) {
    if (instance.driver === CLAUDE_DRIVER) {
      const decoded = decodeClaudeSettings(instance.config ?? {});
      if (Option.isNone(decoded)) continue;
      const homePath = yield* resolveClaudeInstanceHome(decoded.value, instance, baseEnvironment);
      append({
        provider: "claude",
        dir: yield* resolveClaudeTranscriptDir(homePath),
      });
      continue;
    }

    if (instance.driver === CODEX_DRIVER) {
      const decoded = decodeCodexSettings(instance.config ?? {});
      if (Option.isNone(decoded)) continue;
      const layout = yield* resolveCodexHomeLayout(decoded.value);
      append({ provider: "codex", dir: path.join(layout.sharedHomePath, "sessions") });
    }
  }

  return sources;
});
