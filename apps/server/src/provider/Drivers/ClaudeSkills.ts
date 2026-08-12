/**
 * ClaudeSkills — filesystem discovery of Claude Code skills for the `$` picker.
 *
 * Claude Code loads skills from `<config dir>/skills` (user scope) and
 * `<cwd>/.claude/skills` (project scope). Cross-agent skills live under
 * `~/.agents/skills` and `<cwd>/.agents/skills`. Each skill is one directory
 * with a `SKILL.md` carrying YAML frontmatter. The Agent SDK init handshake
 * surfaces skills only as slash commands without their filesystem paths, so the
 * provider snapshot scans the same locations directly, mirroring how the
 * Codex app-server reports its skills.
 *
 * @module provider/Drivers/ClaudeSkills
 */
import * as NodeOS from "node:os";

import type { ClaudeSettings, ServerProviderSkill } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { expandHomePath } from "../../pathExpansion.ts";
import { scanFilesystemSkillRoots, type FilesystemSkillScope } from "./AgentSkills.ts";

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
 * Enumerate Claude Code skills from the user config dir, shared `.agents/skills`
 * locations, and the workspace. Discovery is best-effort: unreadable roots and
 * malformed skill entries are skipped so a broken skill never degrades the
 * provider snapshot. Resolution is most-specific-wins on two axes: project
 * scope beats user scope, and within a scope the Claude-native `.claude/skills`
 * root beats the portable `.agents/skills` root of the same name — so a
 * Claude-specific skill keeps running even when a portable namesake exists.
 */
export const discoverClaudeSkills = Effect.fn("discoverClaudeSkills")(function* (
  config: Pick<ClaudeSettings, "homePath">,
  cwd?: string,
  environment?: NodeJS.ProcessEnv,
  options?: { readonly homeDirectory?: string },
): Effect.fn.Return<ReadonlyArray<ServerProviderSkill>, never, FileSystem.FileSystem | Path.Path> {
  const path = yield* Path.Path;
  const configDirPath = yield* resolveClaudeConfigDirPath(config, environment ?? process.env, cwd);
  const homeDirectory = options?.homeDirectory ?? NodeOS.homedir();

  // Order is load-bearing: scanFilesystemSkillRoots lets later roots win on
  // collisions, so `.agents` precedes `.claude` within each scope by design.
  const roots: ReadonlyArray<{ directory: string; scope: FilesystemSkillScope }> = [
    { directory: path.join(homeDirectory, ".agents", "skills"), scope: "user" },
    { directory: path.join(configDirPath, "skills"), scope: "user" },
    ...(cwd
      ? [
          { directory: path.join(cwd, ".agents", "skills"), scope: "project" as const },
          { directory: path.join(cwd, ".claude", "skills"), scope: "project" as const },
        ]
      : []),
  ];

  return yield* scanFilesystemSkillRoots(roots);
});
