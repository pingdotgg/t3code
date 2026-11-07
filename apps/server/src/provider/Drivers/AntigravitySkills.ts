import type { ServerProviderSkill } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { parse as parseYamlDocument } from "yaml";

/** Match Python os.path.expanduser: USERPROFILE, then HOMEDRIVE+HOMEPATH on Windows; HOME elsewhere. */
export function resolveAntigravityUserHome(
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
  home: string,
): string {
  if (platform === "win32") {
    if (environment.USERPROFILE) return environment.USERPROFILE;
    if (environment.HOMEDRIVE && environment.HOMEPATH) {
      return `${environment.HOMEDRIVE}${environment.HOMEPATH}`;
    }
    return home;
  }
  return environment.HOME || home;
}

/** Link private GEMINI_HOME skills to ~/.gemini; ~/.agents/skills is ignored because .agents/skills is project-only. */
export function antigravityUserSkillDirectories(
  path: Path.Path,
  geminiHome: string,
): readonly [configSkills: string, cliSkills: string] {
  return [
    path.join(geminiHome, "config", "skills"),
    path.join(geminiHome, "antigravity-cli", "skills"),
  ];
}

const MAX_SKILL_BYTES = 1_000_000;
const MAX_SCAN_BYTES = 8_000_000;
const MAX_SCAN_ENTRIES = 10_000;

const SkillFrontmatter = Schema.Struct({
  name: Schema.optional(Schema.NullOr(Schema.String)),
  description: Schema.optional(Schema.NullOr(Schema.String)),
});
const decodeSkillFrontmatter = Schema.decodeUnknownSync(SkillFrontmatter);

