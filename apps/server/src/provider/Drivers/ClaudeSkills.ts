/**
 * ClaudeSkills — filesystem discovery of Claude Code skills for the `$` picker.
 *
 * Claude Code loads skills from `<config dir>/skills` (user scope), from every
 * installed plugin, and from `<cwd>/.agents/skills` and `<cwd>/.claude/skills`
 * (project scope), one directory per skill with a `SKILL.md` carrying YAML
 * frontmatter. Later roots win on name collisions, so precedence is user,
 * plugins, `.agents`, then `.claude`. The Agent SDK init handshake surfaces
 * skills only as slash commands without their filesystem paths, so the
 * provider snapshot scans the same locations directly, mirroring how the
 * Codex app-server reports its skills.
 *
 * @module provider/Drivers/ClaudeSkills
 */
import * as NodeOS from "node:os";

import type { ClaudeSettings, ServerProviderSkill } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { parse as parseYamlDocument } from "yaml";

import { expandHomePath } from "../../pathExpansion.ts";

type ClaudeSkillScope = "user" | "project";

/** One skill folder, the directory holding a `SKILL.md`. `prefix` namespaces a plugin's skills. */
interface ClaudeSkillDirectory {
  readonly directory: string;
  readonly scope: ClaudeSkillScope;
  readonly prefix?: string;
}

// The plugin manifests are user-editable JSON with no schema guarantee, so
// every field is narrowed before use rather than asserted.
const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value : undefined;

/** Parse a JSON file, yielding `undefined` when it is missing or malformed. */
const readJsonFile = (filePath: string): Effect.Effect<unknown, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* fileSystem.readFileString(filePath).pipe(
      Effect.map((contents): unknown => {
        try {
          return JSON.parse(contents);
        } catch {
          return undefined;
        }
      }),
      Effect.orElseSucceed(() => undefined),
    );
  });

/**
 * The skill folders directly under `parent`, sorted for deterministic
 * collisions. A `skills` directory holds stray files and stale leftovers too,
 * so the `SKILL.md` is what makes an entry a skill — without that check a
 * plugin path that merely looks inhabited would end the search for the one
 * that really holds the skills.
 */
const listSkillDirectories = Effect.fn("listSkillDirectories")(function* (
  parent: string,
  scope: ClaudeSkillScope,
  prefix?: string,
): Effect.fn.Return<ReadonlyArray<ClaudeSkillDirectory>, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const entries = yield* fileSystem
    .readDirectory(parent)
    .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));

  const directories: Array<ClaudeSkillDirectory> = [];
  for (const entry of [...entries].sort()) {
    const directory = path.join(parent, entry);
    const isSkill = yield* fileSystem
      .exists(path.join(directory, "SKILL.md"))
      .pipe(Effect.orElseSucceed(() => false));
    if (isSkill) {
      directories.push({ directory, scope, ...(prefix ? { prefix } : {}) });
    }
  }
  return directories;
});

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

type SkillFrontmatter =
  | { readonly kind: "missing" }
  | { readonly kind: "malformed" }
  | { readonly kind: "parsed"; readonly name?: string; readonly description?: string };

function parseSkillFrontmatter(contents: string): SkillFrontmatter {
  const match = FRONTMATTER_PATTERN.exec(contents);
  if (!match) {
    return { kind: "missing" };
  }

  let parsed: unknown;
  try {
    parsed = parseYamlDocument(match[1] ?? "");
  } catch {
    return { kind: "malformed" };
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
  };
}

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
  const homePath = config.homePath.trim();
  if (homePath.length > 0) {
    return path.resolve(expandHomePath(homePath));
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
  return path.join(NodeOS.homedir(), ".claude");
});

/**
 * The `plugin@marketplace` switches from every settings layer the CLI merges,
 * most specific last. A plugin can be installed and still turned off, and its
 * skills do not load while it is.
 */
