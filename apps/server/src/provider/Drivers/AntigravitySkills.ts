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
// Typical frontmatter fits in one chunk, so most skills cost about this much of the scan budget.
const SKILL_READ_CHUNK_BYTES = 1024;

const SkillFrontmatter = Schema.Struct({
  name: Schema.optional(Schema.NullOr(Schema.String)),
  description: Schema.optional(Schema.NullOr(Schema.String)),
});
const decodeSkillFrontmatter = Schema.decodeUnknownSync(SkillFrontmatter);
const decodePluginPreferences = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      plugins: Schema.optional(
        Schema.Record(Schema.String, Schema.Struct({ enabled: Schema.optional(Schema.Boolean) })),
      ),
    }),
  ),
);

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

/** Plugin names that a GEMINI_HOME's config.json turns off. */
const readAntigravityDisabledPlugins = Effect.fn("readAntigravityDisabledPlugins")(function* (
  configPath: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const info = yield* readIfPresent(fileSystem.stat(configPath), configPath);
  if (info?.type !== "File") return new Set<string>();
  if (info.size > BigInt(MAX_SKILL_BYTES)) {
    return yield* new AntigravitySkillsProbeError({
      reason: "scan-budget-exhausted",
      path: configPath,
    });
  }
  const config = yield* readIfPresent(fileSystem.readFileString(configPath), configPath);
  const preferences = config === undefined ? undefined : decodePluginPreferences(config);
  return new Set(
    Object.entries(
      (preferences?._tag === "Some" ? preferences.value.plugins : undefined) ?? {},
    ).flatMap(([name, plugin]) => (plugin.enabled === false ? [name] : [])),
  );
});

/** agy skips a plugin folder without one of these manifests. */
const ANTIGRAVITY_PLUGIN_MANIFESTS = [
  "plugin.json",
  ".antigravity-plugin/plugin.json",
  ".gemini-plugin/plugin.json",
] as const;

/** Enabled plugins in the user's ~/.gemini, by name, that a profile links and agy then loads. */
export const readAntigravityUserPlugins = Effect.fn("readAntigravityUserPlugins")(function* (
  userHome: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const pluginsDirectory = path.join(userHome, ".gemini", "config", "plugins");
  const plugins = new Map<string, string>();
  const names = yield* readIfPresent(fileSystem.readDirectory(pluginsDirectory), pluginsDirectory);
  if (names === undefined || names.length === 0) return plugins;
  const disabled = yield* readAntigravityDisabledPlugins(
    path.join(userHome, ".gemini", "config", "config.json"),
  );
  for (const name of names.toSorted()) {
    if (disabled.has(name)) continue;
    const pluginDirectory = path.join(pluginsDirectory, name);
    const info = yield* readIfPresent(fileSystem.stat(pluginDirectory), pluginDirectory);
    if (info?.type !== "Directory") continue;
    for (const manifest of ANTIGRAVITY_PLUGIN_MANIFESTS) {
      const manifestPath = path.join(pluginDirectory, manifest);
      if ((yield* readIfPresent(fileSystem.stat(manifestPath), manifestPath))?.type === "File") {
        plugins.set(name, pluginDirectory);
        break;
      }
    }
  }
  return plugins;
});

/** Plugins agy loads from the profile once its next launch relinks the enabled user plugins. */
export const readAntigravityPlugins = Effect.fn("readAntigravityPlugins")(function* (input: {
  readonly profileDirectory: string;
  readonly userHome: string;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const pluginsDirectory = path.join(input.profileDirectory, "config", "plugins");
  const userPluginsDirectory = path.join(input.userHome, ".gemini", "config", "plugins");
  const plugins = yield* readAntigravityUserPlugins(input.userHome);
  const names = yield* readIfPresent(fileSystem.readDirectory(pluginsDirectory), pluginsDirectory);
  for (const name of names ?? []) {
    const pluginDirectory = path.join(pluginsDirectory, name);
    const target = yield* fileSystem.readLink(pluginDirectory).pipe(
      Effect.map((value) => path.resolve(pluginsDirectory, value)),
      Effect.orElseSucceed(() => undefined),
    );
    // Profile preparation replaces its links into the user's plugins, so those come from above.
    if (target !== undefined && path.dirname(target) === userPluginsDirectory) continue;
    const info = yield* readIfPresent(fileSystem.stat(pluginDirectory), pluginDirectory);
    if (info?.type === "Directory") plugins.set(name, pluginDirectory);
  }
  const disabled = yield* readAntigravityDisabledPlugins(
    path.join(input.profileDirectory, "config", "config.json"),
  );
  return [...plugins]
    .filter(([name]) => !disabled.has(name))
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([, pluginDirectory]) => pluginDirectory);
});

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

