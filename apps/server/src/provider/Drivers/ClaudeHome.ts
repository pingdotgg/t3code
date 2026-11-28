import { claudeTelemetryOptOut } from "@t3tools/provider-core/server/providerTelemetry";
import type { Settings as ClaudeSdkSettings } from "@anthropic-ai/claude-agent-sdk";
import type {
  ClaudeSettings,
  ProviderInstanceId,
  ProviderInstanceEnvironment,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  materializeHomeOverlay,
  type HomeOverlay,
  type OverlayPolicy,
  type OverlayFold,
} from "@t3tools/provider-core/server/homeOverlay";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as HostProcess from "@t3tools/shared/HostProcess";

import { readClaudeSettingsEnv } from "./ClaudeSkills.ts";
import { linkInferenceSkills } from "./inferenceSkills.ts";

const quotePath = Schema.encodeSync(Schema.fromJsonString(Schema.String));

const CLAUDE_BACKEND_ENVIRONMENT = [
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_ANTHROPIC_AWS",
  "CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD",
  "CLAUDE_CODE_USE_MANTLE",
  "CLAUDE_CODE_USE_GATEWAY",
] as const;

const CLAUDE_ACCOUNT_ENVIRONMENT = [
  ...CLAUDE_BACKEND_ENVIRONMENT,
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_CUSTOM_HEADERS",
  "ANTHROPIC_PROFILE",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
  "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR",
  "CLAUDE_CODE_API_KEY_HELPER_TTL_MS",
  "CLAUDE_CODE_SKIP_BEDROCK_AUTH",
  "CLAUDE_CODE_SKIP_VERTEX_AUTH",
  "CLAUDE_CODE_SKIP_FOUNDRY_AUTH",
  "AWS_BEARER_TOKEN_BEDROCK",
  "ANTHROPIC_FOUNDRY_API_KEY",
  "ANTHROPIC_FOUNDRY_BASE_URL",
  "ANTHROPIC_FOUNDRY_RESOURCE",
] as const;

export const ClaudeAccountDir = Schema.NonEmptyString.check(
  Schema.isPattern(/^(?:\/|[A-Za-z]:[\\/]|\\\\)/),
).pipe(Schema.brand("ClaudeAccountDir"));
export type ClaudeAccountDir = typeof ClaudeAccountDir.Type;
export const parseClaudeAccountDir = Schema.decodeSync(ClaudeAccountDir);

const SYNC_BUCKET = /^(?:\.bucket-)?[0-9a-f-]{36}_(?:[0-9a-f-]{36}|unbound)$/i;
const SYNCED_BUCKETS: OverlayFold = {
  _tag: "FoldDirectory",
  children: (name) =>
    SYNC_BUCKET.test(name)
      ? { _tag: "Move", kind: name.startsWith(".bucket-") ? "file" : "directory" }
      : { _tag: "Conflict" },
};
const CLAUDE_PROFILE_FILES = ["settings.json", "CLAUDE.md", "keybindings.json"];
// The CLI writes into plugins and skills, so those exist before linking; the rest link once present.
const CLAUDE_PROFILE_WRITABLE_DIRECTORIES = ["plugins", "skills"];
const CLAUDE_PROFILE_DIRECTORIES = ["agents", "commands", "output-styles", "rules", "hooks"];
const CLAUDE_PROFILE_ENTRIES: ReturnType<OverlayPolicy["shared"]> = [
  ...CLAUDE_PROFILE_FILES.map((name) => ({ name, adopt: { _tag: "Conflict" as const } })),
  ...[...CLAUDE_PROFILE_WRITABLE_DIRECTORIES, ...CLAUDE_PROFILE_DIRECTORIES].map((name) => ({
    name,
    ensureDirectory: CLAUDE_PROFILE_WRITABLE_DIRECTORIES.includes(name),
    adopt:
      name === "plugins" || name === "skills"
        ? {
            _tag: "FoldDirectory" as const,
            children: (child: string): OverlayFold =>
              child === "synced"
                ? SYNCED_BUCKETS
                : {
                    _tag:
                      name === "plugins" && child === "plugin-directory-cache-v2.json"
                        ? "Drop"
                        : "Conflict",
                  },
          }
        : { _tag: "Conflict" as const },
  })),
];

