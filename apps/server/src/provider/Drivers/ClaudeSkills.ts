import type { ClaudeSettings, ServerProviderSkill } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";
import { fromLenientJson } from "@t3tools/shared/schemaJson";
import { SKILL_MENTION_PATTERN } from "@t3tools/shared/composerInlineTokens";
import { parse as parseYamlDocument } from "yaml";

import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";

import { claudeAccountConfigPath, readClaudeOauthAccount } from "../claudeResetCredits.ts";
import { parseGitfileTarget } from "../../project/worktreeContainer.ts";

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

// A caller-supplied environment is a plain object, without Windows' case-insensitive keys.
function windowsEnvironmentValue(environment: NodeJS.ProcessEnv, name: string) {
  const key = name.toLowerCase();
  return Object.entries(environment)
    .find(([candidate]) => candidate.toLowerCase() === key)?.[1]
    ?.trim();
}

function claudeManagedDirectory(
  path: Path.Path,
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
): string | undefined {
  if (platform === "darwin") {
    return "/Library/Application Support/ClaudeCode";
  }
  if (platform === "win32") {
    const programFiles = windowsEnvironmentValue(environment, "ProgramFiles");
    return programFiles ? path.join(programFiles, "ClaudeCode") : undefined;
  }
  return "/etc/claude-code";
}

function claudeManagedSettingsPaths(
  path: Path.Path,
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
): ReadonlyArray<string> {
  const managedDirectory = claudeManagedDirectory(path, platform, environment);
  const programData =
    platform === "win32" ? windowsEnvironmentValue(environment, "ProgramData") : undefined;
  return [
    ...(programData ? [path.join(programData, "ClaudeCode", "managed-settings.json")] : []),
    ...(managedDirectory ? [path.join(managedDirectory, "managed-settings.json")] : []),
  ];
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
    ...claudeManagedSettingsPaths(path, platform, environment),
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
  const gitFileTarget = parseGitfileTarget(gitFile);
  if (gitFileTarget === undefined) return root;
  const gitDirectory = path.resolve(root, gitFileTarget);
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
    syncClaudeAiPlugins: Schema.optional(Schema.Unknown),
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
  const managedPluginNames = new Set<string>();
  const managedPaths = new Set(claudeManagedSettingsPaths(path, platform, environment));
  let syncedPluginsHidden = false;
  const repositoryRoot = cwd === undefined ? undefined : yield* findRepositoryRoot(cwd);
  const projectSettingsPath =
    cwd === undefined ? undefined : path.join(cwd, ".claude", "settings.json");

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
        if (managedPaths.has(settingsPath) && key.includes("@")) {
          managedPluginNames.add(pluginNameKey(key.slice(0, key.indexOf("@"))));
        }
      } else {
        // Extended formats replace lower-precedence values without enabling the plugin here.
        enabledPlugins.delete(key);
      }
    }
    // Claude ignores this switch in shared project settings, and honors only false.
    if (parsed?.syncClaudeAiPlugins === false && settingsPath !== projectSettingsPath) {
      syncedPluginsHidden = true;
    }
  }

  return {
    skillOverrides: overridesByName,
    enabledPlugins,
    managedPluginNames,
    syncedPluginsHidden,
  };
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
    defaultEnabled: Schema.optional(Schema.Unknown),
  }),
);
const KnownMarketplaces = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown));
const decodeKnownMarketplace = Schema.decodeUnknownOption(
  Schema.Struct({ installLocation: Schema.NonEmptyString }),
);
const MarketplaceManifest = Schema.fromJsonString(
  Schema.Struct({ plugins: Schema.Array(Schema.Unknown) }),
);
const decodeMarketplaceEntry = Schema.decodeUnknownOption(
  Schema.Struct({
    name: Schema.String,
    source: Schema.Unknown,
    skills: Schema.optional(Schema.Union([Schema.String, Schema.Array(Schema.String)])),
  }),
);

const SyncedPlugins = Schema.fromJsonString(
  Schema.Struct({ plugins: Schema.Array(Schema.Unknown) }),
);
const decodeSyncedPlugin = Schema.decodeUnknownOption(
  Schema.Struct({
    pluginId: Schema.String,
    name: Schema.String,
    generation: Schema.optional(Schema.Number),
  }),
);
const ACCOUNT_UUID_PATTERN = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

