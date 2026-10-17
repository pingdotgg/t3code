/**
 * Cursor discovers Agent Skills recursively from user and project roots but
 * its ACP command catalog only appears after opening a real session. Scanning
 * the same roots avoids starting an agent and its MCP servers just to populate
 * a composer menu.
 */

import type { ServerProviderSkill } from "@t3tools/contracts";
import * as ByteSize from "effect/ByteSize";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import { parse as parseYamlDocument } from "yaml";
import * as HostProcess from "@t3tools/shared/HostProcess";

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const SKILL_MENTION_PATTERN =
  /(^|\s)\p{Sc}(?![0-9][0-9_]*(?:[kKmMbBtT]|[eE][0-9]+)?(?:\s|$))(?=[a-zA-Z0-9:_-]*[a-zA-Z])([a-zA-Z0-9][a-zA-Z0-9:_-]*)(?=\s|$)/gu;
const HAS_SKILL_MENTION_PATTERN = new RegExp(SKILL_MENTION_PATTERN.source, "u");
const MAX_SKILL_DEPTH = 10;
const MAX_SKILL_BYTES = ByteSize.bytes(1_000_000);
const MAX_SKILL_SCAN_ENTRIES = 10_000;
const MAX_SKILL_SCAN_BYTES = ByteSize.bytes(8_000_000);

interface CursorSkillFrontmatter {
  readonly description?: string;
  readonly displayName?: string;
  readonly userInvocationOnly?: boolean;
  readonly userInvocable?: boolean;
  readonly cliVisible: boolean;
}

interface CursorSkillScanBudget {
  remainingEntries: number;
  remainingBytes: bigint;
  exhausted: boolean;
  incomplete: boolean;
}

class CursorSkillsProbeError extends Schema.TaggedError<CursorSkillsProbeError>()(
  "CursorSkillsProbeError",
  {
    reason: Schema.Literals(["scan-budget-exhausted", "filesystem-error"]),
    cwd: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    const location = this.cwd === undefined ? "" : ` for '${this.cwd}'`;
    return `Cursor skill discovery${location} was incomplete (${this.reason}).`;
  }
}

const orUndefined = <A, R>(
  effect: Effect.Effect<A, PlatformError.PlatformError, R>,
  budget?: CursorSkillScanBudget,
): Effect.Effect<A | undefined, never, R> =>
  effect.pipe(
    Effect.map((value): A | undefined => value),
    Effect.catchTags({
      PlatformError: (error) => {
        if (error.reason._tag !== "NotFound" && budget) budget.incomplete = true;
        return Effect.void.pipe(Effect.as(undefined));
      },
    }),
  );

function parseFrontmatterBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1 ? true : value === 0 ? false : undefined;
  if (typeof value !== "string") return undefined;
  switch (value.trim().toLowerCase()) {
    case "true":
    case "yes":
    case "on":
      return true;
    case "false":
    case "no":
    case "off":
      return false;
    default:
      return undefined;
  }
}

