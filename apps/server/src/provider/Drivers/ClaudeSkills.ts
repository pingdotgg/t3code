// @effect-diagnostics nodeBuiltinImport:off - fingerprinting hashes incrementally with Node's sha256 and reads the OS username.
import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";

import type { ClaudeSettings, ServerProviderSkill } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";
import { fromLenientJson } from "@t3tools/shared/schemaJson";
import { SKILL_MENTION_PATTERN } from "@t3tools/shared/composerInlineTokens";
import { parse as parseYamlDocument } from "yaml";

import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";

type ClaudeSkillScope = "user" | "project";

type ClaudeSkillRoot = {
  readonly directory: string;
  readonly scope: ClaudeSkillScope;
  readonly prefix?: string;
};

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

type SkillFrontmatter =
  | { readonly kind: "missing" }
  | { readonly kind: "malformed" }
  | {
      readonly kind: "parsed";
      readonly name?: string;
      readonly description?: string;
      readonly userInvocationOnly?: boolean;
      readonly userInvocable?: boolean;
    };

/** Claude accepts YAML 1.1 booleans that this YAML 1.2 parser leaves as strings or numbers. */
function parseFrontmatterBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    return value === 1 ? true : value === 0 ? false : undefined;
  }
  if (typeof value !== "string") return undefined;
  switch (value.trim().toLowerCase()) {
    case "true":
    case "yes":
    case "on":
    case "y":
      return true;
    case "false":
    case "no":
    case "off":
    case "n":
      return false;
    default:
      return undefined;
  }
}

