/**
 * AgentSkills — shared filesystem discovery of cross-agent skills for the `$` picker.
 *
 * Portable skills live under `~/.agents/skills` and `<cwd>/.agents/skills`, one
 * directory per skill with a `SKILL.md` carrying YAML frontmatter. Providers
 * without native skill inventory (Cursor, Grok, OpenCode, …) use this scanner;
 * Claude layers vendor-specific roots (`<config>/skills`, `<cwd>/.claude/skills`)
 * on the same scanner. Codex reports skills natively via its app-server.
 *
 * @module provider/Drivers/AgentSkills
 */
import * as NodeOS from "node:os";

import type { ServerProviderSkill } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { parse as parseYamlDocument } from "yaml";

export type FilesystemSkillScope = "user" | "project";

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
 * Scan explicit skill roots. Discovery is best-effort: unreadable roots and
 * malformed entries are skipped. Later roots overwrite earlier ones on name
 * collisions so project-scoped skills beat user-scoped ones.
 */
export const scanFilesystemSkillRoots = Effect.fn("scanFilesystemSkillRoots")(function* (
  roots: ReadonlyArray<{ directory: string; scope: FilesystemSkillScope }>,
): Effect.fn.Return<ReadonlyArray<ServerProviderSkill>, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
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

/**
 * Enumerate portable skills under the user home only (`~/.agents/skills`).
 * Use this for environment-level (project-agnostic) snapshots; pair with
 * `discoverProjectAgentSkills` for per-workspace resolution.
 */
export const discoverUserAgentSkills = Effect.fn("discoverUserAgentSkills")(function* (options?: {
  readonly homeDirectory?: string;
}): Effect.fn.Return<ReadonlyArray<ServerProviderSkill>, never, FileSystem.FileSystem | Path.Path> {
  const path = yield* Path.Path;
  const homeDirectory = options?.homeDirectory ?? NodeOS.homedir();
  return yield* scanFilesystemSkillRoots([
    { directory: path.join(homeDirectory, ".agents", "skills"), scope: "user" },
  ]);
});

/**
 * Enumerate portable skills under a single workspace root only
 * (`<workspaceRoot>/.agents/skills`). Resolve this per active project so a
 * project's skills follow the project, not the server's launch directory.
 */
export const discoverProjectAgentSkills = Effect.fn("discoverProjectAgentSkills")(function* (
  workspaceRoot: string,
): Effect.fn.Return<ReadonlyArray<ServerProviderSkill>, never, FileSystem.FileSystem | Path.Path> {
  const path = yield* Path.Path;
  return yield* scanFilesystemSkillRoots([
    { directory: path.join(workspaceRoot, ".agents", "skills"), scope: "project" },
  ]);
});

/**
 * Enumerate portable skills from the user home and optional workspace cwd.
 */
export const discoverAgentSkills = Effect.fn("discoverAgentSkills")(function* (
  cwd?: string,
  options?: { readonly homeDirectory?: string },
): Effect.fn.Return<ReadonlyArray<ServerProviderSkill>, never, FileSystem.FileSystem | Path.Path> {
  const path = yield* Path.Path;
  const homeDirectory = options?.homeDirectory ?? NodeOS.homedir();

  return yield* scanFilesystemSkillRoots([
    { directory: path.join(homeDirectory, ".agents", "skills"), scope: "user" },
    ...(cwd ? [{ directory: path.join(cwd, ".agents", "skills"), scope: "project" as const }] : []),
  ]);
});
