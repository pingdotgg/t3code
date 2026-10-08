/**
 * CursorSkills — workspace-aware discovery and native invocation for Cursor.
 *
 * Cursor discovers Agent Skills recursively from user and project roots but
 * its ACP command catalog only appears after opening a real session. Scanning
 * the same roots avoids starting an agent and its MCP servers just to populate
 * a composer menu. Enabled plugins keep skills in `plugins/local` and in the
 * one completed cache version the SDK marked, not in every historical SHA.
 *
 * @module provider/Drivers/CursorSkills
 */
import * as NodeOS from "node:os";

import type { ServerProviderSkill } from "@t3tools/contracts";
import * as ByteSize from "effect/ByteSize";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import { parse as parseYamlDocument } from "yaml";

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

const PLUGIN_MANIFEST_PATHS = [
  ".cursor-plugin/plugin.json",
  ".claude-plugin/plugin.json",
  "plugin.json",
] as const;

function isPathInside(parent: string, candidate: string, path: Path.Path): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function safePluginRelativePath(value: string): string | undefined {
  const normalized = value.replaceAll("\\", "/").trim();
  if (
    normalized.length === 0 ||
    normalized.includes("..") ||
    normalized.includes("://") ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:/.test(normalized)
  ) {
    return undefined;
  }
  const stripped = normalized.replace(/^\.\//, "").replace(/\/+$/, "");
  return stripped.length === 0 ? undefined : stripped;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const readCursorSkill = Effect.fn("readCursorSkill")(function* (input: {
  readonly directory: string;
  readonly scope: "user" | "project";
  readonly budget: CursorSkillScanBudget;
  readonly containmentRoot?: string;
}): Effect.fn.Return<ServerProviderSkill | undefined, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const skillPath = path.join(input.directory, "SKILL.md");
  const skillInfo = yield* orUndefined(fileSystem.stat(skillPath), input.budget);
  if (skillInfo?.type !== "File") return undefined;
  if (input.containmentRoot !== undefined) {
    const [resolvedSkill, resolvedRoot] = yield* Effect.all([
      orUndefined(fileSystem.realPath(skillPath), input.budget),
      orUndefined(fileSystem.realPath(input.containmentRoot), input.budget),
    ]);
    if (!resolvedSkill || !resolvedRoot || !isPathInside(resolvedRoot, resolvedSkill, path)) {
      return undefined;
    }
  }

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

    const skill = yield* readCursorSkill({
      directory,
      scope: input.scope,
      budget: input.budget,
    });
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
      if (depth >= MAX_SKILL_DEPTH) {
        input.budget.exhausted = true;
        return;
      }
      yield* visit(child, depth + 1);
    }
  });

  yield* visit(rootDirectory, 0);
  return skills;
});

const decodePluginJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

const takeScanEntry = (budget: CursorSkillScanBudget): boolean => {
  if (budget.exhausted || budget.remainingEntries === 0) {
    budget.exhausted = true;
    return false;
  }
  budget.remainingEntries -= 1;
  return true;
};

const readJsonObject = Effect.fn("readCursorPluginJson")(function* (
  file: string,
  budget: CursorSkillScanBudget,
): Effect.fn.Return<Record<string, unknown> | undefined, never, FileSystem.FileSystem> {
  const fileSystem = yield* FileSystem.FileSystem;
  const info = yield* orUndefined(fileSystem.stat(file), budget);
  if (info?.type !== "File" || info.size > MAX_SKILL_BYTES || info.size > budget.remainingBytes) {
    return undefined;
  }
  const contents = yield* orUndefined(fileSystem.readFileString(file), budget);
  if (contents === undefined) return undefined;
  budget.remainingBytes -= info.size;
  const parsed = yield* decodePluginJson(contents).pipe(Effect.orElseSucceed(() => undefined));
  return isRecord(parsed) ? parsed : undefined;
});

