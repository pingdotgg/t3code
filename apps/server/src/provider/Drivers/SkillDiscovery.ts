/**
 * Shared filesystem discovery for agent `SKILL.md` packages used by the `$`
 * skill picker. Harnesses differ in which roots they scan; this module owns
 * frontmatter parsing and root enumeration only.
 *
 * @module provider/Drivers/SkillDiscovery
 */
import type { ServerProviderSkill } from "@t3tools/contracts";
import { normalizeProviderSkillWorkspacePath } from "@t3tools/shared/providerSkills";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { parse as parseYamlDocument } from "yaml";

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

export type SkillFrontmatter =
  | { readonly kind: "missing" }
  | { readonly kind: "malformed" }
  | { readonly kind: "parsed"; readonly name?: string; readonly description?: string };

export function parseSkillFrontmatter(contents: string): SkillFrontmatter {
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

export type SkillDiscoveryScope = NonNullable<ServerProviderSkill["scope"]>;

export interface SkillDiscoveryRoot {
  readonly directory: string;
  readonly scope: SkillDiscoveryScope;
  /** Cursor permits organizational directories below a skills root. */
  readonly recursive?: boolean;
  /**
   * Workspace cwd this project root belongs to. Stamped onto discovered
   * skills so clients can scope the `$` picker to one project/worktree.
   * Omit for user/global roots.
   */
  readonly sourceCwd?: string;
}

/**
 * Walk `startDir` and its parents until a directory containing `.git` is found
 * (or the filesystem root). Used by OpenCode/Grok-style discovery.
 */
export const resolveGitRootPath = Effect.fn("resolveGitRootPath")(function* (
  startDir: string,
): Effect.fn.Return<string, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  let current = path.resolve(startDir);
  for (;;) {
    const gitPath = path.join(current, ".git");
    const exists = yield* fileSystem.exists(gitPath).pipe(Effect.orElseSucceed(() => false));
    if (exists) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return path.resolve(startDir);
    }
    current = parent;
  }
});

/**
 * Paths from `gitRoot` down to `startDir` (inclusive), root first so nearer
 * directories can be appended later and win under later-wins skill maps.
 * Used by harnesses that scan skill dirs at every monorepo package level.
 */
export function listAncestorPaths(
  pathApi: Path.Path,
  startDir: string,
  gitRoot: string,
): ReadonlyArray<string> {
  const fromCwd: string[] = [];
  let current = pathApi.resolve(startDir);
  const stop = pathApi.resolve(gitRoot);
  for (;;) {
    fromCwd.push(current);
    if (current === stop) {
      break;
    }
    const parent = pathApi.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return fromCwd.toReversed();
}

/**
 * Normalize a single workspace path or list into absolute unique paths.
 * Empty / whitespace entries are dropped.
 */
export function normalizeSkillWorkspaceCwds(
  pathApi: Path.Path,
  cwd: string | ReadonlyArray<string> | undefined,
): ReadonlyArray<string> {
  if (cwd === undefined) {
    return [];
  }
  const values = typeof cwd === "string" ? [cwd] : [...cwd];
  const resolved = new Set<string>();
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      resolved.add(pathApi.resolve(trimmed));
    }
  }
  return [...resolved];
}

/**
 * Collision key: user/global skills collide by name only; project skills
 * collide by (sourceCwd, name) so the same skill name can exist in two
 * workspaces without one wiping the other from the inventory.
 */
function skillInventoryKey(name: string, sourceCwd: string | undefined): string {
  return sourceCwd === undefined ? `user:${name}` : `cwd:${sourceCwd}\0${name}`;
}

/**
 * Collect skills from ordered roots. Later roots override earlier ones on
 * name collision within the same inventory key (callers should list user
 * roots first, then project roots for a given workspace, so project wins —
 * matching Claude/OpenCode "most specific wins"). Skills from different
 * `sourceCwd` values are kept side by side.
 */
export const discoverSkillsFromRoots = Effect.fn("discoverSkillsFromRoots")(function* (
  roots: ReadonlyArray<SkillDiscoveryRoot>,
): Effect.fn.Return<ReadonlyArray<ServerProviderSkill>, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const skillsByKey = new Map<string, ServerProviderSkill>();

  for (const root of roots) {
    // path.resolve first (absolute), then shared normalizer so server stamps
    // match client filterProviderSkillsForWorkspace comparison.
    const sourceCwd = root.sourceCwd?.trim()
      ? normalizeProviderSkillWorkspacePath(path.resolve(root.sourceCwd.trim()))
      : undefined;
    const entries = yield* fileSystem
      .readDirectory(root.directory, { recursive: root.recursive ?? false })
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));

    for (const entry of [...entries].sort()) {
      if (root.recursive && path.basename(entry) !== "SKILL.md") {
        continue;
      }
      const skillPath = root.recursive
        ? path.join(root.directory, entry)
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

      const directoryName = root.recursive ? path.basename(path.dirname(entry)) : entry.trim();
      const name = (frontmatter.kind === "parsed" ? frontmatter.name : undefined) ?? directoryName;
      if (!name) {
        continue;
      }

      skillsByKey.set(skillInventoryKey(name, sourceCwd), {
        name,
        path: skillPath,
        enabled: true,
        scope: root.scope,
        ...(sourceCwd ? { sourceCwd } : {}),
        ...(frontmatter.kind === "parsed" && frontmatter.description
          ? { description: frontmatter.description }
          : {}),
      });
    }
  }

  return [...skillsByKey.values()].sort((left, right) => {
    const byName = left.name.localeCompare(right.name);
    if (byName !== 0) {
      return byName;
    }
    return (left.sourceCwd ?? "").localeCompare(right.sourceCwd ?? "");
  });
});
