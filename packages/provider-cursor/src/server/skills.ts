// Scan skills without opening an ACP session and starting its MCP servers.

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

import { CURSOR_PUBLIC_MARKETPLACE, type CursorEnabledPlugin } from "./enabledPlugins.ts";

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const SKILL_MENTION_PATTERN =
  /(^|\s)\p{Sc}(?![0-9][0-9_]*(?:[kKmMbBtT]|[eE][0-9]+)?(?:\s|$))(?=[a-zA-Z0-9:_-]*[a-zA-Z])([a-zA-Z0-9][a-zA-Z0-9:_-]*)(?=\s|$)/gu;
const HAS_SKILL_MENTION_PATTERN = new RegExp(SKILL_MENTION_PATTERN.source, "u");
const SLASH_SKILL_PATTERN = /(?:^|\s)\/([a-zA-Z0-9][a-zA-Z0-9:_-]*)(?=\s|$)/gu;
const MAX_SKILL_DEPTH = 10;
const PLUGIN_MANIFEST_PATHS = [
  ".cursor-plugin/plugin.json",
  ".claude-plugin/plugin.json",
  "plugin.json",
];
const MAX_SKILL_BYTES = ByteSize.bytes(1_000_000);
const MAX_SKILL_SCAN_ENTRIES = 10_000;
const MAX_SKILL_SCAN_STATS = 100_000;
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
  remainingStats: number;
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

const discoverSkillsInRoot = Effect.fn("discoverCursorSkillsInRoot")(function* (input: {
  readonly directory: string;
  readonly scope: "user" | "project" | "system";
  readonly maxDepth?: number;
  readonly budget: CursorSkillScanBudget;
  readonly scannedRoots: Set<string>;
}): Effect.fn.Return<ReadonlyArray<ServerProviderSkill>, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const skills: ServerProviderSkill[] = [];
  if (input.budget.exhausted) return skills;
  const rootDirectory = yield* orUndefined(fileSystem.realPath(input.directory), input.budget);
  if (!rootDirectory) return skills;
  // Symlinked roots may share a tree; do not charge its scan budget twice.
  if (input.scannedRoots.has(rootDirectory)) return skills;
  input.scannedRoots.add(rootDirectory);
  const visitedDirectories = new Set<string>();

  const visit = Effect.fn("visitCursorSkillDirectory")(function* (
    directory: string,
    depth: number,
  ): Effect.fn.Return<void, never> {
    if (input.budget.exhausted) return;
    const resolvedDirectory = yield* orUndefined(fileSystem.realPath(directory), input.budget);
    if (!resolvedDirectory) {
      return;
    }
    if (visitedDirectories.has(resolvedDirectory)) {
      return;
    }
    visitedDirectories.add(resolvedDirectory);
    // Outside-root symlinks expose only their own SKILL.md; never traverse the target tree.
    const insideRoot =
      resolvedDirectory === rootDirectory ||
      resolvedDirectory.startsWith(`${rootDirectory}${path.sep}`);

    if (input.budget.remainingStats === 0) {
      input.budget.exhausted = true;
      return;
    }
    input.budget.remainingStats -= 1;
    const skillPath = path.join(directory, "SKILL.md");
    const skillInfo = yield* orUndefined(fileSystem.stat(skillPath), input.budget);
    if (skillInfo?.type === "File") {
      let frontmatter: CursorSkillFrontmatter | undefined = { cliVisible: true };
      if (skillInfo.size <= MAX_SKILL_BYTES && skillInfo.size <= input.budget.remainingBytes) {
        const contents = yield* orUndefined(fileSystem.readFileString(skillPath));
        if (contents !== undefined) {
          input.budget.remainingBytes -= skillInfo.size;
          frontmatter = parseSkillFrontmatter(contents);
        }
      }
      const name = path.basename(directory).trim();
      if (frontmatter?.cliVisible && name) {
        skills.push({
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
        });
      }
    }

    if (!insideRoot) {
      return;
    }
    const entries = yield* orUndefined(fileSystem.readDirectory(directory), input.budget);
    if (!entries) {
      return;
    }
    for (const entry of [...entries].sort()) {
      // Installed dependencies can exhaust the shared budget and hide unrelated skills.
      if (entry === "node_modules") continue;
      // Files spend no directory budget, so a separate cap keeps a huge file tree bounded.
      if (input.budget.remainingStats === 0) {
        input.budget.exhausted = true;
        return;
      }
      input.budget.remainingStats -= 1;
      const child = path.join(directory, entry);
      const info = yield* orUndefined(fileSystem.stat(child), input.budget);
      // Only directories can hold skills, so only they spend the budget: a skill
      // shipping many ordinary files must not hide its siblings.
      if (info?.type !== "Directory") continue;
      if (depth >= (input.maxDepth ?? MAX_SKILL_DEPTH)) continue;
      if (input.budget.remainingEntries === 0) {
        input.budget.exhausted = true;
        return;
      }
      input.budget.remainingEntries -= 1;
      yield* visit(child, depth + 1);
    }
  });

  yield* visit(rootDirectory, 0);
  return skills;
});

