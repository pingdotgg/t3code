import type { ServerProviderSkill } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { fromYaml } from "@t3tools/shared/schemaYaml";

const decodeSkillMetadata = Schema.decodeUnknownOption(
  fromYaml(
    Schema.Struct({
      name: Schema.optional(Schema.String),
      description: Schema.optional(Schema.String),
    }),
  ),
);

function parseSkill(contents: string, folderName: string) {
  const header = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(contents)?.[1];
  if (header === undefined) return { name: folderName };
  const metadata = Option.getOrUndefined(decodeSkillMetadata(header));
  if (metadata === undefined) return undefined;
  const name = metadata.name?.trim() ?? folderName;
  const description = metadata.description?.trim();
  return {
    name,
    ...(description ? { description } : {}),
  };
}

const readDirectory = Effect.fn("KiroSkills.readDirectory")(function* (directory: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.readDirectory(directory).pipe(
    Effect.catchTags({
      PlatformError: (error) =>
        error.reason._tag === "NotFound"
          ? Effect.succeed([])
          : Effect.logWarning("Kiro skill scan skipped an unreadable directory.", {
              directory,
              errorTag: error.reason._tag,
            }).pipe(Effect.as([])),
    }),
  );
});

const discoverRoot = Effect.fn("KiroSkills.discoverRoot")(function* (input: {
  readonly directory: string;
  readonly scope: "project" | "user";
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const skills: Array<{ readonly skill: ServerProviderSkill; readonly folder: string }> = [];
  for (const entry of (yield* readDirectory(input.directory)).sort((left, right) =>
    left.localeCompare(right),
  )) {
    const folder = path.join(input.directory, entry);
    const skillPath = path.join(folder, "SKILL.md");
    const contents = yield* fileSystem.readFileString(skillPath).pipe(Effect.option);
    if (Option.isNone(contents)) continue;
    const metadata = parseSkill(contents.value, entry);
    if (
      metadata === undefined ||
      !metadata.name ||
      metadata.name.includes("/") ||
      metadata.name.includes("\\")
    )
      continue;
    const realFolder = yield* fileSystem.realPath(folder).pipe(Effect.orElseSucceed(() => folder));
    skills.push({
      folder: realFolder,
      skill: {
        ...metadata,
        path: skillPath,
        scope: input.scope,
        enabled: true,
      },
    });
  }
  return skills;
});

export const discoverKiroSkills = Effect.fn("KiroSkills.discover")(function* (input: {
  readonly cwd: string;
  readonly home: string;
}) {
  const path = yield* Path.Path;
  const roots = [
    { directory: path.join(input.cwd, ".kiro", "skills"), scope: "project" as const },
    { directory: path.join(input.home, ".kiro", "skills"), scope: "user" as const },
  ];

  const seenFolders = new Set<string>();
  const seenNames = new Set<string>();
  const skills: Array<ServerProviderSkill> = [];
  for (const root of roots) {
    for (const { folder, skill } of yield* discoverRoot(root)) {
      if (seenFolders.has(folder) || seenNames.has(skill.name)) continue;
      seenFolders.add(folder);
      seenNames.add(skill.name);
      skills.push(skill);
    }
  }
  return skills;
});
