/**
 * CursorSkills — filesystem discovery of Cursor agent skills for the `$` picker.
 *
 * Cursor Agent loads skills from user and project Agent Skills directories.
 * T3's Cursor provider snapshot historically left `skills` empty, so the
 * composer `$` picker had nothing to show even when `SKILL.md` files existed
 * on disk. This scanner fills the snapshot the same way Claude's filesystem
 * inventory does, without waiting on ACP `available_commands_update`.
 *
 * Scan order is later-write-wins:
 *   user `.agents/skills` → user `.cursor/skills-cursor` → user `.cursor/skills`
 *   → each project `.agents/skills` → that project's `.cursor/skills`
 *
 * Project beats user. `.cursor` beats `.agents`. Cursor's directory name is
 * the skill name (frontmatter `name` is ignored for identity).
 *
 * @module provider/Drivers/CursorSkills
 */
import * as NodeOS from "node:os";

import type { ServerProviderSkill } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { parse as parseYamlDocument } from "yaml";

type CursorSkillScope = "user" | "project";

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

type SkillFrontmatter =
  | { readonly kind: "missing" }
  | { readonly kind: "malformed" }
  | { readonly kind: "parsed"; readonly name?: string; readonly description?: string };

export interface DiscoverCursorSkillsInput {
  readonly cwd?: string;
  readonly extraProjectCwds?: ReadonlyArray<string>;
  readonly homeDir?: string;
}

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

export function isUsableCursorSkillProjectCwd(cwd: string | undefined): cwd is string {
  const trimmed = cwd?.trim() ?? "";
  return trimmed.length > 0 && trimmed !== "/" && trimmed !== "\\";
}

/**
 * Enumerate Cursor skills from user config dirs and one or more workspaces.
 * Discovery is best-effort: unreadable roots and malformed skill entries are
 * skipped so a broken skill never degrades the provider snapshot.
 */
export const discoverCursorSkills = Effect.fn("discoverCursorSkills")(function* (
  input: DiscoverCursorSkillsInput = {},
): Effect.fn.Return<ReadonlyArray<ServerProviderSkill>, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const homeDir = input.homeDir?.trim() || NodeOS.homedir();

  const projectCwds: Array<string> = [];
  const seenProjectCwds = new Set<string>();
  const addProjectCwd = (cwd: string | undefined) => {
    if (!isUsableCursorSkillProjectCwd(cwd)) {
      return;
    }
    const resolved = path.resolve(cwd);
    if (seenProjectCwds.has(resolved)) {
      return;
    }
    seenProjectCwds.add(resolved);
    projectCwds.push(resolved);
  };
  addProjectCwd(input.cwd);
  for (const extra of input.extraProjectCwds ?? []) {
    addProjectCwd(extra);
  }

  const roots: Array<{ directory: string; scope: CursorSkillScope }> = [
    { directory: path.join(homeDir, ".agents", "skills"), scope: "user" },
    { directory: path.join(homeDir, ".cursor", "skills-cursor"), scope: "user" },
    { directory: path.join(homeDir, ".cursor", "skills"), scope: "user" },
  ];
  for (const projectCwd of projectCwds) {
    roots.push(
      { directory: path.join(projectCwd, ".agents", "skills"), scope: "project" },
      { directory: path.join(projectCwd, ".cursor", "skills"), scope: "project" },
    );
  }

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

      // Cursor identifies skills by directory name, not frontmatter `name`.
      const name = entry.trim();
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
