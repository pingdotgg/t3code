/**
 * JcodeSkills — filesystem discovery of Jcode skills for the `$` picker.
 *
 * Jcode loads skills from `<home>/skills` (user scope), `~/.claude/skills`
 * (compatibility), and `./.jcode/skills` (project scope, cwd relative),
 * one directory per skill with a `SKILL.md` carrying YAML frontmatter.
 * Unlike Claude Code, Jcode identifies a skill by its frontmatter `name`,
 * not by the directory (verified against the CLI: `frontend_design/`
 * publishes as `frontend-design`), so the frontmatter name is authoritative
 * here. `disable-model-invocation: true` maps to `userInvocationOnly`, the
 * same flag Claude Code uses. A skill also hidden from the agent through an
 * `agents/*.yaml` `policy.allow_implicit_invocation: false` is marked the
 * same way. Unlike Claude, user-invocable (slash-menu) visibility is not a
 * separate flag, so skills here are always offered under `/`.
 *
 * @module provider/Drivers/JcodeSkills
 */
import * as NodeOS from "node:os";

import type { ServerProviderSkill } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { parse as parseYamlDocument } from "yaml";

import { expandHomePath } from "../../pathExpansion.ts";

type JcodeSkillScope = "user" | "project" | "system";

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

/**
 * Reads are capped per file so a bloated SKILL.md or agents/*.yaml can never
 * turn skill discovery into an unbounded memory read. No retry-and-grow:
 * files past the cap are skipped.
 */
const MAX_SKILL_FILE_BYTES = 512 * 1024;
const MAX_AGENTS_YAML_BYTES = 64 * 1024;

/** Minimal projection of an `agents/<engine>.yaml` per-skill descriptor. */
interface JcodeAgentsYaml {
  displayName?: string;
  shortDescription?: string;
  /** `policy.allow_implicit_invocation: false` hides the skill from the agent. */
  allowImplicitInvocation?: boolean;
}

/**
 * One bounded read per file: the handle validates the file type at open time,
 * so a path swapped between a stat pass and a later unbounded read cannot
 * smuggle in a bigger or special file. Reading `maxBytes + 1` lets us reject
 * files that grew past the cap after the stat-free open; callers skip those.
 */
const readBoundedSkillFile = Effect.fn("JcodeSkills.readBoundedSkillFile")(function* (
  fileSystem: FileSystem.FileSystem,
  filePath: string,
  maxBytes: number,
): Effect.fn.Return<string | undefined> {
  return yield* Effect.scoped(
    fileSystem.open(filePath, { flag: "r" }).pipe(
      Effect.flatMap((file) =>
        Effect.gen(function* () {
          const info = yield* file.stat;
          if (info.type !== "File") return undefined;
          if (Number(info.size) > maxBytes) return undefined;
          const buffer = yield* file.readAlloc(maxBytes + 1);
          if (Option.isNone(buffer)) return undefined;
          if (buffer.value.byteLength > maxBytes) return undefined;
          return new TextDecoder().decode(buffer.value);
        }),
      ),
      Effect.catchCause(() => Effect.succeed(undefined)),
    ),
  );
});

function parseAgentsYaml(contents: string): JcodeAgentsYaml {
  let parsed: unknown;
  try {
    parsed = parseYamlDocument(contents);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null) return {};
  const record = parsed as Record<string, unknown>;
  const result: JcodeAgentsYaml = {};

  const interfaceRecord =
    typeof record.interface === "object" && record.interface !== null
      ? (record.interface as Record<string, unknown>)
      : undefined;
  if (interfaceRecord) {
    if (typeof interfaceRecord.display_name === "string" && interfaceRecord.display_name.trim()) {
      result.displayName = interfaceRecord.display_name.trim();
    }
    if (
      typeof interfaceRecord.short_description === "string" &&
      interfaceRecord.short_description.trim()
    ) {
      result.shortDescription = interfaceRecord.short_description.trim();
    }
  }

  const policy =
    typeof record.policy === "object" && record.policy !== null
      ? (record.policy as Record<string, unknown>)
      : undefined;
  if (policy && typeof policy.allow_implicit_invocation === "boolean") {
    result.allowImplicitInvocation = policy.allow_implicit_invocation;
  }
  return result;
}

type JcodeSkillFrontmatter =
  | { readonly kind: "malformed" }
  | {
      readonly kind: "parsed";
      readonly name: string;
      readonly description?: string;
      readonly userInvocationOnly?: boolean;
    };

