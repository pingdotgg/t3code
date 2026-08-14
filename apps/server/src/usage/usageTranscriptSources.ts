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
 * Match the config-dir precedence seen by the Claude subprocess. Explicit and
 * environment config dirs store transcripts directly under `projects`; only
 * the default installation nests them under `~/.claude/projects`.
 */
const resolveClaudeInstanceTranscriptDir = Effect.fn(
  "UsageTranscriptSources.resolveClaudeInstanceTranscriptDir",
)(function* (
  config: ClaudeSettings,
  instance: ProviderInstanceConfig,
  baseEnvironment: NodeJS.ProcessEnv,
) {
  const path = yield* Path.Path;
  if (config.homePath.trim().length > 0) {
    return path.join(yield* resolveClaudeHomePath(config), "projects");
  }

  const environment = mergeProviderInstanceEnvironment(instance.environment, baseEnvironment);
  const environmentHome = environment.CLAUDE_CONFIG_DIR?.trim() ?? "";
  if (environmentHome.length > 0) {
    // Environment variables are passed directly to the subprocess and do
    // not receive shell-style tilde expansion.
    return path.join(path.resolve(environmentHome), "projects");
  }

  return path.join(NodeOS.homedir(), ".claude", "projects");
});

/**
 * Match the direct-home precedence seen by the Codex subprocess: an explicit
 * homePath wins, otherwise CODEX_HOME comes from the merged instance/process
 * environment. A shadow home keeps the configured shared-home layout because
 * CodexDriver materializes that layout and passes the shadow path explicitly.
 */
const resolveCodexInstanceLayout = Effect.fn("UsageTranscriptSources.resolveCodexInstanceLayout")(
  function* (
    config: CodexSettings,
    instance: ProviderInstanceConfig,
    baseEnvironment: NodeJS.ProcessEnv,
  ) {
    const path = yield* Path.Path;
    if (config.homePath.trim().length > 0 || config.shadowHomePath.trim().length > 0) {
      return yield* resolveCodexHomeLayout(config);
    }

    const environment = mergeProviderInstanceEnvironment(instance.environment, baseEnvironment);
    const environmentHome = environment.CODEX_HOME?.trim() ?? "";
    return yield* resolveCodexHomeLayout({
      ...config,
      // Environment variables are not shell-expanded. Resolve the value first
      // so resolveCodexHomeLayout does not treat a literal `~` as config syntax.
      homePath: environmentHome.length > 0 ? path.resolve(environmentHome) : "",
    });
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
      append({
        provider: "claude",
        dir: yield* resolveClaudeInstanceTranscriptDir(decoded.value, instance, baseEnvironment),
      });
      continue;
    }

    if (instance.driver === CODEX_DRIVER) {
      const decoded = decodeCodexSettings(instance.config ?? {});
      if (Option.isNone(decoded)) continue;
      const layout = yield* resolveCodexInstanceLayout(decoded.value, instance, baseEnvironment);
      append({ provider: "codex", dir: path.join(layout.sharedHomePath, "sessions") });
    }
  }

  return sources;
});