function parseSkillFrontmatter(contents: string): SkillFrontmatter {
  const match = FRONTMATTER_PATTERN.exec(contents);
  if (!match) {
    return { kind: "missing" };
  }

  const frontmatter = match[1] ?? "";
  let parsed: unknown;
  try {
    parsed = parseYamlDocument(frontmatter);
  } catch {
    // Repair Claude's accepted ': ' scalars without disturbing comments or YAML structure.
    const repaired = frontmatter.replace(
      /^([\w-]+:[ \t]*)([^\r\n]*)/gm,
      (line, prefix: string, value: string) => {
        const scalar = value.split(/[ \t]+#/)[0] ?? "";
        if (!/:[ \t]/.test(scalar) || /^(?:["'[\]{}|>&*!#%@`]|[-?:](?:[ \t]|$))/.test(scalar)) {
          return line;
        }
        return `${prefix}${JSON.stringify(scalar)}${value.slice(scalar.length)}`;
      },
    );
    try {
      parsed = parseYamlDocument(repaired);
    } catch {
      return { kind: "malformed" };
    }
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { kind: "malformed" };
  }

  const record = parsed as Record<string, unknown>;
  const name = typeof record.name === "string" ? record.name.trim() : "";
  const description = typeof record.description === "string" ? record.description.trim() : "";
  return {
    kind: "parsed",
    ...(name ? { name } : {}),
    ...(description ? { description } : {}),
    ...(parseFrontmatterBoolean(record["disable-model-invocation"]) === true
      ? { userInvocationOnly: true }
      : {}),
    ...(parseFrontmatterBoolean(record["user-invocable"]) === false
      ? { userInvocable: false }
      : {}),
  };
}

function claudeManagedSettingsPath(
  path: Path.Path,
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
): string | undefined {
  if (platform === "darwin") {
    return "/Library/Application Support/ClaudeCode/managed-settings.json";
  }
  if (platform === "win32") {
    const programData = environment.PROGRAMDATA?.trim();
    return programData ? path.join(programData, "ClaudeCode", "managed-settings.json") : undefined;
  }
  return "/etc/claude-code/managed-settings.json";
}

/** Claude Code settings files, lowest precedence first. */
function claudeSettingsPaths(
  path: Path.Path,
  configDirPath: string,
  cwd: string | undefined,
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
  repositoryRoot?: string,
): ReadonlyArray<string> {
  const managedPath = claudeManagedSettingsPath(path, platform, environment);
  const root = repositoryRoot !== undefined && repositoryRoot !== cwd ? repositoryRoot : undefined;
  return [
    path.join(configDirPath, "settings.json"),
    ...(cwd
      ? [
          path.join(cwd, ".claude", "settings.json"),
          path.join(cwd, ".claude", "settings.local.json"),
        ]
      : []),
    ...(root ? [path.join(root, ".claude", "settings.local.json")] : []),
    ...(managedPath ? [managedPath] : []),
  ];
}

// Untraced: skill discovery resolves every distinct plugin project path, too often for spans.
const findRepositoryRoot = Effect.fnUntraced(function* (
  cwd: string,
): Effect.fn.Return<string | undefined, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  let current = path.resolve(cwd);
  while (true) {
    const isRoot = yield* fileSystem
      .exists(path.join(current, ".git"))
      .pipe(Effect.orElseSucceed(() => false));
    if (isRoot) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
});

const findPluginRepositoryRoot = Effect.fnUntraced(function* (cwd: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* findRepositoryRoot(cwd);
  if (root === undefined) return undefined;
  const gitFile = yield* fileSystem
    .readFileString(path.join(root, ".git"))
    .pipe(Effect.orElseSucceed(() => ""));
  if (!gitFile.trim().startsWith("gitdir:")) return root;
  const gitDirectory = path.resolve(root, gitFile.trim().slice(7).trim());
  const commonFile = yield* fileSystem
    .readFileString(path.join(gitDirectory, "commondir"))
    .pipe(Effect.orElseSucceed(() => ""));
  const worktreeFile = yield* fileSystem
    .readFileString(path.join(gitDirectory, "gitdir"))
    .pipe(Effect.orElseSucceed(() => ""));
  if (!commonFile.trim() || !worktreeFile.trim()) return root;
  const commonDirectory = path.resolve(gitDirectory, commonFile.trim());
  const backlinkPath = yield* fileSystem
    .realPath(path.resolve(gitDirectory, worktreeFile.trim()))
    .pipe(Effect.orElseSucceed(() => undefined));
  const worktreeGitPath = yield* fileSystem
    .realPath(path.join(root, ".git"))
    .pipe(Effect.orElseSucceed(() => undefined));
  if (
    path.dirname(gitDirectory) !== path.join(commonDirectory, "worktrees") ||
    backlinkPath === undefined ||
    backlinkPath !== worktreeGitPath
  ) {
    return root;
  }
  // Claude shares plugin install records across linked worktrees, using their common repository.
  return path.basename(commonDirectory) === ".git"
    ? path.dirname(commonDirectory)
    : commonDirectory;
});

/**
 * The CLI validates the whole map, not each entry: verified against it, one
 * entry with an unknown value (or a boolean) makes it drop every override in
 * that file, so this schema does the same rather than applying the valid
 * siblings the CLI ignores.
 */
const SkillOverrideValue = Schema.Literals(["on", "name-only", "user-invocable-only", "off"]);

// Lenient because these settings files are hand-edited and Claude Code itself
// tolerates comments and trailing commas in them.
const SkillSettings = fromLenientJson(
  Schema.Struct({
    skillOverrides: Schema.optional(Schema.Record(Schema.String, SkillOverrideValue)),
    enabledPlugins: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  }),
);
const decodeSkillSettings = Schema.decodeUnknownEffect(SkillSettings);

type SkillOverride = {
  readonly enabled: boolean;
  readonly userInvocationOnly: boolean;
};

function parseSkillOverride(value: typeof SkillOverrideValue.Type): SkillOverride {
  switch (value) {
    case "off":
      return { enabled: false, userInvocationOnly: false };
    case "user-invocable-only":
      return { enabled: true, userInvocationOnly: true };
    case "on":
    case "name-only":
      return { enabled: true, userInvocationOnly: false };
  }
}

const readSkillSettings = Effect.fn("readSkillSettings")(function* (
  configDirPath: string,
  cwd: string | undefined,
  environment: NodeJS.ProcessEnv,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const overridesByName = new Map<string, SkillOverride>();
  const enabledPlugins = new Map<string, boolean>();
  const repositoryRoot = cwd === undefined ? undefined : yield* findRepositoryRoot(cwd);

  for (const settingsPath of claudeSettingsPaths(
    path,
    configDirPath,
    cwd,
    platform,
    environment,
    repositoryRoot,
  )) {
    const contents = yield* fileSystem
      .readFileString(settingsPath)
      .pipe(Effect.orElseSucceed(() => undefined));
    if (contents === undefined) {
      continue;
    }

    const parsed = yield* decodeSkillSettings(contents).pipe(
      Effect.tapError((cause) =>
        Effect.logDebug("claude settings file is unreadable; ignoring skill settings", {
          path: settingsPath,
          cause,
        }),
      ),
      Effect.orElseSucceed(() => undefined),
    );
    for (const [name, value] of Object.entries(parsed?.skillOverrides ?? {})) {
      overridesByName.set(name, parseSkillOverride(value));
    }
    for (const [key, enabled] of Object.entries(parsed?.enabledPlugins ?? {})) {
      if (typeof enabled === "boolean") {
        enabledPlugins.set(key, enabled);
      } else {
        // Extended formats replace lower-precedence values without enabling the plugin here.
        enabledPlugins.delete(key);
      }
    }
  }

  return { skillOverrides: overridesByName, enabledPlugins };
});

const InstalledPlugins = Schema.fromJsonString(
  Schema.Struct({ plugins: Schema.Record(Schema.String, Schema.Array(Schema.Unknown)) }),
);
const decodeInstalledPlugin = Schema.decodeUnknownOption(
  Schema.Struct({
    scope: Schema.Literals(["user", "project", "local", "managed"]),
    installPath: Schema.NonEmptyString,
    projectPath: Schema.optional(Schema.NonEmptyString),
  }),
);
const PluginManifest = Schema.fromJsonString(
  Schema.Struct({
    name: Schema.optional(Schema.NonEmptyString),
    skills: Schema.optional(Schema.Union([Schema.String, Schema.Array(Schema.String)])),
  }),
);

function isInsideDirectory(path: Path.Path, directory: string, candidate: string): boolean {
  const relative = path.relative(directory, candidate);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

const resolveClaudePluginsPath = Effect.fn("resolveClaudePluginsPath")(function* (
  configDirPath: string,
  cwd: string | undefined,
  environment: NodeJS.ProcessEnv,
) {
  const path = yield* Path.Path;
  const home = yield* HostProcess.HomeDirectory;
  const pluginDirectory = environment.CLAUDE_CODE_PLUGIN_CACHE_DIR;
  return pluginDirectory
    ? path.resolve(cwd ?? ".", expandHomePath(pluginDirectory, home))
    : path.join(configDirPath, "plugins");
});

const discoverPluginSkillRoots = Effect.fn("discoverPluginSkillRoots")(function* (
  configDirPath: string,
  cwd: string | undefined,
  enabledPlugins: ReadonlyMap<string, boolean>,
  environment: NodeJS.ProcessEnv,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const pluginsPath = yield* resolveClaudePluginsPath(configDirPath, cwd, environment);
  const installed = yield* fileSystem
    .readFileString(path.join(pluginsPath, "installed_plugins.json"))
    .pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(InstalledPlugins)),
      Effect.orElseSucceed(() => undefined),
    );
  if (installed === undefined) return [];
  const roots: Array<ClaudeSkillRoot> = [];
  // The CLI's process.cwd() resolves symlinks; registry projectPath values remain lexical.
  const workspace =
    cwd === undefined
      ? undefined
      : yield* fileSystem.realPath(cwd).pipe(Effect.orElseSucceed(() => path.resolve(cwd)));
  // Install records repeat project paths, often hundreds of times per discovery.
  const projectRepositoryRoots = new Map<string, string | undefined>();
  const repositoryRoot =
    workspace === undefined ? undefined : yield* findPluginRepositoryRoot(workspace);

  for (const [key, entries] of Object.entries(installed.plugins).sort()) {
    if (enabledPlugins.get(key) !== true) continue;
    const applicable = yield* Effect.filter(
      entries.flatMap((entry) => Option.toArray(decodeInstalledPlugin(entry))),
      (record) =>
        Effect.gen(function* () {
          if (record.scope === "user" || record.scope === "managed") return true;
          if (record.projectPath === undefined || workspace === undefined) return false;
          const projectPath = path.resolve(record.projectPath);
          if (projectPath === workspace) return true;
          if (repositoryRoot === undefined) return false;
          if (!projectRepositoryRoots.has(projectPath)) {
            projectRepositoryRoots.set(projectPath, yield* findPluginRepositoryRoot(projectPath));
          }
          return projectRepositoryRoots.get(projectPath) === repositoryRoot;
        }),
    );
    // The native loader keeps registry order, preferring the first install that exists.
    const existing = yield* Effect.findFirst(applicable, (record) =>
      fileSystem
        .exists(path.resolve(cwd ?? ".", record.installPath))
        .pipe(Effect.orElseSucceed(() => false)),
    );
    const install = Option.getOrElse(existing, () => applicable[0]);
    if (!install) continue;
    const scope = install.scope === "user" || install.scope === "managed" ? "user" : "project";
    const installPath = path.resolve(cwd ?? ".", install.installPath);
    const manifest = yield* fileSystem
      .readFileString(path.join(installPath, ".claude-plugin", "plugin.json"))
      .pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(PluginManifest)),
        Effect.orElseSucceed(() => undefined),
      );
    const prefix = manifest?.name ?? key.split("@")[0];
    if (!prefix) continue;

    const defaultDirectory = path.join(installPath, "skills");
    const hasDefaultDirectory = yield* fileSystem
      .exists(defaultDirectory)
      .pipe(Effect.orElseSucceed(() => false));
    if (hasDefaultDirectory) roots.push({ directory: defaultDirectory, scope, prefix });
    const declared = manifest?.skills;
    if (declared === undefined && !hasDefaultDirectory) {
      const hasRootSkill = yield* fileSystem
        .exists(path.join(installPath, "SKILL.md"))
        .pipe(Effect.orElseSucceed(() => false));
      if (hasRootSkill) roots.push({ directory: installPath, scope, prefix });
    }

    const canonicalInstallPath = yield* fileSystem
      .realPath(installPath)
      .pipe(Effect.orElseSucceed(() => undefined));
    for (const relative of typeof declared === "string" ? [declared] : (declared ?? [])) {
      const directory = path.resolve(installPath, relative);
      if (!isInsideDirectory(path, installPath, directory) || canonicalInstallPath === undefined) {
        continue;
      }
      const canonicalDirectory = yield* fileSystem
        .realPath(directory)
        .pipe(Effect.orElseSucceed(() => undefined));
      // The native loader rejects manifest roots that escape through a symlink, too.
      if (
        canonicalDirectory !== undefined &&
        isInsideDirectory(path, canonicalInstallPath, canonicalDirectory)
      ) {
        roots.push({ directory, scope, prefix });
      }
    }
  }
  return roots;
});

