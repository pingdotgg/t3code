/**
 * CursorSkills — filesystem discovery of Cursor Agent skills for the `$` picker.
 *
 * Cursor loads skills from `.cursor`, `.agents`, `.codex`, and `.claude`
 * roots at both user and project scope, one directory per skill with a
 * `SKILL.md`. Unlike Codex, Cursor's ACP surface exposes skills only as
 * slash-command metadata mixed in with commands and built-ins, without
 * filesystem paths or a stable scope tag, so we scan the same locations
 * directly.
 *
 * Discovery is per working directory: two projects in one environment have
 * different project roots, and a thread running in a worktree resolves to that
 * worktree. Nothing here is cached or hung off the provider status snapshot.
 *
 * ## Behavior verified against `cursor-agent` 2026.07.20-8cc9c0b
 *
 * Observed by driving a real `cursor-agent acp` session against a fixture
 * project and reading its `available_commands_update` inventory. These rules
 * are stricter or looser than Cursor's published docs in places; the docs lost:
 *
 *  - A skill's name is its **directory name**. A `name:` in frontmatter that
 *    disagrees is ignored — Cursor listed `mismatched-dir`, not the
 *    `renamed-skill` its frontmatter declared.
 *  - `description` is optional. When frontmatter omits it (or omits
 *    frontmatter entirely) Cursor falls back to the body's first Markdown
 *    heading, so we do too rather than showing a blank picker row.
 *  - Frontmatter is optional and its absence is not an error.
 *  - Names are not restricted to lowercase ASCII and hyphens; a
 *    `Weird_Name` directory loaded and listed verbatim.
 *  - `.cursor/skills` wins over `.agents/skills` within the same scope: a
 *    name present in both listed once, with the `.cursor` description.
 *  - Roots are searched recursively, so `shipping/land-it/SKILL.md` loads.
 *
 * Invocation was also verified there: `$name`, `/name`, and even a bare `name`
 * all load the skill, because Cursor resolves skills model-side from injected
 * metadata rather than expanding a slash token in the harness. Cursor rows
 * therefore use `$name`, which preserves composer chips and avoids colliding
 * with the slash-command trigger.
 *
 * @module provider/Drivers/CursorSkills
 */
import * as NodeOS from "node:os";

import type { ServerProviderSkill } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { parse as parseYamlDocument } from "yaml";

type CursorSkillScope = "user" | "project";

interface CursorSkillRoot {
  readonly directory: string;
  readonly boundary: string;
  readonly scope: CursorSkillScope;
}

/**
 * Cap on metadata bytes read per `SKILL.md`. Skill bodies are prose and can be
 * long; we only ever need the frontmatter and the first heading, and the body
 * must never cross the wire.
 */
const SKILL_METADATA_READ_LIMIT = 64 * 1024;

/** Guard against a pathological skills root; far above any real inventory. */
const MAX_SKILLS_PER_ROOT = 500;

/** Bound traversal even when a pathological root contains no skills. */
export const MAX_DIRECTORIES_PER_ROOT = 2_000;

/** Bound per-entry sorting and stat work in unusually wide directory trees. */
export const MAX_ENTRIES_PER_ROOT = 10_000;

const FRONTMATTER_PATTERN = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;
const FENCE_PATTERN = /^[ \t]{0,3}(`{3,}|~{3,})(.*)$/;
const HEADING_PATTERN = /^[ \t]{0,3}#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/;
const UTF8_BOM = "\ufeff";

const utf8Decoder = new TextDecoder("utf-8");

/** Find the first ATX heading that Markdown renders outside a fenced code block. */
function firstBodyHeading(body: string): string | undefined {
  let fence: { readonly marker: "`" | "~"; readonly length: number } | undefined;

  for (const line of body.split(/\r?\n/)) {
    const fenceMatch = FENCE_PATTERN.exec(line);
    const fenceRun = fenceMatch?.[1];

    if (fence) {
      if (
        fenceRun?.startsWith(fence.marker) === true &&
        fenceRun.length >= fence.length &&
        fenceMatch?.[2]?.trim().length === 0
      ) {
        fence = undefined;
      }
      continue;
    }

    if (fenceRun) {
      const marker = fenceRun[0] as "`" | "~";
      const info = fenceMatch?.[2] ?? "";
      // Backticks in a backtick fence's info string make it plain text under
      // CommonMark, while tilde fences have no corresponding restriction.
      if (marker === "~" || !info.includes("`")) {
        fence = { marker, length: fenceRun.length };
        continue;
      }
    }

    const headingText = HEADING_PATTERN.exec(line)?.[1]?.trim();
    if (headingText) return headingText;
  }

  return undefined;
}

/**
 * Pull a display description out of `SKILL.md`, preferring frontmatter and
 * falling back to the body's first heading the way Cursor does. Returns
 * `undefined` when neither is usable; the picker then shows the name alone.
 */