export class AntigravitySkillsProbeError extends Schema.TaggedError<AntigravitySkillsProbeError>()(
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
          ? Effect.undefined
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

interface SkillRoot {
  readonly directory: string;
  readonly scope: string;
}

const scanSkillDirectories = Effect.fn("scanAntigravitySkillDirectories")(function* (
  roots: ReadonlyArray<SkillRoot>,
  budget: ScanBudget,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
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

const PluginManifest = Schema.fromJsonString(
  Schema.Struct({ disabled: Schema.optional(Schema.Boolean) }),
);
const PluginPreferences = Schema.fromJsonString(
  Schema.Struct({
    plugins: Schema.optional(
      Schema.Record(Schema.String, Schema.Struct({ enabled: Schema.optional(Schema.Boolean) })),
    ),
  }),
);

const decodePluginManifest = Schema.decodeEffect(PluginManifest);
const decodePluginPreferences = Schema.decodeEffect(PluginPreferences);
const encodeString = Schema.encodeSync(Schema.fromJsonString(Schema.String));

const discoverAntigravityPlugins = Effect.fn("discoverAntigravityPlugins")(function* (
  userHome: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = path.join(userHome, ".gemini", "config");
  const directory = path.join(config, "plugins");
  const entries = yield* readIfPresent(fileSystem.readDirectory(directory), directory);
  if (entries === undefined) return [];
  const budget: ScanBudget = {
    remainingBytes: MAX_SCAN_BYTES,
    remainingEntries: MAX_SCAN_ENTRIES,
  };
  if (entries.length > budget.remainingEntries) {
    return yield* new AntigravitySkillsProbeError({
      reason: "scan-budget-exhausted",
      path: directory,
    });
  }
  budget.remainingEntries -= entries.length;
  const preferencesPath = path.join(config, "config.json");
  const preferencesContents = yield* readSkill(preferencesPath, budget);
  const preferences =
    preferencesContents === undefined
      ? { plugins: {} }
      : yield* decodePluginPreferences(preferencesContents).pipe(
          Effect.catchTags({
            SchemaError: () =>
              Effect.logWarning("Antigravity plugin preferences are invalid.", {
                errorTag: "invalid-config",
              }).pipe(Effect.as(undefined)),
          }),
        );
  if (preferences === undefined) return [];
  const plugins = [];
  for (const entry of entries.toSorted()) {
    const pluginDirectory = path.join(directory, entry);
    if (
      (yield* readIfPresent(fileSystem.stat(pluginDirectory), pluginDirectory))?.type !==
      "Directory"
    )
      continue;
    const enabled = preferences.plugins?.[entry]?.enabled;
    if (enabled === false) continue;
    const manifestPath = path.join(pluginDirectory, "plugin.json");
    const contents = yield* readSkill(manifestPath, budget);
    if (contents === undefined) continue;
    const manifest = yield* decodePluginManifest(contents).pipe(
      Effect.catchTags({
        SchemaError: () =>
          Effect.logWarning("Skipped an Antigravity plugin with an invalid manifest.", {
            errorTag: "invalid-config",
          }).pipe(Effect.as(undefined)),
      }),
    );
    if (manifest === undefined) continue;
    if (manifest.disabled && enabled !== true) continue;
    const skills = yield* scanSkillDirectories(
      [{ directory: path.join(pluginDirectory, "skills"), scope: "user" }],
      budget,
    );
    if (skills.length === 0) continue;
    plugins.push({
      directory: pluginDirectory,
      skills: skills.map((skill) => ({
        ...skill,
        name: `plugin:${[entry, skill.name]
          .map((part) =>
            part.replace(
              /[^a-z0-9-]/gu,
              (character) => `_${Buffer.from(character).toString("hex")}_`,
            ),
          )
          .join(":")}`,
        displayName: `${entry}:${skill.name}`,
      })),
    });
  }
  return plugins;
});

/** Keep read errors typed so workspace snapshots cannot cache partial results. */
export const discoverAntigravitySkills = Effect.fn("discoverAntigravitySkills")(function* (input: {
  readonly cwd: string;
  readonly userHome: string;
}): Effect.fn.Return<
  ReadonlyArray<ServerProviderSkill>,
  AntigravitySkillsProbeError,
  FileSystem.FileSystem | Path.Path
> {
  const path = yield* Path.Path;
  const [configSkills, cliSkills] = antigravityUserSkillDirectories(
    path,
    path.join(input.userHome, ".gemini"),
  );
  const skills = yield* scanSkillDirectories(
    [
      { directory: configSkills, scope: "user" },
      { directory: path.resolve(input.cwd, ".gemini", "skills"), scope: "project" },
      { directory: cliSkills, scope: "user" },
      { directory: path.resolve(input.cwd, ".agents", "skills"), scope: "project" },
      { directory: path.resolve(input.cwd, ".agent", "skills"), scope: "project" },
    ],
    { remainingBytes: MAX_SCAN_BYTES, remainingEntries: MAX_SCAN_ENTRIES },
  );
  const plugins = yield* discoverAntigravityPlugins(input.userHome);
  return [...skills, ...plugins.flatMap((plugin) => plugin.skills)].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
});

// ACP accepts standalone skills, so plugin entries use a process-owned native catalog.
export const prepareAntigravityPluginSkills = Effect.fn("prepareAntigravityPluginSkills")(
  function* (input: { readonly userHome: string; readonly runtimeTempDirectory: string }) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const plugins = yield* discoverAntigravityPlugins(input.userHome);
    if (plugins.length === 0) return [];
    const directory = path.join(input.runtimeTempDirectory, "plugin-skills");
    yield* Effect.forEach(
      plugins.flatMap((plugin) =>
        plugin.skills.map((skill) => ({ pluginDirectory: plugin.directory, skill })),
      ),
      ({ pluginDirectory, skill }, index) =>
        Effect.gen(function* () {
          const skillDirectory = path.join(directory, ".agents", "skills", String(index));
          yield* fileSystem.makeDirectory(skillDirectory, { recursive: true });
          yield* fileSystem.writeFileString(
            path.join(skillDirectory, "SKILL.md"),
            `---\nname: ${encodeString(skill.name)}\ndescription: ${encodeString(skill.description ?? "")}\n---\n\nRead and follow the skill at ${encodeString(skill.path)}. Resolve its relative paths from ${encodeString(path.dirname(skill.path))}. The plugin root is ${encodeString(pluginDirectory)}.\n`,
          );
        }),
      { concurrency: 8, discard: true },
    );
    return [directory, ...plugins.map((plugin) => plugin.directory)];
  },
);
