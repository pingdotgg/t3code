/**
 * ClaudeSkills — filesystem discovery of Claude Code skills for the `$` picker.
 *
 * Claude Code loads skills from `<config dir>/skills` (user scope), then from
 * `.agents/skills` and `.claude/skills` in the workspace and parent
 * directories up to the repo root (project scope), one directory per skill
 * with a `SKILL.md` carrying YAML frontmatter. Later roots win on name
 * collisions, so precedence is user, `.agents`, then `.claude`. The Agent SDK
 * init handshake surfaces skills only as slash commands without their
 * filesystem paths, so the provider snapshot scans the same locations
 * directly, mirroring how the Codex app-server reports its skills.
 *
 * `cwd` may be one path or many (registered project roots + worktrees). User
 * skills are loaded once; project roots from every workspace are scanned.
 *
 * @module provider/Drivers/ClaudeSkills
 */
import * as NodeOS from "node:os";

import type { ClaudeSettings, ServerProviderSkill } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { expandHomePath } from "../../pathExpansion.ts";
import {
  discoverSkillsFromRoots,
  listAncestorPaths,
  normalizeSkillWorkspaceCwds,
  resolveGitRootPath,
  type SkillDiscoveryRoot,
} from "./SkillDiscovery.ts";

/**
 * Resolve the Claude config directory the CLI would use, matching the
 * precedence the spawned CLI sees: the instance's `homePath` (exported as
 * `CLAUDE_CONFIG_DIR` by `makeClaudeEnvironment`), then a `CLAUDE_CONFIG_DIR`
 * already present in the process environment, then `~/.claude`.
 */
const resolveClaudeConfigDirPath = Effect.fn("resolveClaudeConfigDirPath")(function* (
  config: Pick<ClaudeSettings, "homePath">,
  environment: NodeJS.ProcessEnv,
  cwd?: string,
): Effect.fn.Return<string, never, Path.Path> {
  const path = yield* Path.Path;
  const homePath = config.homePath.trim();
  if (homePath.length > 0) {
    return path.resolve(expandHomePath(homePath));
  }
  // No tilde expansion here: the spawned CLI receives this env var verbatim
  // (env vars are never shell-expanded), so a literal `~` must stay literal
  // for discovery to scan the same directory the runtime would. A relative
  // value is resolved against the workspace cwd — the subprocess's own cwd —
  // for the same reason.
  const environmentConfigDir = environment.CLAUDE_CONFIG_DIR?.trim() ?? "";
  if (environmentConfigDir.length > 0) {
    return cwd ? path.resolve(cwd, environmentConfigDir) : path.resolve(environmentConfigDir);
  }
  return path.join(NodeOS.homedir(), ".claude");
});

/**
 * Enumerate Claude Code skills from the user config dir, then project
 * `.agents/skills` and `.claude/skills` dirs for each workspace cwd
 * (git root → cwd). Discovery is best-effort: unreadable roots and malformed
 * skill entries are skipped so a broken skill never degrades the provider
 * snapshot. On name collisions, later roots win: `.agents` beats user and
 * `.claude` beats `.agents`, matching Claude Code's resolution.
 */
export const discoverClaudeSkills = Effect.fn("discoverClaudeSkills")(function* (
  config: Pick<ClaudeSettings, "homePath">,
  cwd?: string | ReadonlyArray<string>,
  environment?: NodeJS.ProcessEnv,
): Effect.fn.Return<ReadonlyArray<ServerProviderSkill>, never, FileSystem.FileSystem | Path.Path> {
  const path = yield* Path.Path;
  const resolvedEnvironment = environment ?? process.env;
  const projectCwds = normalizeSkillWorkspaceCwds(path, cwd);
  const configDirPath = yield* resolveClaudeConfigDirPath(
    config,
    resolvedEnvironment,
    projectCwds[0],
  );

  const roots: SkillDiscoveryRoot[] = [
    { directory: path.join(configDirPath, "skills"), scope: "user" },
  ];

  for (const projectCwd of projectCwds) {
    const gitRoot = yield* resolveGitRootPath(projectCwd);
    for (const dir of listAncestorPaths(path, projectCwd, gitRoot)) {
      roots.push(
        { directory: path.join(dir, ".agents", "skills"), scope: "project" },
        { directory: path.join(dir, ".claude", "skills"), scope: "project" },
      );
    }
  }

  return yield* discoverSkillsFromRoots(roots);
});
