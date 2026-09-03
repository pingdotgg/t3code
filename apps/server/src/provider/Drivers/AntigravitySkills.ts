import type { ServerProviderSkill } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { parse as parseYamlDocument } from "yaml";

const MAX_SKILL_BYTES = 1_000_000;
const MAX_SCAN_BYTES = 8_000_000;
const MAX_SCAN_ENTRIES = 10_000;

const SkillFrontmatter = Schema.Struct({
  name: Schema.optional(Schema.NullOr(Schema.String)),
  description: Schema.optional(Schema.NullOr(Schema.String)),
});
const decodeSkillFrontmatter = Schema.decodeUnknownSync(SkillFrontmatter);

export class AntigravitySkillsProbeError extends Schema.TaggedErrorClass<AntigravitySkillsProbeError>()(
  "AntigravitySkillsProbeError",
  {
    reason: Schema.Literals(["scan-budget-exhausted", "filesystem-error"]),
    path: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.reason === "scan-budget-exhausted"
      ? `Antigravity skill discovery exceeded its scan limit at '${this.path}'.`
      : `Antigravity could not read skills at '${this.path}'.`;
  }
}

interface ScanBudget {
  remainingBytes: number;
  remainingEntries: number;
}

const readIfPresent = <A, R>(
  effect: Effect.Effect<A, PlatformError.PlatformError, R>,
  path: string,
) =>
  effect.pipe(
    Effect.catchTags({
      PlatformError: (cause) =>
        cause.reason._tag === "NotFound"
          ? Effect.succeed(undefined)
          : Effect.fail(
              new AntigravitySkillsProbeError({ reason: "filesystem-error", path, cause }),
            ),
    }),
  );

function parseSkillFrontmatter(contents: string, fileName: string) {
  const start = contents.indexOf("---");
  if (start === -1) return undefined;
  const end = contents.indexOf("---", start + 3);
  if (end === -1) return undefined;
  try {
    const frontmatter = decodeSkillFrontmatter(
      parseYamlDocument(contents.slice(start + 3, end).trim()) ?? {},
    );
    const name = frontmatter.name || fileName.slice(0, -3);
    const description = frontmatter.description?.trim();
    // Native names are not trimmed. Do not rename one to fit the picker contract.
    if (!name || name !== name.trim()) return undefined;
    return { name, ...(description ? { description } : {}) };
  } catch {
    return undefined;
  }
}

/** The native loader orders child paths with Go's URL.EscapedPath encoding. */
function skillPathSortKey(entry: string) {
  return encodeURI(entry).replace(
    /[!'()*?#]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** Read only regular skill files, with a byte limit that applies during the read. */
const readSkill = Effect.fn("readAntigravitySkill")(function* (
  skillPath: string,
  budget: ScanBudget,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const info = yield* readIfPresent(fileSystem.stat(skillPath), skillPath);
  if (info?.type !== "File") return undefined;

  const byteLimit = Math.min(MAX_SKILL_BYTES, budget.remainingBytes);
  if (info.size > BigInt(byteLimit)) {
    return yield* new AntigravitySkillsProbeError({
      reason: "scan-budget-exhausted",
      path: skillPath,
    });
  }
  const chunks = yield* readIfPresent(
    fileSystem.stream(skillPath, { bytesToRead: byteLimit + 1 }).pipe(Stream.runCollect),
    skillPath,
  );
  if (chunks === undefined) return undefined;
  const bytes = Buffer.concat(chunks);
  if (bytes.byteLength > byteLimit) {
    return yield* new AntigravitySkillsProbeError({
      reason: "scan-budget-exhausted",
      path: skillPath,
    });
  }
  budget.remainingBytes -= bytes.byteLength;
  return bytes.toString("utf8");
});

/**
 * Match the official ACP's explicit skill roots. The first valid same-name skill
 * wins. Each root loads its own SKILL.md or those in its immediate subdirectories.
 * Read failures remain typed so workspace snapshots do not cache partial results.
 */
export const discoverAntigravitySkills = Effect.fn("discoverAntigravitySkills")(function* (input: {
  readonly cwd: string;
  readonly profileDirectory: string;
}): Effect.fn.Return<
  ReadonlyArray<ServerProviderSkill>,
  AntigravitySkillsProbeError,
  FileSystem.FileSystem | Path.Path
> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const roots = [
    { directory: path.resolve(input.profileDirectory, "config", "skills"), scope: "user" },
    { directory: path.resolve(input.cwd, ".gemini", "skills"), scope: "project" },
    {
      directory: path.resolve(input.profileDirectory, "antigravity-cli", "skills"),
      scope: "user",
    },
    { directory: path.resolve(input.cwd, ".agents", "skills"), scope: "project" },
  ];
  const budget: ScanBudget = {
    remainingBytes: MAX_SCAN_BYTES,
    remainingEntries: MAX_SCAN_ENTRIES,
  };
  const skillsByName = new Map<string, ServerProviderSkill>();

  const scanDirectory = Effect.fn("scanAntigravitySkillDirectory")(function* (
    directory: string,
    scope: string,
    scanChildren: boolean,
  ): Effect.fn.Return<void, AntigravitySkillsProbeError, FileSystem.FileSystem> {
    const info = yield* readIfPresent(fileSystem.stat(directory), directory);
    if (info?.type !== "Directory") return;
    const entries = yield* readIfPresent(fileSystem.readDirectory(directory), directory);
    if (entries === undefined) return;
    if (entries.length > budget.remainingEntries) {
      return yield* new AntigravitySkillsProbeError({
        reason: "scan-budget-exhausted",
        path: directory,
      });
    }
    budget.remainingEntries -= entries.length;

    const sortedEntries = entries.toSorted();
    const skillFileName = sortedEntries.find((entry) => entry.toLowerCase() === "skill.md");
    if (skillFileName !== undefined) {
      if (!skillFileName.endsWith(".md")) return;
      const skillPath = path.join(directory, skillFileName);
      const contents = yield* readSkill(skillPath, budget);
      if (contents === undefined) return;
      const skill = parseSkillFrontmatter(contents, skillFileName);
      if (!skill || skillsByName.has(skill.name)) return;
      skillsByName.set(skill.name, {
        ...skill,
        path: skillPath,
        scope,
        enabled: true,
      });
      return;
    }
    if (scanChildren) {
      const children = sortedEntries
        .map((entry) => ({ entry, sortKey: skillPathSortKey(entry) }))
        .sort((left, right) =>
          left.sortKey < right.sortKey ? -1 : left.sortKey > right.sortKey ? 1 : 0,
        );
      for (const { entry } of children) {
        yield* scanDirectory(path.join(directory, entry), scope, false);
      }
    }
  });

  for (const root of roots) {
    yield* scanDirectory(root.directory, root.scope, true);
  }
  return [...skillsByName.values()].sort((left, right) => left.name.localeCompare(right.name));
});
