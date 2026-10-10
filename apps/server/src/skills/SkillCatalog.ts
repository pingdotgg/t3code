/**
 * SkillCatalog - a read-only look at the skills in the folders the enabled agents read.
 *
 * Skills are found by reading those folders directly, never by asking an agent to look. Nothing
 * is cached, watched, spawned or written, and every read is bounded. A link that points nowhere
 * and a folder without a SKILL.md are skipped rather than reported as failures, so one bad entry
 * never hides the rest; a folder that exists but can't be read is reported with the list.
 *
 * Agents differ on skills that share a name (see `SkillCollision`): some load only the first
 * copy in their folder order, so a copy that another folder shadows is `none` for that instance,
 * and others load every copy.
 *
 * @module SkillCatalog
 */
import {
  ProviderInstanceId,
  resolveProviderInstanceEnabled,
  type ProviderDriverKind,
  type ProviderInstanceConfig,
  type SkillAgentAccess,
  type SkillCopy,
  type SkillFile,
  type SkillFolderProblem,
  type SkillGetInput,
  type SkillGetResult,
  type SkillListInput,
  type SkillListResult,
  type SkillScope,
  type SkillSummary,
  SkillRequestError,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import {
  AGENT_SKILL_FOLDERS,
  STANDARD_SKILL_FOLDER,
  skillCollisionFor,
  skillRootsFor,
  type AgentSkillFolderList,
} from "@t3tools/provider-core/server/AgentSkillFolders";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";

import {
  parseSkillFrontmatter,
  readSkillOverrides,
  resolveClaudeConfigDirPath,
} from "../provider/Drivers/ClaudeSkills.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { deriveProviderInstanceConfigMap } from "../provider/ProviderInstanceRegistryHydration.ts";
import * as Settings from "../serverSettings.ts";

const SKILL_FILE = "SKILL.md";
const MAX_FOLDER_ENTRIES = 1_000;
const MAX_FILES = 500;
/** Folders walked inside one skill, and entries looked at in each. */
const MAX_DIRECTORIES = 200;
const MAX_DIRECTORY_ENTRIES = 1_000;
const HEAD_BYTES = 4_096;
/** A long description can push the closing `---` of the header past the first read. */
const LONG_HEAD_BYTES = 32_768;
const MAX_SKILL_BYTES = 1024 * 1024;
const DESCRIPTION_CHARS = 160;
const SKIPPED_DIRECTORIES = new Set([".git", "node_modules"]);
const CONCURRENCY = 16;

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const decodeHomePath = Schema.decodeUnknownOption(
  Schema.Struct({ homePath: Schema.optional(Schema.String) }),
);

/**
 * A skill's folder name is whatever the agents' scanners accept, short of what could leave the
 * folder (`.`, `..`, separators, NUL) or hides it (a leading dot).
 */
const isSkillFolderName = (name: string) =>
  name !== "" && !name.startsWith(".") && !/[\\/\0]/.test(name);

const capDescription = (description: string) => {
  const chars = [...description];
  return chars.length > DESCRIPTION_CHARS
    ? `${chars.slice(0, DESCRIPTION_CHARS).join("").trimEnd()}…`
    : description;
};

/** A folder an agent reads skills from. */
interface ReadRoot {
  readonly scope: SkillScope;
  readonly directory: string;
  /** `~/.claude/skills` or `.agents/skills`, as shown to the user. */
  readonly label: string;
  /** The folder most agents share. */
  readonly standard: boolean;
}

const rootKey = (root: Pick<ReadRoot, "scope" | "directory">) => `${root.scope}\0${root.directory}`;

/** An enabled provider instance and the folders it reads, in the order it looks. */
interface AgentInstance {
  readonly instanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind;
  readonly reads: readonly ReadRoot[];
  /**
   * Skill folder names the agent's own settings switch off: Claude's `skillOverrides`. It lists
   * such a skill as disabled and loads none of the copies. Empty for an agent without the setting.
   */
  readonly switchedOff: ReadonlySet<string>;
}

/** One folder entry that holds a skill: a real directory, or a link to one. */
interface FolderEntry {
  readonly root: ReadRoot;
  readonly name: string;
  readonly link: boolean;
  /** Absolute path after following links. */
  readonly home: string;
}

interface SkillHeader {
  readonly description: string;
  /** Claude Code can't read the header, so it skips the skill. */
  readonly invalid: boolean;
}

/** The same skill reached through several folders. */
interface SkillGroup {
  readonly scope: SkillScope;
  readonly name: string;
  readonly home: string;
  readonly entries: readonly FolderEntry[];
  readonly header: SkillHeader;
}

const NOT_FOUND: SkillGetResult = {
  home: null,
  description: "",
  contents: null,
  files: [],
  filesTruncated: false,
};

export class SkillCatalog extends Context.Service<
  SkillCatalog,
  {
    /**
     * One compact record per skill home, in the project (when `cwd` is given) and in the user's
     * home folder. A `cwd` that isn't a registered project's workspace root is refused.
     */
    readonly list: (input: SkillListInput) => Effect.Effect<SkillListResult, SkillRequestError>;
    /** The full SKILL.md text and the file list of one skill from `list`. */
    readonly get: (input: SkillGetInput) => Effect.Effect<SkillGetResult, SkillRequestError>;
  }
>()("t3/skills/SkillCatalog") {}

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const environment = yield* HostProcess.Environment;
  const homeDirectory = yield* HostProcess.HomeDirectory;
  const serverSettings = yield* Settings.ServerSettingsService;
  const projects = yield* ProjectService.ProjectService;

  /** The text at the start of a regular file, at most `maxBytes` of it. */
  const readPrefix = Effect.fnUntraced(function* (file: string, maxBytes: number) {
    const info = yield* fileSystem.stat(file).pipe(Effect.orElseSucceed(() => undefined));
    if (info?.type !== "File") return undefined;
    const size = Number(info.size);
    if (size === 0) return { text: "", truncated: false };
    const chunks = yield* fileSystem.stream(file, { bytesToRead: Math.min(size, maxBytes) }).pipe(
      Stream.runCollect,
      Effect.orElseSucceed(() => undefined),
    );
    return chunks
      ? { text: Buffer.concat(chunks).toString("utf8"), truncated: size > maxBytes }
      : undefined;
  });

  /** SKILL.md under a skill's real folder, unless it is a link that leaves the folder. */
  const readSkillFile = Effect.fnUntraced(function* (home: string, maxBytes: number) {
    const file = path.join(home, SKILL_FILE);
    const real = yield* fileSystem.realPath(file).pipe(Effect.orElseSucceed(() => undefined));
    if (real === undefined || !real.startsWith(`${home}${path.sep}`)) return undefined;
    return yield* readPrefix(real, maxBytes);
  });

  /** The skill's header, or undefined when the folder has no readable SKILL.md. */
  const readHeader = Effect.fnUntraced(function* (home: string) {
    const head = yield* readSkillFile(home, HEAD_BYTES);
    if (!head) return undefined;
    const longer =
      head.truncated && head.text.startsWith("---") && !FRONTMATTER.test(head.text)
        ? yield* readSkillFile(home, LONG_HEAD_BYTES)
        : undefined;
    const header = parseSkillFrontmatter((longer ?? head).text);
    return {
      description:
        header.kind === "parsed" ? (header.description ?? "").replace(/\s+/g, " ").trim() : "",
      invalid: header.kind === "malformed",
    } satisfies SkillHeader;
  });

  /** The folder `name` in a root, when it is a directory or a link to one. */
  const entryAt = Effect.fnUntraced(function* (root: ReadRoot, name: string) {
    const entryPath = path.join(root.directory, name);
    const info = yield* fileSystem.stat(entryPath).pipe(Effect.orElseSucceed(() => undefined));
    if (info?.type !== "Directory") return undefined;
    const home = yield* fileSystem.realPath(entryPath).pipe(Effect.orElseSucceed(() => undefined));
    if (home === undefined) return undefined;
    const link = yield* fileSystem.readLink(entryPath).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );
    return { root, name, link, home } satisfies FolderEntry;
  });

  /** The skill folders in a root. A root that is missing is empty; one that can't be read says so. */
  const scanRoot = Effect.fnUntraced(function* (root: ReadRoot) {
    const listed = yield* fileSystem.readDirectory(root.directory).pipe(
      Effect.map((names) => ({ names, unreadable: false })),
      Effect.catchTags({
        PlatformError: (error) =>
          Effect.succeed({ names: [] as string[], unreadable: error.reason._tag !== "NotFound" }),
      }),
    );
    const entries = yield* Effect.forEach(
      listed.names.filter(isSkillFolderName).toSorted().slice(0, MAX_FOLDER_ENTRIES),
      (name) => entryAt(root, name),
      { concurrency: CONCURRENCY },
    );
    return { root, unreadable: listed.unreadable, entries: entries.filter((e) => e !== undefined) };
  });

  /** A folder as given and as it really is, since either can prefix a real path. */
  const rootsOf = Effect.fnUntraced(function* (directory: string) {
    const real = yield* fileSystem.realPath(directory).pipe(Effect.orElseSucceed(() => directory));
    return [...new Set([real, directory])];
  });

  /** The roots paths are shown against. */
  const displayRootsOf = Effect.fnUntraced(function* (cwd: string | undefined) {
    return {
      project: cwd ? yield* rootsOf(cwd) : [],
      home: yield* rootsOf(homeDirectory),
    };
  });

  /** Relative to the project, or `~/...` under the home directory. */
  const displayPath = (
    absolute: string,
    roots: { readonly project: readonly string[]; readonly home: readonly string[] },
  ) => {
    for (const root of roots.project) {
      if (absolute === root) return ".";
      if (absolute.startsWith(`${root}${path.sep}`)) {
        return path.relative(root, absolute).replaceAll("\\", "/");
      }
    }
    for (const root of roots.home) {
      if (absolute === root) return "~";
      if (absolute.startsWith(`${root}${path.sep}`)) {
        return `~/${path.relative(root, absolute).replaceAll("\\", "/")}`;
      }
    }
    return absolute;
  };

  /**
   * A project's folders are read only when `cwd` is the workspace root of a project the
   * environment knows, so a request can't have the server walk skill folders under any path on
   * the machine. Without a `cwd` only the Global folders are read.
   */
  const requireProject = Effect.fnUntraced(function* (cwd: string | undefined) {
    if (cwd === undefined) return undefined;
    // The lookup resolves a relative path against the server's own folder, so it never sees one.
    const project = path.isAbsolute(cwd)
      ? yield* projects.getByWorkspaceRoot(cwd).pipe(
          Effect.catchTags({
            // A folder that is gone or isn't a folder can't be a project's root.
            ProjectOperationError: (error) =>
              error.operation === "normalize-workspace"
                ? Effect.succeed(Option.none<never>())
                : Effect.die(error),
          }),
        )
      : Option.none();
    if (Option.isNone(project)) {
      return yield* new SkillRequestError({ reason: "projectNotRegistered" });
    }
    return cwd;
  });

  /** A global folder as shown to the user: `~/...` under the home directory, else its path. */
  const globalLabel = (directory: string) => {
    const relative = path.relative(homeDirectory, directory);
    if (relative === "") return "~";
    return relative.startsWith("..") || path.isAbsolute(relative)
      ? directory
      : `~/${relative.replaceAll("\\", "/")}`;
  };

  /**
   * Where an instance keeps its config, which its own global skill folder lives under. This
   * follows the setting or variable that moves the agent's home, in the order the agent applies
   * them; an agent without one stays at its default folder under the home directory.
   */
  const configHomeOf = Effect.fnUntraced(function* (
    instance: ProviderInstanceConfig,
    table: AgentSkillFolderList,
    cwd: string | undefined,
  ) {
    const env = yield* mergeProviderInstanceEnvironment(instance.environment, environment).pipe(
      Effect.provideService(HostProcess.HomeDirectory, homeDirectory),
    );
    const setting = Option.getOrUndefined(decodeHomePath(instance.config))?.homePath?.trim() ?? "";
    const fallback = path.join(homeDirectory, table.configHome ?? "");
    const absoluteOr = (value: string | undefined) =>
      value && path.isAbsolute(value) ? value : fallback;
    if (instance.driver === "claudeAgent") {
      return yield* resolveClaudeConfigDirPath({ homePath: setting }, env, cwd).pipe(
        Effect.provideService(Path.Path, path),
        Effect.provideService(HostProcess.HomeDirectory, homeDirectory),
      );
    }
    if (instance.driver === "codex") {
      return absoluteOr(expandHomePath(setting || (env.CODEX_HOME?.trim() ?? ""), homeDirectory));
    }
    if (instance.driver === "grok") return absoluteOr(env.GROK_HOME?.trim());
    return fallback;
  });

  /**
   * The skills Claude's settings switch off, resolved the way the `$` picker resolves them: the
   * user's, the project's and its local file, then the managed policy, last one naming a skill
   * wins.
   */
  const claudeSwitchedOff = Effect.fnUntraced(function* (
    instance: ProviderInstanceConfig,
    configHome: string,
    cwd: string | undefined,
  ) {
    const env = yield* mergeProviderInstanceEnvironment(instance.environment, environment).pipe(
      Effect.provideService(HostProcess.HomeDirectory, homeDirectory),
    );
    const overrides = yield* readSkillOverrides(configHome, cwd, env).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );
    return new Set([...overrides].flatMap(([name, override]) => (override.enabled ? [] : [name])));
  });

  /** The enabled provider instances whose folders T3 Code knows, in the table's order. */
  const loadInstances = Effect.fnUntraced(function* (cwd: string | undefined) {
    const settings = yield* serverSettings.getSettings.pipe(Effect.option);
    if (Option.isNone(settings)) return [];
    const configs = Object.entries(deriveProviderInstanceConfigMap(settings.value));
    const instances: AgentInstance[] = [];
    for (const table of AGENT_SKILL_FOLDERS) {
      for (const [instanceId, config] of configs) {
        if (config.driver !== table.agent || !resolveProviderInstanceEnabled(config)) continue;
        const configHome = yield* configHomeOf(config, table, cwd);
        const reads = skillRootsFor(table.agent).flatMap((root): ReadRoot[] => {
          const standard = root.folder === STANDARD_SKILL_FOLDER;
          if (root.scope === "project") {
            return cwd
              ? [
                  {
                    scope: "project",
                    directory: path.join(cwd, root.folder),
                    label: root.folder,
                    standard,
                  },
                ]
              : [];
          }
          const prefix = table.configHome === undefined ? undefined : `${table.configHome}/`;
          const directory =
            prefix !== undefined && root.folder.startsWith(prefix)
              ? path.join(configHome, root.folder.slice(prefix.length))
              : path.join(homeDirectory, root.folder);
          return [{ scope: "global", directory, label: globalLabel(directory), standard }];
        });
        instances.push({
          instanceId: ProviderInstanceId.make(instanceId),
          driver: table.agent,
          reads,
          switchedOff:
            table.agent === "claudeAgent"
              ? yield* claudeSwitchedOff(config, configHome, cwd)
              : new Set(),
        });
      }
    }
    return instances;
  });

  /** The shared folders, then every folder an enabled instance reads, each once. */
  const rootsFor = (cwd: string | undefined, instances: readonly AgentInstance[]) => {
    const standard: ReadRoot[] = [
      {
        scope: "global",
        directory: path.join(homeDirectory, STANDARD_SKILL_FOLDER),
        label: globalLabel(path.join(homeDirectory, STANDARD_SKILL_FOLDER)),
        standard: true,
      },
      ...(cwd
        ? [
            {
              scope: "project" as const,
              directory: path.join(cwd, STANDARD_SKILL_FOLDER),
              label: STANDARD_SKILL_FOLDER,
              standard: true,
            },
          ]
        : []),
    ];
    const byKey = new Map<string, ReadRoot>();
    for (const root of [...standard, ...instances.flatMap((instance) => instance.reads)]) {
      if (!byKey.has(rootKey(root))) byKey.set(rootKey(root), root);
    }
    return [...byKey.values()];
  };

  /** SKILL.md text of each skill, read once, and `undefined` when it can't be shown whole. */
  const makeTextReader = () => {
    const texts = new Map<string, string | undefined>();
    return Effect.fnUntraced(function* (home: string) {
      if (!texts.has(home)) {
        const file = yield* readSkillFile(home, MAX_SKILL_BYTES);
        texts.set(home, file && !file.truncated ? file.text : undefined);
      }
      return texts.get(home);
    });
  };

  /** The other skills that share a name with each skill, and whether their text is identical. */
  const compareCopies = Effect.fnUntraced(function* (
    groups: readonly SkillGroup[],
    roots: { readonly project: readonly string[]; readonly home: readonly string[] },
  ) {
    const textOf = makeTextReader();
    const result = new Map<SkillGroup, SkillCopy[]>();
    for (const members of Map.groupBy(groups, (group) => group.name).values()) {
      for (const group of members) {
        const copies: SkillCopy[] = [];
        for (const other of members.filter((member) => member !== group)) {
          let same = other.home === group.home;
          if (!same) {
            const [left, right] = yield* Effect.all([textOf(group.home), textOf(other.home)]);
            same = left !== undefined && left === right;
          }
          copies.push({ scope: other.scope, home: displayPath(other.home, roots), same });
        }
        if (copies.length > 0) {
          result.set(
            group,
            copies.toSorted(
              (a, b) =>
                Number(b.scope === "project") - Number(a.scope === "project") ||
                a.home.localeCompare(b.home),
            ),
          );
        }
      }
    }
    return result;
  });

  const list: SkillCatalog["Service"]["list"] = Effect.fn("SkillCatalog.list")(function* (input) {
    const cwd = yield* requireProject(input.cwd);
    const displayRoots = yield* displayRootsOf(cwd);
    const instances = yield* loadInstances(cwd);
    const roots = rootsFor(cwd, instances);
    const scanned = yield* Effect.forEach(roots, scanRoot, { concurrency: CONCURRENCY });

    // Group by what is really on disk: the same folder reached through several links is one skill.
    const grouped = new Map<string, Omit<SkillGroup, "header">>();
    for (const { entries } of scanned) {
      for (const entry of entries) {
        const key = `${entry.root.scope}\0${entry.name}\0${entry.home}`;
        const existing = grouped.get(key);
        grouped.set(
          key,
          existing
            ? { ...existing, entries: [...existing.entries, entry] }
            : { scope: entry.root.scope, name: entry.name, home: entry.home, entries: [entry] },
        );
      }
    }

    const headers = new Map(
      yield* Effect.forEach(
        new Set([...grouped.values()].map((group) => group.home)),
        (home) => readHeader(home).pipe(Effect.map((header) => [home, header] as const)),
        { concurrency: CONCURRENCY },
      ),
    );
    // A folder without a SKILL.md isn't a skill, whatever links to it.
    const groups = [...grouped.values()].flatMap((group): SkillGroup[] => {
      const header = headers.get(group.home);
      return header === undefined ? [] : [{ ...group, header }];
    });
    const groupOf = new Map(
      groups.flatMap((group) => group.entries.map((e) => [e, group] as const)),
    );
    const entryAtRoot = new Map(
      scanned.map(
        ({ root, entries }) => [rootKey(root), new Map(entries.map((e) => [e.name, e]))] as const,
      ),
    );
    const copies = yield* compareCopies(groups, displayRoots);

    /** How one instance reaches a skill: through the folders it loads it from, else `none`. */
    const accessFor = (group: SkillGroup, instance: AgentInstance): SkillAgentAccess => {
      const found = instance.reads.flatMap((root) => {
        const entry = entryAtRoot.get(rootKey(root))?.get(group.name);
        const owner = entry && groupOf.get(entry);
        // Claude skips a skill whose header it can't read, and it doesn't shadow a later one.
        const skipped = instance.driver === "claudeAgent" && owner?.header.invalid === true;
        return entry && owner && !skipped ? [{ entry, owner }] : [];
      });
      // A first-wins agent loads only the first copy in its order; the others load every copy.
      const firstWins = skillCollisionFor(instance.driver) === "first-wins";
      const loaded =
        instance.switchedOff.has(group.name) || (firstWins && found[0]?.owner !== group)
          ? []
          : found.filter((f) => f.owner === group);
      // One copy can be reached through several of the agent's folders; the shared one is shown.
      const via = (loaded.find((f) => f.entry.root.standard) ?? loaded[0])?.entry;
      if (via) {
        return {
          instanceId: instance.instanceId,
          driver: instance.driver,
          state: via.root.standard || !via.link ? "direct" : "link",
          folder: via.root.label,
        };
      }
      const looksIn = instance.reads.find((root) => root.scope === group.scope);
      return {
        instanceId: instance.instanceId,
        driver: instance.driver,
        state: "none",
        folder:
          looksIn?.label ??
          (group.scope === "global"
            ? globalLabel(path.join(homeDirectory, STANDARD_SKILL_FOLDER))
            : STANDARD_SKILL_FOLDER),
      };
    };

    const skills = groups.map((group): SkillSummary => ({
      name: group.name,
      scope: group.scope,
      home: displayPath(group.home, displayRoots),
      description: capDescription(group.header.description),
      ...(group.header.invalid ? { invalidHeader: true } : {}),
      copies: copies.get(group) ?? [],
      access: instances.map((instance) => accessFor(group, instance)),
    }));

    const unreadable = new Map<string, SkillFolderProblem>();
    for (const { root, unreadable: failed } of scanned) {
      if (failed)
        unreadable.set(`${root.scope}\0${root.label}`, { scope: root.scope, folder: root.label });
    }

    return {
      skills: skills.toSorted(
        (a, b) =>
          a.name.localeCompare(b.name) ||
          Number(b.scope === "project") - Number(a.scope === "project"),
      ),
      unreadable: [...unreadable.values()],
    };
  });

  /**
   * Relative paths and sizes of the files under a skill's folder, breadth first. It stops at the
   * file limit, and bounds the folders it enters and the entries it looks at in each, so a skill
   * with a huge or deeply branching tree costs a fixed amount of work.
   */
  const walkSkillFiles = Effect.fnUntraced(function* (root: string) {
    const files: SkillFile[] = [];
    const pending = [""];
    let visited = 0;
    let truncated = false;
    let full = false;
    while (pending.length > 0 && !full) {
      const relative = pending.shift() ?? "";
      visited += 1;
      const names = (yield* fileSystem
        .readDirectory(path.join(root, relative))
        .pipe(Effect.orElseSucceed((): string[] => []))).toSorted();
      if (names.length > MAX_DIRECTORY_ENTRIES) truncated = true;
      const looked = names.slice(0, MAX_DIRECTORY_ENTRIES);
      for (let start = 0; start < looked.length && !full; start += CONCURRENCY) {
        const children = yield* Effect.forEach(
          looked.slice(start, start + CONCURRENCY),
          (name) =>
            Effect.gen(function* () {
              const absolute = path.join(root, relative, name);
              const link = yield* fileSystem.readLink(absolute).pipe(
                Effect.as(true),
                Effect.orElseSucceed(() => false),
              );
              const info = link
                ? undefined
                : yield* fileSystem.stat(absolute).pipe(Effect.orElseSucceed(() => undefined));
              return { name, link, info };
            }),
          { concurrency: CONCURRENCY },
        );
        for (const { name, link, info } of children) {
          const childPath = relative ? `${relative}/${name}` : name;
          if (info?.type === "Directory") {
            if (SKIPPED_DIRECTORIES.has(name)) continue;
            if (visited + pending.length >= MAX_DIRECTORIES) truncated = true;
            else pending.push(childPath);
            continue;
          }
          // Links count as files and are never followed; other special files aren't shown.
          if (!link && info?.type !== "File") continue;
          if (files.length >= MAX_FILES) {
            truncated = true;
            full = true;
            break;
          }
          files.push({
            path: childPath,
            size: info ? Number(info.size) : 0,
            executable: info !== undefined && (info.mode & 0o111) !== 0,
          });
        }
      }
    }
    return {
      files: files.toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
      truncated,
    };
  });

  const get: SkillCatalog["Service"]["get"] = Effect.fn("SkillCatalog.get")(function* (input) {
    const cwd = yield* requireProject(input.cwd);
    const base = input.scope === "project" ? cwd : homeDirectory;
    if (!base || !isSkillFolderName(input.name)) return NOT_FOUND;
    // Only the folders agents read are looked in, so the request can't name an arbitrary path.
    const roots = rootsFor(cwd, yield* loadInstances(cwd)).filter(
      (root) => root.scope === input.scope,
    );
    const candidates = yield* Effect.forEach(roots, (root) => entryAt(root, input.name), {
      concurrency: CONCURRENCY,
    });
    const displayRoots = yield* displayRootsOf(cwd);
    const chosen = candidates.find(
      (entry) => entry !== undefined && displayPath(entry.home, displayRoots) === input.home,
    );
    if (!chosen) return NOT_FOUND;
    const header = yield* readHeader(chosen.home);
    const skillFile = yield* readSkillFile(chosen.home, MAX_SKILL_BYTES);
    const { files, truncated } = yield* walkSkillFiles(chosen.home);
    return {
      home: chosen.home,
      description: header?.description ?? "",
      contents: skillFile && !skillFile.truncated ? skillFile.text : null,
      files,
      filesTruncated: truncated,
    };
  });

  return SkillCatalog.of({ list, get });
});

export const layer = Layer.effect(SkillCatalog, make);
