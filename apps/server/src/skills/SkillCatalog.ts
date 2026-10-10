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
 * An agent that can see a skill but whose own settings switch it off is `off`, read from the
 * agent's settings files and never by asking the agent (see `AgentSkillSettings`). One that reads
 * the skill's folder directly, with no setting T3 Code can write, is `fixed`.
 *
 * @module SkillCatalog
 */
import {
  ProviderInstanceId,
  resolveProviderInstanceEnabled,
  type ProviderDriverKind,
  type ProviderInstanceConfig,
  type SkillAgentAccess,
  type SkillAgentState,
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
import * as Stream from "effect/Stream";

import {
  AGENT_SKILL_FOLDERS,
  STANDARD_SKILL_FOLDER,
  ownProjectFolderFor,
  skillCollisionFor,
  skillFoldersFor,
  skillRootsFor,
  type AgentSkillFolderList,
  type SkillCollision,
} from "@t3tools/provider-core/server/AgentSkillFolders";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";

import { parseSkillFrontmatter } from "../provider/Drivers/ClaudeSkills.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { deriveProviderInstanceConfigMap } from "../provider/ProviderInstanceRegistryHydration.ts";
import * as Settings from "../serverSettings.ts";
import { resolveAgentConfigHome } from "./AgentConfigHome.ts";
import {
  loadSkillSwitches,
  skillSwitchKind,
  type SkillSwitchContext,
  type SkillSwitchView,
  type SwitchedSkill,
} from "./AgentSkillSettings.ts";
import { codexSettingsHome } from "./CodexSkillSettings.ts";
import {
  LIBRARY_FOLDER,
  RegisteredProjects,
  libraryLinksIn,
  linkLeadsTo,
  type LibraryLink,
} from "./SkillLibrary.ts";
import { readSources } from "./SkillLockFiles.ts";

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
  /** The library of Global skills used in only some projects, which no agent reads. */
  readonly library?: boolean;
}

const rootKey = (root: Pick<ReadRoot, "scope" | "directory">) => `${root.scope}\0${root.directory}`;

/** An enabled provider instance and the folders it reads, in the order it looks. */
interface AgentInstance {
  readonly instanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind;
  readonly reads: readonly ReadRoot[];
  /** What it takes to read and write the agent's own skill settings. */
  readonly switches: SkillSwitchContext;
}

/** One folder entry that holds a skill: a real directory, or a link to one. */
interface FolderEntry {
  readonly root: ReadRoot;
  readonly name: string;
  /** What the link points at, as written; undefined for a real directory. */
  readonly target: string | undefined;
  /** Absolute path after following links. */
  readonly home: string;
  /** A project's link to a library skill, which is that Global skill and not one of the project's. */
  readonly libraryLink?: boolean;
}

