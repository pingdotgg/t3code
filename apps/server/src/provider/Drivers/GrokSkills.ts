/**
 * GrokSkills — filesystem discovery of Grok Build skills for the `$` picker.
 *
 * Grok loads skills from `<grok home>/bundled/skills` (system), then user
 * `~/.agents/skills` and `<grok home>/skills`, then workspace `.agents/skills`,
 * `.claude/skills`, and `.grok/skills` (project). Each skill is a directory
 * with a `SKILL.md` carrying YAML frontmatter.
 *
 * Skills are deduplicated by case-insensitive name. Later roots win, so
 * project skills beat user skills and `.grok` beats `.agents` / `.claude`.
 * That also collapses the common `~/.grok/skills/<name> -> ~/.agents/skills/<name>`
 * symlink layout into a single picker row.
 *
 * ACP does not surface skill paths for the composer picker, so the provider
 * snapshot scans these locations directly (same approach as ClaudeSkills).
 *
 * @module provider/Drivers/GrokSkills
 */
import * as NodeOS from "node:os";

import type { ServerProviderSkill } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { parse as parseYamlDocument } from "yaml";

type GrokSkillScope = "system" | "user" | "project";

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

function skillDedupKey(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * Resolve the user home used for `~/.agents` (and default `~/.grok`). Prefer
 * `HOME` / `USERPROFILE` from the provider environment so tests can isolate
 * discovery without touching the real home directory.
 */
const resolveUserHomePath = Effect.fn("resolveUserHomePath")(function* (
  environment: NodeJS.ProcessEnv,
  cwd?: string,
): Effect.fn.Return<string, never, Path.Path> {
  const path = yield* Path.Path;
  const home = environment.HOME?.trim() || environment.USERPROFILE?.trim() || "";
  if (home.length > 0) {
    return cwd ? path.resolve(cwd, home) : path.resolve(home);
  }
  return NodeOS.homedir();
});

/**
 * Resolve the Grok home directory the CLI would use: `GROK_HOME` when set
 * (resolved against the workspace cwd when relative), otherwise `<user home>/.grok`.
 */
const resolveGrokHomePath = Effect.fn("resolveGrokHomePath")(function* (
  environment: NodeJS.ProcessEnv,
  userHomePath: string,
  cwd?: string,
): Effect.fn.Return<string, never, Path.Path> {
  const path = yield* Path.Path;
  // Env vars are never shell-expanded, so a literal `~` must stay literal for
  // discovery to match the runtime. Relative values resolve against cwd.
  const grokHome = environment.GROK_HOME?.trim() ?? "";
  if (grokHome.length > 0) {
    return cwd ? path.resolve(cwd, grokHome) : path.resolve(grokHome);
  }
  return path.join(userHomePath, ".grok");
});

/**
 * Enumerate Grok Build skills from bundled, user, and project roots.
 * Discovery is best-effort: unreadable roots and malformed skill entries are
 * skipped so a broken skill never degrades the provider snapshot.
 */
export const discoverGrokSkills = Effect.fn("discoverGrokSkills")(function* (
  cwd?: string,
  environment?: NodeJS.ProcessEnv,
): Effect.fn.Return<ReadonlyArray<ServerProviderSkill>, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const env = environment ?? process.env;
  const userHomePath = yield* resolveUserHomePath(env, cwd);
  const homePath = yield* resolveGrokHomePath(env, userHomePath, cwd);

  // Lowest priority first. Later roots overwrite earlier ones with the same
  // case-insensitive name.
  const roots: ReadonlyArray<{ directory: string; scope: GrokSkillScope }> = [
    { directory: path.join(homePath, "bundled", "skills"), scope: "system" },
    { directory: path.join(userHomePath, ".agents", "skills"), scope: "user" },
    { directory: path.join(homePath, "skills"), scope: "user" },
    ...(cwd
      ? [
          { directory: path.join(cwd, ".agents", "skills"), scope: "project" as const },
          { directory: path.join(cwd, ".claude", "skills"), scope: "project" as const },
          { directory: path.join(cwd, ".grok", "skills"), scope: "project" as const },
        ]
      : []),
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
      // Malformed frontmatter means the skill won't load in Grok either —
      // skip it rather than surfacing a broken entry under its directory name.
      if (frontmatter.kind === "malformed") {
        continue;
      }

      const name = (frontmatter.kind === "parsed" ? frontmatter.name : undefined) ?? entry.trim();
      if (!name) {
        continue;
      }

      skillsByName.set(skillDedupKey(name), {
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
