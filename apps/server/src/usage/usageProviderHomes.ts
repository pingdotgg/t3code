/**
 * usageProviderHomes - enumerates the transcript homes the usage scan reads.
 *
 * Providers can be configured multiple times through `providerInstances`
 * (e.g. `claude_pro` + `claude_max`), each isolated in its own home. The scan
 * must read every configured home, not just the legacy single-instance
 * settings, or secondary accounts silently report zero usage.
 *
 * Resolution mirrors what the spawned CLI actually uses: an explicit
 * `homePath` wins; without one, an absolute home configured on the instance
 * environment (`CLAUDE_CONFIG_DIR` / `CODEX_HOME`) wins, and otherwise the
 * default home. The server process's own ambient environment is deliberately
 * not consulted, so what usage scans is determined by settings alone rather
 * than by how this particular server happened to be launched.
 *
 * @module usageProviderHomes
 */
import * as NodeOS from "node:os";

import { ClaudeSettings, CodexSettings, type ServerSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { expandHomePath } from "../pathExpansion.ts";
import { resolveClaudeHomePath } from "../provider/Drivers/ClaudeHome.ts";
import { resolveCodexHomeLayout } from "../provider/Drivers/CodexHomeLayout.ts";
import { deriveProviderInstanceConfigMap } from "../provider/Layers/ProviderInstanceRegistryHydration.ts";
import { mergeProviderInstanceEnvironment } from "../provider/ProviderInstanceEnvironment.ts";

const decodeClaudeSettings = Schema.decodeUnknownEffect(ClaudeSettings);
const decodeCodexSettings = Schema.decodeUnknownEffect(CodexSettings);

export interface UsageProviderHomes {
  /** One entry per distinct Claude home; transcripts nest under it. */
  readonly claudeHomePaths: readonly string[];
  /** One entry per distinct Codex `sessions` directory. */
  readonly codexSessionDirs: readonly string[];
  readonly grokSessionsDir: string;
}

export const resolveUsageProviderHomes = Effect.fn("resolveUsageProviderHomes")(function* (
  settings: ServerSettings,
  hostEnvironment: NodeJS.ProcessEnv,
): Effect.fn.Return<UsageProviderHomes, never, Path.Path> {
  const path = yield* Path.Path;
  const instances = deriveProviderInstanceConfigMap(settings);

  const claudeHomePaths: string[] = [];
  const codexSessionDirs: string[] = [];
  const pushUnique = (list: string[], value: string) => {
    if (!list.includes(value)) list.push(value);
  };

  /**
   * Home taken from an instance environment variable. The spawned CLI
   * receives env vars verbatim (never shell-expanded), so no tilde expansion
   * here — see `resolveClaudeConfigDirPath` in ClaudeSkills. A relative value
   * resolves against each workspace's own cwd and therefore has no single
   * scan directory; only absolute values are honored.
   */
  const environmentHomePath = (value: string | undefined): string | null => {
    const trimmed = value?.trim() ?? "";
    return trimmed.length > 0 && path.isAbsolute(trimmed) ? path.resolve(trimmed) : null;
  };

  // Disabled instances still scan: usage covers turns driven outside T3 Code,
  // and a paused instance's transcripts are still this machine's spend.
  for (const envelope of Object.values(instances)) {
    if (envelope.driver === "claudeAgent") {
      // An envelope whose config fails to decode is already surfaced as an
      // unavailable instance by the registry; usage just skips it.
      const config = yield* decodeClaudeSettings(envelope.config ?? {}).pipe(
        Effect.catchCause(() => Effect.succeed(null)),
      );
      if (config === null) continue;
      if (config.homePath.trim().length > 0) {
        pushUnique(claudeHomePaths, yield* resolveClaudeHomePath(config));
        continue;
      }
      const environment = mergeProviderInstanceEnvironment(envelope.environment, {});
      const configDir = environmentHomePath(environment["CLAUDE_CONFIG_DIR"]);
      pushUnique(claudeHomePaths, configDir ?? (yield* resolveClaudeHomePath(config)));
    } else if (envelope.driver === "codex") {
      const config = yield* decodeCodexSettings(envelope.config ?? {}).pipe(
        Effect.catchCause(() => Effect.succeed(null)),
      );
      if (config === null) continue;
      const layout = yield* resolveCodexHomeLayout(config);
      // The runtime only exports CODEX_HOME from `homePath` when it is set,
      // so with an empty `homePath` an instance-level CODEX_HOME reaches the
      // CLI and decides where sessions land.
      const environment = mergeProviderInstanceEnvironment(envelope.environment, {});
      const environmentHome =
        config.homePath.trim().length === 0 ? environmentHomePath(environment["CODEX_HOME"]) : null;
      pushUnique(codexSessionDirs, path.join(environmentHome ?? layout.sharedHomePath, "sessions"));
    }
  }

  // Grok Settings only expose the binary path; home is `$GROK_HOME` or `~/.grok`.
  // Empty/whitespace GROK_HOME must fall back: coalescing alone would scan cwd.
  const grokHomeEnv = hostEnvironment["GROK_HOME"]?.trim() ?? "";
  const grokHome =
    grokHomeEnv.length > 0
      ? path.resolve(expandHomePath(grokHomeEnv))
      : path.join(NodeOS.homedir(), ".grok");

  return {
    claudeHomePaths,
    codexSessionDirs,
    grokSessionsDir: path.join(grokHome, "sessions"),
  };
});