function parseSkillDescription(contents: string): string | undefined {
  const body = contents.startsWith(UTF8_BOM) ? contents.slice(UTF8_BOM.length) : contents;
  const match = FRONTMATTER_PATTERN.exec(body);

  if (match) {
    let parsed: unknown;
    try {
      parsed = parseYamlDocument(match[1] ?? "");
    } catch {
      parsed = undefined;
    }
    if (typeof parsed === "object" && parsed !== null) {
      const declared = (parsed as Record<string, unknown>).description;
      if (typeof declared === "string" && declared.trim().length > 0) {
        return declared.trim();
      }
    }
  }

  return firstBodyHeading(match ? body.slice(match[0].length) : body);
}

/**
 * Resolve the home directory Cursor's subprocess would see. Callers pass the
 * already-merged provider instance environment so discovery and the spawned
 * CLI agree; `os.homedir()` is only a last resort. Exported for tests, which
 * exercise the Windows branches without a Windows worker.
 *
 * `platform` comes from `HostProcessPlatform` so tests can drive either branch.
 */
export function resolveCursorHomeDirectory(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string {
  const read = (key: string): string | undefined => {
    const value = environment[key]?.trim();
    return value && value.length > 0 ? value : undefined;
  };

  if (platform === "win32") {
    const userProfile = read("USERPROFILE");
    if (userProfile) return userProfile;
    const homeDrive = read("HOMEDRIVE");
    const homePath = read("HOMEPATH");
    if (homeDrive && homePath) return `${homeDrive}${homePath}`;
  } else {
    const home = read("HOME");
    if (home) return home;
  }

  return NodeOS.homedir();
}

/**
 * The eight roots Cursor reads, lowest precedence first: `.claude`, `.codex`,
 * `.agents`, then `.cursor` within each scope. Later roots overwrite earlier
 * ones by name, and all project roots follow all user roots so project scope
 * wins.
 */
function buildSkillRoots(input: {
  readonly path: Path.Path;
  readonly homeDirectory: string;
  readonly cwd: string;
}): ReadonlyArray<CursorSkillRoot> {
  const home = input.path.resolve(input.homeDirectory);
  const workspace = input.path.resolve(input.cwd);
  return [
    { directory: input.path.join(home, ".claude", "skills"), boundary: home, scope: "user" },
    { directory: input.path.join(home, ".codex", "skills"), boundary: home, scope: "user" },
    { directory: input.path.join(home, ".agents", "skills"), boundary: home, scope: "user" },
    { directory: input.path.join(home, ".cursor", "skills"), boundary: home, scope: "user" },
    {
      directory: input.path.join(workspace, ".claude", "skills"),
      boundary: workspace,
      scope: "project",
    },
    {
      directory: input.path.join(workspace, ".codex", "skills"),
      boundary: workspace,
      scope: "project",
    },
    {
      directory: input.path.join(workspace, ".agents", "skills"),
      boundary: workspace,
      scope: "project",
    },
    {
      directory: input.path.join(workspace, ".cursor", "skills"),
      boundary: workspace,
      scope: "project",
    },
  ];
}

/**
 * Read at most `SKILL_METADATA_READ_LIMIT` bytes of a `SKILL.md`. A single
 * bounded `readAlloc` rather than `readFileString` plus a slice, so a huge
 * skill body is never pulled into memory. Unreadable files yield `undefined`
 * and skip only that skill.
 */
const readSkillMetadata = Effect.fn("readSkillMetadata")(function* (
  skillPath: string,
): Effect.fn.Return<string | undefined, never, FileSystem.FileSystem> {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const file = yield* fileSystem.open(skillPath, { flag: "r" });
      const bytes = yield* file.readAlloc(FileSystem.Size(SKILL_METADATA_READ_LIMIT));
      return Option.match(bytes, {
        onNone: () => "",
        onSome: (value) => utf8Decoder.decode(value),
      });
    }),
  ).pipe(Effect.orElseSucceed(() => undefined));
});

/**
 * Walk one skills root, collecting every directory that directly contains a
 * `SKILL.md`. Recursion is what makes organizational category directories
 * (`shipping/land-it/SKILL.md`) work, and is confined to the four known roots
 * — this never scans the workspace looking for hidden roots.
 *
 * Symlinked skill directories are followed only while their canonical target
 * remains inside the canonical skill root. The root itself must remain inside
 * its user-home or workspace boundary. Resolved paths are tracked so a cycle
 * terminates, and an unreadable directory skips only its subtree.
 */
