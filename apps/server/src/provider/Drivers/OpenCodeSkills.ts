/**
 * OpenCode skill discovery for the `$` picker.
 *
 * Mirrors OpenCode's documented roots and hierarchy:
 * - Global: `~/.claude/skills`, `~/.agents/skills`, `~/.config/opencode/skills`
 *   (native opencode last so it wins collisions)
 * - Project: at every directory from git root down to the workspace cwd —
 *   `.claude/skills`, `.agents/skills`, `.opencode/skills` (native last)
 *
 * Callers pass a workspace cwd (typically ServerConfig.cwd). Snapshot skills
 * are process/server-cwd scoped — not per-thread worktree.
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
  resolveGitRootPath,
  type SkillDiscoveryRoot,
} from "./SkillDiscovery.ts";

/** Compat roots first, native `.opencode` last — later wins in discoverSkillsFromRoots. */
const OPENCODE_PROJECT_SKILL_DIR_NAMES = [".claude", ".agents", ".opencode"] as const;

function projectSkillRootsForDir(pathApi: Path.Path["Service"], dir: string): SkillDiscoveryRoot[] {
  return OPENCODE_PROJECT_SKILL_DIR_NAMES.map((name) => ({
    directory: pathApi.join(dir, name, "skills"),
    scope: "project" as const,
  }));
}

export const discoverOpenCodeSkills = Effect.fn("discoverOpenCodeSkills")(function* (
  cwd: string,
): Effect.fn.Return<ReadonlyArray<ServerProviderSkill>, never, FileSystem.FileSystem | Path.Path> {
  const path = yield* Path.Path;
  const home = NodeOS.homedir();
  const gitRoot = yield* resolveGitRootPath(cwd);

  // User: lower-priority globals first, native opencode config last.
  // Project: every monorepo level from git root → cwd; native .opencode last per tier.
  const roots: SkillDiscoveryRoot[] = [
    { directory: path.join(home, ".claude", "skills"), scope: "user" },
    { directory: path.join(home, ".agents", "skills"), scope: "user" },
    { directory: path.join(home, ".config", "opencode", "skills"), scope: "user" },
    ...listAncestorPaths(path, cwd, gitRoot).flatMap((dir) => projectSkillRootsForDir(path, dir)),
  ];

  return yield* discoverSkillsFromRoots(roots);
});