const DASH = 0x2d;

/** Finds the byte offset after the second `---`, as parseSkillFrontmatter's indexOf calls do. */
function makeFrontmatterEndFinder() {
  let bytesSeen = 0;
  let dashes = 0;
  let markers = 0;
  return (chunk: Uint8Array) => {
    for (const byte of chunk) {
      bytesSeen += 1;
      dashes = byte === DASH ? dashes + 1 : 0;
      if (dashes === 3) {
        dashes = 0;
        markers += 1;
        if (markers === 2) return bytesSeen;
      }
    }
    return undefined;
  };
}

/** Reads through the frontmatter only, so skill bodies do not spend the scan budget. */
const readSkillFrontmatter = Effect.fn("readAntigravitySkill")(function* (
  skillPath: string,
  budget: ScanBudget,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const info = yield* readIfPresent(fileSystem.stat(skillPath), skillPath);
  if (info?.type !== "File") return undefined;

  const byteLimit = Math.min(MAX_SKILL_BYTES, budget.remainingBytes);
  const findFrontmatterEnd = makeFrontmatterEndFinder();
  let frontmatterEnd: number | undefined;
  const chunks = yield* readIfPresent(
    fileSystem
      .stream(skillPath, { bytesToRead: byteLimit + 1, chunkSize: SKILL_READ_CHUNK_BYTES })
      .pipe(
        Stream.takeUntil((chunk) => (frontmatterEnd = findFrontmatterEnd(chunk)) !== undefined),
        Stream.runCollect,
      ),
    skillPath,
  );
  if (chunks === undefined) return undefined;
  const bytes = Buffer.concat(chunks);
  budget.remainingBytes -= bytes.byteLength;
  if ((frontmatterEnd ?? bytes.byteLength) > byteLimit) {
    return yield* new AntigravitySkillsProbeError({
      reason: "scan-budget-exhausted",
      path: skillPath,
    });
  }
  return bytes.toString("utf8", 0, frontmatterEnd);
});

/** Keep read errors typed so workspace snapshots cannot cache partial results. */
export const discoverAntigravitySkills = Effect.fn("discoverAntigravitySkills")(function* (input: {
  readonly cwd: string;
  readonly userHome: string;
  /** The instance's GEMINI_HOME, where agy loads plugins from. */
  readonly profileDirectory: string;
}): Effect.fn.Return<
  ReadonlyArray<ServerProviderSkill>,
  AntigravitySkillsProbeError,
  FileSystem.FileSystem | Path.Path
> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const [configSkills, cliSkills] = antigravityUserSkillDirectories(
    path,
    path.join(input.userHome, ".gemini"),
  );
  const roots = [
    { directory: configSkills, scope: "user" },
    { directory: path.resolve(input.cwd, ".gemini", "skills"), scope: "project" },
    { directory: cliSkills, scope: "user" },
    { directory: path.resolve(input.cwd, ".agents", "skills"), scope: "project" },
    { directory: path.resolve(input.cwd, ".agent", "skills"), scope: "project" },
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
      const contents = yield* readSkillFrontmatter(skillPath, budget);
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

  for (const pluginDirectory of yield* readAntigravityPlugins(input)) {
    yield* scanDirectory(path.join(pluginDirectory, "skills"), "user", true);
  }
  return [...skillsByName.values()].sort((left, right) => left.name.localeCompare(right.name));
});