const resolveClaudeConfigDirPath = Effect.fn("resolveClaudeConfigDirPath")(function* (
  config: Pick<ClaudeSettings, "homePath">,
  environment: NodeJS.ProcessEnv,
  cwd?: string,
): Effect.fn.Return<string, never, Path.Path> {
  const path = yield* Path.Path;
  const home = yield* HostProcess.HomeDirectory;
  const homePath = config.homePath.trim();
  if (homePath.length > 0) {
    return path.resolve(expandHomePath(homePath, home));
  }
  // Match the spawned CLI: preserve a literal ~ and resolve relative config against workspace cwd.
  const environmentConfigDir = environment.CLAUDE_CONFIG_DIR?.trim() ?? "";
  if (environmentConfigDir.length > 0) {
    return cwd ? path.resolve(cwd, environmentConfigDir) : path.resolve(environmentConfigDir);
  }
  return path.join(home, ".claude");
});

const SettingsEnv = Schema.Struct({
  ANTHROPIC_BASE_URL: Schema.optional(Schema.String),
  CLAUDE_CODE_ENTRYPOINT: Schema.optional(Schema.String),
  // Unquoted JSON values must not fail the decode and drop ANTHROPIC_BASE_URL with them.
  CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: Schema.optional(Schema.Unknown),
  CLAUDE_CODE_GATEWAY_MODEL_DISCOVERY_TIMEOUT_MS: Schema.optional(Schema.Unknown),
});
const decodeSettingsEnv = Schema.decodeUnknownEffect(
  fromLenientJson(Schema.Struct({ env: Schema.optional(SettingsEnv) })),
);

