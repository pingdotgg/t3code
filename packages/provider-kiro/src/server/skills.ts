/**
 * Lists Kiro skills for the `/` and `$` menus from the SKILL.md folders Kiro
 * reads. Kiro reports skills only to a running session, and a session starts
 * the user's MCP servers, so none is opened for a composer menu.
 *
 * @module provider-kiro/server/skills
 */
import type { ServerProviderSkill } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { parse as parseYamlDocument } from "yaml";

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1_024;

const decodeSkillFrontmatter = Schema.decodeUnknownOption(
  Schema.Struct({ name: Schema.String, description: Schema.String }),
);

/**
 * Reads SKILL.md as Kiro CLI 3.1.0 does: the file opens with `---`, the YAML
 * runs to the closing `---` or the end of the file, and a skill without a
 * valid `name` and a `description` is not loaded.
 */
function parseKiroSkill(
  contents: string,
): { readonly name: string; readonly description: string } | undefined {
  const opening = /^---[ \t]*\r?\n/.exec(contents);
  if (opening === null) return undefined;
  const rest = contents.slice(opening[0].length);
  const closing = /^---[ \t]*\r?$/m.exec(rest);
  let parsed: unknown;
  try {
    parsed = parseYamlDocument(closing === null ? rest : rest.slice(0, closing.index));
  } catch {
    return undefined;
  }
  const frontmatter = Option.getOrUndefined(decodeSkillFrontmatter(parsed));
  if (frontmatter === undefined) return undefined;
  const { name } = frontmatter;
  // Kiro shows a block description on one line.
  const description = frontmatter.description.replace(/\s+/g, " ").trim();
  return SKILL_NAME.test(name) &&
    name.length <= MAX_NAME_LENGTH &&
    description.length > 0 &&
    description.length <= MAX_DESCRIPTION_LENGTH
    ? { name, description }
    : undefined;
}

const readSkillsRoot = Effect.fn("KiroSkills.readSkillsRoot")(function* (
  directory: string,
  scope: "user" | "project",
): Effect.fn.Return<ReadonlyArray<ServerProviderSkill>, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  // A missing root, a stray file and an unreadable SKILL.md are all "no skill here".
  const folders = yield* fileSystem
    .readDirectory(directory)
    .pipe(Effect.orElseSucceed((): Array<string> => []));
  const skills: Array<ServerProviderSkill> = [];
  for (const folder of folders.toSorted()) {
    const skillPath = path.join(directory, folder, "SKILL.md");
    const contents = yield* Effect.option(fileSystem.readFileString(skillPath));
    const skill = Option.isSome(contents) ? parseKiroSkill(contents.value) : undefined;
    if (skill !== undefined) skills.push({ ...skill, path: skillPath, scope, enabled: true });
  }
  return skills;
});

/**
 * The skills a Kiro session in `cwd` loads: `~/.kiro/skills` (`KIRO_HOME`
 * replaces `~/.kiro`), then the workspace's own `.kiro/skills` (Kiro reads no
 * parent folder). A later skill replaces a same-named earlier one in its
 * place, as in Kiro's list.
 */
export const discoverKiroSkills = Effect.fn("discoverKiroSkills")(function* (input: {
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
}): Effect.fn.Return<ReadonlyArray<ServerProviderSkill>, never, FileSystem.FileSystem | Path.Path> {
  const path = yield* Path.Path;
  const home =
    input.environment.HOME?.trim() ||
    input.environment.USERPROFILE?.trim() ||
    (yield* HostProcess.HomeDirectory);
  const kiroHome = input.environment.KIRO_HOME?.trim() || path.join(home, ".kiro");
  const skills = new Map<string, ServerProviderSkill>();
  for (const [kiroFolder, scope] of [
    [kiroHome, "user"],
    [path.join(input.cwd, ".kiro"), "project"],
  ] as const) {
    for (const skill of yield* readSkillsRoot(path.join(kiroFolder, "skills"), scope)) {
      skills.set(skill.name, skill);
    }
  }
  return [...skills.values()];
});