const CLAUDE_OVERLAY_POLICY: OverlayPolicy = {
  shared: (sharedNames) =>
    CLAUDE_PROFILE_ENTRIES.filter(
      (entry) =>
        entry.ensureDirectory ||
        !CLAUDE_PROFILE_DIRECTORIES.includes(entry.name) ||
        sharedNames.includes(entry.name),
    ),
  mustBeReal: [".claude.json", ".credentials.json", "sessions", "session-env", "backups"],
  healIfLinked: [],
  retired: CLAUDE_PROFILE_ENTRIES.map((entry) => entry.name),
};

export function claudeCliEnvironment(environment: NodeJS.ProcessEnv, configDir: string) {
  const next = { ...environment };
  for (const key of Object.keys(next)) {
    const name = key.toUpperCase();
    if (
      name.startsWith("ANTHROPIC_") ||
      CLAUDE_ACCOUNT_ENVIRONMENT.some((entry) => entry === name) ||
      name === "CLAUDE_CONFIG_DIR" ||
      name === "CLAUDE_SECURESTORAGE_CONFIG_DIR"
    ) {
      delete next[key];
    }
  }
  return { ...next, CLAUDE_CONFIG_DIR: configDir, CLAUDE_SECURESTORAGE_CONFIG_DIR: configDir };
}

export function claudePrivateSettings(settings: ClaudeSdkSettings | undefined) {
  return { ...settings, env: { ...settings?.env, ...claudeTelemetryOptOut } };
}

export function claudeAccountSettings(
  configDir: ClaudeAccountDir | undefined,
): ClaudeSdkSettings | undefined {
  if (configDir === undefined) return undefined;
  return {
    forceLoginMethod: "claudeai",
    apiKeyHelper: "",
    awsAuthRefresh: "",
    awsCredentialExport: "",
    env: {
      ...Object.fromEntries(CLAUDE_ACCOUNT_ENVIRONMENT.map((key) => [key, ""])),
      ...Object.fromEntries(CLAUDE_BACKEND_ENVIRONMENT.map((key) => [key, "0"])),
      CLAUDE_CONFIG_DIR: configDir,
      CLAUDE_SECURESTORAGE_CONFIG_DIR: configDir,
    },
  };
}

export type ClaudeRuntime = {
  readonly environment: NodeJS.ProcessEnv;
} & (
  | {
      readonly mode: "existing";
      readonly config: ClaudeSettings;
      readonly configDir: string;
      readonly overlay: undefined;
      readonly nativeSkillsHome?: string;
    }
  | {
      readonly mode: "cli";
      readonly config: ClaudeSettings & { readonly homePath: ClaudeAccountDir };
      readonly configDir: ClaudeAccountDir;
      readonly overlay: HomeOverlay;
      readonly nativeSkillsHome?: never;
    }
);

export const resolveClaudeRuntime = Effect.fn("resolveClaudeRuntime")(function* (input: {
  readonly instanceId: ProviderInstanceId;
  readonly config: ClaudeSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly stateDir: string;
  readonly nativeEnvironment?: NodeJS.ProcessEnv;
}): Effect.fn.Return<ClaudeRuntime, never, Path.Path> {
  if (input.config.setupMode !== "cli") {
    return {
      mode: "existing",
      config: input.config,
      configDir: yield* resolveClaudeHomePath(input.config, input.environment),
      environment: yield* makeClaudeEnvironment(input.config, input.environment),
      overlay: undefined,
      ...(input.config.setupMode === "inference" && input.config.shareProfile
        ? {
            nativeSkillsHome: yield* resolveClaudeHomePath(
              { homePath: input.config.inferenceSkillsHomePath ?? "" },
              input.nativeEnvironment ?? (yield* HostProcess.Environment),
            ),
          }
        : {}),
    };
  }
  const path = yield* Path.Path;
  const configDir = parseClaudeAccountDir(
    path.join(input.stateDir, "providers", "claude", input.instanceId, "cli"),
  );
  return {
    mode: "cli",
    config: { ...input.config, homePath: configDir },
    configDir,
    environment: claudeCliEnvironment(input.environment, configDir),
    overlay: {
      sharedRoot: yield* resolveClaudeHomePath({ homePath: "" }, input.environment),
      accountDir: configDir,
      policy: CLAUDE_OVERLAY_POLICY,
      active: input.config.shareProfile,
    },
  };
});