function parseSkillFrontmatter(contents: string): JcodeSkillFrontmatter {
  const match = FRONTMATTER_PATTERN.exec(contents);
  if (!match) return { kind: "malformed" };

  let parsed: unknown;
  try {
    parsed = parseYamlDocument(match[1] ?? "");
  } catch {
    return { kind: "malformed" };
  }
  if (typeof parsed !== "object" || parsed === null) return { kind: "malformed" };

  const record = parsed as Record<string, unknown>;
  const name = typeof record.name === "string" ? record.name.trim() : "";
  if (!name) return { kind: "malformed" };
  const description = typeof record.description === "string" ? record.description.trim() : "";
  return {
    kind: "parsed",
    name,
    ...(description ? { description } : {}),
    ...(record["disable-model-invocation"] === true ? { userInvocationOnly: true } : {}),
  };
}

/** `agents/yaml` descriptors for one skill directory, best-effort. */
const readAgentsYaml = Effect.fn("JcodeSkills.readAgentsYaml")(function* (
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  agentsDirectory: string,
): Effect.fn.Return<ReadonlyArray<JcodeAgentsYaml>> {
  const entries = yield* fileSystem
    .readDirectory(agentsDirectory)
    .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
  const records: JcodeAgentsYaml[] = [];
  for (const entry of [...entries].sort()) {
    if (!entry.endsWith(".yaml") && !entry.endsWith(".yml")) continue;
    const yamlFile = path.join(agentsDirectory, entry);
    const contents = yield* readBoundedSkillFile(fileSystem, yamlFile, MAX_AGENTS_YAML_BYTES);
    if (contents !== undefined) {
      records.push(parseAgentsYaml(contents));
    }
  }
  return records;
});

/**
 * Discover jcode skills across its roots. A missing root is the normal case;
 * discovery never fails the caller, it just yields fewer skills.
 */
export const discoverJcodeSkills = Effect.fn("discoverJcodeSkills")(function* (input: {
  readonly homePath?: string;
  /** Claude compatibility root. Injectable so sandboxed homes and test
   * harnesses can point it elsewhere; defaults to `~/.claude/skills`. */
  readonly compatSkillsPath?: string;
  readonly cwd?: string;
}): Effect.fn.Return<ReadonlyArray<ServerProviderSkill>, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const configuredHome = input.homePath?.trim() ?? "";
  const home =
    configuredHome.length > 0
      ? path.resolve(expandHomePath(configuredHome))
      : path.join(NodeOS.homedir(), ".jcode");

  const compatSkillsPath = input.compatSkillsPath?.trim()
    ? path.resolve(expandHomePath(input.compatSkillsPath.trim()))
    : path.join(NodeOS.homedir(), ".claude", "skills");

  // Order is precedence: a user skill shadows same-name skills in the
  // compatibility and project roots.
  const roots: ReadonlyArray<{ directory: string; scope: JcodeSkillScope }> = [
    { directory: path.join(home, "skills"), scope: "user" },
    { directory: compatSkillsPath, scope: "system" },
    ...(input.cwd && input.cwd.trim().length > 0
      ? [{ directory: path.join(input.cwd, ".jcode", "skills"), scope: "project" as const }]
      : []),
  ];

  const skillsByName = new Map<string, ServerProviderSkill>();
  for (const root of roots) {
    const entries = yield* fileSystem
      .readDirectory(root.directory)
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));

    for (const entry of [...entries].sort()) {
      const skillDirectory = path.join(root.directory, entry);
      const skillFile = path.join(skillDirectory, "SKILL.md");
      const contents = yield* readBoundedSkillFile(fileSystem, skillFile, MAX_SKILL_FILE_BYTES);
      if (contents === undefined) continue;

      const frontmatter = parseSkillFrontmatter(contents);
      if (frontmatter.kind !== "parsed") continue;
      if (skillsByName.has(frontmatter.name)) continue;

      const agentsRecords = yield* readAgentsYaml(
        fileSystem,
        path,
        path.join(skillDirectory, "agents"),
      );
      // Any engine hiding the skill from its agent means user-only, as does
      // jcode's `disable-model-invocation` frontmatter flag.
      const userInvocationOnly =
        frontmatter.userInvocationOnly === true ||
        agentsRecords.some((record) => record.allowImplicitInvocation === false);

      const preferred = agentsRecords.find(
        (record) => record.displayName !== undefined || record.shortDescription !== undefined,
      );
      skillsByName.set(frontmatter.name, {
        name: frontmatter.name,
        path: skillFile,
        enabled: true,
        scope: root.scope,
        ...(frontmatter.description ? { description: frontmatter.description } : {}),
        ...(userInvocationOnly ? { userInvocationOnly: true } : {}),
        ...(preferred?.displayName ? { displayName: preferred.displayName } : {}),
        ...(preferred?.shortDescription ? { shortDescription: preferred.shortDescription } : {}),
      });
    }
  }

  return [...skillsByName.values()].toSorted((left, right) => left.name.localeCompare(right.name));
});
