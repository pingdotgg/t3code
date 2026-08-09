/**
 * Shared filesystem discovery for agent `SKILL.md` packages used by the `$`
 * skill picker. Harnesses differ in which roots they scan; this module owns
 * frontmatter parsing and root enumeration only.
 *
 * @module provider/Drivers/SkillDiscovery
 */
import type { ServerProviderSkill } from "@t3tools/contracts";
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
  pathApi: Path.Path["Service"],
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
 * Collect skills from ordered roots. Later roots override earlier ones on name
 * collision (callers should list user roots first, then project roots, so
 * project wins — matching Claude/OpenCode "most specific wins").
 */
export const discoverSkillsFromRoots = Effect.fn("discoverSkillsFromRoots")(function* (
  roots: ReadonlyArray<SkillDiscoveryRoot>,
): Effect.fn.Return<ReadonlyArray<ServerProviderSkill>, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const skillsByName = new Map<string, ServerProviderSkill>();

  for (const root of roots) {
    const entries = yield* fileSystem
      .readDirectory(root.directory)
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));

    for (const entry of [...entries].sort()) {
      const skillPath = path.join(root.directory, entry, "SKILL.md");
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

      const name = (frontmatter.kind === "parsed" ? frontmatter.name : undefined) ?? entry.trim();
      if (!name) {
        continue;
      }

      skillsByName.set(name, {
        name,
        path: skillPath,
        enabled: true,
        scope: root.scope,
        ...(frontmatter.kind === "parsed" && frontmatter.description
          ? { description: frontmatter.description }
          : {}),
      });
    }
  }

  return [...skillsByName.values()].sort((left, right) => left.name.localeCompare(right.name));
});
