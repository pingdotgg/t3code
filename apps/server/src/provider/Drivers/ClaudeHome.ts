// @effect-diagnostics nodeBuiltinImport:off
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { ClaudeSettings } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { resolveCommandPath } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { expandHomePath } from "../../pathExpansion.ts";

const NPM_CLAUDE_PACKAGE_BIN = ["node_modules", "@anthropic-ai", "claude-code", "bin"] as const;

function isWindowsScriptShim(filePath: string): boolean {
  const extension = NodePath.win32.extname(filePath).toLowerCase();
  return extension === ".cmd" || extension === ".bat" || extension === ".ps1" || extension === "";
}

/**
 * Resolve a Claude Code binary path suitable for `pathToClaudeCodeExecutable`.
 *
 * The Claude Agent SDK expects a native binary, not an npm PATH shim. On Windows,
 * `npm i -g @anthropic-ai/claude-code` installs `claude.cmd` / a shell wrapper that
 * point at `node_modules/@anthropic-ai/claude-code/bin/claude.exe` — unwrap that.
 */
export const resolveClaudeCodeExecutable = Effect.fn("resolveClaudeCodeExecutable")(function* (
  binaryPath: string,
  environment?: NodeJS.ProcessEnv,
): Effect.fn.Return<string, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcessPlatform;
  const configured = binaryPath.trim() || "claude";
  const nativeBinaryName = platform === "win32" ? "claude.exe" : "claude";

  const resolved = yield* resolveCommandPath(
    configured,
    environment ? { env: environment } : {},
  ).pipe(Effect.catchTags({ CommandResolutionError: () => Effect.succeed(configured) }));

  // Only unwrap npm shims — never replace an explicit native/custom executable
  // just because a sibling node_modules/@anthropic-ai/claude-code layout exists.
  const shouldUnwrapNpmShim =
    platform === "win32"
      ? isWindowsScriptShim(resolved)
      : // Bare `claude` on PATH is typically the npm/posix wrapper script.
        configured === "claude" || configured === nativeBinaryName;

  if (shouldUnwrapNpmShim) {
    // npm global prefix: <prefix>/claude(.cmd) → <prefix>/node_modules/@anthropic-ai/claude-code/bin/claude[.exe]
    const npmNativeBinary = path.join(
      path.dirname(resolved),
      ...NPM_CLAUDE_PACKAGE_BIN,
      nativeBinaryName,
    );
    if (yield* fileSystem.exists(npmNativeBinary).pipe(Effect.orElseSucceed(() => false))) {
      return npmNativeBinary;
    }
  }

  const resolvedExists = yield* fileSystem.exists(resolved).pipe(Effect.orElseSucceed(() => false));
  if (resolvedExists) {
    // Don't hand Windows script shims to the Agent SDK — it needs the .exe.
    if (platform === "win32" && isWindowsScriptShim(resolved)) {
      return configured;
    }
    return resolved;
  }

  return configured;
});

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

export const makeClaudeContinuationGroupKey = Effect.fn("makeClaudeContinuationGroupKey")(
  function* (config: Pick<ClaudeSettings, "homePath">): Effect.fn.Return<string, never, Path.Path> {
    const resolvedHomePath = yield* resolveClaudeHomePath(config);
    return `claude:home:${resolvedHomePath}`;
  },
);

export const makeClaudeCapabilitiesCacheKey = Effect.fn("makeClaudeCapabilitiesCacheKey")(
  function* (
    config: Pick<ClaudeSettings, "binaryPath" | "homePath">,
    cwd?: string,
  ): Effect.fn.Return<string, never, Path.Path> {
    const resolvedHomePath = yield* resolveClaudeHomePath(config);
    return `${config.binaryPath}\0${resolvedHomePath}\0${cwd ?? ""}`;
  },
);