const discoverPluginSkillDirectory = Effect.fn("discoverCursorPluginSkillDirectory")(
  function* (input: {
    readonly directory: string;
    readonly pluginRoot: string;
    readonly scope: "user" | "project";
    readonly budget: CursorSkillScanBudget;
  }): Effect.fn.Return<
    ReadonlyArray<ServerProviderSkill>,
    never,
    FileSystem.FileSystem | Path.Path
  > {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const skills: ServerProviderSkill[] = [];
    if (input.budget.exhausted) return skills;
    const pluginRoot = yield* orUndefined(fileSystem.realPath(input.pluginRoot), input.budget);
    const entries = yield* orUndefined(fileSystem.readDirectory(input.directory), input.budget);
    if (!pluginRoot || !entries) return skills;

    for (const entry of [...entries].sort()) {
      if (input.budget.exhausted) return skills;
      if (input.budget.remainingEntries === 0) {
        input.budget.exhausted = true;
        return skills;
      }
      input.budget.remainingEntries -= 1;
      if (entry.startsWith(".")) continue;
      const child = path.join(input.directory, entry);
      const info = yield* orUndefined(fileSystem.stat(child), input.budget);
      if (info?.type !== "Directory") continue;
      const resolvedChild = yield* orUndefined(fileSystem.realPath(child), input.budget);
      if (!resolvedChild || !isPathInside(pluginRoot, resolvedChild, path)) continue;
      const skill = yield* readCursorSkill({
        directory: child,
        scope: input.scope,
        budget: input.budget,
        containmentRoot: input.pluginRoot,
      });
      if (skill) skills.push(skill);
    }
    return skills;
  },
);

const resolvePluginRelativePath = Effect.fn("resolveCursorPluginRelativePath")(function* (
  pluginRoot: string,
  relativePath: string,
): Effect.fn.Return<string | undefined, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const safePath = safePluginRelativePath(relativePath);
  if (!safePath) return undefined;
  const candidate = path.resolve(pluginRoot, safePath);
  if (!isPathInside(path.resolve(pluginRoot), candidate, path)) return undefined;
  const [resolvedRoot, resolvedCandidate] = yield* Effect.all([
    orUndefined(fileSystem.realPath(pluginRoot)),
    orUndefined(fileSystem.realPath(candidate)),
  ]);
  if (!resolvedRoot || !resolvedCandidate || !isPathInside(resolvedRoot, resolvedCandidate, path)) {
    return undefined;
  }
  return candidate;
});

const readPluginManifest = Effect.fn("readCursorPluginManifest")(function* (
  pluginRoot: string,
  budget: CursorSkillScanBudget,
): Effect.fn.Return<Record<string, unknown> | undefined, never, FileSystem.FileSystem | Path.Path> {
  const path = yield* Path.Path;
  for (const relativePath of PLUGIN_MANIFEST_PATHS) {
    if (budget.exhausted) return undefined;
    const manifest = yield* readJsonObject(path.join(pluginRoot, relativePath), budget);
    if (manifest) return manifest;
  }
  return undefined;
});

