/**
 * InstructionCatalog - a read-only look at the instruction files (AGENTS.md, CLAUDE.md and
 * friends) the enabled agents read, and at which agent reads which.
 *
 * Files are found by reading the places `AgentInstructionFiles` names, never by asking an agent.
 * Nothing is cached, watched, spawned or written, and every read is bounded. A list looks only at
 * the project's top folder and at the agents' home files; a file in a subfolder comes from the
 * project's file index. What each agent reads follows its rules in the table, not an assumption:
 * Pi stops at the first file of a folder, OpenCode falls back to CLAUDE.md only when there is no
 * AGENTS.md, Codex prefers AGENTS.override.md, and Claude reads a project AGENTS.md only as its
 * "Project instructions" setting, its own CLAUDE.md files and its version allow.
 *
 * The all-projects file is one real file the agents' home files link to, `~/.agents/AGENTS.md`
 * unless the agents' home files already link to one other file, which is then kept (see
 * `sharedLocation`). Ids are built here and are the only way to name a file: a client never sends
 * a path, so every id is resolved again from the table (see `resolve`).
 *
 * @module InstructionCatalog
 */
import {
  InstructionError,
  PROVIDER_DISPLAY_NAMES,
  ProviderInstanceId,
  resolveProviderInstanceEnabled,
  type ClaudeInstructionChoice,
  type InstructionAgentAccess,
  type InstructionAgentReason,
  type InstructionAgentState,
  type InstructionEntry,
  type InstructionKind,
  type InstructionListInput,
  type InstructionListResult,
  type InstructionProblem,
  type InstructionReadInput,
  type InstructionReadResult,
  type InstructionScope,
  type ProviderDriverKind,
  type ProviderInstanceConfig,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import { AGENT_SKILL_FOLDERS } from "@t3tools/provider-core/server/AgentSkillFolders";

import * as ProjectService from "../project/ProjectService.ts";
import { deriveProviderInstanceConfigMap } from "../provider/ProviderInstanceRegistryHydration.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as Settings from "../serverSettings.ts";
import { resolveAgentConfigHome } from "../skills/AgentConfigHome.ts";
import * as WorkspaceEntries from "../workspace/WorkspaceEntries.ts";
import {
  AGENT_INSTRUCTION_FILES,
  claudeManagedInstructionPath,
  type AgentInstructionRules,
  type HomeInstructionRules,
} from "./AgentInstructionFiles.ts";
import {
  DEFAULT_CLAUDE_INSTRUCTION_VALUE,
  hasAgentsMdImport,
  parseSettingsJson,
  readClaudeInstructionSetting,
  removeAgentsMdImport,
  supportsAgentsMd,
  type AgentsMdImportTarget,
  type ClaudeInstructionSetting,
} from "./ClaudeInstructionSetting.ts";
import { inspect, readText, type FileFacts, type ReadOutcome } from "./InstructionFileIO.ts";

/** Where the all-projects file goes, next to `~/.agents/skills`, unless the agents already share another. */
const DEFAULT_SHARED_FILE = ".agents/AGENTS.md";
/** The personal file Claude Code tells people to keep out of git. */
const PERSONAL_FILE = "CLAUDE.local.md";
const CLAUDE_DRIVER = "claudeAgent";
const NESTED_NAMES: ReadonlySet<string> = new Set(["AGENTS.md", "CLAUDE.md"]);
const MAX_NESTED = 50;
const NESTED_SEARCH_LIMIT = 200;
const CONCURRENCY = 8;
/** The default folder of an agent that follows `XDG_CONFIG_HOME` sits under this in the home directory. */
const XDG_PREFIX = ".config/";

/** The files of a project's top folder that get an entry, with the id each one has. */
const ROOT_FILES = [
  { name: "AGENTS.md", kind: "shared" },
  { name: "CLAUDE.md", kind: "claude" },
  { name: ".claude/CLAUDE.md", kind: "claude" },
  { name: PERSONAL_FILE, kind: "claudeLocal" },
] as const satisfies ReadonlyArray<{ readonly name: string; readonly kind: InstructionKind }>;

const GLOBAL_SHARED_ID = "global:shared";
const MANAGED_ID = "managed:claude";

const rootId = (file: (typeof ROOT_FILES)[number]) => `project:${file.kind}:${file.name}`;
const nestedId = (relativePath: string) => `project:nested:${relativePath}`;
const claudeHomeId = (instanceId: string) => `global:claude:${instanceId}`;
const agentOwnId = (instanceId: string) => `global:agentOwn:${instanceId}`;

const unknownEntry = () =>
  new InstructionError({
    reason: "unknownEntry",
    message: "That isn't an instruction file T3 Code manages.",
  });

/** A flag-style environment variable counts as set unless it is empty, `0` or `false`. */
const isFlagSet = (value: string | undefined) =>
  value !== undefined && !["", "0", "false"].includes(value.trim().toLowerCase());

/** An enabled provider instance whose instruction files T3 Code knows. */
interface AgentInstance {
  readonly instanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind;
  readonly displayName: string;
  readonly rules: AgentInstructionRules;
  readonly version: string | null;
  /** The process environment with the instance's own variables laid over it. */
  readonly env: NodeJS.ProcessEnv;
  /** The agent's home folder as this instance resolves it; undefined when it has no home file. */
  readonly directory: string | undefined;
}

export interface SharedFile {
  /** Where the all-projects file is, or would be created. */
  readonly path: string;
  /** Its real path after following links; undefined while it doesn't exist. */
  readonly real: string | undefined;
  readonly exists: boolean;
}

/** How one agent reaches the all-projects file, and what it takes to change that. */
export interface AgentReach {
  readonly instanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind;
  readonly displayName: string;
  /** The agent's home folder. */
  readonly directory: string;
  /** `link`: a symlink at `joinPath`. `import`: an import line at the top of the file at `joinPath`. */
  readonly join: "link" | "import";
  readonly joinPath: string;
  readonly state: InstructionAgentState;
  readonly reason?: InstructionAgentReason | undefined;
  readonly blockingFile?: string | undefined;
  /** The files the agent reads the shared file through. `own: false` is a folder of another agent. */
  readonly via: ReadonlyArray<{
    readonly path: string;
    readonly kind: "direct" | "link" | "import";
    readonly own: boolean;
  }>;
  /** The agent's own home file, when it has one that is not the shared file. */
  readonly ownFile: string | undefined;
  /** Every home file the agent loads, whatever its text. */
  readonly reads: ReadonlySet<string>;
}

export interface SharedView {
  readonly file: SharedFile;
  readonly homeDirectory: string;
  /** Every enabled agent that has a home file, in the table's order. */
  readonly agents: ReadonlyArray<AgentReach>;
}

/** What an id names, as the table and the disk say now. */
export interface ResolvedInstruction {
  readonly id: string;
  readonly scope: InstructionScope;
  readonly kind: InstructionKind;
  /** Where the file is or would be created; it may be a link. */
  readonly path: string;
  readonly relativePath?: string | undefined;
  readonly readOnly: boolean;
  /** The instance whose home file this is, for `agentOwn` and Claude's own file. */
  readonly owner?: ProviderInstanceId | undefined;
}

export class InstructionCatalog extends Context.Service<
  InstructionCatalog,
  {
    /**
     * The instruction files in the project's top folder (when `cwd` is given) and the user's home
     * folder, with the agents that read each. Subfolder files come from the project's file index.
     * A `cwd` that isn't a registered project's workspace root is refused, here and in `read` and
     * `resolve`, before anything under it is read.
     */
    readonly list: (
      input: InstructionListInput,
    ) => Effect.Effect<InstructionListResult, InstructionError>;
    /** The text of one file from `list`, or nothing when it is missing or too large. */
    readonly read: (
      input: InstructionReadInput,
    ) => Effect.Effect<InstructionReadResult, InstructionError>;
    /** The file an id names, looked up from the table again. Nothing is read or written. */
    readonly resolve: (input: {
      readonly cwd?: string | undefined;
      readonly id: string;
    }) => Effect.Effect<ResolvedInstruction, InstructionError>;
    /** The all-projects file and how each agent reaches it, for turning agents on or off. */
    readonly shared: Effect.Effect<SharedView>;
  }
>()("t3/instructions/InstructionCatalog") {}

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const environment = yield* HostProcess.Environment;
  const serverSettings = yield* Settings.ServerSettingsService;
  const providers = yield* ProviderRegistry.ProviderRegistry;
  const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
  const projects = yield* ProjectService.ProjectService;
  const fileSystemContext = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
  const homeDirectory = yield* HostProcess.HomeDirectory;

  const inspectAt = (file: string) => inspect(file).pipe(Effect.provideContext(fileSystemContext));
  const readTextAt = (file: string) =>
    readText(file).pipe(Effect.provideContext(fileSystemContext));

  /** Text read once per file during one call. */
  const makeTextReader = () => {
    const texts = new Map<string, ReadOutcome>();
    return Effect.fnUntraced(function* (file: string) {
      const known = texts.get(file);
      if (known !== undefined) return known;
      const outcome = yield* readTextAt(file);
      texts.set(file, outcome);
      return outcome;
    });
  };
  type TextReader = ReturnType<typeof makeTextReader>;

  /**
   * A project's folder is only read when it is the workspace root of a project the environment
   * knows, so an id can't name a file under any path on the machine. Without a `cwd` only the
   * agents' home files are reachable.
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
      return yield* new InstructionError({
        reason: "unregisteredProject",
        message: "That folder isn't a project in this environment.",
      });
    }
    return cwd;
  });

  const sizeOf = Effect.fnUntraced(function* (file: string) {
    const info = yield* fileSystem.stat(file).pipe(Effect.option);
    return Option.isSome(info) && info.value.type === "File" ? Number(info.value.size) : undefined;
  });

  // --- Agents -------------------------------------------------------------------------------

  /**
   * An agent's home folder. Claude, Codex and Grok follow the same settings and variables as their
   * skill folders (`resolveAgentConfigHome`); the others follow the variables the table names.
   */
  const homeFolderOf = Effect.fnUntraced(function* (
    config: ProviderInstanceConfig,
    home: HomeInstructionRules,
    env: NodeJS.ProcessEnv,
    cwd: string | undefined,
  ) {
    const fallback = path.join(homeDirectory, home.folder);
    if (AGENT_SKILL_FOLDERS.find((table) => table.agent === config.driver)?.configHome) {
      return yield* resolveAgentConfigHome({
        instance: config,
        fallback,
        environment,
        cwd,
      }).pipe(
        Effect.provideService(Path.Path, path),
        Effect.provideService(HostProcess.HomeDirectory, homeDirectory),
      );
    }
    const named = home.folderEnv === undefined ? "" : (env[home.folderEnv]?.trim() ?? "");
    const configured = expandHomePath(named, homeDirectory);
    if (configured !== "" && path.isAbsolute(configured)) return configured;
    const xdg = env.XDG_CONFIG_HOME?.trim() ?? "";
    if (
      home.xdgConfigHome === true &&
      xdg !== "" &&
      path.isAbsolute(xdg) &&
      home.folder.startsWith(XDG_PREFIX)
    ) {
      return path.join(xdg, home.folder.slice(XDG_PREFIX.length));
    }
    return fallback;
  });

  /** The enabled provider instances whose instruction files T3 Code knows, in the table's order. */
  const loadInstances = Effect.fnUntraced(function* (cwd: string | undefined) {
    const settings = yield* serverSettings.getSettings.pipe(Effect.option);
    if (Option.isNone(settings)) return [];
    const snapshots = new Map(
      (yield* providers.getProviders).map((provider) => [provider.instanceId, provider] as const),
    );
    const configs = Object.entries(deriveProviderInstanceConfigMap(settings.value));
    const instances: AgentInstance[] = [];
    for (const rules of AGENT_INSTRUCTION_FILES) {
      for (const [id, config] of configs) {
        if (config.driver !== rules.agent || !resolveProviderInstanceEnabled(config)) continue;
        const instanceId = ProviderInstanceId.make(id);
        const env = yield* mergeProviderInstanceEnvironment(config.environment, environment).pipe(
          Effect.provideService(HostProcess.HomeDirectory, homeDirectory),
        );
        const snapshot = snapshots.get(instanceId);
        instances.push({
          instanceId,
          driver: rules.agent,
          displayName:
            snapshot?.displayName?.trim() || (PROVIDER_DISPLAY_NAMES[rules.agent] ?? rules.agent),
          rules,
          version: snapshot?.version ?? null,
          env,
          directory:
            rules.home === null ? undefined : yield* homeFolderOf(config, rules.home, env, cwd),
        });
      }
    }
    return instances;
  });

  // --- Claude's "Project instructions" setting ------------------------------------------------

  const claudeChoiceOf = Effect.fnUntraced(function* (instance: AgentInstance, textOf: TextReader) {
    const settingsPath = path.join(instance.directory ?? homeDirectory, "settings.json");
    const outcome = yield* textOf(settingsPath);
    let setting: ClaudeInstructionSetting = {
      value: DEFAULT_CLAUDE_INSTRUCTION_VALUE,
      explicit: false,
    };
    let problem: InstructionProblem | undefined;
    if (outcome._tag === "Read") {
      const settings = parseSettingsJson(outcome.text);
      if (settings === undefined) problem = { path: settingsPath, reason: "It isn't valid JSON." };
      else setting = readClaudeInstructionSetting(settings);
    } else if (outcome._tag !== "Missing") {
      problem = { path: settingsPath, reason: "T3 Code couldn't read it." };
    }
    return {
      choice: {
        instanceId: instance.instanceId,
        ...setting,
        supported: supportsAgentsMd(instance.version),
        version: instance.version,
      } satisfies ClaudeInstructionChoice,
      problem,
    };
  });

  // --- The all-projects file and how agents reach it -------------------------------------------

  /**
   * The all-projects file. When some agents' home files are links and all of them lead to the same
   * real file, that file is the shared one, so people who already link everything to one file keep
   * it. Otherwise it is `~/.agents/AGENTS.md`.
   */
  const sharedLocation = Effect.fnUntraced(function* (instances: readonly AgentInstance[]) {
    const targets = new Set<string>();
    const candidates = instances.flatMap((instance) => {
      const { home } = instance.rules;
      const { directory } = instance;
      return home === null || directory === undefined
        ? []
        : home.files.map((name) => path.join(directory, name));
    });
    const found = yield* Effect.forEach(candidates, (file) => inspectAt(file), {
      concurrency: CONCURRENCY,
    });
    for (const facts of found) {
      if (facts.linkTarget !== undefined && facts.isFile && facts.real !== undefined) {
        targets.add(facts.real);
      }
    }
    const [only] = targets.size === 1 ? [...targets] : [];
    const location = only ?? path.join(homeDirectory, DEFAULT_SHARED_FILE);
    const facts = yield* inspectAt(location);
    return {
      path: location,
      real: facts.real,
      exists: facts.isFile,
    } satisfies SharedFile;
  });

  /** The file leads to the shared file, or is a link to it that leads nowhere yet. */
  const reachesShared = (facts: FileFacts, shared: SharedFile) =>
    facts.present &&
    (facts.real !== undefined
      ? facts.real === shared.real
      : facts.linkTarget !== undefined && facts.linkTarget === shared.path);

  interface NamedFile {
    readonly name: string;
    readonly path: string;
    readonly facts: FileFacts;
  }

  /** What an agent finds in its home: its own files, and the other agents' it reads as well. */
  const loadHome = Effect.fnUntraced(function* (instance: AgentInstance, shared: SharedFile) {
    const home = instance.rules.home;
    const directory = instance.directory;
    if (home === null || directory === undefined) return undefined;
    const inFolder = yield* Effect.forEach(
      home.files,
      (name) => {
        const file = path.join(directory, name);
        return inspectAt(file).pipe(
          Effect.map((facts): NamedFile => ({ name, path: file, facts })),
        );
      },
      { concurrency: CONCURRENCY },
    );
    const usable = inFolder.filter(
      (file) =>
        (file.facts.isFile && !(home.skipsEmpty === true && file.facts.size === 0)) ||
        reachesShared(file.facts, shared),
    );
    const loaded = home.selection === "all" ? usable : usable.slice(0, 1);
    const fallbacks: NamedFile[] = [];
    for (const also of home.alsoReads ?? []) {
      if (also.disabledByEnv?.some((name) => isFlagSet(instance.env[name]))) continue;
      if (also.when === "no-own-file" && usable.length > 0) continue;
      for (const name of also.files) {
        const file = path.join(homeDirectory, also.folder, name);
        const facts = yield* inspectAt(file);
        if (facts.isFile || reachesShared(facts, shared))
          fallbacks.push({ name, path: file, facts });
      }
    }
    // The agent's own file is the one that would be replaced to join: the first file it reads in
    // its folder, or for an agent that reads them all, the file the link would take.
    const ownFile =
      home.selection === "all" ? usable.find((file) => file.name === home.shared.file) : loaded[0];
    return {
      home,
      directory,
      loaded,
      fallbacks,
      ownFile:
        ownFile !== undefined && ownFile.facts.isFile && !reachesShared(ownFile.facts, shared)
          ? ownFile
          : undefined,
    };
  });

  const reachOf = Effect.fnUntraced(function* (
    instance: AgentInstance,
    shared: SharedFile,
    textOf: TextReader,
  ) {
    const loaded = yield* loadHome(instance, shared);
    if (loaded === undefined) return undefined;
    const { home, directory } = loaded;
    const joinPath = path.join(directory, home.shared.file);
    const reach = (
      state: InstructionAgentState,
      rest: Pick<AgentReach, "via"> & Partial<Pick<AgentReach, "reason" | "blockingFile">>,
    ): AgentReach => ({
      instanceId: instance.instanceId,
      driver: instance.driver,
      displayName: instance.displayName,
      directory,
      join: home.shared.join,
      joinPath,
      state,
      ownFile: loaded.ownFile?.path,
      reads: new Set([...loaded.loaded, ...loaded.fallbacks].map((file) => file.path)),
      ...rest,
    });

    const through = [
      ...loaded.loaded.map((file) => ({ ...file, own: true })),
      ...loaded.fallbacks.map((file) => ({ ...file, own: false })),
    ]
      .filter((file) => reachesShared(file.facts, shared))
      .map((file) => ({
        path: file.path,
        kind: file.facts.linkTarget === undefined ? ("direct" as const) : ("link" as const),
        own: file.own,
      }));
    if (through.length > 0) {
      return reach(through.some((entry) => entry.kind === "direct") ? "direct" : "link", {
        via: through,
      });
    }
    if (home.shared.join === "import") {
      const read = loaded.loaded[0] === undefined ? undefined : yield* textOf(joinPath);
      return read?._tag === "Read" && hasAgentsMdImport(read.text, importTarget(joinPath, shared))
        ? reach("import", { via: [{ path: joinPath, kind: "import", own: true }] })
        : reach("none", { via: [] });
    }
    // A file of the agent's own sits where the link would go, or in front of it.
    if (loaded.ownFile !== undefined) {
      const blockingFile =
        loaded.ownFile.name === home.shared.file ? undefined : loaded.ownFile.name;
      return reach("none", { via: [], reason: "ownFile", blockingFile });
    }
    return reach("none", { via: [] });
  });

  const importTarget = (claudeMd: string, shared: SharedFile): AgentsMdImportTarget => ({
    path,
    agentsMdPath: shared.path,
    claudeMdDirectory: path.dirname(claudeMd),
    homeDirectory,
  });

  const scanShared = Effect.fnUntraced(function* (
    instances: readonly AgentInstance[],
    textOf: TextReader,
  ) {
    const file = yield* sharedLocation(instances);
    const reaches = yield* Effect.forEach(
      instances,
      (instance) => reachOf(instance, file, textOf),
      {
        concurrency: CONCURRENCY,
      },
    );
    return {
      file,
      homeDirectory,
      agents: reaches.filter((reach) => reach !== undefined),
    } satisfies SharedView;
  });

  // --- Project files --------------------------------------------------------------------------

  interface ProjectFacts {
    readonly cwd: string;
    /** Names of the project's top-folder files that exist, with their sizes. */
    readonly sizes: ReadonlyMap<string, number>;
    /** Some Claude file in the top folder imports the project's AGENTS.md. */
    readonly claudeImportsAgentsMd: boolean;
    /**
     * The top folder's CLAUDE.md holds nothing but that import, or is the same file as AGENTS.md
     * through a link, so it has nothing to show.
     */
    readonly claudeMdOnlyImports: boolean;
  }

  const loadProject = Effect.fnUntraced(function* (
    cwd: string,
    instances: readonly AgentInstance[],
    textOf: TextReader,
  ) {
    const names = new Set<string>(ROOT_FILES.map((file) => file.name));
    for (const instance of instances) {
      for (const file of instance.rules.project?.files ?? []) names.add(file.name);
    }
    const found = yield* Effect.forEach(
      [...names],
      (name) => sizeOf(path.join(cwd, name)).pipe(Effect.map((size) => [name, size] as const)),
      { concurrency: CONCURRENCY },
    );
    const sizes = new Map<string, number>();
    for (const [name, size] of found) if (size !== undefined) sizes.set(name, size);
    const agentsMd = path.join(cwd, "AGENTS.md");
    let claudeImportsAgentsMd = false;
    let claudeMdOnlyImports = false;
    if (sizes.has("CLAUDE.md") && sizes.has("AGENTS.md")) {
      const [claudeReal, agentsReal] = yield* Effect.all([
        fileSystem.realPath(path.join(cwd, "CLAUDE.md")).pipe(Effect.option),
        fileSystem.realPath(agentsMd).pipe(Effect.option),
      ]);
      if (
        Option.isSome(claudeReal) &&
        Option.isSome(agentsReal) &&
        claudeReal.value === agentsReal.value
      ) {
        claudeImportsAgentsMd = true;
        claudeMdOnlyImports = true;
      }
    }
    for (const name of ["CLAUDE.md", ".claude/CLAUDE.md", PERSONAL_FILE]) {
      if (!sizes.has(name)) continue;
      if (name === "CLAUDE.md" && claudeMdOnlyImports) continue;
      const file = path.join(cwd, name);
      const read = yield* textOf(file);
      if (read._tag !== "Read") continue;
      const target = {
        path,
        agentsMdPath: agentsMd,
        claudeMdDirectory: path.dirname(file),
        homeDirectory,
      } satisfies AgentsMdImportTarget;
      if (!hasAgentsMdImport(read.text, target)) continue;
      claudeImportsAgentsMd = true;
      if (name === "CLAUDE.md" && removeAgentsMdImport(read.text, target).trim() === "") {
        claudeMdOnlyImports = true;
      }
    }
    return { cwd, sizes, claudeImportsAgentsMd, claudeMdOnlyImports } satisfies ProjectFacts;
  });

  const accessOf = (
    instance: Pick<AgentInstance, "instanceId" | "driver">,
    state: InstructionAgentState,
    extra: {
      readonly reason?: InstructionAgentReason | undefined;
      readonly blockingFile?: string | undefined;
    } = {},
  ): InstructionAgentAccess => ({
    instanceId: instance.instanceId,
    driver: instance.driver,
    state,
    ...(extra.reason === undefined ? {} : { reason: extra.reason }),
    ...(extra.blockingFile === undefined ? {} : { blockingFile: extra.blockingFile }),
  });

  /** How Claude reaches the project's AGENTS.md: through its setting, an import, or not at all. */
  const claudeAgentsMdAccess = (
    instance: AgentInstance,
    choice: ClaudeInstructionChoice,
    project: ProjectFacts,
  ) => {
    if (choice.value !== "managed-only" && project.claudeImportsAgentsMd) {
      return accessOf(instance, "import");
    }
    if (!choice.supported) return accessOf(instance, "none", { reason: "oldVersion" });
    if (choice.value === "managed-only" || choice.value === "claude-md") {
      return accessOf(instance, "none", { reason: "settingOff" });
    }
    if (choice.value === "claude-md-and-agents-md") return accessOf(instance, "setting");
    const blockingFile = ["CLAUDE.md", ".claude/CLAUDE.md", PERSONAL_FILE].find((name) =>
      project.sizes.has(name),
    );
    return blockingFile === undefined
      ? accessOf(instance, "setting")
      : accessOf(instance, "none", { reason: "claudeFiles", blockingFile });
  };

  /** How one agent reaches a file in the project's top folder. */
  const projectAccess = (
    instance: AgentInstance,
    name: string,
    project: ProjectFacts,
    claude: ReadonlyMap<ProviderInstanceId, ClaudeInstructionChoice>,
  ): InstructionAgentAccess | undefined => {
    const rules = instance.rules.project;
    if (rules === null) return undefined;
    const index = rules.files.findIndex((file) => file.name === name);
    const rule = rules.files[index];
    if (rule === undefined) return accessOf(instance, "none");
    if (rule.governedBy === "claudeProjectInstructions") {
      const choice = claude.get(instance.instanceId);
      return choice === undefined
        ? accessOf(instance, "none")
        : claudeAgentsMdAccess(instance, choice, project);
    }
    // The file is meant to stay out of git, which Grok skips; whether this one is isn't known here.
    if (rules.skipsGitIgnored === true && name === PERSONAL_FILE) return accessOf(instance, "none");
    if (rules.selection !== "all") {
      const blocker = rules.files.slice(0, index).find((file) => project.sizes.has(file.name));
      if (blocker !== undefined) return accessOf(instance, "none", { blockingFile: blocker.name });
      if (index > 0 && rules.fallbackDisabledByEnv?.some((flag) => isFlagSet(instance.env[flag]))) {
        return accessOf(instance, "none");
      }
    }
    return accessOf(instance, "direct");
  };

  /**
   * AGENTS.md and CLAUDE.md files below the project's top folder, from the file index. Which
   * agents read one depends on the folder's other files and on what the agent opens, so these
   * entries don't claim any.
   */
  const nestedFiles = Effect.fnUntraced(function* (cwd: string) {
    const found = new Set<string>();
    for (const name of NESTED_NAMES) {
      const result = yield* workspaceEntries
        .search({ cwd, query: name, limit: NESTED_SEARCH_LIMIT, kind: "file" })
        .pipe(Effect.option);
      for (const entry of Option.isSome(result) ? result.value.entries : []) {
        const segments = entry.path.split("/");
        const base = segments.at(-1) ?? "";
        if (entry.ignored === true || !NESTED_NAMES.has(base) || segments.length < 2) continue;
        if (segments.includes(".git") || segments.includes("node_modules")) continue;
        // `.claude/CLAUDE.md` in the top folder has its own entry.
        if (segments.length === 2 && segments[0] === ".claude") continue;
        found.add(entry.path);
      }
    }
    return [...found].toSorted().slice(0, MAX_NESTED);
  });

  // --- Resolving ids ---------------------------------------------------------------------------

  /** A relative path with a folder in it, naming an AGENTS.md or CLAUDE.md, that can't leave the project. */
  const isNestedPath = (relative: string) => {
    const segments = relative.split("/");
    return (
      segments.length >= 2 &&
      !relative.includes("\0") &&
      !relative.includes("\\") &&
      !segments.some((segment) => segment === "" || segment === "." || segment === "..") &&
      !segments.includes(".git") &&
      NESTED_NAMES.has(segments.at(-1) ?? "")
    );
  };

  const resolve: InstructionCatalog["Service"]["resolve"] = Effect.fn("InstructionCatalog.resolve")(
    function* (input) {
      const [scope = "", kind = "", ...tail] = input.id.split(":");
      const rest = tail.join(":");
      const cwd = yield* requireProject(input.cwd);

      if (scope === "project") {
        if (cwd === undefined) return yield* unknownEntry();
        if (kind === "nested") {
          if (!isNestedPath(rest)) return yield* unknownEntry();
          const file = path.join(cwd, rest);
          const [realFolder, realRoot] = yield* Effect.all([
            fileSystem.realPath(path.dirname(file)).pipe(Effect.option),
            fileSystem.realPath(cwd).pipe(Effect.option),
          ]);
          if (Option.isNone(realFolder) || Option.isNone(realRoot)) {
            return yield* new InstructionError({
              reason: "notFound",
              message: "That folder doesn't exist.",
            });
          }
          const inside = path.relative(realRoot.value, realFolder.value);
          if (inside === ".." || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside)) {
            return yield* unknownEntry();
          }
          return {
            id: input.id,
            scope: "project",
            kind: "nested",
            path: file,
            relativePath: rest,
            readOnly: false,
          } satisfies ResolvedInstruction;
        }
        const root = ROOT_FILES.find((file) => file.kind === kind && file.name === rest);
        if (root === undefined) return yield* unknownEntry();
        return {
          id: input.id,
          scope: "project",
          kind: root.kind,
          path: path.join(cwd, root.name),
          relativePath: root.name,
          readOnly: false,
        } satisfies ResolvedInstruction;
      }

      if (scope === "global" && kind === "shared" && rest === "") {
        const instances = yield* loadInstances(cwd);
        const shared = yield* sharedLocation(instances);
        return {
          id: input.id,
          scope: "global",
          kind: "shared",
          path: shared.path,
          readOnly: false,
        } satisfies ResolvedInstruction;
      }

      if (scope === "global" && (kind === "claude" || kind === "agentOwn")) {
        const instances = yield* loadInstances(cwd);
        const instance = instances.find((candidate) => candidate.instanceId === rest);
        const isClaude = instance?.driver === CLAUDE_DRIVER;
        if (
          instance?.rules.home == null ||
          instance.directory === undefined ||
          isClaude !== (kind === "claude")
        ) {
          return yield* unknownEntry();
        }
        const shared = yield* sharedLocation(instances);
        const loaded = yield* loadHome(instance, shared);
        const file =
          kind === "claude"
            ? path.join(instance.directory, instance.rules.home.shared.file)
            : (loaded?.ownFile?.path ??
              path.join(instance.directory, instance.rules.home.shared.file));
        return {
          id: input.id,
          scope: "global",
          kind,
          path: file,
          readOnly: false,
          owner: instance.instanceId,
        } satisfies ResolvedInstruction;
      }

      if (input.id === MANAGED_ID) {
        const managed = claudeManagedInstructionPath(platform);
        if (managed === undefined) return yield* unknownEntry();
        return {
          id: input.id,
          scope: "managed",
          kind: "managed",
          path: managed,
          readOnly: true,
        } satisfies ResolvedInstruction;
      }
      return yield* unknownEntry();
    },
  );

  // --- Listing ---------------------------------------------------------------------------------

  const list: InstructionCatalog["Service"]["list"] = Effect.fn("InstructionCatalog.list")(
    function* (input) {
      const cwd = yield* requireProject(input.cwd);
      const textOf = makeTextReader();
      const instances = yield* loadInstances(cwd);
      const claudeInstances = instances.filter((instance) => instance.driver === CLAUDE_DRIVER);
      const unreadable: InstructionProblem[] = [];

      const settings = yield* Effect.forEach(
        claudeInstances,
        (instance) => claudeChoiceOf(instance, textOf),
        { concurrency: CONCURRENCY },
      );
      const claude = settings.map((setting) => setting.choice);
      for (const { problem } of settings) if (problem !== undefined) unreadable.push(problem);
      const claudeByInstance = new Map(claude.map((choice) => [choice.instanceId, choice]));

      const view = yield* scanShared(instances, textOf);
      const entries: InstructionEntry[] = [];

      const problemAt = (file: string, reason: string) => unreadable.push({ path: file, reason });
      const note = (file: string, read: ReadOutcome) => {
        if (read._tag === "TooLarge") problemAt(file, "It's larger than 1 MB.");
        else if (read._tag === "Unreadable") problemAt(file, "T3 Code couldn't read it.");
      };

      if (cwd !== undefined) {
        const project = yield* loadProject(cwd, instances, textOf);
        for (const root of ROOT_FILES) {
          const size = project.sizes.get(root.name);
          // The project's AGENTS.md and the user's own CLAUDE.local.md are listed while missing,
          // so they can be created. The local one only when an agent would read it.
          const creatable = root.kind === "shared" || root.kind === "claudeLocal";
          if (size === undefined && !creatable) continue;
          // Many repos keep a one-line CLAUDE.md that only points Claude at AGENTS.md. It already
          // does its job, so it gets no entry, as a Global CLAUDE.md that only imports Global.
          if (root.name === "CLAUDE.md" && project.claudeMdOnlyImports) continue;
          const access = instances.flatMap((instance) => {
            const found = projectAccess(instance, root.name, project, claudeByInstance);
            return found === undefined ? [] : [found];
          });
          if (size === undefined && root.kind === "claudeLocal") {
            if (access.every((entry) => entry.state === "none")) continue;
          }
          entries.push({
            id: rootId(root),
            scope: "project",
            kind: root.kind,
            path: path.join(cwd, root.name),
            relativePath: root.name,
            exists: size !== undefined,
            size: size ?? 0,
            readOnly: false,
            access,
          });
        }
        for (const relative of yield* nestedFiles(cwd)) {
          const file = path.join(cwd, relative);
          const size = yield* sizeOf(file);
          if (size === undefined) continue;
          entries.push({
            id: nestedId(relative),
            scope: "project",
            kind: "nested",
            path: file,
            relativePath: relative,
            exists: true,
            size,
            readOnly: false,
            access: [],
          });
        }
      }

      // The all-projects file, and the files agents keep in their homes besides it.
      const sharedRead = view.file.exists ? yield* textOf(view.file.path) : undefined;
      if (sharedRead !== undefined) note(view.file.path, sharedRead);
      const sharedText = sharedRead?._tag === "Read" ? sharedRead.text.trim() : undefined;
      const sameAsShared = (read: ReadOutcome) =>
        read._tag === "Read" && sharedText !== undefined && read.text.trim() === sharedText;
      entries.push({
        id: GLOBAL_SHARED_ID,
        scope: "global",
        kind: "shared",
        path: view.file.path,
        exists: view.file.exists,
        size: view.file.exists ? ((yield* sizeOf(view.file.path)) ?? 0) : 0,
        readOnly: false,
        access: view.agents.map((reach) =>
          accessOf(reach, reach.state, {
            reason: reach.reason,
            blockingFile: reach.blockingFile,
          }),
        ),
      });

      const listedHomeFiles = new Set<string>();
      for (const reach of view.agents) {
        const instance = instances.find((candidate) => candidate.instanceId === reach.instanceId);
        if (instance === undefined || reach.ownFile === undefined) continue;
        if (listedHomeFiles.has(reach.ownFile)) continue;
        const isClaude = reach.driver === CLAUDE_DRIVER;
        const read = yield* textOf(reach.ownFile);
        note(reach.ownFile, read);
        // Claude's file is only worth a row when it holds more than the line that joins it.
        if (isClaude && read._tag === "Read") {
          const target = importTarget(reach.ownFile, view.file);
          if (removeAgentsMdImport(read.text, target).trim() === "") continue;
        }
        listedHomeFiles.add(reach.ownFile);
        const access = view.agents.map((other) =>
          accessOf(other, other.reads.has(reach.ownFile ?? "") ? "direct" : "none"),
        );
        entries.push({
          id: isClaude ? claudeHomeId(reach.instanceId) : agentOwnId(reach.instanceId),
          scope: "global",
          kind: isClaude ? "claude" : "agentOwn",
          path: reach.ownFile,
          exists: true,
          size: (yield* sizeOf(reach.ownFile)) ?? 0,
          readOnly: false,
          owner: reach.instanceId,
          access,
          sameAsShared: sameAsShared(read),
        });
      }

      const managedPath = claudeManagedInstructionPath(platform);
      if (managedPath !== undefined) {
        const size = yield* sizeOf(managedPath);
        if (size !== undefined) {
          entries.push({
            id: MANAGED_ID,
            scope: "managed",
            kind: "managed",
            path: managedPath,
            exists: true,
            size,
            readOnly: true,
            access: claudeInstances.map((instance) => accessOf(instance, "direct")),
          });
        }
      }

      return { entries, claude, sharedPath: view.file.path, unreadable };
    },
  );

  const read: InstructionCatalog["Service"]["read"] = Effect.fn("InstructionCatalog.read")(
    function* (input) {
      const entry = yield* resolve(input);
      const outcome = yield* readTextAt(entry.path);
      return {
        id: input.id,
        contents: outcome._tag === "Read" ? outcome.text : null,
        revision: outcome._tag === "Read" ? outcome.revision : null,
        tooLarge: outcome._tag === "TooLarge",
      };
    },
  );

  const shared = Effect.gen(function* () {
    const instances = yield* loadInstances(undefined);
    return yield* scanShared(instances, makeTextReader());
  }).pipe(Effect.withSpan("InstructionCatalog.shared"));

  return InstructionCatalog.of({ list, read, resolve, shared });
});

export const layer = Layer.effect(InstructionCatalog, make);
