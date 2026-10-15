/**
 * ClaudeSkills — filesystem discovery of Claude Code skills for the `$` picker.
 *
 * Claude Code loads skills from `<config dir>/skills` (user scope) and
 * `<cwd>/.claude/skills` (project scope), one directory per skill with a
 * `SKILL.md` carrying YAML frontmatter. The user root wins on name collisions,
 * matching the CLI. `.agents/skills` is a Codex location: verified against the
 * CLI, a skill that lives only there is answered with `Unknown command`, so it
 * is not scanned here.
 * Enabled installed plugins contribute namespaced skills from their install's
 * `skills/` directory and manifest-declared directories.
 * The Agent SDK init handshake surfaces skills only as slash commands without
 * their filesystem paths, so the provider snapshot scans the same locations
 * directly, mirroring how the Codex app-server reports its skills.
 *
 * @module provider/Drivers/ClaudeSkills
 */

import type { ClaudeSettings, ServerProviderSkill } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { fromLenientJson } from "@t3tools/shared/schemaJson";
import { parse as parseYamlDocument } from "yaml";

import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";

type ClaudeSkillScope = "user" | "project";

type ClaudeSkillRoot = {
  readonly directory: string;
  readonly scope: ClaudeSkillScope;
  readonly prefix?: string;
  readonly singleSkill?: boolean;
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

/**
 * Claude Code accepts the YAML 1.1 boolean spellings (`yes`/`no`, `on`/`off`,
 * `1`/`0`), which the 1.2 core schema this parser uses leaves as strings and
 * numbers. Verified against the CLI: a skill carrying `user-invocable: no` is
 * absent from its published slash commands, so a strict `=== false` here would
 * offer a command the CLI rejects.
 */
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
    // Claude Code accepts plain scalars containing `: `. Repair only those,
    // leaving comments and YAML structure for the full-document parser.
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

/**
 * Where an administrator installs the policy file whose settings outrank every
 * user and project one. Absent on almost every machine, which is why a missing
 * file is the normal case rather than an error.
 */
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

/**
 * Settings files Claude Code merges for `skillOverrides`, in increasing
 * precedence: user, project, project-local, then the administrator's managed
 * policy, which wins outright. When the workspace sits inside a git
 * repository, the repository root's `settings.local.json` is read too and
 * outranks the workspace's own local file. Verified against the CLI from a
 * nested cwd: a root local file switching a skill off wins over a cwd one
 * switching it on, the root's plain `settings.json` is not consulted, and
 * without a `.git` above the cwd no root file is read. A skill the user
 * switched off is reported disabled rather than dropped, so the picker can
 * grey it out instead of silently losing it.
 */
export function skillOverrideSettingsPaths(
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

/**
 * Nearest ancestor of `cwd` (inclusive) holding a `.git` entry, which is the
 * boundary Claude Code walks up to for project settings. `undefined` outside
 * a repository.
 */
const findRepositoryRoot = Effect.fn("findRepositoryRoot")(function* (
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

/**
 * The four states Claude Code accepts. The CLI validates the whole map, not
 * each entry: verified against it, one entry with an unknown value (or a
 * boolean) makes it drop every override in that file, so this schema does the
 * same rather than applying the valid siblings the CLI ignores.
 */
const SkillOverrideValue = Schema.Literals(["on", "name-only", "user-invocable-only", "off"]);

// Lenient because these settings files are hand-edited and Claude Code itself
// tolerates comments and trailing commas in them.
const SkillOverrideSettings = fromLenientJson(
  Schema.Struct({
    skillOverrides: Schema.optional(Schema.Record(Schema.String, SkillOverrideValue)),
  }),
);
const decodeSkillOverrideSettings = Schema.decodeUnknownEffect(SkillOverrideSettings);
const decodeEnabledPluginSettings = Schema.decodeUnknownEffect(
  fromLenientJson(
    Schema.Struct({
      enabledPlugins: Schema.optional(Schema.Record(Schema.String, Schema.Boolean)),
    }),
  ),
);

/**
 * What a `skillOverrides` entry says about one skill. `"user-invocable-only"`
 * hides it from the agent exactly as `disable-model-invocation` does, so it is
 * kept apart from a plain on/off decision rather than collapsed into one.
 */
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

  for (const settingsPath of skillOverrideSettingsPaths(
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

    const parsed = yield* decodeSkillOverrideSettings(contents).pipe(
      Effect.tapError((cause) =>
        Effect.logDebug("claude settings file is unreadable; ignoring skillOverrides", {
          path: settingsPath,
          cause,
        }),
      ),
      Effect.orElseSucceed(() => undefined),
    );
    for (const [name, value] of Object.entries(parsed?.skillOverrides ?? {})) {
      overridesByName.set(name, parseSkillOverride(value));
    }
    // Decode independently: an invalid skillOverrides map must not discard
    // the plugin enablement in the same settings file.
    const pluginSettings = yield* decodeEnabledPluginSettings(contents).pipe(
      Effect.orElseSucceed(() => undefined),
    );
    for (const [key, enabled] of Object.entries(pluginSettings?.enabledPlugins ?? {})) {
      enabledPlugins.set(key, enabled);
    }
  }

  return { skillOverrides: overridesByName, enabledPlugins };
});

const InstalledPlugins = Schema.fromJsonString(
  Schema.Struct({ plugins: Schema.Record(Schema.String, Schema.Array(Schema.Unknown)) }),
);
const decodeInstalledPlugin = Schema.decodeUnknownOption(
  Schema.Struct({
    scope: Schema.Literals(["user", "project", "local"]),
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

/** Installed plugin records are authoritative; marketplace catalogs include uninstalled plugins. */
const discoverPluginSkillRoots = Effect.fn("discoverPluginSkillRoots")(function* (
  configDirPath: string,
  cwd: string | undefined,
  enabledPlugins: ReadonlyMap<string, boolean>,
): Effect.fn.Return<ReadonlyArray<ClaudeSkillRoot>, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const installed = yield* fileSystem
    .readFileString(path.join(configDirPath, "plugins", "installed_plugins.json"))
    .pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(InstalledPlugins)),
      Effect.orElseSucceed(() => undefined),
    );
  const roots: Array<ClaudeSkillRoot> = [];
  const workspace = cwd === undefined ? undefined : path.resolve(cwd);
  const scopePriority = { user: 0, project: 1, local: 2 };

  for (const [key, entries] of Object.entries(installed?.plugins ?? {}).sort()) {
    if (enabledPlugins.get(key) !== true) continue;
    // Project and local installs only apply to their own workspace; the narrowest wins.
    const install = entries
      .flatMap((entry) => Option.toArray(decodeInstalledPlugin(entry)))
      .filter(
        (record) =>
          record.scope === "user" ||
          (record.projectPath !== undefined && path.resolve(record.projectPath) === workspace),
      )
      .sort((left, right) => scopePriority[right.scope] - scopePriority[left.scope])[0];
    if (!install) continue;
    const scope = install.scope === "user" ? "user" : "project";

    const manifest = yield* fileSystem
      .readFileString(path.join(install.installPath, ".claude-plugin", "plugin.json"))
      .pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(PluginManifest)),
        Effect.orElseSucceed(() => undefined),
      );
    const prefix = manifest?.name ?? key.split("@")[0];
    if (!prefix) continue;
    roots.push({ directory: path.join(install.installPath, "skills"), scope, prefix });
    // Plugins such as mattpocock-skills declare individual nested skill folders;
    // a declared path can also be a directory containing several skills.
    const declared = manifest?.skills;
    for (const relative of typeof declared === "string" ? [declared] : (declared ?? [])) {
      const directory = path.resolve(install.installPath, relative);
      const singleSkill = yield* fileSystem
        .exists(path.join(directory, "SKILL.md"))
        .pipe(Effect.orElseSucceed(() => false));
      roots.push({ directory, scope, prefix, singleSkill });
    }
  }
  return roots;
});

/**
 * Resolve the Claude config directory the CLI would use, matching the
 * precedence the spawned CLI sees: the instance's `homePath` (exported as
 * `CLAUDE_CONFIG_DIR` by `makeClaudeEnvironment`), then a `CLAUDE_CONFIG_DIR`
 * already present in the process environment, then `~/.claude`.
 */
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
  // No tilde expansion here: the spawned CLI receives this env var verbatim
  // (env vars are never shell-expanded), so a literal `~` must stay literal
  // for discovery to scan the same directory the runtime would. A relative
  // value is resolved against the workspace cwd — the subprocess's own cwd —
  // for the same reason.
  const environmentConfigDir = environment.CLAUDE_CONFIG_DIR?.trim() ?? "";
  if (environmentConfigDir.length > 0) {
    return cwd ? path.resolve(cwd, environmentConfigDir) : path.resolve(environmentConfigDir);
  }
  return path.join(home, ".claude");
});