/** The `env` values T3 Code reads from Claude's user and managed settings; later files win. */
export const readClaudeSettingsEnv = Effect.fn("readClaudeSettingsEnv")(function* (
  config: Pick<ClaudeSettings, "homePath">,
  cwd: string | undefined,
  environment: NodeJS.ProcessEnv,
): Effect.fn.Return<typeof SettingsEnv.Type, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const configDirPath = yield* resolveClaudeConfigDirPath(config, environment, cwd);
  const settingsEnv: typeof SettingsEnv.Type = {};
  for (const settingsPath of claudeSettingsPaths(
    path,
    configDirPath,
    undefined,
    platform,
    environment,
  )) {
    const contents = yield* fileSystem
      .readFileString(settingsPath)
      .pipe(Effect.orElseSucceed(() => undefined));
    if (contents === undefined) continue;
    const parsed = yield* decodeSettingsEnv(contents).pipe(Effect.orElseSucceed(() => undefined));
    Object.assign(settingsEnv, parsed?.env);
  }
  return settingsEnv;
});

// Claude's --add-dir is repeatable and variadic; parseCliArgs keeps only one value.
export function claudeLaunchArgDirectories(launchArgs?: string): ReadonlyArray<string> {
  const directories: string[] = [];
  let collecting = false;
  for (const token of tokenizeCliArgs(launchArgs)) {
    if (token === "--") break;
    if (token === "--add-dir") {
      collecting = true;
    } else if (token.startsWith("--add-dir=")) {
      directories.push(token.slice("--add-dir=".length));
      collecting = false;
    } else if (token.startsWith("-")) {
      collecting = false;
    } else if (collecting) {
      directories.push(token);
    }
  }
  return directories;
}