export const materializeClaudeHome = Effect.fn("materializeClaudeHome")(function* (
  runtime: ClaudeRuntime,
) {
  if (runtime.mode === "existing" && runtime.config.setupMode === "inference") {
    yield* linkInferenceSkills(runtime.nativeSkillsHome, runtime.configDir, "synced").pipe(
      Effect.ignoreCause({ log: true }),
    );
  }
  if (!runtime.overlay) return;
  const fileSystem = yield* FileSystem.FileSystem;
  yield* fileSystem.makeDirectory(runtime.configDir, { recursive: true, mode: 0o700 });
  yield* materializeHomeOverlay(runtime.overlay);
});

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
  const resolvedBaseEnv = { ...(baseEnv ?? process.env), ...claudeTelemetryOptOut };
  const homePath = config.homePath.trim();
  if (homePath.length === 0) return resolvedBaseEnv;
  const resolvedHomePath = yield* resolveClaudeHomePath(config);
  return {
    ...resolvedBaseEnv,
    // Changing HOME hides macOS Keychain credentials; use CLAUDE_CONFIG_DIR to keep login access.
    CLAUDE_CONFIG_DIR: resolvedHomePath,
  };
});

// A Claude Code session that launched T3 exports these. A claude spawned with them acts as part of
// that session: its session id, messaging socket and token, and effort.
const CLAUDE_HOST_SESSION_VARIABLES = [
  "CLAUDECODE",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_HOST_SESSION_ID",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_CODE_DESKTOP_APP_VERSION",
  "CLAUDE_EFFORT",
  "CLAUDE_PID",
  "CLAUDE_AGENT_SDK_VERSION",
];

/**
 * Base env for the Claude processes T3 Code runs, before `makeClaudeEnvironment`.
 * Claude Code reads its entrypoint from the process env, not its settings `env`, so T3 Code applies that override itself.
 */
export const mergeClaudeProcessEnvironment = Effect.fn("mergeClaudeProcessEnvironment")(function* (
  config: Pick<ClaudeSettings, "homePath" | "setupMode" | "enabled">,
  instanceEnvironment: ProviderInstanceEnvironment | undefined,
  hostEnvironment: NodeJS.ProcessEnv,
) {
  const baseEnvironment: NodeJS.ProcessEnv = {
    ...(config.setupMode === "inference"
      ? claudeCliEnvironment(hostEnvironment, config.homePath)
      : hostEnvironment),
    CLAUDE_CODE_ENTRYPOINT: "t3-code",
  };
  for (const name of CLAUDE_HOST_SESSION_VARIABLES) delete baseEnvironment[name];
  // The desktop runs the server as Node through Electron. Commands Claude runs inherit its env, so
  // an Electron app they start (T3 Code itself, VS Code) would run as Node and exit.
  delete baseEnvironment.ELECTRON_RUN_AS_NODE;
  const environment = yield* mergeProviderInstanceEnvironment(instanceEnvironment, baseEnvironment);
  // A turned-off Claude never runs, so its settings stay unread.
  if (!config.enabled) return environment;
  const settingsEntrypoint = (yield* readClaudeSettingsEnv(config, undefined, environment))
    .CLAUDE_CODE_ENTRYPOINT;
  return settingsEntrypoint
    ? { ...environment, CLAUDE_CODE_ENTRYPOINT: settingsEntrypoint }
    : environment;
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
  ): Effect.fn.Return<string, never, Path.Path | FileSystem.FileSystem> {
    const fileSystem = yield* FileSystem.FileSystem;
    const resolvedHomePath = yield* resolveClaudeHomePath(config, environment);
    // Two instances that reach one Claude home through a symlink share sessions, so they can resume.
    // Only the key uses the real path: the spawn keeps the literal path, which names the Keychain login.
    const canonicalHomePath = yield* fileSystem
      .realPath(resolvedHomePath)
      .pipe(Effect.orElseSucceed(() => resolvedHomePath));
    return `claude:home:${canonicalHomePath}`;
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