/**
 * Enumerate Claude Code skills from the user config dir and the workspace
 * `.claude/skills`. Discovery is best-effort: unreadable roots and malformed
 * skill entries are skipped so a broken skill never degrades the provider
 * snapshot. Roots are listed highest precedence first and the first hit for a
 * name wins, matching Claude Code: verified against the CLI with the same
 * skill name in both scopes, the user copy is the one that runs. Reporting the
 * project copy instead would attach its invocation metadata to a command
 * Claude Code resolves elsewhere.
 */
export const discoverClaudeSkills = Effect.fn("discoverClaudeSkills")(function* (
  config: Pick<ClaudeSettings, "homePath">,
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
    ...(yield* discoverPluginSkillRoots(configDirPath, cwd, enabledPlugins)),
  ];

  const skillsByName = new Map<string, ServerProviderSkill>();
  for (const root of roots) {
    const entries = root.singleSkill
      ? [path.basename(root.directory)]
      : yield* fileSystem
          .readDirectory(root.directory)
          .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));

    for (const entry of [...entries].sort()) {
      const skillPath = root.singleSkill
        ? path.join(root.directory, "SKILL.md")
        : path.join(root.directory, entry, "SKILL.md");
      const contents = yield* fileSystem
        .readFileString(skillPath)
        .pipe(Effect.orElseSucceed(() => undefined));
      if (contents === undefined) {
        continue;
      }

      const frontmatter = parseSkillFrontmatter(contents);
      // Malformed frontmatter means the skill won't load in Claude Code
      // either — skip it rather than surfacing a broken entry under its
      // directory name.
      if (frontmatter.kind === "malformed") {
        continue;
      }

      // Claude Code identifies a user/project skill by its directory, not by the
      // frontmatter `name`: verified against the CLI, a skill in `probe-alias/`
      // declaring `name: probe-alias-frontmatter` is published as
      // `probe-alias`, and only `skillOverrides["probe-alias"]` switches it
      // off. Keying off the frontmatter name would report a command that does
      // not exist and miss the override that disables it.
      const directoryName = entry.trim();
      if (!directoryName) {
        continue;
      }
      // Plugin skills use their frontmatter name, with a sanitized directory fallback.
      const pluginSkillName =
        root.prefix && frontmatter.kind === "parsed" ? frontmatter.name : undefined;
      const name = root.prefix
        ? `${root.prefix}:${pluginSkillName ?? directoryName.replace(/[^a-zA-Z0-9_-]/g, "-")}`
        : directoryName;

      // First root wins, so a later root never displaces a higher-precedence
      // skill of the same name.
      if (skillsByName.has(name)) {
        continue;
      }

      const override = skillOverrides.get(name);
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