const readEnabledPlugins = Effect.fn("readEnabledPlugins")(function* (
  configDirPath: string,
  cwd: string | undefined,
): Effect.fn.Return<Record<string, unknown>, never, FileSystem.FileSystem | Path.Path> {
  const path = yield* Path.Path;
  const files = [
    path.join(configDirPath, "settings.json"),
    ...(cwd
      ? [
          path.join(cwd, ".claude", "settings.json"),
          path.join(cwd, ".claude", "settings.local.json"),
        ]
      : []),
  ];

  const merged: Record<string, unknown> = {};
  for (const file of files) {
    Object.assign(merged, asRecord(asRecord(yield* readJsonFile(file))?.enabledPlugins));
  }
  return merged;
});

/**
 * The skill folders a plugin rooted at `pluginRoot` contributes.
 *
 * `skills/<name>` is the conventional layout, and a plugin manifest may also
 * point at skills kept elsewhere in the tree — `mattpocock-skills` buckets
 * every one of them under `skills/<category>/<name>`, which the conventional
 * scan alone never reaches. The manifest lives at `.claude-plugin/plugin.json`,
 * with older plugins keeping it at the plugin root.
 *
 * A manifest entry usually names one skill folder, and is read as a folder of
 * them when it carries no `SKILL.md` of its own — both shapes ship today, and
 * guessing wrong drops the plugin's skills silently.
 */
const pluginSkillDirectories = Effect.fn("pluginSkillDirectories")(function* (
  pluginRoot: string,
  plugin: string,
): Effect.fn.Return<ReadonlyArray<ClaudeSkillDirectory>, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directories = [
    ...(yield* listSkillDirectories(path.join(pluginRoot, "skills"), "user", plugin)),
  ];

  const manifest =
    asRecord(yield* readJsonFile(path.join(pluginRoot, ".claude-plugin", "plugin.json"))) ??
    asRecord(yield* readJsonFile(path.join(pluginRoot, "plugin.json")));
  const skills = manifest?.skills;
  const declared = Array.isArray(skills) ? skills : [skills];

  const seen = new Set(directories.map((entry) => entry.directory));
  for (const value of declared) {
    const relative = asString(value);
    if (relative === undefined) {
      continue;
    }
    const declaredPath = path.resolve(pluginRoot, relative);
    const isSkill = yield* fileSystem
      .exists(path.join(declaredPath, "SKILL.md"))
      .pipe(Effect.orElseSucceed(() => false));

    for (const entry of isSkill
      ? [{ directory: declaredPath, scope: "user" as const, prefix: plugin }]
      : yield* listSkillDirectories(declaredPath, "user", plugin)) {
      if (seen.has(entry.directory)) {
        continue;
      }
      seen.add(entry.directory);
      directories.push(entry);
    }
  }
  return directories;
});

/**
 * Skill folders contributed by installed plugins.
 *
 * Claude Code exposes a plugin's skills as `<plugin>:<skill>`, so the prefix is
 * part of the name the composer sends back — an unprefixed `ponytail` is not a
 * skill Claude Code resolves.
 *
 * Only plugins the CLI would actually load count, so a marketplace's other
 * offerings, plugins switched off in `settings.json`, and installs belonging to
 * a different workspace all stay out of the picker: surfacing them fills it
 * with skills that fail at send time. The install record does not say where the
 * skills sit, though, and three layouts are in the wild — a cached install, a
 * plugin inside a marketplace checkout, and a marketplace whose root *is* the
 * plugin (`installPath` is stale for directory-sourced marketplaces, so it
 * cannot be trusted alone). The first candidate that yields skills wins.
 */