const decodePluginManifest = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ skills: Schema.optional(Schema.Unknown) })),
);

const cursorPluginSkillRoots = Effect.fn("cursorPluginSkillRoots")(function* (
  pluginDirectory: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  for (const manifestPath of PLUGIN_MANIFEST_PATHS) {
    const contents = yield* orUndefined(
      fileSystem.readFileString(path.join(pluginDirectory, manifestPath)),
    );
    if (contents === undefined) continue;
    const manifest = decodePluginManifest(contents);
    if (Option.isNone(manifest)) continue;
    const declared = manifest.value.skills;
    if (declared === undefined) break;
    return (Array.isArray(declared) ? declared : [declared])
      .filter(
        (entry): entry is string =>
          typeof entry === "string" &&
          !entry.includes("..") &&
          !entry.includes("://") &&
          !path.isAbsolute(entry),
      )
      .map((entry) => path.join(pluginDirectory, entry.replace(/SKILL\.md$/, "")));
  }
  return [path.join(pluginDirectory, "skills")];
});

/** The plugins the Cursor SDK loads: every local one, and the enabled ones it has cached. */
const cursorPluginSkillSources = Effect.fn("cursorPluginSkillSources")(function* (
  userHome: string,
  enabledPlugins: ReadonlyArray<CursorEnabledPlugin>,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const pluginsRoot = path.join(userHome, ".cursor", "plugins");
  const children = (directory: string) =>
    orUndefined(fileSystem.readDirectory(directory)).pipe(
      Effect.map((entries) => [...(entries ?? [])].sort()),
    );
  const plugins: Array<{ readonly directory: string; readonly unlisted: boolean }> = [];

  const localRoot = path.join(pluginsRoot, "local");
  const resolvedLocalRoot = yield* orUndefined(fileSystem.realPath(localRoot));
  for (const entry of yield* children(localRoot)) {
    if (entry.startsWith(".")) continue;
    const directory = yield* orUndefined(fileSystem.realPath(path.join(localRoot, entry)));
    // The SDK ignores a local plugin that is a symlink to somewhere outside this folder.
    if (directory?.startsWith(`${resolvedLocalRoot}${path.sep}`)) {
      plugins.push({ directory, unlisted: false });
    }
  }

  const cacheSegment = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, "_");
  for (const plugin of enabledPlugins) {
    const versionsRoot = path.join(
      pluginsRoot,
      "cache",
      cacheSegment(plugin.marketplace),
      cacheSegment(plugin.name),
    );
    // Cursor loads one revision and prunes the rest; until it does, the newest install is current.
    let current: { readonly directory: string; readonly completedAt: number } | undefined;
    for (const version of yield* children(versionsRoot)) {
      const directory = path.join(versionsRoot, version);
      const complete = yield* orUndefined(fileSystem.stat(path.join(directory, ".cache-complete")));
      if (complete?.type !== "File") continue;
      const completedAt = Option.getOrUndefined(complete.mtime)?.getTime() ?? 0;
      if (current === undefined || completedAt > current.completedAt) {
        current = { directory, completedAt };
      }
    }
    if (current !== undefined) {
      plugins.push({
        directory: current.directory,
        unlisted: plugin.marketplace !== CURSOR_PUBLIC_MARKETPLACE,
      });
    }
  }

  const sources: Array<{
    readonly directory: string;
    readonly scope: "user";
    readonly maxDepth: number;
    readonly unlisted: boolean;
  }> = [];
  for (const plugin of plugins) {
    for (const directory of yield* cursorPluginSkillRoots(plugin.directory)) {
      // Like the SDK, a plugin's skills are the folders directly below its skills root.
      sources.push({
        directory,
        scope: "user",
        maxDepth: 1,
        unlisted: plugin.unlisted,
      });
    }
  }
  return sources;
});

