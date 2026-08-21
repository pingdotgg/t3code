/**
 * CursorSkills — filesystem discovery for the Cursor `$` picker.
 *
 * Cursor Agent discovers skills from its own, Agent Skills, Claude, and Codex
 * directories. T3 reads the same on-disk skills because Cursor ACP does not
 * expose a skill catalogue.
 *
 * @module provider/Drivers/CursorSkills
 */
import * as NodeOS from "node:os";

import type { ServerProviderSkill } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { parse as parseYamlDocument } from "yaml";

type CursorSkillScope = "user" | "project";

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const SKILL_NAME_PATTERN = /^[a-z0-9-]+$/;
const SKILL_TOKEN_PATTERN = /(^|\s)\$([a-z0-9-]+)(?=\s|$|[^\w-])/g;

type SkillFrontmatter =
  | { readonly kind: "malformed" }
  | { readonly kind: "parsed"; readonly name: string; readonly description: string };

function parseSkillFrontmatter(contents: string): SkillFrontmatter {
  const match = FRONTMATTER_PATTERN.exec(contents);
  if (!match) {
    return { kind: "malformed" };
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
  if (!SKILL_NAME_PATTERN.test(name) || !description) {
    return { kind: "malformed" };
  }

  return { kind: "parsed", name, description };
}

function isSkillFile(entry: string): boolean {
  return entry === "SKILL.md" || entry.replaceAll("\\", "/").endsWith("/SKILL.md");
}

/**
 * List skills from Cursor's documented user and project roots. The scan is
 * best-effort so unreadable or malformed entries never affect provider state.
 */
export const discoverCursorSkills = Effect.fn("discoverCursorSkills")(function* (
  cwd?: string,
  environment?: NodeJS.ProcessEnv,
): Effect.fn.Return<ReadonlyArray<ServerProviderSkill>, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const homePath = environment?.HOME?.trim() || NodeOS.homedir();
  const roots: ReadonlyArray<{ directory: string; scope: CursorSkillScope }> = [
    { directory: path.join(homePath, ".agents", "skills"), scope: "user" },
    { directory: path.join(homePath, ".cursor", "skills"), scope: "user" },
    { directory: path.join(homePath, ".claude", "skills"), scope: "user" },
    { directory: path.join(homePath, ".codex", "skills"), scope: "user" },
    ...(cwd
      ? [
          { directory: path.join(cwd, ".agents", "skills"), scope: "project" as const },
          { directory: path.join(cwd, ".cursor", "skills"), scope: "project" as const },
          { directory: path.join(cwd, ".claude", "skills"), scope: "project" as const },
          { directory: path.join(cwd, ".codex", "skills"), scope: "project" as const },
        ]
      : []),
  ];

  const skillsByName = new Map<string, ServerProviderSkill>();
  for (const root of roots) {
    const entries = yield* fileSystem
      .readDirectory(root.directory, { recursive: true })
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));

    for (const entry of [...entries].filter(isSkillFile).sort()) {
      const skillPath = path.join(root.directory, entry);
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
      if (frontmatter.name !== path.basename(path.dirname(skillPath))) {
        continue;
      }

      skillsByName.set(frontmatter.name, {
        name: frontmatter.name,
        description: frontmatter.description,
        path: skillPath,
        enabled: true,
        scope: root.scope,
      });
    }
  }

  return [...skillsByName.values()].sort((left, right) => left.name.localeCompare(right.name));
});

/**
 * T3 uses `$skill` for its shared picker. Cursor invokes selected skills with
 * `/skill`, so translate only known skill tokens before the ACP prompt runs.
 */
export function renderCursorSkillInvocations(
  input: string,
  skillNames: ReadonlySet<string>,
): string {
  return input.replace(SKILL_TOKEN_PATTERN, (match, prefix: string, name: string) =>
    skillNames.has(name) ? `${prefix}/${name}` : match,
  );
}