/** Claude compares plugin names case-insensitively. */
function pluginNameKey(name: string): string {
  return name.normalize("NFC").toLowerCase();
}

/** Claude's folder for a synced row: reserved characters become `_`, trailing dots and spaces go. */
function syncedPluginDirectoryName(name: string): string {
  const replaced = name.replace(/[<>:"|?*\\/]/g, "_");
  let end = replaced.length;
  while (end > 0 && (replaced[end - 1] === "." || replaced[end - 1] === " ")) end--;
  return replaced.slice(0, end);
}

function isInsideDirectory(path: Path.Path, directory: string, candidate: string): boolean {
  const relative = path.relative(directory, candidate);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

const readPluginManifest = Effect.fn("readPluginManifest")(function* (pluginPath: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return yield* fileSystem
    .readFileString(path.join(pluginPath, ".claude-plugin", "plugin.json"))
    .pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(PluginManifest)),
      Effect.orElseSucceed(() => undefined),
    );
});

/** Declared skill folders that exist inside the install, through symlinks too, as the native loader requires. */
const containedSkillDirectories = Effect.fn("containedSkillDirectories")(function* (
  installPath: string,
  declared: ReadonlyArray<string>,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const canonicalInstallPath = yield* fileSystem
    .realPath(installPath)
    .pipe(Effect.orElseSucceed(() => undefined));
  const directories: Array<string> = [];
  for (const relative of declared) {
    const directory = path.resolve(installPath, relative);
    if (!isInsideDirectory(path, installPath, directory) || canonicalInstallPath === undefined) {
      continue;
    }
    const canonicalDirectory = yield* fileSystem
      .realPath(directory)
      .pipe(Effect.orElseSucceed(() => undefined));
    if (
      canonicalDirectory !== undefined &&
      isInsideDirectory(path, canonicalInstallPath, canonicalDirectory)
    ) {
      directories.push(directory);
    }
  }
  return directories;
});

const pluginSkillRoots = Effect.fn("pluginSkillRoots")(function* (
  installPath: string,
  scope: ClaudeSkillScope,
  prefix: string,
  manifest: typeof PluginManifest.Type | undefined,
  entrySkills?: ReadonlyArray<string>,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const defaultDirectory = path.join(installPath, "skills");
  // A root-sourced marketplace entry's skills list replaces the plugin's skills; `./` means skills/.
  const entryDirectories =
    entrySkills === undefined ? [] : yield* containedSkillDirectories(installPath, entrySkills);
  if (entryDirectories.length > 0) {
    return entryDirectories.map((directory) => ({
      directory: directory === installPath ? defaultDirectory : directory,
      scope,
      prefix,
    }));
  }
  const roots: Array<ClaudeSkillRoot> = [];
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
  const declaredDirectories = yield* containedSkillDirectories(
    installPath,
    typeof declared === "string" ? [declared] : (declared ?? []),
  );
  for (const directory of declaredDirectories) roots.push({ directory, scope, prefix });
  return roots;
});

/** The `<org>_<account>` folder Claude syncs the signed-in account's claude.ai plugins into. */
const resolveSyncedPluginBucket = Effect.fn("resolveSyncedPluginBucket")(function* (
  config: Pick<ClaudeSettings, "homePath">,
  configDirPath: string,
  environment: NodeJS.ProcessEnv,
) {
  const accountConfigPath = yield* claudeAccountConfigPath(
    config.homePath.trim() || environment.CLAUDE_CONFIG_DIR?.trim() ? configDirPath : undefined,
  );
  const account = yield* readClaudeOauthAccount(accountConfigPath);
  const organizationId = environment.CLAUDE_CODE_ORGANIZATION_UUID ?? account?.organizationUuid;
  // A stored claude.ai login names its own account; an injected token uses the env account.
  const environmentAccountId = environment.CLAUDE_CODE_ACCOUNT_UUID;
  const accountId =
    account !== undefined && !environment.CLAUDE_CODE_OAUTH_TOKEN
      ? typeof account.accountUuid === "string"
        ? account.accountUuid
        : undefined
      : environmentAccountId && ACCOUNT_UUID_PATTERN.test(environmentAccountId)
        ? environmentAccountId
        : "unbound";
  if (
    !organizationId ||
    !accountId ||
    !ACCOUNT_UUID_PATTERN.test(organizationId) ||
    (accountId !== "unbound" && !ACCOUNT_UUID_PATTERN.test(accountId))
  ) {
    return undefined;
  }
  return `${organizationId.toLowerCase()}_${accountId.toLowerCase()}`;
});

/** A plugin folder itself, or else the manifest-bearing plugins directly inside it. */
const expandInlinePluginDirectory = Effect.fn("expandInlinePluginDirectory")(function* (
  directory: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const exists = (candidate: string) =>
    fileSystem.exists(candidate).pipe(Effect.orElseSucceed(() => false));
  for (const component of [path.join(".claude-plugin", "plugin.json"), "skills", "SKILL.md"]) {
    if (yield* exists(path.join(directory, component))) return [directory];
  }
  const children = yield* fileSystem
    .readDirectory(directory)
    .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
  return yield* Effect.filter(
    [...children].sort().map((child) => path.join(directory, child)),
    (child) => exists(path.join(child, ".claude-plugin", "plugin.json")),
  );
});

/**
 * Plugin folders Claude Code loads inline, from --plugin-dir launch arguments and then
 * CLAUDE_CODE_PLUGIN_DIRS, and their plugin names.
 */
const discoverInlinePluginSkillRoots = Effect.fn("discoverInlinePluginSkillRoots")(function* (
  launchArgPluginDirectories: ReadonlyArray<string>,
  environmentPluginDirectories: string | undefined,
  cwd: string | undefined,
  enabledPlugins: ReadonlyMap<string, boolean>,
  managedPluginNames: ReadonlySet<string>,
) {
  const path = yield* Path.Path;
  const home = yield* HostProcess.HomeDirectory;
  const platform = yield* HostProcess.Platform;
  const roots: Array<ClaudeSkillRoot> = [];
  const names = new Set<string>();
  const seen = new Set<string>();
  const directories = [
    // Claude resolves a relative --plugin-dir against its cwd and expands no `~` in it.
    ...launchArgPluginDirectories
      .filter((directory) => directory && (cwd || path.isAbsolute(directory)))
      .map((directory) => path.resolve(cwd ?? ".", directory)),
    // Claude skips relative CLAUDE_CODE_PLUGIN_DIRS entries rather than resolving them.
    ...(environmentPluginDirectories ?? "")
      .split(platform === "win32" ? ";" : ":")
      .map((entry) => expandHomePath(entry.trim(), home))
      .filter((directory) => directory && path.isAbsolute(directory))
      .map((directory) => path.resolve(directory)),
  ];
  for (const directory of directories) {
    for (const installPath of yield* expandInlinePluginDirectory(directory)) {
      if (seen.has(installPath)) continue;
      seen.add(installPath);
      const manifest = yield* readPluginManifest(installPath);
      const prefix = manifest?.name ?? path.basename(installPath);
      // A `<name>@inline` setting wins; otherwise the manifest's `defaultEnabled` decides.
      const setting = enabledPlugins.get(`${prefix}@inline`);
      if (setting === false || (setting === undefined && manifest?.defaultEnabled === false)) {
        continue;
      }
      // Managed enabledPlugins entries, true or false, lock the name against inline copies.
      if (managedPluginNames.has(pluginNameKey(prefix))) continue;
      names.add(pluginNameKey(prefix));
      roots.push(...(yield* pluginSkillRoots(installPath, "user", prefix, manifest)));
    }
  }
  return { roots, names };
});

const discoverPluginSkillRoots = Effect.fn("discoverPluginSkillRoots")(function* (
  configDirPath: string,
  cwd: string | undefined,
  enabledPlugins: ReadonlyMap<string, boolean>,
  inlinePluginNames: ReadonlySet<string>,
  syncedBucket: string | undefined,
  environment: NodeJS.ProcessEnv,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* HostProcess.HomeDirectory;
  const pluginDirectory = environment.CLAUDE_CODE_PLUGIN_CACHE_DIR;
  const pluginsPath = pluginDirectory
    ? path.resolve(cwd ?? ".", expandHomePath(pluginDirectory, home))
    : path.join(configDirPath, "plugins");
  const installed = yield* fileSystem
    .readFileString(path.join(pluginsPath, "installed_plugins.json"))
    .pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(InstalledPlugins)),
      Effect.orElseSucceed(() => undefined),
    );
  const roots: Array<ClaudeSkillRoot> = [];
  // An enabled inline plugin replaces installed and synced plugins of the same name.
  const claimedPluginNames = new Set(inlinePluginNames);
  // The CLI's process.cwd() resolves symlinks; registry projectPath values remain lexical.
  const workspace =
    cwd === undefined
      ? undefined
      : yield* fileSystem.realPath(cwd).pipe(Effect.orElseSucceed(() => path.resolve(cwd)));
  // Install records repeat project paths, often hundreds of times per discovery.
  const projectRepositoryRoots = new Map<string, string | undefined>();
  const repositoryRoot =
    workspace === undefined ? undefined : yield* findPluginRepositoryRoot(workspace);
  const knownMarketplaces = yield* fileSystem
    .readFileString(path.join(pluginsPath, "known_marketplaces.json"))
    .pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(KnownMarketplaces)),
      Effect.orElseSucceed((): Record<string, unknown> => ({})),
    );
  const marketplaceEntries = new Map<string, ReadonlyArray<unknown>>();
  // Claude applies an entry's skills list only when the entry's source is the marketplace root.
  const readRootEntrySkills = Effect.fnUntraced(function* (marketplace: string, plugin: string) {
    if (!marketplaceEntries.has(marketplace)) {
      const location = Option.getOrUndefined(
        decodeKnownMarketplace(knownMarketplaces[marketplace]),
      )?.installLocation;
      const manifest =
        location === undefined
          ? undefined
          : yield* fileSystem
              .readFileString(path.join(location, ".claude-plugin", "marketplace.json"))
              .pipe(
                Effect.flatMap(Schema.decodeUnknownEffect(MarketplaceManifest)),
                Effect.orElseSucceed(() => undefined),
              );
      marketplaceEntries.set(marketplace, manifest?.plugins ?? []);
    }
    const entry = (marketplaceEntries.get(marketplace) ?? [])
      .flatMap((candidate) => Option.toArray(decodeMarketplaceEntry(candidate)))
      .find((candidate) => candidate.name === plugin);
    if (
      entry?.skills === undefined ||
      typeof entry.source !== "string" ||
      !entry.source.split(/[\\/]/).every((segment) => segment === "" || segment === ".")
    ) {
      return undefined;
    }
    return typeof entry.skills === "string" ? [entry.skills] : entry.skills;
  });

  for (const [key, entries] of Object.entries(installed?.plugins ?? {}).sort()) {
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
    const manifest = yield* readPluginManifest(installPath);
    const prefix = manifest?.name ?? key.split("@")[0];
    if (!prefix || inlinePluginNames.has(pluginNameKey(prefix))) continue;
    // A registry record whose install is gone loads nothing and claims no namespace.
    if (Option.isSome(existing)) claimedPluginNames.add(pluginNameKey(prefix));
    const separator = key.lastIndexOf("@");
    const entrySkills =
      separator > 0
        ? yield* readRootEntrySkills(key.slice(separator + 1), key.slice(0, separator))
        : undefined;
    roots.push(...(yield* pluginSkillRoots(installPath, scope, prefix, manifest, entrySkills)));
  }
  if (syncedBucket === undefined) return roots;

  const syncedPath = path.join(configDirPath, "plugins", "synced");
  const bucketPath = path.join(syncedPath, syncedBucket);
  const disabledSyncedPlugins = new Set(
    [...enabledPlugins].flatMap(([pluginKey, enabled]) =>
      !enabled && pluginKey.endsWith("@synced") ? [pluginNameKey(pluginKey.slice(0, -7))] : [],
    ),
  );
  const hasBucketMarker = yield* fileSystem
    .exists(path.join(syncedPath, `.bucket-${syncedBucket}`))
    .pipe(Effect.orElseSucceed(() => false));
  if (!hasBucketMarker) return roots;
  const synced = yield* fileSystem.readFileString(path.join(bucketPath, "manifest.json")).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(SyncedPlugins)),
    Effect.orElseSucceed(() => undefined),
  );
  for (const row of synced?.plugins ?? []) {
    const plugin = Option.getOrUndefined(decodeSyncedPlugin(row));
    const directoryName = plugin === undefined ? "" : syncedPluginDirectoryName(plugin.name);
    if (!plugin || !directoryName || directoryName.startsWith(".")) continue;
    const generation = plugin.generation;
    const pluginPath = path.join(
      bucketPath,
      generation !== undefined && Number.isInteger(generation) && generation >= 2
        ? `${directoryName}~g${generation}`
        : directoryName,
    );
    const manifest = yield* readPluginManifest(pluginPath);
    const prefix = manifest?.name ?? directoryName;
    // An installed plugin of the same name, then the first synced row, holds the namespace.
    const key = pluginNameKey(prefix);
    if (claimedPluginNames.has(key) || disabledSyncedPlugins.has(key)) continue;
    claimedPluginNames.add(key);
    roots.push(...(yield* pluginSkillRoots(pluginPath, "user", prefix, manifest)));
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

const authOverrideKeys = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_API_KEY_HELPER",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
  "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
] as const;

