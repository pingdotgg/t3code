/**
 * Cursor Agent skill discovery for the `$` picker.
 *
 * Cursor loads `.cursor/skills` and `.agents/skills`, plus Claude and Codex
 * compatibility roots, at user and project scope. Project roots are checked
 * from the git root down to each workspace cwd. Cursor also permits grouping
 * directories below a skills root, so those roots are scanned recursively.
 *
 * @module provider/Drivers/CursorSkills
 */
import * as NodeOS from "node:os";

import type { ServerProviderSkill } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  discoverSkillsFromRoots,
  listAncestorPaths,
  normalizeSkillWorkspaceCwds,
  resolveGitRootPath,
  type SkillDiscoveryRoot,
} from "./SkillDiscovery.ts";

// Compatibility roots first; the shared `.agents` root and Cursor-native root
// take precedence on name collisions at the same directory tier.
const CURSOR_SKILL_DIR_NAMES = [".claude", ".codex", ".agents", ".cursor"] as const;

function skillRootsForDir(
  path: Path.Path,
  dir: string,
  scope: SkillDiscoveryRoot["scope"],
  sourceCwd?: string,
): SkillDiscoveryRoot[] {
  return CURSOR_SKILL_DIR_NAMES.map((name) => ({
    directory: path.join(dir, name, "skills"),
    scope,
    recursive: true,
    ...(sourceCwd ? { sourceCwd } : {}),
  }));
}

export const discoverCursorSkills = Effect.fn("discoverCursorSkills")(function* (
  cwd: string | ReadonlyArray<string>,
): Effect.fn.Return<ReadonlyArray<ServerProviderSkill>, never, FileSystem.FileSystem | Path.Path> {
  const path = yield* Path.Path;
  const roots: SkillDiscoveryRoot[] = skillRootsForDir(path, NodeOS.homedir(), "user");

  for (const projectCwd of normalizeSkillWorkspaceCwds(path, cwd)) {
    const gitRoot = yield* resolveGitRootPath(projectCwd);
    for (const dir of listAncestorPaths(path, projectCwd, gitRoot)) {
      roots.push(...skillRootsForDir(path, dir, "project", projectCwd));
    }
  }

  return yield* discoverSkillsFromRoots(roots);
});
