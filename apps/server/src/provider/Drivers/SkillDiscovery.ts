import type { ServerProviderSkill } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { parse as parseYamlDocument } from "yaml";

export interface SkillRoot {
  readonly directory: string;
  readonly scope: "user" | "project";
}

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

function metadata(contents: string) {
  const match = FRONTMATTER_PATTERN.exec(contents);
  if (!match) return { valid: true } as const;
  try {
    const parsed: unknown = parseYamlDocument(match[1] ?? "");
    if (typeof parsed !== "object" || parsed === null) return { valid: false } as const;
    const record = parsed as Record<string, unknown>;
    const name = typeof record.name === "string" ? record.name.trim() : "";
    const description = typeof record.description === "string" ? record.description.trim() : "";
    return { valid: true, name, description } as const;
  } catch {
    return { valid: false } as const;
  }
}

export const discoverSkillsFromRoots = Effect.fn("discoverSkillsFromRoots")(function* (
  roots: ReadonlyArray<SkillRoot>,
): Effect.fn.Return<ReadonlyArray<ServerProviderSkill>, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const skills = new Map<string, ServerProviderSkill>();
  for (const root of roots) {
    const entries = yield* fileSystem
      .readDirectory(root.directory)
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
    for (const entry of [...entries].sort()) {
      const skillPath = path.join(root.directory, entry, "SKILL.md");
      const contents = yield* fileSystem
        .readFileString(skillPath)
        .pipe(Effect.orElseSucceed(() => undefined));
      if (contents === undefined) continue;
      const parsed = metadata(contents);
      if (!parsed.valid) continue;
      const name = parsed.name || entry.trim();
      if (!name) continue;
      skills.set(name, {
        name,
        path: skillPath,
        enabled: true,
        scope: root.scope,
        ...(parsed.description ? { description: parsed.description } : {}),
      });
    }
  }
  return [...skills.values()].sort((left, right) => left.name.localeCompare(right.name));
});
