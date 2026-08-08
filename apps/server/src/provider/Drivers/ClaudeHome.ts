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
  config: Pick<ClaudeSettings, "homePath"> &
    Partial<Pick<ClaudeSettings, "useCliProxyApi" | "cliProxyApiUrl" | "cliProxyApiKey">>,
  baseEnv?: NodeJS.ProcessEnv,
): Effect.fn.Return<NodeJS.ProcessEnv, never, Path.Path> {
  const resolvedBaseEnv = baseEnv ?? process.env;
  const homePath = config.homePath.trim();
  const cliProxyApiUrl = config.cliProxyApiUrl?.trim() || "http://127.0.0.1:8317";
  const cliProxyApiKey = config.cliProxyApiKey?.trim() ?? "";

  if (homePath.length === 0 && !config.useCliProxyApi) return resolvedBaseEnv;

  return {
    ...resolvedBaseEnv,
    // Isolate this instance's config via CLAUDE_CONFIG_DIR rather than HOME.
    // Overriding HOME also relocates the macOS login keychain lookup
    // ($HOME/Library/Keychains), so the spawned CLI can't find its stored
    // OAuth credentials and reports "Not logged in". CLAUDE_CONFIG_DIR points
    // Claude Code at its config dir directly while leaving HOME (and the
    // keychain) intact.
    ...(homePath.length > 0 ? { CLAUDE_CONFIG_DIR: yield* resolveClaudeHomePath(config) } : {}),
    ...(config.useCliProxyApi
      ? {
          ANTHROPIC_BASE_URL: cliProxyApiUrl,
          // Always stamp the token so an unrelated ambient Anthropic token is
          // never forwarded to the configured proxy by accident.
          ANTHROPIC_AUTH_TOKEN: cliProxyApiKey,
          // Claude Code prefers ANTHROPIC_API_KEY when it is present. Clear it
          // for this child so the proxy token remains the active credential.
          ANTHROPIC_API_KEY: "",
        }
      : {}),
  };
});

export const makeClaudeContinuationGroupKey = Effect.fn("makeClaudeContinuationGroupKey")(
  function* (
    config: Pick<ClaudeSettings, "homePath"> &
      Partial<Pick<ClaudeSettings, "useCliProxyApi" | "cliProxyApiUrl">>,
  ): Effect.fn.Return<string, never, Path.Path> {
    const resolvedHomePath = yield* resolveClaudeHomePath(config);
    const proxyKey = config.useCliProxyApi
      ? `:cliproxy:${config.cliProxyApiUrl?.trim() || "http://127.0.0.1:8317"}`
      : "";
    return `claude:home:${resolvedHomePath}${proxyKey}`;
  },
);

export const makeClaudeCapabilitiesCacheKey = Effect.fn("makeClaudeCapabilitiesCacheKey")(
  function* (
    config: Pick<ClaudeSettings, "binaryPath" | "homePath"> &
      Partial<Pick<ClaudeSettings, "useCliProxyApi" | "cliProxyApiUrl">>,
    cwd?: string,
  ): Effect.fn.Return<string, never, Path.Path> {
    const resolvedHomePath = yield* resolveClaudeHomePath(config);
    const proxyKey = config.useCliProxyApi
      ? `\0cliproxy:${config.cliProxyApiUrl?.trim() || "http://127.0.0.1:8317"}`
      : "";
    return `${config.binaryPath}\0${resolvedHomePath}\0${cwd ?? ""}${proxyKey}`;
  },
);
