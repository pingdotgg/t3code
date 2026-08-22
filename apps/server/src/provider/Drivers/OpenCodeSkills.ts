/**
 * OpenCode skill discovery for the `$` picker.
 *
 * Mirrors OpenCode's documented roots and hierarchy:
 * - Global: `~/.claude/skills`, `~/.agents/skills`, `~/.config/opencode/skills`
 *   (native opencode last so it wins collisions)
 * - Project: at every directory from git root down to each workspace cwd —
 *   `.claude/skills`, `.agents/skills`, `.opencode/skills` (native last)
 *
 * `cwd` may be one path or many (registered project roots + worktrees).
 * Project skills are tagged with that workspace's `sourceCwd`.
 *
 * @module provider/Drivers/OpenCodeSkills
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

function projectSkillRootsForDir(
  pathApi: Path.Path,
  dir: string,
  sourceCwd: string,
): SkillDiscoveryRoot[] {
  return [
    { directory: pathApi.join(dir, ".claude", "skills"), scope: "project", sourceCwd },
    { directory: pathApi.join(dir, ".agents", "skills"), scope: "project", sourceCwd },
    { directory: pathApi.join(dir, ".opencode", "skill"), scope: "project", sourceCwd },
    { directory: pathApi.join(dir, ".opencode", "skills"), scope: "project", sourceCwd },
  ];
}

export const discoverOpenCodeSkills = Effect.fn("discoverOpenCodeSkills")(function* (
  cwd: string | ReadonlyArray<string>,
): Effect.fn.Return<ReadonlyArray<ServerProviderSkill>, never, FileSystem.FileSystem | Path.Path> {
  const path = yield* Path.Path;
  const home = NodeOS.homedir();
  const projectCwds = normalizeSkillWorkspaceCwds(path, cwd);

  // User: lower-priority globals first, native opencode config last.
  // Project: every monorepo level from git root → each workspace cwd.
  const roots: SkillDiscoveryRoot[] = [
    { directory: path.join(home, ".claude", "skills"), scope: "user" },
    { directory: path.join(home, ".agents", "skills"), scope: "user" },
    { directory: path.join(home, ".config", "opencode", "skill"), scope: "user" },
    { directory: path.join(home, ".config", "opencode", "skills"), scope: "user" },
  ];

  for (const projectCwd of projectCwds) {
    const gitRoot = yield* resolveGitRootPath(projectCwd);
    roots.push(
      ...listAncestorPaths(path, projectCwd, gitRoot).flatMap((dir) =>
        projectSkillRootsForDir(path, dir, projectCwd),
      ),
    );
  }

  return yield* discoverSkillsFromRoots(roots);
});