function parseSkillFrontmatter(contents: string): CursorSkillFrontmatter | undefined {
  const match = FRONTMATTER_PATTERN.exec(contents);
  if (!match) return { cliVisible: true };

  let parsed: unknown;
  try {
    parsed = parseYamlDocument(match[1] ?? "");
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;

  const record = parsed as Record<string, unknown>;
  const metadata =
    typeof record.metadata === "object" && record.metadata !== null
      ? (record.metadata as Record<string, unknown>)
      : undefined;
  const rawSurfaces = metadata?.surfaces;
  const surfaces = Array.isArray(rawSurfaces)
    ? rawSurfaces.filter((surface): surface is string => typeof surface === "string")
    : typeof rawSurfaces === "string"
      ? rawSurfaces.split(",")
      : [];
  const description = typeof record.description === "string" ? record.description.trim() : "";
  const displayName = typeof record.name === "string" ? record.name.trim() : "";
  return {
    cliVisible:
      surfaces.length === 0 || surfaces.some((surface) => surface.trim().toLowerCase() === "cli"),
    ...(description ? { description } : {}),
    ...(displayName ? { displayName } : {}),
    ...(parseFrontmatterBoolean(record["disable-model-invocation"]) === true
      ? { userInvocationOnly: true }
      : {}),
    ...(parseFrontmatterBoolean(record["user-invocable"]) === false
      ? { userInvocable: false }
      : {}),
  };
}

const readSkill = Effect.fn("readCursorSkill")(function* (input: {
  readonly directory: string;
  readonly scope: "user" | "project";
  readonly budget: CursorSkillScanBudget;
}): Effect.fn.Return<ServerProviderSkill | undefined, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const skillPath = path.join(input.directory, "SKILL.md");
  const skillInfo = yield* orUndefined(fileSystem.stat(skillPath), input.budget);
  if (skillInfo?.type !== "File") return undefined;
  let frontmatter: CursorSkillFrontmatter | undefined = { cliVisible: true };
  if (skillInfo.size <= MAX_SKILL_BYTES && skillInfo.size <= input.budget.remainingBytes) {
    const contents = yield* orUndefined(fileSystem.readFileString(skillPath));
    if (contents !== undefined) {
      input.budget.remainingBytes -= skillInfo.size;
      frontmatter = parseSkillFrontmatter(contents);
    }
  }
  const name = path.basename(input.directory).trim();
  if (!frontmatter?.cliVisible || !name) return undefined;
  return {
    name,
    path: skillPath,
    scope: input.scope,
    enabled: true,
    ...(frontmatter.displayName && frontmatter.displayName !== name
      ? { displayName: frontmatter.displayName }
      : {}),
    ...(frontmatter.description ? { description: frontmatter.description } : {}),
    ...(frontmatter.userInvocationOnly ? { userInvocationOnly: true } : {}),
    ...(frontmatter.userInvocable === false ? { userInvocable: false } : {}),
  };
});

const discoverSkillsInRoot = Effect.fn("discoverCursorSkillsInRoot")(function* (input: {
  readonly directory: string;
  readonly scope: "user" | "project";
  readonly budget: CursorSkillScanBudget;
}): Effect.fn.Return<ReadonlyArray<ServerProviderSkill>, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const skills: ServerProviderSkill[] = [];
  if (input.budget.exhausted) return skills;
  const rootDirectory = yield* orUndefined(fileSystem.realPath(input.directory), input.budget);
  if (!rootDirectory) return skills;
  const visitedDirectories = new Set<string>();

  const visit = Effect.fn("visitCursorSkillDirectory")(function* (
    directory: string,
    depth: number,
  ): Effect.fn.Return<void, never, FileSystem.FileSystem | Path.Path> {
    if (input.budget.exhausted) return;
    const resolvedDirectory = yield* orUndefined(fileSystem.realPath(directory), input.budget);
    if (!resolvedDirectory) {
      return;
    }
    if (visitedDirectories.has(resolvedDirectory)) {
      return;
    }
    visitedDirectories.add(resolvedDirectory);
    // A symlink whose target lives outside the root is a skill package
    // boundary: read its own SKILL.md so linked skill libraries show up, but
    // never walk the target tree.
    const insideRoot =
      resolvedDirectory === rootDirectory ||
      resolvedDirectory.startsWith(`${rootDirectory}${path.sep}`);

    const skill = yield* readSkill({ directory, scope: input.scope, budget: input.budget });
    if (skill) skills.push(skill);

    if (!insideRoot) {
      return;
    }
    const entries = yield* orUndefined(fileSystem.readDirectory(directory), input.budget);
    if (!entries) {
      return;
    }
    for (const entry of [...entries].sort()) {
      if (input.budget.remainingEntries === 0) {
        input.budget.exhausted = true;
        return;
      }
      input.budget.remainingEntries -= 1;
      const child = path.join(directory, entry);
      const info = yield* orUndefined(fileSystem.stat(child), input.budget);
      if (info?.type !== "Directory") continue;
      if (depth >= MAX_SKILL_DEPTH) continue;
      yield* visit(child, depth + 1);
    }
  });

  yield* visit(rootDirectory, 0);
  return skills;
});