const hasAuthEnvironment = (environment: Readonly<Record<string, unknown>>) =>
  authOverrideKeys.some((key) => {
    const value = environment[key];
    return typeof value === "string" ? Boolean(value.trim()) : Boolean(value);
  });

const decodeAuthSettings = Schema.decodeUnknownEffect(
  fromLenientJson(
    Schema.Struct({
      apiKeyHelper: Schema.optional(Schema.String),
      env: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
    }),
  ),
);

export const hasClaudeAuthenticationOverride = Effect.fn("hasClaudeAuthenticationOverride")(
  function* (
    config: Pick<ClaudeSettings, "homePath">,
    cwd: string | undefined,
    environment: NodeJS.ProcessEnv,
  ) {
    if (hasAuthEnvironment(environment)) return true;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const platform = yield* HostProcess.Platform;
    const configDir = yield* resolveClaudeConfigDirPath(config, environment, cwd);
    const root = cwd === undefined ? undefined : yield* findRepositoryRoot(cwd);
    for (const file of claudeSettingsPaths(path, configDir, cwd, platform, environment, root)) {
      const settings = yield* fileSystem.readFileString(file).pipe(
        Effect.flatMap(decodeAuthSettings),
        Effect.orElseSucceed(() => undefined),
      );
      if (settings?.apiKeyHelper?.trim() || hasAuthEnvironment(settings?.env ?? {})) return true;
    }
    return false;
  },
);