/** First name wins, matching Claude Code's precedence of user skills over project skills. */
export const discoverClaudeSkills = Effect.fn("discoverClaudeSkills")(function* (
  config: Pick<ClaudeSettings, "homePath"> & Partial<Pick<ClaudeSettings, "launchArgs">>,
  cwd?: string,
  environment?: NodeJS.ProcessEnv,
): Effect.fn.Return<ReadonlyArray<ServerProviderSkill>, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const configDirPath = yield* resolveClaudeConfigDirPath(config, environment ?? process.env, cwd);
  const { skillOverrides, enabledPlugins } = yield* readSkillSettings(
    configDirPath,
    cwd,
    environment ?? process.env,
  );

  const roots: ReadonlyArray<ClaudeSkillRoot> = [
    { directory: path.join(configDirPath, "skills"), scope: "user" },
    ...(cwd ? [{ directory: path.join(cwd, ".claude", "skills"), scope: "project" as const }] : []),
    ...claudeLaunchArgDirectories(config.launchArgs)
      .filter((directory) => directory && (cwd || path.isAbsolute(directory)))
      .map((directory) => ({
        directory: path.join(path.resolve(cwd ?? ".", directory), ".claude", "skills"),
        scope: "project" as const,
      })),
    ...(yield* discoverPluginSkillRoots(
      configDirPath,
      cwd,
      enabledPlugins,
      environment ?? process.env,
    )),
  ];

  const skillsByName = new Map<string, ServerProviderSkill>();
  for (const root of roots) {
    const singleSkill =
      root.prefix !== undefined &&
      (yield* fileSystem
        .exists(path.join(root.directory, "SKILL.md"))
        .pipe(Effect.orElseSucceed(() => false)));
    const entries = singleSkill
      ? [path.basename(root.directory)]
      : yield* fileSystem
          .readDirectory(root.directory)
          .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));

    for (const entry of [...entries].sort()) {
      const skillPath = singleSkill
        ? path.join(root.directory, "SKILL.md")
        : path.join(root.directory, entry, "SKILL.md");
      const contents = yield* fileSystem
        .readFileString(skillPath)
        .pipe(Effect.orElseSucceed(() => undefined));
      if (contents === undefined) {
        continue;
      }

      const frontmatter = parseSkillFrontmatter(contents);
      if (frontmatter.kind === "malformed") {
        continue;
      }

      const directoryName = entry.trim();
      if (!directoryName) continue;
      let name = directoryName;
      if (root.prefix) {
        // Native folder skills use their folder; only a single SKILL.md uses its name field.
        const declaredName = singleSkill && frontmatter.kind === "parsed" ? frontmatter.name : "";
        const unprefixedName = declaredName?.startsWith(`${root.prefix}:`)
          ? declaredName.slice(root.prefix.length + 1)
          : declaredName;
        name = `${root.prefix}:${(unprefixedName || entry).replace(/[^a-zA-Z0-9_-]/g, "-")}`;
        // Advertise only exact native names the shared composer grammar can invoke.
        const [mention] = `$${name}`.matchAll(SKILL_MENTION_PATTERN);
        if (mention?.[2] !== name) continue;
      }

      if (skillsByName.has(name)) {
        continue;
      }

      const override = root.prefix ? undefined : skillOverrides.get(name);
      const userInvocationOnly =
        (frontmatter.kind === "parsed" && frontmatter.userInvocationOnly === true) ||
        override?.userInvocationOnly === true;
      skillsByName.set(name, {
        name,
        path: skillPath,
        enabled: override?.enabled ?? true,
        scope: root.scope,
        ...(frontmatter.kind === "parsed" && frontmatter.description
          ? { description: frontmatter.description }
          : {}),
        ...(userInvocationOnly ? { userInvocationOnly: true } : {}),
        ...(frontmatter.kind === "parsed" && frontmatter.userInvocable === false
          ? { userInvocable: false }
          : {}),
      });
    }
  }

  return [...skillsByName.values()].sort((left, right) => left.name.localeCompare(right.name));
});