const discoverSkillsInPlugin = Effect.fn("discoverCursorSkillsInPlugin")(function* (input: {
  readonly directory: string;
  readonly scope: "user" | "project";
  readonly budget: CursorSkillScanBudget;
}): Effect.fn.Return<ReadonlyArray<ServerProviderSkill>, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (input.budget.exhausted) return [];
  const info = yield* orUndefined(fileSystem.stat(input.directory), input.budget);
  if (info?.type !== "Directory") return [];

  const manifest = yield* readPluginManifest(input.directory, input.budget);
  const skills: ServerProviderSkill[] = [];
  const readContainedSkill = (directory: string) =>
    readCursorSkill({
      directory,
      scope: input.scope,
      budget: input.budget,
      containmentRoot: input.directory,
    });
  const readDeclaredSkills = Effect.fn("readDeclaredCursorPluginSkills")(function* (
    relativePath: string,
    asDirectory: boolean,
  ) {
    const resolved = yield* resolvePluginRelativePath(input.directory, relativePath);
    if (!resolved) return;
    const info = yield* orUndefined(fileSystem.stat(resolved), input.budget);
    if (info?.type === "File" && path.basename(resolved) === "SKILL.md") {
      const skill = yield* readContainedSkill(path.dirname(resolved));
      if (skill) skills.push(skill);
      return;
    }
    if (info?.type !== "Directory") return;
    if (!asDirectory) {
      const skillFile = path.join(resolved, "SKILL.md");
      const skillInfo = yield* orUndefined(fileSystem.stat(skillFile), input.budget);
      if (skillInfo?.type === "File") {
        const skill = yield* readContainedSkill(resolved);
        if (skill) skills.push(skill);
        return;
      }
    }
    skills.push(
      ...(yield* discoverPluginSkillDirectory({
        directory: resolved,
        pluginRoot: input.directory,
        scope: input.scope,
        budget: input.budget,
      })),
    );
  });

  if (manifest && "skills" in manifest) {
    const declared = manifest.skills;
    if (typeof declared === "string") {
      if (!takeScanEntry(input.budget)) return skills;
      yield* readDeclaredSkills(declared, true);
    } else if (Array.isArray(declared)) {
      for (const entry of declared) {
        if (!takeScanEntry(input.budget)) break;
        if (typeof entry !== "string") continue;
        yield* readDeclaredSkills(entry, false);
      }
    }
    return skills;
  }

  const skillsDirectory = path.join(input.directory, "skills");
  const skillsInfo = yield* orUndefined(fileSystem.stat(skillsDirectory), input.budget);
  if (skillsInfo?.type === "Directory") {
    skills.push(
      ...(yield* discoverPluginSkillDirectory({
        directory: skillsDirectory,
        pluginRoot: input.directory,
        scope: input.scope,
        budget: input.budget,
      })),
    );
  }
  const rootSkill = yield* readContainedSkill(input.directory);
  if (rootSkill) skills.push(rootSkill);
  return skills;
});

const listDirectoryNames = Effect.fn("listCursorPluginDirectoryNames")(function* (
  directory: string,
  budget: CursorSkillScanBudget,
): Effect.fn.Return<ReadonlyArray<string> | undefined, never, FileSystem.FileSystem> {
  const fileSystem = yield* FileSystem.FileSystem;
  const entries = yield* orUndefined(fileSystem.readDirectory(directory), budget);
  return entries === undefined ? undefined : [...entries].sort();
});

const CACHE_COMPLETE_MARKER = ".cache-complete";

const cursorLocalPluginInstalls = Effect.fn("cursorLocalPluginInstalls")(function* (input: {
  readonly userHome: string;
  readonly budget: CursorSkillScanBudget;
  readonly inspect: (
    directory: string,
  ) => Effect.Effect<void, never, FileSystem.FileSystem | Path.Path>;
}): Effect.fn.Return<void, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const localRoot = path.join(input.userHome, ".cursor", "plugins", "local");
  const resolvedLocalRoot = yield* orUndefined(fileSystem.realPath(localRoot), input.budget);
  const localEntries = yield* listDirectoryNames(localRoot, input.budget);
  if (!resolvedLocalRoot || !localEntries) return;
  for (const entry of localEntries) {
    if (!takeScanEntry(input.budget)) return;
    if (entry.startsWith(".")) continue;
    const child = path.join(localRoot, entry);
    const info = yield* orUndefined(fileSystem.stat(child), input.budget);
    if (info?.type !== "Directory") continue;
    const resolvedChild = yield* orUndefined(fileSystem.realPath(child), input.budget);
    if (!resolvedChild || !isPathInside(resolvedLocalRoot, resolvedChild, path)) continue;
    yield* input.inspect(child);
    if (input.budget.exhausted) return;
  }
});

