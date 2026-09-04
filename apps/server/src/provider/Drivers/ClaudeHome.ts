import * as NodeOS from "node:os";

import type { ClaudeSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import { expandHomePath } from "../../pathExpansion.ts";

export const resolveClaudeHomePath = Effect.fn("resolveClaudeHomePath")(function* (
  config: Pick<ClaudeSettings, "homePath">,
): Effect.fn.Return<string, never, Path.Path> {
  const path = yield* Path.Path;
  const homePath = config.homePath.trim();
  return path.resolve(homePath.length > 0 ? expandHomePath(homePath) : NodeOS.homedir());
});

/**
 * Resolve the Claude config directory the spawned CLI uses. An explicit
 * provider override wins, followed by the instance environment, then
 * Claude's default `$HOME/.claude` location.
 */
export const resolveClaudeConfigDirPath = Effect.fn("resolveClaudeConfigDirPath")(function* (
  config: Pick<ClaudeSettings, "homePath">,
  environment?: NodeJS.ProcessEnv,
  cwd?: string,
): Effect.fn.Return<string, never, Path.Path> {
  const path = yield* Path.Path;
  const homePath = config.homePath.trim();
  if (homePath.length > 0) {
    return yield* resolveClaudeHomePath(config);
  }

  const resolvedEnvironment = environment ?? process.env;
  // No tilde expansion here: the spawned CLI receives this env var verbatim
  // (env vars are never shell-expanded), so a literal `~` must stay literal
  // for discovery to scan the same directory the runtime would. A relative
  // value is resolved against the workspace cwd — the subprocess's own cwd —
  // for the same reason.
  const environmentConfigDir = resolvedEnvironment.CLAUDE_CONFIG_DIR?.trim() ?? "";
  if (environmentConfigDir.length > 0) {
    return cwd ? path.resolve(cwd, environmentConfigDir) : path.resolve(environmentConfigDir);
  }
  const inheritedHome =
    resolvedEnvironment.HOME?.trim() || resolvedEnvironment.USERPROFILE?.trim() || NodeOS.homedir();
  return path.join(path.resolve(inheritedHome), ".claude");
});

/**
 * Capability probes run from an existing neutral cwd because Claude treats
 * `<cwd>/.claude/settings.json` as project settings. The intended config dir
 * remains available through CLAUDE_CONFIG_DIR, including when it does not yet
 * exist or arrived as a relative inherited environment variable.
 */
export const makeClaudeCapabilitiesProbeContext = Effect.fn("makeClaudeCapabilitiesProbeContext")(
  function* (
    config: Pick<ClaudeSettings, "homePath">,
    environment?: NodeJS.ProcessEnv,
    workspaceCwd?: string,
  ): Effect.fn.Return<
    { readonly cwd: string; readonly environment: NodeJS.ProcessEnv },
    never,
    Path.Path
  > {
    const path = yield* Path.Path;
    const resolvedEnvironment = environment ?? process.env;
    const configDirPath = yield* resolveClaudeConfigDirPath(config, environment, workspaceCwd);
    return {
      cwd: path.resolve(NodeOS.tmpdir()),
      environment: {
        ...resolvedEnvironment,
        CLAUDE_CONFIG_DIR: configDirPath,
      },
    };
  },
);

export const makeClaudeEnvironment = Effect.fn("makeClaudeEnvironment")(function* (
  config: Pick<ClaudeSettings, "homePath">,
  baseEnv?: NodeJS.ProcessEnv,
): Effect.fn.Return<NodeJS.ProcessEnv, never, Path.Path> {
  const resolvedBaseEnv = baseEnv ?? process.env;
  const homePath = config.homePath.trim();
  if (homePath.length === 0) return resolvedBaseEnv;
  const resolvedHomePath = yield* resolveClaudeHomePath(config);
  return {
    ...resolvedBaseEnv,
    // Isolate this instance's config via CLAUDE_CONFIG_DIR rather than HOME.
    // Overriding HOME also relocates the macOS login keychain lookup
    // ($HOME/Library/Keychains), so the spawned CLI can't find its stored
    // OAuth credentials and reports "Not logged in". CLAUDE_CONFIG_DIR points
    // Claude Code at its config dir directly while leaving HOME (and the
    // keychain) intact.
    CLAUDE_CONFIG_DIR: resolvedHomePath,
  };
});

export const makeClaudeContinuationGroupKey = Effect.fn("makeClaudeContinuationGroupKey")(
  function* (config: Pick<ClaudeSettings, "homePath">): Effect.fn.Return<string, never, Path.Path> {
    const resolvedHomePath = yield* resolveClaudeHomePath(config);
    return `claude:home:${resolvedHomePath}`;
  },
);

export const makeClaudeCapabilitiesCacheKey = Effect.fn("makeClaudeCapabilitiesCacheKey")(
  function* (
    config: Pick<ClaudeSettings, "binaryPath" | "homePath">,
    environment?: NodeJS.ProcessEnv,
    workspaceCwd?: string,
  ): Effect.fn.Return<string, never, Path.Path> {
    const configDirPath = yield* resolveClaudeConfigDirPath(config, environment, workspaceCwd);
    return `${config.binaryPath}\0${configDirPath}`;
  },
);
