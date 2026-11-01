import {
  resolveSettings,
  type Settings as ClaudeSdkSettings,
} from "@anthropic-ai/claude-agent-sdk";
import type { ClaudeSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Data from "effect/Data";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import {
  providerProxyToken,
  type ProviderProxyRoute,
} from "@t3tools/provider-core/server/providerProxy";
import * as HostProcess from "@t3tools/shared/HostProcess";

class ClaudeProxySettingsError extends Data.TaggedError("ClaudeProxySettingsError")<{
  readonly message: string;
}> {}

const encodeSettings = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
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

// Ambient Bedrock, Vertex, or API-key settings would send requests around the proxy.
const CLAUDE_ROUTE_OVERRIDE_VARIABLES = [
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_ANTHROPIC_AWS",
  "CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD",
  "CLAUDE_CODE_USE_MANTLE",
  "CLAUDE_CODE_USE_GATEWAY",
] as const;

export const applyClaudeProxyEnvironment = (
  environment: NodeJS.ProcessEnv,
  proxy: ProviderProxyRoute | undefined,
): NodeJS.ProcessEnv => {
  if (proxy === undefined) return environment;
  const next: NodeJS.ProcessEnv = {
    ...environment,
    ANTHROPIC_BASE_URL: proxy.url,
    ANTHROPIC_AUTH_TOKEN: providerProxyToken(proxy),
    // Empty, not removed: Claude Code otherwise falls back to a saved API key.
    ANTHROPIC_API_KEY: "",
  };
  for (const name of CLAUDE_ROUTE_OVERRIDE_VARIABLES) delete next[name];
  return next;
};

// Claude applies settings env over process env; flag settings pin the route for saved configs too.
export const applyClaudeProxySettings = (
  settings: ClaudeSdkSettings,
  proxy: ProviderProxyRoute | undefined,
): ClaudeSdkSettings => {
  if (proxy === undefined) return settings;
  return {
    ...settings,
    env: {
      ...settings?.env,
      ...Object.fromEntries(CLAUDE_ROUTE_OVERRIDE_VARIABLES.map((name) => [name, "0"])),
      ANTHROPIC_BASE_URL: proxy.url,
      ANTHROPIC_AUTH_TOKEN: providerProxyToken(proxy),
      ANTHROPIC_API_KEY: "",
      CLAUDE_CODE_OAUTH_TOKEN: "",
    },
  };
};

// A private settings file keeps proxy credentials out of process arguments.
export const writeClaudeProxySettingsFile = Effect.fn("writeClaudeProxySettingsFile")(function* (
  settings: ClaudeSdkSettings,
  environment: NodeJS.ProcessEnv,
  cwd?: string | null,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const remotePath = path.join(
    environment.CLAUDE_CONFIG_DIR ?? path.join(yield* HostProcess.HomeDirectory, ".claude"),
    "remote-settings.json",
  );
  const remote = yield* fileSystem.readFileString(remotePath).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))),
    Effect.catchReason("PlatformError", "NotFound", () => Effect.void),
  );
  const resolved = yield* Effect.tryPromise(() =>
    resolveSettings({
      ...(cwd == null ? {} : { cwd }),
      settingSources: [],
      ...(remote === undefined ? {} : { serverManagedSettings: remote as ClaudeSdkSettings }),
    }),
  );
  const managed = resolved.effective;
  const expected = settings.env ?? {};
  if (
    managed.policyHelper !== undefined ||
    managed.policyHelpers !== undefined ||
    Object.entries(managed.env ?? {}).some(
      ([key, value]) =>
        (["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"].includes(key) ||
          CLAUDE_ROUTE_OVERRIDE_VARIABLES.includes(
            key as (typeof CLAUDE_ROUTE_OVERRIDE_VARIABLES)[number],
          )) &&
        value !== expected[key],
    )
  ) {
    return yield* new ClaudeProxySettingsError({
      message:
        "Claude managed policy conflicts with proxy routing. Remove its routing overrides or disable Use proxy.",
    });
  }
  const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-claude-proxy-" });
  const settingsPath = path.join(directory, "settings.json");
  yield* fileSystem.writeFileString(settingsPath, encodeSettings(settings), { mode: 0o600 });
  return settingsPath;
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