const addCompletedCachePlugins = Effect.fn("addCompletedCursorCachePlugins")(function* (input: {
  readonly cacheRoot: string;
  readonly budget: CursorSkillScanBudget;
  readonly inspect: (
    directory: string,
  ) => Effect.Effect<void, never, FileSystem.FileSystem | Path.Path>;
}): Effect.fn.Return<void, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const resolvedCacheRoot = yield* orUndefined(fileSystem.realPath(input.cacheRoot), input.budget);
  if (!resolvedCacheRoot) return;
  // The SDK marks a finished cache install with .cache-complete and leaves old
  // SHAs on disk. Several completed versions are ambiguous, so only one is used.
  const marketplaces = yield* listDirectoryNames(input.cacheRoot, input.budget);
  if (!marketplaces) return;
  for (const marketplace of marketplaces) {
    if (!takeScanEntry(input.budget)) return;
    if (marketplace.startsWith(".")) continue;
    const marketplaceDirectory = path.join(input.cacheRoot, marketplace);
    const marketplaceInfo = yield* orUndefined(fileSystem.stat(marketplaceDirectory), input.budget);
    if (marketplaceInfo?.type !== "Directory") continue;
    const plugins = yield* listDirectoryNames(marketplaceDirectory, input.budget);
    if (!plugins) continue;
    for (const plugin of plugins) {
      if (!takeScanEntry(input.budget)) return;
      if (plugin.startsWith(".")) continue;
      const pluginDirectory = path.join(marketplaceDirectory, plugin);
      const pluginInfo = yield* orUndefined(fileSystem.stat(pluginDirectory), input.budget);
      if (pluginInfo?.type !== "Directory") continue;
      const versions = yield* listDirectoryNames(pluginDirectory, input.budget);
      if (!versions) continue;
      const completed: string[] = [];
      for (const version of versions) {
        if (!takeScanEntry(input.budget)) return;
        if (version.startsWith(".")) continue;
        const versionDirectory = path.join(pluginDirectory, version);
        const versionInfo = yield* orUndefined(fileSystem.stat(versionDirectory), input.budget);
        if (versionInfo?.type !== "Directory") continue;
        const marker = yield* orUndefined(
          fileSystem.stat(path.join(versionDirectory, CACHE_COMPLETE_MARKER)),
          input.budget,
        );
        if (marker?.type !== "File") continue;
        const resolvedVersion = yield* orUndefined(
          fileSystem.realPath(versionDirectory),
          input.budget,
        );
        if (resolvedVersion && isPathInside(resolvedCacheRoot, resolvedVersion, path)) {
          completed.push(versionDirectory);
        }
      }
      const [onlyCompleted] = completed;
      if (completed.length === 1 && onlyCompleted) {
        yield* input.inspect(onlyCompleted);
        if (input.budget.exhausted) return;
      }
    }
  }
});

const inspectCursorSkills = Effect.fn("inspectCursorSkills")(function* (
  cwd?: string,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const path = yield* Path.Path;
  const userHome = environment.HOME?.trim() || environment.USERPROFILE?.trim() || NodeOS.homedir();
  const rootsBelow = (base: string, scope: "user" | "project") => [
    { directory: path.join(base, ".cursor", "skills"), scope },
    { directory: path.join(base, ".agents", "skills"), scope },
    { directory: path.join(base, ".codex", "skills"), scope },
    { directory: path.join(base, ".claude", "skills"), scope },
  ];
  const roots = [...(cwd ? rootsBelow(cwd, "project") : []), ...rootsBelow(userHome, "user")];

  const skillsByName = new Map<string, ServerProviderSkill>();
  const budget: CursorSkillScanBudget = {
    remainingEntries: MAX_SKILL_SCAN_ENTRIES,
    remainingBytes: MAX_SKILL_SCAN_BYTES,
    exhausted: false,
    incomplete: false,
  };
  const remember = (skills: ReadonlyArray<ServerProviderSkill>) => {
    for (const skill of skills) {
      if (!skillsByName.has(skill.name)) skillsByName.set(skill.name, skill);
    }
  };
  for (const root of roots) {
    if (budget.exhausted) break;
    remember(yield* discoverSkillsInRoot({ ...root, budget }));
  }
  const inspectInstall = (directory: string) =>
    Effect.gen(function* () {
      remember(yield* discoverSkillsInPlugin({ directory, scope: "user", budget }));
    });
  if (!budget.exhausted) {
    yield* cursorLocalPluginInstalls({ userHome, budget, inspect: inspectInstall });
  }
  if (!budget.exhausted) {
    yield* addCompletedCachePlugins({
      cacheRoot: path.join(userHome, ".cursor", "plugins", "cache"),
      budget,
      inspect: inspectInstall,
    });
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
