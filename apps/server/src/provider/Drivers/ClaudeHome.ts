import type { ClaudeSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as HostProcess from "@t3tools/shared/HostProcess";

const quotePath = Schema.encodeSync(Schema.fromJsonString(Schema.String));

export const resolveClaudeHomePath = Effect.fn("resolveClaudeHomePath")(function* (
  config: Pick<ClaudeSettings, "homePath">,
  environment?: NodeJS.ProcessEnv,
): Effect.fn.Return<string, never, Path.Path> {
  const path = yield* Path.Path;
  const home = yield* HostProcess.HomeDirectory;
  const homePath = config.homePath.trim();
  if (homePath.length > 0) {
    return path.resolve(expandHomePath(homePath, home));
  }
  // Inherited env vars are not shell-expanded, so a literal `~` stays literal.
  const inherited = environment?.CLAUDE_CONFIG_DIR?.trim() ?? "";
  if (inherited.length > 0) {
    return path.resolve(inherited);
  }
  return path.resolve(path.join(home, ".claude"));
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
    // Changing HOME hides macOS Keychain credentials; use CLAUDE_CONFIG_DIR to keep login access.
    CLAUDE_CONFIG_DIR: resolvedHomePath,
  };
});

/** managed-mcp.json excludes other MCP config and forbids --strict-mcp-config; omit the flag when present. */
export const hasClaudeManagedMcpConfig = Effect.fn("hasClaudeManagedMcpConfig")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const platform = yield* HostProcess.Platform;
  const managedMcpConfigPath =
    platform === "darwin"
      ? "/Library/Application Support/ClaudeCode/managed-mcp.json"
      : platform === "win32"
        ? "C:\\Program Files\\ClaudeCode\\managed-mcp.json"
        : "/etc/claude-code/managed-mcp.json";
  return yield* fileSystem.exists(managedMcpConfigPath).pipe(Effect.orElseSucceed(() => false));
});

// A worktree's .git file points at <main>/.git/worktrees/<name>, whose commondir leads back to
// <main>/.git. A bare repository has no main checkout, so its worktree keeps its own file.
// Untraced because claudeLocalSettingsDirectory already owns the span.
const mainCheckoutRoot = Effect.fnUntraced(function* (checkout: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return yield* fileSystem.readFileString(path.join(checkout, ".git")).pipe(
    Effect.flatMap((pointer) => {
      const gitDir = /^gitdir:\s*(.+)$/m.exec(pointer)?.[1]?.trim();
      if (gitDir === undefined) return Effect.succeed(checkout);
      const worktreeGitDir = path.resolve(checkout, gitDir);
      return fileSystem.readFileString(path.join(worktreeGitDir, "commondir")).pipe(
        Effect.map((commonDir) => {
          const common = path.resolve(worktreeGitDir, commonDir.trim());
          return path.basename(common) === ".git" ? path.dirname(common) : checkout;
        }),
      );
    }),
    Effect.orElseSucceed(() => checkout),
  );
});

// Claude Code keeps .claude/settings.local.json at the repository root, or in cwd outside a
// repository, on Windows, or when the root is home. Its owner check is skipped, so callers must
// stay safe when Claude Code ignores the root file.
export const claudeLocalSettingsDirectory = Effect.fn("claudeLocalSettingsDirectory")(function* (
  cwd: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if ((yield* HostProcess.Platform) === "win32") return cwd;
  for (let directory = cwd; ; directory = path.dirname(directory)) {
    const isCheckout = yield* fileSystem
      .exists(path.join(directory, ".git"))
      .pipe(Effect.orElseSucceed(() => false));
    if (isCheckout) {
      const root = yield* mainCheckoutRoot(directory);
      return root === (yield* HostProcess.HomeDirectory) ? cwd : root;
    }
    if (path.dirname(directory) === directory) return cwd;
  }
});

export const makeClaudeContinuationGroupKey = Effect.fn("makeClaudeContinuationGroupKey")(
  function* (
    config: Pick<ClaudeSettings, "homePath">,
    environment?: NodeJS.ProcessEnv,
  ): Effect.fn.Return<string, never, Path.Path> {
    const resolvedHomePath = yield* resolveClaudeHomePath(config, environment);
    return `claude:home:${resolvedHomePath}`;
  },
);

export const makeClaudeCapabilitiesCacheKey = Effect.fn("makeClaudeCapabilitiesCacheKey")(
  function* (
    config: Pick<ClaudeSettings, "binaryPath" | "homePath">,
    cwd?: string,
    environment?: NodeJS.ProcessEnv,
  ): Effect.fn.Return<string, never, Path.Path> {
    const resolvedHomePath = yield* resolveClaudeHomePath(config, environment);
    return `${config.binaryPath}\0${resolvedHomePath}\0${cwd ?? ""}`;
  },
);

/** Separate spawn env from login commands to preserve literal paths, including relative inherited values. */
export const claudeSignedOutMessage = (input: {
  readonly configDir: string | undefined;
  readonly cwd: string;
}): string => {
  const configuration =
    input.configDir !== undefined
      ? ` from ${quotePath(input.cwd)}, with CLAUDE_CONFIG_DIR set to ${quotePath(input.configDir)}`
      : "";
  return `Claude could not authenticate. For subscription login, run \`claude auth login\` on this environment's machine${configuration}, then start a new thread. For API-key authentication, check this instance's configured credentials.`;
};
