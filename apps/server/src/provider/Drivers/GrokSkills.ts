/**
 * Grok skill discovery for the `$` picker.
 *
 * Mirrors Grok Build user-guide skill locations, including `.agents/skills`
 * (and other compat roots) at each tier and a walk from cwd up to the repo
 * root. Within a tier, native `.grok/skills` is listed last so it wins name
 * collisions over compat directories.
 *
 * Callers pass a workspace cwd (typically ServerConfig.cwd). Snapshot skills
 * are process/server-cwd scoped — not per-thread worktree.
 *
 * @module provider/Drivers/GrokSkills
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

/** Compat roots first, native `.grok` last — later wins in discoverSkillsFromRoots. */
const GROK_SKILL_DIR_NAMES = [".cursor", ".claude", ".agents", ".grok"] as const;

function skillRootsForDir(
  pathApi: Path.Path["Service"],
  dir: string,
  scope: SkillDiscoveryRoot["scope"],
): SkillDiscoveryRoot[] {
  return GROK_SKILL_DIR_NAMES.map((name) => ({
    directory: pathApi.join(dir, name, "skills"),
    scope,
  }));
}

export const discoverGrokSkills = Effect.fn("discoverGrokSkills")(function* (
  cwd: string,
): Effect.fn.Return<ReadonlyArray<ServerProviderSkill>, never, FileSystem.FileSystem | Path.Path> {
  const path = yield* Path.Path;
  const home = NodeOS.homedir();
  const gitRoot = yield* resolveGitRootPath(cwd);

  // User roots first (compat → native), then project ancestors git root → cwd.
  // Later roots win so nearer-to-cwd project skills override user skills.
  const roots: SkillDiscoveryRoot[] = [
    ...skillRootsForDir(path, home, "user"),
    ...listAncestorPaths(path, cwd, gitRoot).flatMap((dir) =>
      skillRootsForDir(path, dir, "project"),
    ),
  ];

  return yield* discoverSkillsFromRoots(roots);
});