const inspectCursorSkills = Effect.fn("inspectCursorSkills")(function* (
  cwd?: string,
  environment: NodeJS.ProcessEnv = process.env,
  enabledPlugins: ReadonlyArray<CursorEnabledPlugin> = [],
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
  const roots = [
    ...(cwd ? rootsBelow(cwd, "project") : []),
    ...rootsBelow(userHome, "user"),
    // Cursor syncs its built-in skills here; same-named user and project skills win.
    { directory: path.join(userHome, ".cursor", "skills-cursor"), scope: "system" as const },
    ...(yield* cursorPluginSkillSources(userHome, enabledPlugins)),
  ];

  const skillsByName = new Map<string, ServerProviderSkill>();
  const unlisted: ServerProviderSkill[] = [];
  const budget: CursorSkillScanBudget = {
    remainingEntries: MAX_SKILL_SCAN_ENTRIES,
    remainingStats: MAX_SKILL_SCAN_STATS,
    remainingBytes: MAX_SKILL_SCAN_BYTES,
    exhausted: false,
    incomplete: false,
  };
  const scannedRoots = new Set<string>();
  for (const root of roots) {
    if (budget.exhausted) break;
    const skills = yield* discoverSkillsInRoot({ ...root, budget, scannedRoots });
    for (const skill of skills) {
      if (skillsByName.has(skill.name)) continue;
      if (!("unlisted" in root && root.unlisted)) {
        skillsByName.set(skill.name, skill);
        continue;
      }
      // The model has no catalog entry to open, so an invoked skill's text travels with the prompt.
      skillsByName.set(skill.name, { ...skill, userInvocationOnly: true });
      if (!skill.userInvocationOnly) unlisted.push(skill);
    }
  }
  return {
    skills: [...skillsByName.values()].sort((left, right) => left.name.localeCompare(right.name)),
    unlisted,
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
  enabledPlugins: ReadonlyArray<CursorEnabledPlugin> = [],
) {
  return (yield* inspectCursorSkills(cwd, environment, enabledPlugins)).skills;
});

/** A session's skills, with the ones the Cursor SDK leaves out of the model's skill catalog. */
export const discoverCursorSessionSkills = Effect.fn("discoverCursorSessionSkills")(function* (
  cwd?: string,
  environment: NodeJS.ProcessEnv = process.env,
  enabledPlugins: ReadonlyArray<CursorEnabledPlugin> = [],
) {
  const { skills, unlisted } = yield* inspectCursorSkills(cwd, environment, enabledPlugins);
  return { skills, unlisted };
});

export const probeCursorSkills = Effect.fn("probeCursorSkills")(function* (
  cwd?: string,
  environment: NodeJS.ProcessEnv = process.env,
  enabledPlugins: ReadonlyArray<CursorEnabledPlugin> = [],
) {
  const inspection = yield* inspectCursorSkills(cwd, environment, enabledPlugins);
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

/** Names invoked as `/name`, the form Cursor uses and `rewriteCursorSkillMentions` produces. */
export function cursorSlashSkillNames(prompt: string): ReadonlySet<string> {
  return new Set(Array.from(prompt.matchAll(SLASH_SKILL_PATTERN), (match) => match[1] ?? ""));
}

/** Cursor hides `disable-model-invocation` skills from the model, so the prompt carries them. */
export function appendCursorInvokedSkills(
  prompt: string,
  skills: ReadonlyArray<{ readonly name: string; readonly contents: string }>,
): string {
  if (skills.length === 0) return prompt;
  const blocks = skills.map(
    (skill) =>
      `<skill name="${skill.name}">\n${skill.contents.replace(FRONTMATTER_PATTERN, "").trim()}\n</skill>`,
  );
  return `${prompt}\n\nThe user invoked these skills. Follow their instructions:\n\n${blocks.join("\n\n")}`;
}

/** Tells the model about the skills its Cursor catalog lacks: those of team marketplace plugins. */
export function appendCursorSkillCatalog(
  prompt: string,
  skills: ReadonlyArray<Pick<ServerProviderSkill, "name" | "description" | "path">>,
): string {
  if (skills.length === 0) return prompt;
  const entries = skills.map(
    (skill) =>
      `- ${skill.name}: ${(skill.description ?? "No description.").replace(/\s+/g, " ")} (${skill.path})`,
  );
  return `${prompt}\n\nThese skills are also in your skill catalog. Before you use one, read its file and follow it:\n\n${entries.join("\n")}`;
}