// The CLI's managed folder, which differs from `claudeManagedSettingsPath` on Windows.
function claudeManagedDirectories(
  path: Path.Path,
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
) {
  const settingsPath = claudeManagedSettingsPath(path, platform, environment);
  const cliDirectory =
    platform === "darwin"
      ? "/Library/Application Support/ClaudeCode"
      : platform === "win32"
        ? "C:\\Program Files\\ClaudeCode"
        : "/etc/claude-code";
  return [...new Set([cliDirectory, ...(settingsPath ? [path.dirname(settingsPath)] : [])])];
}

const CLAUDE_COMMAND_SUBDIRECTORIES = ["commands", "skills", "workflows"];
// Each makes the CLI load commands from somewhere the fingerprint does not walk.
const CLAUDE_COMMAND_SOURCE_REDIRECTS = [
  "CLAUDE_CODE_DESKTOP_SKILLS_PLUGIN_DIR",
  "CLAUDE_CODE_HOST_SKILL_CATALOG",
  "CLAUDE_CODE_MANAGED_SETTINGS_PATH",
  "CLAUDE_CODE_PLUGIN_DIRS",
  "CLAUDE_CODE_PLUGIN_SEED_DIR",
  "CLAUDE_CODE_PLUGIN_USE_ZIP_CACHE",
  "CLAUDE_CODE_REMOTE_SETTINGS_PATH",
  "CLAUDE_CODE_USE_COWORK_PLUGINS",
  "GIT_DIR",
  "GIT_COMMON_DIR",
  "GIT_WORK_TREE",
  "GIT_CEILING_DIRECTORIES",
];
// The CLI rewrites these on its own: `store` on every start, the rest on background syncs.
// Marketplace clones can be huge, and only their manifests, added separately, feed the list.
const CLAUDE_PLUGIN_ROOT_IGNORED = new Set([
  ".last_inuse_sweep",
  "marketplaces",
  "plugin-directory-cache.json",
  "plugin-directory-cache-v2.json",
  "store",
]);
// `.marketplaces.json` is a server listing whose timestamps move constantly; synced plugin files are its siblings.
const CLAUDE_PLUGIN_SYNC_BOOKKEEPING = new Set([".last-complete-round", ".marketplaces.json"]);
// Plugins from these load from the walked cache. A directory marketplace loads them live from
// its own folder, verified against 2.1.316, so anything else is treated as unknowable.
const CLAUDE_CACHED_MARKETPLACE_SOURCES = new Set(["git", "github"]);
// Walking more than this would cost about as much as the probe it avoids.
const MAX_COMMAND_SOURCE_ENTRIES = 2_000;

const encodeMachineState = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const KnownMarketplaces = Schema.fromJsonString(
  Schema.Record(
    Schema.String,
    Schema.Struct({
      source: Schema.Struct({ source: Schema.String }),
      installLocation: Schema.optional(Schema.String),
    }),
  ),
);
const InstalledPluginPaths = Schema.fromJsonString(
  Schema.Struct({
    plugins: Schema.Record(
      Schema.String,
      Schema.Array(Schema.Struct({ installPath: Schema.optional(Schema.String) })),
    ),
  }),
);