const CURSOR_PLUGIN_MANIFESTS = [
  ".cursor-plugin/plugin.json",
  ".claude-plugin/plugin.json",
  "plugin.json",
];
const decodeCursorPluginManifest = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      name: Schema.String.check(Schema.isPattern(/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/)),
      skills: Schema.optional(Schema.Union([Schema.String, Schema.Array(Schema.String)])),
    }),
  ),
);

/**
 * Follows the plugin loader in `@cursor/sdk`. Cursor asks its account API which
 * cached plugins are enabled, which the SDK does not expose, so this also lists
 * plugins the user disabled.
 */
const discoverCursorPluginSkillDirectories = Effect.fn("discoverCursorPluginSkillDirectories")(
  function* (userHome: string, budget: CursorSkillScanBudget) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const fileType = (file: string) =>
      orUndefined(fileSystem.stat(file)).pipe(Effect.map((info) => info?.type));
    const subdirectories = Effect.fn("listCursorPluginSubdirectories")(function* (
      directory: string,
    ) {
      const children: string[] = [];
      if (budget.exhausted) return children;
      const entries = (yield* orUndefined(fileSystem.readDirectory(directory))) ?? [];
      for (const entry of [...entries].sort()) {
        if (budget.remainingEntries === 0) {
          budget.exhausted = true;
          break;
        }
        budget.remainingEntries -= 1;
        const child = path.join(directory, entry);
        if ((yield* fileType(child)) === "Directory") children.push(child);
      }
      return children;
    });
    const readManifest = Effect.fn("readCursorPluginManifest")(function* (root: string) {
      for (const candidate of CURSOR_PLUGIN_MANIFESTS) {
        const manifestPath = path.join(root, candidate);
        const info = yield* orUndefined(fileSystem.stat(manifestPath));
        if (info?.type !== "File" || info.size > MAX_SKILL_BYTES) continue;
        if (info.size > budget.remainingBytes) continue;
        if ((yield* orUndefined(fileSystem.readLink(manifestPath))) !== undefined) continue;
        const contents = yield* orUndefined(fileSystem.readFileString(manifestPath));
        if (contents === undefined) continue;
        budget.remainingBytes -= info.size;
        const manifest = decodeCursorPluginManifest(contents);
        if (Option.isSome(manifest)) return manifest.value;
      }
      return undefined;
    });

    const pluginsDirectory = path.join(userHome, ".cursor", "plugins");
    const pluginRoots: string[] = [];
    const marketplace = path.join(pluginsDirectory, "cache", "cursor-public");
    for (const plugin of yield* subdirectories(marketplace)) {
      for (const version of yield* subdirectories(plugin)) {
        if ((yield* fileType(path.join(version, ".cache-complete"))) === "File") {
          pluginRoots.push(version);
        }
      }
    }
    const localDirectory = path.join(pluginsDirectory, "local");
    const realLocalDirectory = yield* orUndefined(fileSystem.realPath(localDirectory));
    for (const plugin of yield* subdirectories(localDirectory)) {
      if (path.basename(plugin).startsWith(".")) continue;
      const realPlugin = yield* orUndefined(fileSystem.realPath(plugin));
      if (realLocalDirectory && realPlugin?.startsWith(`${realLocalDirectory}${path.sep}`)) {
        pluginRoots.push(plugin);
      }
    }

    const directories: string[] = [];
    for (const root of pluginRoots) {
      if (budget.exhausted) break;
      const realRoot = yield* orUndefined(fileSystem.realPath(root));
      if (!realRoot) continue;
      const insideRoot = (file: string) =>
        orUndefined(fileSystem.realPath(file)).pipe(
          Effect.map((realFile) => realFile?.startsWith(`${realRoot}${path.sep}`) === true),
        );
      const skills = (yield* readManifest(root))?.skills ?? "skills";
      const folders: string[] = [];
      for (const entry of typeof skills === "string" ? [skills] : skills) {
        if (entry.includes("..") || entry.includes("://") || path.isAbsolute(entry)) continue;
        const target = path.join(root, entry);
        const skillFile =
          path.basename(target) === "SKILL.md" ? target : path.join(target, "SKILL.md");
        if (typeof skills !== "string" && (yield* fileType(skillFile)) === "File") {
          folders.push(path.dirname(skillFile));
        } else {
          folders.push(...(yield* subdirectories(target)));
        }
      }
      for (const folder of folders) {
        if ((yield* insideRoot(folder)) && (yield* insideRoot(path.join(folder, "SKILL.md")))) {
          directories.push(folder);
        }
      }
    }
    return directories;
  },
);

