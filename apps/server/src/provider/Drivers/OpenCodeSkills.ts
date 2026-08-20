/**
 * OpenCodeSkills — filesystem discovery of OpenCode skills for the `$` picker.
 *
 * OpenCode loads skills from user directories (~/.claude/skills, ~/.agents/skills,
 * ~/.config/opencode/skills, ~/.opencode/skills, or $OPENCODE_CONFIG_DIR/skills),
 * then project directories from git ancestors down to <cwd> (.claude/skills,
 * .agents/skills, and .opencode/skills), one directory per skill with a `SKILL.md`
 * carrying YAML frontmatter. Later roots win on name collisions, so project skills
 * override user skills, deeper child workspaces override ancestor directories, and
 * `.opencode` wins over `.agents` and `.claude`.
 *
 * @module provider/Drivers/OpenCodeSkills
 */
import * as NodeOS from "node:os";

import type { ServerProviderSkill } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { parse as parseYamlDocument } from "yaml";

type SkillScope = "user" | "project";

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

/**
 * Enumerate OpenCode skills from user config dirs, workspace `.claude/skills`,
 * workspace `.agents/skills`, and workspace `.opencode/skills`, in that order.
 * Discovery is best-effort: unreadable roots and malformed skill entries are skipped.
 * On name collisions, later roots win: project beats user, `.agents` beats `.claude`,
 * and `.opencode` beats `.agents`.
 */
export const discoverOpenCodeSkills = Effect.fn("discoverOpenCodeSkills")(function* (
  cwd?: string,
  environment?: NodeJS.ProcessEnv,
): Effect.fn.Return<ReadonlyArray<ServerProviderSkill>, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const env = environment ?? process.env;

  const homeDir = env.HOME?.trim() || env.USERPROFILE?.trim() || NodeOS.homedir();
  const xdgConfigHome = env.XDG_CONFIG_HOME?.trim();
  const defaultConfigDir = xdgConfigHome
    ? path.join(xdgConfigHome, "opencode")
    : path.join(homeDir, ".config", "opencode");
  const customConfigDir = env.OPENCODE_CONFIG_DIR?.trim();
  const resolvedCustomConfigDir = customConfigDir
    ? cwd
      ? path.resolve(cwd, customConfigDir)
      : path.resolve(customConfigDir)
    : undefined;

  const userRoots: ReadonlyArray<string> = [
    path.join(homeDir, ".claude", "skills"),
    path.join(homeDir, ".agents", "skills"),
    path.join(defaultConfigDir, "skills"),
    path.join(homeDir, ".opencode", "skills"),
    ...(resolvedCustomConfigDir ? [path.join(resolvedCustomConfigDir, "skills")] : []),
  ];

  const projectDirs: ReadonlyArray<string> = cwd
    ? yield* Effect.gen(function* () {
        const dirs: Array<string> = [];
        let current = path.resolve(cwd);
        let foundGit = false;
        while (true) {
          dirs.push(current);
          const gitPath = path.join(current, ".git");
          const hasGit = yield* fileSystem.exists(gitPath).pipe(Effect.orElseSucceed(() => false));
          if (hasGit) {
            foundGit = true;
            break;
          }
          const parent = path.dirname(current);
          if (parent === current) {
            break;
          }
          current = parent;
        }
        return foundGit ? dirs.toReversed() : [path.resolve(cwd)];
      })
    : [];

  const roots: ReadonlyArray<{ directory: string; scope: SkillScope }> = [
    ...userRoots.map((directory) => ({ directory, scope: "user" as const })),
    ...projectDirs.flatMap((dir) => [
      { directory: path.join(dir, ".claude", "skills"), scope: "project" as const },
      { directory: path.join(dir, ".agents", "skills"), scope: "project" as const },
      { directory: path.join(dir, ".opencode", "skills"), scope: "project" as const },
    ]),
  ];

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
