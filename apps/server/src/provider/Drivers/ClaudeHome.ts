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

/**
 * Build the environment and neutral cwd used by Claude's capability probe.
 *
 * Claude treats `<cwd>/.claude/settings.json` as project settings, so the
 * probe runs from the existing OS temp directory instead of the server or
 * config directory. A relative inherited `CLAUDE_CONFIG_DIR` is made absolute
 * first so changing cwd does not change which credentials Claude reads.
 */
export const makeClaudeCapabilitiesProbeContext = Effect.fn("makeClaudeCapabilitiesProbeContext")(
  function* (
    config: Pick<ClaudeSettings, "homePath">,
    baseEnv?: NodeJS.ProcessEnv,
    cwd?: string,
  ): Effect.fn.Return<
    { readonly cwd: string; readonly environment: NodeJS.ProcessEnv },
    never,
    Path.Path
  > {
    const path = yield* Path.Path;
    const environment = yield* makeClaudeEnvironment(config, baseEnv);
    const configDir = environment.CLAUDE_CONFIG_DIR?.trim() ?? "";
    const normalizedConfigDir =
      configDir.length > 0 && !path.isAbsolute(configDir)
        ? path.resolve(cwd ?? process.cwd(), configDir)
        : configDir;

    return {
      cwd: path.resolve(NodeOS.tmpdir()),
      environment:
        normalizedConfigDir !== configDir
          ? { ...environment, CLAUDE_CONFIG_DIR: normalizedConfigDir }
          : environment,
    };
  },
);

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
    cwd?: string,
  ): Effect.fn.Return<string, never, Path.Path> {
    const resolvedHomePath = yield* resolveClaudeHomePath(config);
    const probeContext = yield* makeClaudeCapabilitiesProbeContext(config, environment, cwd);
    const configDir = probeContext.environment.CLAUDE_CONFIG_DIR?.trim() || resolvedHomePath;
    return `${config.binaryPath}\0${configDir}`;
  },
);