/**
 * A digest of local command sources, audited against the 2.1.316 loader and isolated probes.
 * `undefined` means
 * the sources cannot be vouched for, so the caller must probe. Account state and remote flags
 * live outside these files, so callers also pass the health check's view as `machineState`.
 */
export const fingerprintClaudeCommandSources = Effect.fn("fingerprintClaudeCommandSources")(
  function* (
    config: Pick<ClaudeSettings, "homePath">,
    cwd: string,
    environment: NodeJS.ProcessEnv,
    machineState: unknown,
  ): Effect.fn.Return<string | undefined, never, FileSystem.FileSystem | Path.Path> {
    if (CLAUDE_COMMAND_SOURCE_REDIRECTS.some((name) => environment[name] !== undefined)) {
      return undefined;
    }
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const platform = yield* HostProcess.Platform;
    // Windows and WSL also load managed settings from registry keys outside this walk.
    if (
      platform === "win32" ||
      (platform === "linux" &&
        (environment.WSL_DISTRO_NAME !== undefined ||
          environment.WSL_INTEROP !== undefined ||
          /microsoft/i.test(NodeOS.release())))
    ) {
      return undefined;
    }
    const home = yield* HostProcess.HomeDirectory;
    if (environment.HOME !== undefined && environment.HOME !== home) return undefined;
    const configDirPath = yield* resolveClaudeConfigDirPath(config, environment, cwd);
    const pluginsPath = yield* resolveClaudePluginsPath(configDirPath, cwd, environment);
    const hash = NodeCrypto.createHash("sha256").update(encodeMachineState(machineState));
    let remaining = MAX_COMMAND_SOURCE_ENTRIES;

    // Untraced: this runs per directory entry, so spans would swamp the trace.
    const addStat: (
      entry: string,
      ignored?: (child: string, parent: string) => boolean,
    ) => Effect.Effect<void, PlatformError.PlatformError | "tooManyEntries"> = Effect.fnUntraced(
      function* (entry: string, ignored?: (child: string, parent: string) => boolean) {
        remaining -= 1;
        if (remaining < 0) return yield* Effect.fail("tooManyEntries" as const);
        const info = yield* fileSystem
          .stat(entry)
          .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.undefined));
        if (info === undefined) {
          hash.update(`${entry}\0absent\n`);
          return;
        }
        if (info.type !== "Directory") {
          const modified = Option.getOrNull(Option.map(info.mtime, (date) => date.getTime()));
          hash.update(`${entry}\0${info.type}\0${info.size}\0${modified}\n`);
          return;
        }
        hash.update(`${entry}\0dir\n`);
        const children = yield* fileSystem.readDirectory(entry);
        for (const child of [...children].sort()) {
          if (!ignored?.(child, entry)) yield* addStat(path.join(entry, child), ignored);
        }
      },
    );
    // Contents, not a stat: settings may name a redirect, which disables the fingerprint.
    const addSettings = Effect.fnUntraced(function* (settingsPath: string) {
      const contents = yield* fileSystem
        .readFileString(settingsPath)
        .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.undefined));
      if (
        /\\u[0-9a-f]{4}/i.test(contents ?? "") ||
        ["CLAUDE_CONFIG_DIR", "HOME", "USERPROFILE", "additionalDirectories", "policyHelpers"].some(
          (name) => contents?.includes(name),
        ) ||
        contents?.includes("CLAUDE_CODE_PLUGIN_CACHE_DIR") ||
        CLAUDE_COMMAND_SOURCE_REDIRECTS.some((name) => contents?.includes(name))
      ) {
        return yield* Effect.fail("redirected" as const);
      }
      hash.update(`${settingsPath}\0${contents ?? "absent"}\0`);
    });
    const readPluginRecord = <A>(file: string, schema: Schema.Codec<A, string>) =>
      fileSystem.readFileString(path.join(pluginsPath, file)).pipe(
        Effect.catchReason("PlatformError", "NotFound", () => Effect.undefined),
        Effect.flatMap((contents) =>
          contents === undefined ? Effect.undefined : Schema.decodeEffect(schema)(contents),
        ),
      );

    const walk = Effect.gen(function* () {
      // The CLI's cwd has symlinks resolved. It searches upward, stopping before home and at the repository root.
      const workspace = yield* fileSystem.realPath(cwd);
      const repositoryRoot = yield* findRepositoryRoot(workspace);
      const projectDirectories = new Set<string>();
      for (let current = workspace; current !== home; current = path.dirname(current)) {
        projectDirectories.add(current);
        if (current === repositoryRoot || current === path.dirname(current)) break;
      }
      // A linked worktree also loads commands and skills from its main repository.
      const mainRepository = yield* findPluginRepositoryRoot(workspace);
      if (mainRepository !== undefined) projectDirectories.add(mainRepository);

      for (const directory of projectDirectories) {
        yield* addSettings(path.join(directory, ".claude", "settings.json"));
        yield* addSettings(path.join(directory, ".claude", "settings.local.json"));
        for (const subdirectory of CLAUDE_COMMAND_SUBDIRECTORIES) {
          yield* addStat(path.join(directory, ".claude", subdirectory));
        }
      }

      yield* addSettings(path.join(configDirPath, "settings.json"));
      for (const subdirectory of [...CLAUDE_COMMAND_SUBDIRECTORIES, "synced"]) {
        yield* addStat(path.join(configDirPath, subdirectory));
      }
      yield* addStat(path.join(configDirPath, "policy-limits.json"));

      for (const directory of claudeManagedDirectories(path, platform, environment)) {
        yield* addSettings(path.join(directory, "managed-settings.json"));
        const managedSettingsDirectory = path.join(directory, "managed-settings.d");
        yield* addStat(managedSettingsDirectory);
        const managedSettingsFiles = yield* fileSystem
          .readDirectory(managedSettingsDirectory)
          .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed([])));
        for (const file of managedSettingsFiles
          .filter((file) => file.endsWith(".json") && !file.startsWith("."))
          .sort()) {
          yield* addSettings(path.join(managedSettingsDirectory, file));
        }
        for (const subdirectory of CLAUDE_COMMAND_SUBDIRECTORIES) {
          yield* addStat(path.join(directory, ".claude", subdirectory));
        }
      }
      // Remote policy also depends on signatures and consent, not just the settings bytes.
      for (const settingsPath of [
        path.join(configDirPath, "remote-settings.json"),
        ...(platform === "darwin"
          ? [
              `/Library/Managed Preferences/${NodeOS.userInfo().username}/com.anthropic.claudecode.plist`,
              "/Library/Managed Preferences/com.anthropic.claudecode.plist",
            ]
          : []),
      ]) {
        const info = yield* fileSystem
          .stat(settingsPath)
          .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.undefined));
        if (info !== undefined) return yield* Effect.fail("redirected" as const);
      }

      yield* addStat(
        pluginsPath,
        (child, parent) =>
          CLAUDE_PLUGIN_SYNC_BOOKKEEPING.has(child) ||
          (parent === pluginsPath && CLAUDE_PLUGIN_ROOT_IGNORED.has(child)),
      );
      const installed = yield* readPluginRecord("installed_plugins.json", InstalledPluginPaths);
      for (const installs of Object.values(installed?.plugins ?? {})) {
        for (const { installPath } of installs) {
          if (
            installPath !== undefined &&
            (!isInsideDirectory(path, pluginsPath, path.resolve(workspace, installPath)) ||
              path.resolve(workspace, installPath) === pluginsPath ||
              CLAUDE_PLUGIN_ROOT_IGNORED.has(
                path
                  .relative(pluginsPath, path.resolve(workspace, installPath))
                  .split(path.sep)[0] ?? "",
              ))
          ) {
            return yield* Effect.fail("pluginOutsideCache" as const);
          }
        }
      }
      const marketplaces = yield* readPluginRecord("known_marketplaces.json", KnownMarketplaces);
      for (const { source, installLocation } of Object.values(marketplaces ?? {})) {
        if (!CLAUDE_CACHED_MARKETPLACE_SOURCES.has(source.source)) {
          return yield* Effect.fail("liveMarketplace" as const);
        }
        if (installLocation !== undefined) {
          yield* addStat(path.join(installLocation, ".claude-plugin", "marketplace.json"));
        }
      }
      return hash.digest("hex");
    });
    return yield* walk.pipe(Effect.orElseSucceed(() => undefined));
  },
);