interface SkillHeader {
  /** The `name` in the header, which Codex names a skill by. */
  readonly declaredName: string | undefined;
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

/**
 * One skill as the folders hold it, with what it takes to change who reads it. `list` shows the
 * same facts as a summary.
 */
export interface ResolvedSkill {
  readonly scope: SkillScope;
  readonly name: string;
  /** The same display path as `SkillSummary.home`. */
  readonly displayHome: string;
  /** The `name` in the skill's header, when it has one. */
  readonly declaredName?: string | undefined;
  /** Absolute path of the skill's folder, after following links. */
  readonly home: string;
  /**
   * The home is a real folder in one of the agents' skill folders, reached without a link on the
   * way. Only such a skill is T3 Code's to move or delete; a synced library's skill is not.
   */
  readonly own: boolean;
  /** The shared folder of each scope, where a moved skill lands; a project's needs `cwd`. */
  readonly standardFolders: Readonly<Record<SkillScope, string | undefined>>;
  /**
   * Set when the skill is kept in the library (`SkillLibrary`): its entry there, what that links
   * to when it is a link to a synced folder, and the links to it in the registered projects'
   * folders. Such a skill reaches an agent through those links, whichever project the list is for,
   * so its `agents` say what the links give each agent across all of them.
   */
  readonly library?: {
    readonly entry: string;
    readonly target: string | undefined;
    readonly links: ReadonlyArray<LibraryLink>;
  };
  /** Every entry in the agents' folders that reaches the skill: a real folder, or a link. */
  readonly entries: ReadonlyArray<{
    readonly path: string;
    /** The folder the entry is in. */
    readonly directory: string;
    /** What the link points at, as written; undefined for a real folder. */
    readonly target: string | undefined;
  }>;
  readonly agents: ReadonlyArray<{
    readonly instanceId: ProviderInstanceId;
    readonly driver: ProviderDriverKind;
    readonly collision: SkillCollision;
    readonly state: SkillAgentState;
    /** Paths of the entries it loads the skill from; empty when `state` is `none`. */
    readonly via: readonly string[];
    /** T3 Code can't switch this agent for this skill (see `SkillAgentAccess.fixed`). */
    readonly fixed?: boolean;
    /** The agent's own settings switch the skill off, whether or not it can see the skill. */
    readonly switchedOff?: boolean;
    /** Set when the agent has a settings switch for this skill, to read and write it. */
    readonly settings?: SkillSwitchContext | undefined;
    /** The folders it reads, in the order it looks, across both scopes. */
    readonly reads: ReadonlyArray<{
      readonly scope: SkillScope;
      readonly directory: string;
      readonly label: string;
      readonly standard: boolean;
      /** The agent would load a different skill with this name from here. */
      readonly rival: boolean;
    }>;
  }>;
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
    /**
     * Every skill in the agents' folders with this scope and name, as the folders hold it now.
     * A project skill needs `cwd`, which must be a registered project's workspace root like the
     * one `list` takes. Nothing is written.
     */
    readonly resolve: (input: {
      readonly cwd?: string | undefined;
      readonly skills: ReadonlyArray<{ readonly scope: SkillScope; readonly name: string }>;
    }) => Effect.Effect<ReadonlyArray<ResolvedSkill>, SkillRequestError>;
  }
>()("t3/skills/SkillCatalog") {}

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const environment = yield* HostProcess.Environment;
  const homeDirectory = yield* HostProcess.HomeDirectory;
  const serverSettings = yield* Settings.ServerSettingsService;
  const projects = yield* ProjectService.ProjectService;
  const registeredProjects = yield* RegisteredProjects;
  // The lock and library readers take the filesystem from their environment.
  const filesystemContext = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
  const libraryDirectory = path.join(homeDirectory, LIBRARY_FOLDER);

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
      declaredName: header.kind === "parsed" ? header.name : undefined,
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
    const target = yield* fileSystem.readLink(entryPath).pipe(
      Effect.map((value): string | undefined => value),
      Effect.orElseSucceed(() => undefined),
    );
    const libraryLink =
      root.scope === "project" &&
      target !== undefined &&
      linkLeadsTo(path, { path: entryPath, target }, path.join(libraryDirectory, name));
    return {
      root,
      name,
      target,
      home,
      ...(libraryLink ? { libraryLink } : {}),
    } satisfies FolderEntry;
  });

  /**
   * The skill folders in a root, or only those named in `only`. A root that is missing is empty;
   * one that can't be read says so.
   */
  const scanRoot = Effect.fnUntraced(function* (root: ReadRoot, only?: ReadonlySet<string>) {
    const listed = yield* fileSystem.readDirectory(root.directory).pipe(
      Effect.map((names) => ({ names, unreadable: false })),
      Effect.catchTags({
        PlatformError: (error) =>
          Effect.succeed({ names: [] as string[], unreadable: error.reason._tag !== "NotFound" }),
      }),
    );
    const entries = yield* Effect.forEach(
      listed.names
        .filter((name) => isSkillFolderName(name) && (only === undefined || only.has(name)))
        .toSorted()
        .slice(0, MAX_FOLDER_ENTRIES),
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
   * Where an instance keeps its config, which its own global skill folder lives under; an agent
   * without a setting or variable that moves it stays at its default folder under the home
   * directory.
   */
  const configHomeOf = (
    instance: ProviderInstanceConfig,
    table: AgentSkillFolderList,
    cwd: string | undefined,
  ) =>
    resolveAgentConfigHome({
      instance,
      fallback: path.join(homeDirectory, table.configHome ?? ""),
      environment,
      cwd,
    }).pipe(
      Effect.provideService(Path.Path, path),
      Effect.provideService(HostProcess.HomeDirectory, homeDirectory),
    );

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
          switches: {
            driver: table.agent,
            // The skill folders follow the instance's home; its settings file is the one its
            // Codex runs with, which is the shadow home's when it has one.
            configHome:
              table.agent === "codex"
                ? codexSettingsHome(path, config.config, configHome, homeDirectory)
                : configHome,
            homeDirectory,
            environment: yield* mergeProviderInstanceEnvironment(
              config.environment,
              environment,
            ).pipe(Effect.provideService(HostProcess.HomeDirectory, homeDirectory)),
            cwd,
          },
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
      // Listed as Global skills, but read by no agent: a skill here is used where it is linked.
      {
        scope: "global",
        directory: libraryDirectory,
        label: globalLabel(libraryDirectory),
        standard: false,
        library: true,
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

  /**
   * What the agents' folders hold, grouped by what each folder really holds, and how each
   * instance reaches every group. `only` narrows the scan to skills with those names.
   */
  const scanSkills = Effect.fnUntraced(function* (
    cwd: string | undefined,
    only?: ReadonlySet<string>,
  ) {
    const displayRoots = yield* displayRootsOf(cwd);
    const instances = yield* loadInstances(cwd);
    const roots = rootsFor(cwd, instances);
    const scanned = yield* Effect.forEach(roots, (root) => scanRoot(root, only), {
      concurrency: CONCURRENCY,
    });

    // A folder is plain when it is where its path says, with no link on the way below the base.
    const bases = {
      project: cwd === undefined ? undefined : { given: cwd, real: displayRoots.project[0] ?? cwd },
      global: { given: homeDirectory, real: displayRoots.home[0] ?? homeDirectory },
    };
    const plainRoots = new Set<string>();
    yield* Effect.forEach(
      roots,
      (root) =>
        Effect.gen(function* () {
          const base = bases[root.scope];
          const real = yield* fileSystem
            .realPath(root.directory)
            .pipe(Effect.orElseSucceed(() => undefined));
          if (base === undefined || real === undefined) return;
          const relative = path.relative(base.given, root.directory);
          const inside = !relative.startsWith("..") && !path.isAbsolute(relative);
          if (real === (inside ? path.join(base.real, relative) : root.directory)) {
            plainRoots.add(rootKey(root));
          }
        }),
      { concurrency: CONCURRENCY, discard: true },
    );
    const isOwn = (group: Pick<SkillGroup, "entries">) =>
      group.entries.some(
        (entry) => entry.target === undefined && plainRoots.has(rootKey(entry.root)),
      );

    // Group by what is really on disk: the same folder reached through several links is one skill.
    const grouped = new Map<string, Omit<SkillGroup, "header">>();
    for (const { entries } of scanned) {
      for (const entry of entries) {
        // A project's link to a library skill is the Global skill itself.
        const scope = entry.libraryLink ? "global" : entry.root.scope;
        const key = `${scope}\0${entry.name}\0${entry.home}`;
        const existing = grouped.get(key);
        grouped.set(
          key,
          existing
            ? { ...existing, entries: [...existing.entries, entry] }
            : { scope, name: entry.name, home: entry.home, entries: [entry] },
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

    // What each agent's own settings switch off. Read once for the scan, from files only.
    const views = new Map<ProviderInstanceId, SkillSwitchView>(
      groups.length === 0
        ? []
        : yield* Effect.forEach(
            instances.filter((instance) =>
              (["global", "project"] as const).some(
                (scope) => skillSwitchKind(instance.driver, scope) !== undefined,
              ),
            ),
            (instance) =>
              loadSkillSwitches(instance.switches).pipe(
                Effect.provideService(FileSystem.FileSystem, fileSystem),
                Effect.provideService(Path.Path, path),
                Effect.map((view) => [instance.instanceId, view] as const),
              ),
            { concurrency: CONCURRENCY },
          ),
    );
    const switchedSkillOf = (group: SkillGroup): SwitchedSkill => ({
      scope: group.scope,
      name: group.name,
      declaredName: group.header.declaredName,
      home: group.home,
      entryPaths: group.entries.map((entry) => path.join(entry.root.directory, entry.name)),
    });

    /** What an instance would load from one folder for this name, if anything. */
    const loadableAt = (group: SkillGroup, instance: AgentInstance, root: ReadRoot) => {
      const entry = entryAtRoot.get(rootKey(root))?.get(group.name);
      const owner = entry && groupOf.get(entry);
      // Claude skips a skill whose header it can't read, and it doesn't shadow a later one.
      const skipped = instance.driver === "claudeAgent" && owner?.header.invalid === true;
      return entry && owner && !skipped ? { entry, owner } : undefined;
    };

    // The registered projects' links to each library skill, read only when there are any.
    const libraryEntries = new Map(
      groups.flatMap((group) => {
        const entry = group.entries.find((item) => item.root.library === true);
        return entry === undefined
          ? []
          : [[group.name, path.join(entry.root.directory, entry.name)] as const];
      }),
    );
    const libraryLinks =
      libraryEntries.size === 0
        ? new Map<string, LibraryLink[]>()
        : yield* libraryLinksIn({
            roots: yield* registeredProjects,
            entries: libraryEntries,
          }).pipe(Effect.provideContext(filesystemContext));
    const isLibrary = (group: SkillGroup) =>
      group.entries.some((entry) => entry.root.library === true);

    /**
     * How an instance reaches a library skill: through its links in the projects' folders, across
     * all of them, whichever project the list is for. An agent that reads the shared folder has
     * the link every project using the skill has; one that doesn't needs a link in its own folder.
     */
    const libraryAccessFor = (group: SkillGroup, instance: AgentInstance) => {
      const folders = skillFoldersFor(instance.driver, "project");
      const seen = (libraryLinks.get(group.name) ?? []).filter((link) =>
        folders.includes(link.folder),
      );
      const settings =
        skillSwitchKind(instance.driver, group.scope, "projects") === undefined
          ? undefined
          : instance.switches;
      const switchedOff =
        settings !== undefined &&
        views.get(instance.instanceId)?.off(switchedSkillOf(group)) === true;
      const shared = seen.some((link) => link.folder === STANDARD_SKILL_FOLDER);
      const folder =
        (shared ? STANDARD_SKILL_FOLDER : seen[0]?.folder) ??
        ownProjectFolderFor(instance.driver) ??
        STANDARD_SKILL_FOLDER;
      const fixed = seen.length > 0 && shared && !switchedOff && settings === undefined;
      return {
        loadedEntries: [] as FolderEntry[],
        switchedOff,
        settings,
        access: {
          instanceId: instance.instanceId,
          driver: instance.driver,
          state: seen.length === 0 ? "none" : switchedOff ? "off" : shared ? "direct" : "link",
          folder,
          ...(fixed ? { fixed } : {}),
        } satisfies SkillAgentAccess,
      };
    };

    /** How one instance reaches a skill: through the folders it loads it from, else `none`. */
    const accessFor = (group: SkillGroup, instance: AgentInstance) => {
      if (isLibrary(group)) return libraryAccessFor(group, instance);
      const found = instance.reads.flatMap((root) => {
        const loadable = loadableAt(group, instance, root);
        return loadable ? [loadable] : [];
      });
      // A first-wins agent loads only the first copy in its order; the others load every copy.
      const firstWins = skillCollisionFor(instance.driver) === "first-wins";
      const loaded =
        firstWins && found[0]?.owner !== group ? [] : found.filter((f) => f.owner === group);
      // One copy can be reached through several of the agent's folders; the shared one is shown.
      const via = (loaded.find((f) => f.entry.root.standard) ?? loaded[0])?.entry;
      const loadedEntries = loaded.map((f) => f.entry);
      // The agent's own settings, where T3 Code knows how to write them for this skill.
      const settings =
        skillSwitchKind(instance.driver, group.scope) === undefined ? undefined : instance.switches;
      const switchedOff =
        settings !== undefined &&
        views.get(instance.instanceId)?.off(switchedSkillOf(group)) === true;
      if (via) {
        // A link T3 Code made can be taken away; a folder the agent reads itself can't.
        const reachedDirectly = via.root.standard || via.target === undefined;
        const fixed = reachedDirectly && !switchedOff && settings === undefined;
        return {
          loadedEntries,
          switchedOff,
          settings,
          access: {
            instanceId: instance.instanceId,
            driver: instance.driver,
            state: switchedOff ? "off" : reachedDirectly ? "direct" : "link",
            folder: via.root.label,
            ...(fixed ? { fixed } : {}),
          } satisfies SkillAgentAccess,
        };
      }
      const looksIn = instance.reads.find((root) => root.scope === group.scope);
      return {
        loadedEntries,
        switchedOff,
        settings,
        access: {
          instanceId: instance.instanceId,
          driver: instance.driver,
          state: "none",
          folder:
            looksIn?.label ??
            (group.scope === "global"
              ? globalLabel(path.join(homeDirectory, STANDARD_SKILL_FOLDER))
              : STANDARD_SKILL_FOLDER),
        } satisfies SkillAgentAccess,
      };
    };

    return {
      displayRoots,
      instances,
      scanned,
      groups,
      accessFor,
      loadableAt,
      isOwn,
      roots,
      libraryLinks,
    };
  });

  const list: SkillCatalog["Service"]["list"] = Effect.fn("SkillCatalog.list")(function* (input) {
    const cwd = yield* requireProject(input.cwd);
    const { displayRoots, instances, scanned, groups, accessFor, isOwn, libraryLinks } =
      yield* scanSkills(cwd);
    const copies = yield* compareCopies(groups, displayRoots);
    const sources = yield* readSources({
      environment,
      home: homeDirectory,
      projectRoot: cwd,
    }).pipe(Effect.provideContext(filesystemContext));

    const skills = groups.map((group): SkillSummary => {
      const source = (group.scope === "project" ? sources.project : sources.global).get(group.name);
      // The projects a library skill is used in: where the shared folder has its link.
      const using = group.entries.some((item) => item.root.library === true)
        ? [
            ...new Set(
              (libraryLinks.get(group.name) ?? [])
                .filter((link) => link.folder === STANDARD_SKILL_FOLDER)
                .map((link) => link.project),
            ),
          ]
        : [];
      return {
        name: group.name,
        scope: group.scope,
        home: displayPath(group.home, displayRoots),
        description: capDescription(group.header.description),
        ...(group.header.invalid ? { invalidHeader: true } : {}),
        ...(isOwn(group) ? { realFolder: true } : {}),
        copies: copies.get(group) ?? [],
        access: instances.map((instance) => accessFor(group, instance).access),
        ...(source === undefined ? {} : { source }),
        ...(using.length === 0 ? {} : { projects: using }),
      };
    });

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

  /** Where a group is kept in the library, when it is, and the projects' links to it. */
  const libraryOf = (group: SkillGroup, links: ReadonlyMap<string, LibraryLink[]>) => {
    const entry = group.entries.find((item) => item.root.library === true);
    return entry === undefined
      ? {}
      : {
          library: {
            entry: path.join(entry.root.directory, entry.name),
            target: entry.target,
            links: links.get(group.name) ?? [],
          },
        };
  };

  const resolve: SkillCatalog["Service"]["resolve"] = Effect.fn("SkillCatalog.resolve")(
    function* (input) {
      const cwd = yield* requireProject(input.cwd);
      const wanted = input.skills.filter(
        (skill) => isSkillFolderName(skill.name) && (skill.scope === "global" || cwd !== undefined),
      );
      if (wanted.length === 0) return [];
      const { displayRoots, instances, groups, accessFor, loadableAt, isOwn, roots, libraryLinks } =
        yield* scanSkills(cwd, new Set(wanted.map((skill) => skill.name)));
      const standardFolders = {
        project: roots.find((root) => root.scope === "project" && root.standard)?.directory,
        global: roots.find((root) => root.scope === "global" && root.standard)?.directory,
      };
      const wantedKeys = new Set(wanted.map((skill) => `${skill.scope}\0${skill.name}`));
      return groups
        .filter((group) => wantedKeys.has(`${group.scope}\0${group.name}`))
        .map((group): ResolvedSkill => ({
          scope: group.scope,
          name: group.name,
          displayHome: displayPath(group.home, displayRoots),
          declaredName: group.header.declaredName,
          home: group.home,
          own: isOwn(group),
          standardFolders,
          ...libraryOf(group, libraryLinks),
          entries: group.entries.map((entry) => ({
            path: path.join(entry.root.directory, entry.name),
            directory: entry.root.directory,
            target: entry.target,
          })),
          agents: instances.map((instance) => {
            const { access, loadedEntries, switchedOff, settings } = accessFor(group, instance);
            return {
              instanceId: instance.instanceId,
              driver: instance.driver,
              collision: skillCollisionFor(instance.driver),
              state: access.state,
              via: loadedEntries.map((entry) => path.join(entry.root.directory, entry.name)),
              ...("fixed" in access ? { fixed: true } : {}),
              ...(switchedOff ? { switchedOff } : {}),
              settings,
              reads: instance.reads.map((root) => {
                const loadable = loadableAt(group, instance, root);
                return {
                  scope: root.scope,
                  directory: root.directory,
                  label: root.label,
                  standard: root.standard,
                  rival: loadable !== undefined && loadable.owner !== group,
                };
              }),
            };
          }),
        }));
    },
  );

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

  return SkillCatalog.of({ list, get, resolve });
});

export const layer = Layer.effect(SkillCatalog, make);