const inspectCursorSkills = Effect.fn("inspectCursorSkills")(function* (
  cwd?: string,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const path = yield* Path.Path;
  const userHome =
    environment.HOME?.trim() ||
    environment.USERPROFILE?.trim() ||
    (yield* HostProcess.HomeDirectory);
  const rootsBelow = (base: string, scope: "user" | "project") => [
    { directory: path.join(base, ".cursor", "skills"), scope },
    { directory: path.join(base, ".agents", "skills"), scope },
    { directory: path.join(base, ".codex", "skills"), scope },
    { directory: path.join(base, ".claude", "skills"), scope },
  ];
  const roots = [...(cwd ? rootsBelow(cwd, "project") : []), ...rootsBelow(userHome, "user")];

  const skillsByName = new Map<string, ServerProviderSkill>();
  const newBudget = (): CursorSkillScanBudget => ({
    remainingEntries: MAX_SKILL_SCAN_ENTRIES,
    remainingBytes: MAX_SKILL_SCAN_BYTES,
    exhausted: false,
    incomplete: false,
  });
  const budget = newBudget();
  // Plugin limits stop only the plugin scan. A failed probe would hide every skill.
  const pluginBudget = newBudget();
  for (const root of roots) {
    if (budget.exhausted) break;
    const skills = yield* discoverSkillsInRoot({ ...root, budget });
    for (const skill of skills) {
      if (!skillsByName.has(skill.name)) skillsByName.set(skill.name, skill);
    }
  }
  for (const directory of yield* discoverCursorPluginSkillDirectories(userHome, pluginBudget)) {
    const skill = yield* readSkill({ directory, scope: "user", budget: pluginBudget });
    if (skill && !skillsByName.has(skill.name)) skillsByName.set(skill.name, skill);
  }
  return {
    skills: [...skillsByName.values()].sort((left, right) => left.name.localeCompare(right.name)),
    failureReason: budget.exhausted
      ? ("scan-budget-exhausted" as const)
      : budget.incomplete
        ? ("filesystem-error" as const)
        : undefined,
  };
});

export const discoverCursorSkills = Effect.fn("discoverCursorSkills")(function* (
  cwd?: string,
  environment: NodeJS.ProcessEnv = process.env,
) {
  return (yield* inspectCursorSkills(cwd, environment)).skills;
});

export const probeCursorSkills = Effect.fn("probeCursorSkills")(function* (
  cwd?: string,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const inspection = yield* inspectCursorSkills(cwd, environment);
  if (inspection.failureReason) {
    return yield* new CursorSkillsProbeError({
      reason: inspection.failureReason,
      ...(cwd ? { cwd } : {}),
    });
  }
  return inspection.skills;
});

/** Cursor invokes Agent Skills with `/name`; T3 composers insert `$name`. */
export function hasCursorSkillMention(prompt: string): boolean {
  return HAS_SKILL_MENTION_PATTERN.test(prompt);
}

export function rewriteCursorSkillMentions(
  prompt: string,
  skillNames: ReadonlySet<string>,
): string {
  return prompt.replace(SKILL_MENTION_PATTERN, (match, prefix: string, name: string) =>
    skillNames.has(name) ? `${prefix}/${name}` : match,
  );
}
