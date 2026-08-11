/**
 * Grok skill discovery for the `$` picker.
 *
 * Mirrors Grok Build skill locations: native `.grok/skills`, Claude-compatible
 * `.claude/skills`, and user-level `.agents/skills`. Project directories are
 * walked from each workspace cwd up to its repo root. Within a tier, native
 * `.grok/skills` is listed last so it wins name collisions.
 *
 * `cwd` may be one path or many (registered project roots + worktrees).
 * Project skills are tagged with that workspace's `sourceCwd`.
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
  normalizeSkillWorkspaceCwds,
  resolveGitRootPath,
  type SkillDiscoveryRoot,
} from "./SkillDiscovery.ts";

const GROK_USER_SKILL_DIR_NAMES = [".claude", ".agents", ".grok"] as const;
const GROK_PROJECT_SKILL_DIR_NAMES = [".claude", ".grok"] as const;

function skillRootsForDir(
  pathApi: Path.Path,
  dir: string,
  scope: SkillDiscoveryRoot["scope"],
  sourceCwd?: string,
): SkillDiscoveryRoot[] {
  const names = scope === "user" ? GROK_USER_SKILL_DIR_NAMES : GROK_PROJECT_SKILL_DIR_NAMES;
  return names.map((name) => ({
    directory: pathApi.join(dir, name, "skills"),
    scope,
    ...(sourceCwd ? { sourceCwd } : {}),
  }));
}

export const discoverGrokSkills = Effect.fn("discoverGrokSkills")(function* (
  cwd: string | ReadonlyArray<string>,
): Effect.fn.Return<ReadonlyArray<ServerProviderSkill>, never, FileSystem.FileSystem | Path.Path> {
  const path = yield* Path.Path;
  const home = NodeOS.homedir();
  const projectCwds = normalizeSkillWorkspaceCwds(path, cwd);

  // User roots first (compat → native), then project ancestors for each workspace.
  const roots: SkillDiscoveryRoot[] = [...skillRootsForDir(path, home, "user")];

  for (const projectCwd of projectCwds) {
    const gitRoot = yield* resolveGitRootPath(projectCwd);
    roots.push(
      ...listAncestorPaths(path, projectCwd, gitRoot).flatMap((dir) =>
        skillRootsForDir(path, dir, "project", projectCwd),
      ),
    );
  }

  return yield* discoverSkillsFromRoots(roots);
});