const collectSkillsInRoot = Effect.fn("collectSkillsInRoot")(function* (input: {
  readonly root: CursorSkillRoot;
}): Effect.fn.Return<ReadonlyArray<ServerProviderSkill>, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const collected: Array<ServerProviderSkill> = [];
  const visited = new Set<string>();
  let entriesInspected = 0;

  const isWithin = (candidate: string, root: string): boolean => {
    const relative = path.relative(root, candidate);
    return (
      relative === "" ||
      (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
    );
  };

  const resolvedBoundary = yield* fileSystem
    .realPath(input.root.boundary)
    .pipe(Effect.orElseSucceed(() => undefined));
  const resolvedRoot = yield* fileSystem
    .realPath(input.root.directory)
    .pipe(Effect.orElseSucceed(() => undefined));
  if (
    resolvedBoundary === undefined ||
    resolvedRoot === undefined ||
    !isWithin(resolvedRoot, resolvedBoundary)
  ) {
    return collected;
  }

  const walk = (directory: string): Effect.Effect<void, never, FileSystem.FileSystem> =>
    Effect.gen(function* () {
      if (collected.length >= MAX_SKILLS_PER_ROOT || visited.size >= MAX_DIRECTORIES_PER_ROOT) {
        return;
      }

      const resolved = yield* fileSystem
        .realPath(directory)
        .pipe(Effect.orElseSucceed(() => undefined));
      if (resolved === undefined || !isWithin(resolved, resolvedRoot)) return;
      if (visited.has(resolved)) return;
      if (visited.size >= MAX_DIRECTORIES_PER_ROOT) return;
      visited.add(resolved);

      const entries = yield* fileSystem
        .readDirectory(resolved)
        .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));

      const skillPath = path.join(directory, "SKILL.md");
      if (entries.includes("SKILL.md")) {
        const resolvedSkillPath = yield* fileSystem
          .realPath(path.join(resolved, "SKILL.md"))
          .pipe(Effect.orElseSucceed(() => undefined));
        const contents =
          resolvedSkillPath !== undefined && isWithin(resolvedSkillPath, resolvedRoot)
            ? yield* readSkillMetadata(resolvedSkillPath)
            : undefined;
        // Cursor names a skill after the directory that holds its SKILL.md,
        // ignoring any frontmatter `name`.
        const name = path.basename(directory).trim();
        if (contents !== undefined && name.length > 0) {
          const description = parseSkillDescription(contents);
          collected.push({
            name,
            path: skillPath,
            enabled: true,
            scope: input.root.scope,
            ...(description ? { description } : {}),
          });
        }

        // A directory containing SKILL.md is a skill package, not another
        // category root. Its scripts, references, and assets must not consume
        // the shared traversal budget and hide later sibling skills.
        return;
      }

      const remainingEntries = MAX_ENTRIES_PER_ROOT - entriesInspected;
      if (entries.length > remainingEntries) return;
      entriesInspected += entries.length;

      for (const entry of [...entries].sort()) {
        if (collected.length >= MAX_SKILLS_PER_ROOT || visited.size >= MAX_DIRECTORIES_PER_ROOT) {
          return;
        }
        if (entry === "SKILL.md") continue;
        const child = path.join(directory, entry);
        const info = yield* fileSystem.stat(child).pipe(Effect.orElseSucceed(() => undefined));
        if (info?.type !== "Directory") continue;
        yield* walk(child);
      }
    });

  yield* walk(input.root.directory);
  return collected;
});

/**
 * Enumerate the Cursor skills available to an agent running in `cwd`.
 *
 * `environment` must be the merged provider instance environment so the home
 * roots match the ones the spawned `cursor-agent` reads. Discovery is
 * best-effort and has no error channel: an unreadable root, directory, or file
 * removes only what it covers, so a broken skill can never degrade provider
 * health or fail the picker.
 */
export const discoverCursorSkills = Effect.fn("discoverCursorSkills")(function* (
  cwd: string,
  environment: NodeJS.ProcessEnv,
): Effect.fn.Return<ReadonlyArray<ServerProviderSkill>, never, FileSystem.FileSystem | Path.Path> {
  const path = yield* Path.Path;
  const platform = yield* HostProcessPlatform;
  const roots = buildSkillRoots({
    path,
    homeDirectory: resolveCursorHomeDirectory(environment, platform),
    cwd,
  });

  // Root scans are independent filesystem work. `Effect.forEach` preserves
  // input order, so bounded concurrency does not change precedence merging.
  const inventories = yield* Effect.forEach(roots, (root) => collectSkillsInRoot({ root }), {
    concurrency: 4,
  });

  // Lowest precedence first, so later roots win: project over user, and
  // `.cursor` over `.agents`, `.codex`, and `.claude` within a scope.
  const skillsByName = new Map<string, ServerProviderSkill>();
  for (const inventory of inventories) {
    for (const skill of inventory) {
      skillsByName.set(skill.name, skill);
    }
  }

  return [...skillsByName.values()].sort((left, right) => left.name.localeCompare(right.name));
});
