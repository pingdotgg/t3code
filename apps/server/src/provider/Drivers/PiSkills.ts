/**
 * PiSkills — filesystem discovery of Pi skills for the `$` picker.
 *
 * Pi loads skills from:
 *   - Global: `~/.pi/agent/skills/`, `~/.agents/skills/`
 *   - Project (trusted): `.pi/skills/`, `.agents/skills/` in `cwd` and ancestors
 *     up to the filesystem root (mirrors Pi's ancestor walk).
 *
 * One directory per skill with a `SKILL.md` carrying YAML frontmatter.
 * Later roots win on name collisions so project skills override user skills.
 *
 * @module provider/Drivers/PiSkills
 */
import * as NodeOS from "node:os";

import type { ServerProviderSkill } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { parse as parseYamlDocument } from "yaml";

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

type PiSkillScope = "user" | "project";

function ancestorDirectories(cwd: string, path: Path.Path): ReadonlyArray<string> {
  const resolved = path.resolve(cwd);
  const ancestors: string[] = [];
  let cursor = resolved;
  const seen = new Set<string>();
  while (true) {
    if (!seen.has(cursor)) {
      seen.add(cursor);
      ancestors.push(cursor);
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return ancestors;
}

export const discoverPiSkills = Effect.fn("discoverPiSkills")(function* (
  cwd?: string,
  _environment?: NodeJS.ProcessEnv,
): Effect.fn.Return<ReadonlyArray<ServerProviderSkill>, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const homedir = NodeOS.homedir();

  // Global roots — always scanned.
  const globalRoots: ReadonlyArray<{ directory: string; scope: PiSkillScope }> = [
    { directory: path.join(homedir, ".pi", "agent", "skills"), scope: "user" },
    { directory: path.join(homedir, ".agents", "skills"), scope: "user" },
  ];

  // Project roots — cwd and ancestors for .pi/skills and .agents/skills.
  const projectRoots: ReadonlyArray<{ directory: string; scope: PiSkillScope }> = cwd
    ? ancestorDirectories(cwd, path).flatMap((ancestor) => [
        { directory: path.join(ancestor, ".pi", "skills"), scope: "project" as const },
        { directory: path.join(ancestor, ".agents", "skills"), scope: "project" as const },
      ])
    : [];

  // Also include cwd's .claude/skills for shared skill reuse? Pi docs say
  // users can add ~/.claude/skills via settings.skills, but discovery for
  // `$` picker should surface project-local .claude/skills when present,
  // mirroring Claude's behavior for cross-harness reuse.
  const crossHarnessProjectRoots: ReadonlyArray<{ directory: string; scope: PiSkillScope }> = cwd
    ? [{ directory: path.join(cwd, ".claude", "skills"), scope: "project" as const }]
    : [];

  // Order: global first, then project ancestors (cwd first, then parents outward).
  // Later entries win on name collision, so project overrides user.
  const roots = [...globalRoots, ...projectRoots, ...crossHarnessProjectRoots];

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
      // Skip if already set by a later (higher priority) root? Actually we
      // iterate in priority order user -> project, and later should win, so
      // always set (overwrites).
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