const SettingsEnv = Schema.Struct({
  ANTHROPIC_BASE_URL: Schema.optional(Schema.String),
  CLAUDE_CODE_ENTRYPOINT: Schema.optional(Schema.String),
  CLAUDE_CODE_PLUGIN_DIRS: Schema.optional(Schema.String),
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

const decodeSettingsRecord = Schema.decodeUnknownEffect(
  fromLenientJson(Schema.Record(Schema.String, Schema.Unknown)),
);

/** Claude's user settings file as written; undefined when it is missing or not a JSON object. */
export const readClaudeUserSettings = Effect.fn("readClaudeUserSettings")(function* (
  config: Pick<ClaudeSettings, "homePath">,
  cwd: string | undefined,
  environment: NodeJS.ProcessEnv,
): Effect.fn.Return<Record<string, unknown> | undefined, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const configDirPath = yield* resolveClaudeConfigDirPath(config, environment, cwd);
  return yield* fileSystem.readFileString(path.join(configDirPath, "settings.json")).pipe(
    Effect.flatMap(decodeSettingsRecord),
    Effect.orElseSucceed(() => undefined),
  );
});

/** The host of an `ANTHROPIC_BASE_URL` that is not Anthropic's own API. */
export function customClaudeApiEndpointHost(baseUrl: string | undefined): string | undefined {
  const endpoint = URL.parse(baseUrl?.trim() ?? "");
  return endpoint !== null &&
    (endpoint.protocol === "http:" || endpoint.protocol === "https:") &&
    endpoint.hostname !== "" &&
    endpoint.hostname !== "api.anthropic.com"
    ? endpoint.hostname
    : undefined;
}

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

// The Claude CLI takes the next token as this flag's value even when it starts with `--`.
export const claudeLaunchArgParseOptions = { valueFlags: ["append-system-prompt"] };

// Claude's --plugin-dir is repeatable; parseCliArgs keeps only the last one.
export function claudeLaunchArgPluginDirectories(launchArgs?: string): ReadonlyArray<string> {
  const tokens = tokenizeCliArgs(launchArgs);
  const directories: string[] = [];
  for (let index = 0; index < tokens.length && tokens[index] !== "--"; index++) {
    const token = tokens[index]!;
    if (!token.startsWith("--") || token.includes("=")) {
      if (token.startsWith("--plugin-dir=")) directories.push(token.slice("--plugin-dir=".length));
      continue;
    }
    const next = tokens[index + 1];
    const takesNext =
      next !== undefined &&
      (!next.startsWith("--") || claudeLaunchArgParseOptions.valueFlags.includes(token.slice(2)));
    if (!takesNext) continue;
    if (token === "--plugin-dir") directories.push(next);
    index++;
  }
  return directories;
}

/** First name wins: managed skills, then user skills, then project skills. */
export const discoverClaudeSkills = Effect.fn("discoverClaudeSkills")(function* (
  config: Pick<ClaudeSettings, "homePath"> & Partial<Pick<ClaudeSettings, "launchArgs">>,
  cwd?: string,
  environment?: NodeJS.ProcessEnv,
): Effect.fn.Return<ReadonlyArray<ServerProviderSkill>, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const env = environment ?? process.env;
  const configDirPath = yield* resolveClaudeConfigDirPath(config, env, cwd);
  const { skillOverrides, enabledPlugins, managedPluginNames, syncedPluginsHidden } =
    yield* readSkillSettings(configDirPath, cwd, env);
  const managedDirectory = claudeManagedDirectory(path, yield* HostProcess.Platform, env);
  // Most installs have no synced folder; skip reading `.claude.json` for them.
  const hasSyncedPlugins =
    !syncedPluginsHidden &&
    (yield* fileSystem
      .exists(path.join(configDirPath, "plugins", "synced"))
      .pipe(Effect.orElseSucceed(() => false)));
  const syncedBucket = hasSyncedPlugins
    ? yield* resolveSyncedPluginBucket(config, configDirPath, env)
    : undefined;
  // Claude applies its settings `env` over the inherited environment.
  const inlinePluginDirectories =
    (yield* readClaudeSettingsEnv(config, cwd, env)).CLAUDE_CODE_PLUGIN_DIRS ??
    env.CLAUDE_CODE_PLUGIN_DIRS;
  const inlinePlugins = yield* discoverInlinePluginSkillRoots(
    claudeLaunchArgPluginDirectories(config.launchArgs),
    inlinePluginDirectories,
    cwd,
    enabledPlugins,
    managedPluginNames,
  );

  const roots: ReadonlyArray<ClaudeSkillRoot> = [
    ...(managedDirectory
      ? [{ directory: path.join(managedDirectory, ".claude", "skills"), scope: "user" as const }]
      : []),
    { directory: path.join(configDirPath, "skills"), scope: "user" },
    ...(cwd ? [{ directory: path.join(cwd, ".claude", "skills"), scope: "project" as const }] : []),
    ...claudeLaunchArgDirectories(config.launchArgs)
      .filter((directory) => directory && (cwd || path.isAbsolute(directory)))
      .map((directory) => ({
        directory: path.join(path.resolve(cwd ?? ".", directory), ".claude", "skills"),
        scope: "project" as const,
      })),
    ...inlinePlugins.roots,
    ...(yield* discoverPluginSkillRoots(
      configDirPath,
      cwd,
      enabledPlugins,
      inlinePlugins.names,
      syncedBucket,
      env,
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
