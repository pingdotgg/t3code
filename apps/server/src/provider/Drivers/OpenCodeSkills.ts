/**
 * OpenCodeSkills — filesystem discovery of OpenCode skills for the `$` picker.
 *
 * OpenCode loads skills from its config dir (`~/.config/opencode/skill(s)`,
 * user scope) and the workspace (`<cwd>/.opencode/skill(s)`, project scope),
 * matching `{skill,skills}/**\/SKILL.md` with YAML frontmatter. Neither the
 * `models` nor the `agent list` CLI surfaces those skills, and the SDK only
 * reports them once a server is running, so the provider snapshot scans the
 * same locations directly — mirroring `ClaudeSkills` and how the Codex
 * app-server reports its skills.
 *
 * @module provider/Drivers/OpenCodeSkills
 */
import * as NodeOS from "node:os";

import type { ServerProviderSkill } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { parse as parseYamlDocument } from "yaml";

type OpenCodeSkillScope = "user" | "project";

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

/** OpenCode accepts both spellings of the skills directory. */
const SKILL_DIRECTORY_NAMES = ["skill", "skills"] as const;

/**
 * OpenCode matches `**\/SKILL.md`, so a skill may sit deeper than one level.
 * Bound the walk so a pathological tree can never stall a provider probe.
 */
const MAX_SKILL_DEPTH = 5;

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
 * Resolve the OpenCode config directory the runtime would use, matching the
 * precedence OpenCode itself applies: `OPENCODE_CONFIG_DIR`, then the XDG
 * config home, then `~/.config`.
 */
const resolveOpenCodeConfigDirPath = Effect.fn("resolveOpenCodeConfigDirPath")(function* (
  environment: NodeJS.ProcessEnv,
): Effect.fn.Return<string, never, Path.Path> {
  const path = yield* Path.Path;
  // Env vars reach the spawned runtime verbatim, so a literal `~` must stay
  // literal for discovery to scan the directory the runtime would.
  const configDir = environment.OPENCODE_CONFIG_DIR?.trim() ?? "";
  if (configDir.length > 0) {
    return path.resolve(configDir);
  }
  const xdgConfigHome = environment.XDG_CONFIG_HOME?.trim() ?? "";
  const configHome =
    xdgConfigHome.length > 0 ? path.resolve(xdgConfigHome) : path.join(NodeOS.homedir(), ".config");
  return path.join(configHome, "opencode");
});

/**
 * Collect every `SKILL.md` under `root`, depth-first and depth-bounded.
 * Unreadable directories yield nothing so a broken tree never fails a probe.
 */
const collectSkillFiles = Effect.fn("collectSkillFiles")(function* (
  root: string,
  depth = 0,
): Effect.fn.Return<ReadonlyArray<string>, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (depth > MAX_SKILL_DEPTH) {
    return [];
  }

  const entries = yield* fileSystem
    .readDirectory(root)
    .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));

  const found: Array<string> = [];
  for (const entry of [...entries].sort()) {
    const candidate = path.join(root, entry);
    if (entry === "SKILL.md") {
      found.push(candidate);
      continue;
    }
    // `stat` follows symlinks, matching OpenCode's symlink-following scan —
    // the common layout symlinks each skill into the config dir.
    const info = yield* fileSystem.stat(candidate).pipe(Effect.orElseSucceed(() => undefined));
    if (info?.type === "Directory") {
      found.push(...(yield* collectSkillFiles(candidate, depth + 1)));
    }
  }
  return found;
});

/**
 * Enumerate OpenCode skills from the user config dir and the workspace.
 * Discovery is best-effort: unreadable roots and malformed skill entries are
 * skipped so a broken skill never degrades the provider snapshot. On name
 * collisions the project-scoped skill wins, matching OpenCode's
 * later-scan-wins resolution.
 */
export const discoverOpenCodeSkills = Effect.fn("discoverOpenCodeSkills")(function* (
  cwd?: string,
  environment?: NodeJS.ProcessEnv,
): Effect.fn.Return<ReadonlyArray<ServerProviderSkill>, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const configDirPath = yield* resolveOpenCodeConfigDirPath(environment ?? process.env);

  const roots: ReadonlyArray<{ directory: string; scope: OpenCodeSkillScope }> = [
    ...SKILL_DIRECTORY_NAMES.map((name) => ({
      directory: path.join(configDirPath, name),
      scope: "user" as const,
    })),
    ...(cwd
      ? SKILL_DIRECTORY_NAMES.map((name) => ({
          directory: path.join(cwd, ".opencode", name),
          scope: "project" as const,
        }))
      : []),
  ];

  const skillsByName = new Map<string, ServerProviderSkill>();
  for (const root of roots) {
    for (const skillPath of yield* collectSkillFiles(root.directory)) {
      const contents = yield* fileSystem
        .readFileString(skillPath)
        .pipe(Effect.orElseSucceed(() => undefined));
      if (contents === undefined) {
        continue;
      }

      const frontmatter = parseSkillFrontmatter(contents);
      // OpenCode requires a parseable frontmatter `name`; an entry without one
      // never registers, so surfacing it here would advertise a skill the
      // model cannot load.
      if (frontmatter.kind !== "parsed" || !frontmatter.name) {
        continue;
      }

      skillsByName.set(frontmatter.name, {
        name: frontmatter.name,
        path: skillPath,
        enabled: true,
        scope: root.scope,
        ...(frontmatter.description ? { description: frontmatter.description } : {}),
      });
    }
  }

  return [...skillsByName.values()].sort((left, right) => left.name.localeCompare(right.name));
});