const discoverPluginSkillDirectories = Effect.fn("discoverPluginSkillDirectories")(function* (
  configDirPath: string,
  cwd: string | undefined,
): Effect.fn.Return<ReadonlyArray<ClaudeSkillDirectory>, never, FileSystem.FileSystem | Path.Path> {
  const path = yield* Path.Path;
  const pluginsDir = path.join(configDirPath, "plugins");

  const installed = asRecord(
    asRecord(yield* readJsonFile(path.join(pluginsDir, "installed_plugins.json")))?.plugins,
  );
  if (!installed) {
    return [];
  }
  const marketplaces = asRecord(
    yield* readJsonFile(path.join(pluginsDir, "known_marketplaces.json")),
  );
  const enabledPlugins = yield* readEnabledPlugins(configDirPath, cwd);
  const workspace = cwd ? path.resolve(cwd) : undefined;

  const directories: Array<ClaudeSkillDirectory> = [];
  for (const [key, value] of Object.entries(installed)) {
    const [plugin, marketplace] = key.split("@");
    // An explicit `false` is the only way a plugin is off; an install the
    // settings never mention is on, which is how a fresh install behaves.
    if (!plugin || enabledPlugins[key] === false) {
      continue;
    }
    const installLocation = marketplace
      ? asString(asRecord(marketplaces?.[marketplace])?.installLocation)
      : undefined;

    // A project-scoped install belongs to the workspace it names and is not
    // loaded anywhere else. A plugin installed both ways resolves to the
    // project entry, which is the more specific one — never to whichever the
    // manifest happens to list first.
    const applicable = (Array.isArray(value) ? value : [])
      .flatMap((entry) => {
        const record = asRecord(entry);
        const projectPath = asString(record?.projectPath);
        if (projectPath === undefined) {
          return [{ record, projectScoped: false }];
        }
        return path.resolve(projectPath) === workspace ? [{ record, projectScoped: true }] : [];
      })
      .sort((left, right) => Number(right.projectScoped) - Number(left.projectScoped));

    for (const { record } of applicable) {
      const candidates = [
        asString(record?.installPath),
        installLocation ? path.join(installLocation, "plugins", plugin) : undefined,
        installLocation,
      ];
      let found = false;
      for (const candidate of candidates) {
        if (candidate === undefined) {
          continue;
        }
        const skills = yield* pluginSkillDirectories(candidate, plugin);
        if (skills.length > 0) {
          directories.push(...skills);
          found = true;
          break;
        }
      }
      // One install per plugin reaches the picker: several entries mean
      // several scopes, and they all resolve to the same `<plugin>:` names.
      if (found) {
        break;
      }
    }
  }
  return directories;
});

/**
 * Enumerate Claude Code skills from the user config dir and the workspace.
 * Discovery is best-effort: unreadable roots and malformed skill entries are
 * skipped so a broken skill never degrades the provider snapshot. On name
 * collisions the project-scoped skill wins, matching Claude Code's
 * most-specific-wins resolution.
 */
export const discoverClaudeSkills = Effect.fn("discoverClaudeSkills")(function* (
  config: Pick<ClaudeSettings, "homePath">,
  cwd?: string,
  environment?: NodeJS.ProcessEnv,
): Effect.fn.Return<ReadonlyArray<ServerProviderSkill>, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const configDirPath = yield* resolveClaudeConfigDirPath(config, environment ?? process.env, cwd);

  // Later entries win on name collisions, matching Claude Code's
  // most-specific-wins resolution: user, then plugins, then the workspace.
  const skillDirectories: ReadonlyArray<ClaudeSkillDirectory> = [
    ...(yield* listSkillDirectories(path.join(configDirPath, "skills"), "user")),
    ...(yield* discoverPluginSkillDirectories(configDirPath, cwd)),
    ...(cwd
      ? [
          ...(yield* listSkillDirectories(path.join(cwd, ".agents", "skills"), "project")),
          ...(yield* listSkillDirectories(path.join(cwd, ".claude", "skills"), "project")),
        ]
      : []),
  ];

  const skillsByName = new Map<string, ServerProviderSkill>();
  for (const skill of skillDirectories) {
    const skillPath = path.join(skill.directory, "SKILL.md");
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

    const base =
      (frontmatter.kind === "parsed" ? frontmatter.name : undefined) ??
      path.basename(skill.directory).trim();
    if (!base) {
      continue;
    }
    const name = skill.prefix ? `${skill.prefix}:${base}` : base;

    skillsByName.set(name, {
      name,
      path: skillPath,
      enabled: true,
      scope: skill.scope,
      ...(frontmatter.kind === "parsed" && frontmatter.description
        ? { description: frontmatter.description }
        : {}),
    });
  }

  return [...skillsByName.values()].sort((left, right) => left.name.localeCompare(right.name));
});
