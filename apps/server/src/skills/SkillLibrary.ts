/**
 * SkillLibrary - installs skills from a source and describes the skill
 * folders the environment's agents report.
 *
 * Installs go through the `skills` CLI (see SkillsCli.ts), into
 * `.agents/skills` at home or in a project, with links for agents that read
 * their own folder. The CLI's lock files (`~/.agents/.skill-lock.json`, or
 * `$XDG_STATE_HOME/skills/.skill-lock.json`, and a project's
 * `skills-lock.json`) record where each install came from; this module reads
 * them to group skills by source and to update only what the CLI installed.
 * Remove takes any skill in the agents' own skill folders, through the CLI
 * when it installed the skill. Turning skills on or off stays in settings.
 *
 * @module SkillLibrary
 */
import {
  type InstalledSkillInput,
  MAX_SKILL_BUNDLE_BYTES,
  MAX_SKILL_BUNDLE_FILES,
  type ProviderDriverKind,
  type ServerProvider,
  type SkillFileEntry,
  type SkillBundle,
  type SkillExportInput,
  type SkillFolderInfo,
  type SkillImportInput,
  type SkillInspectInput,
  type SkillInspectResult,
  type SkillInstallInput,
  type SkillInstallResult,
  type SkillInstallTarget,
  SkillLibraryError,
  type SkillPreviewInput,
  type SkillPreviewResult,
} from "@t3tools/contracts";
import {
  STANDARD_SKILL_FOLDER,
  agentSkillFolderRoots,
  skillLinkFolders,
  skillsCliInstallAgents,
} from "@t3tools/provider-core/server/AgentSkillFolders";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { fromLenientJson } from "@t3tools/shared/schemaJson";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Base64 from "effect/encoding/Base64";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { parse as parseYamlDocument } from "yaml";

import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as SkillsCli from "./SkillsCli.ts";

export class SkillLibrary extends Context.Service<
  SkillLibrary,
  {
    /** Facts about each SKILL.md the enabled agents report, for `cwd` and the environment. */
    readonly inspect: (input: SkillInspectInput) => Effect.Effect<SkillInspectResult>;
    /** The skills in a source, read from a throwaway install. */
    readonly preview: (
      input: SkillPreviewInput,
    ) => Effect.Effect<SkillPreviewResult, SkillLibraryError>;
    readonly install: (
      input: SkillInstallInput,
    ) => Effect.Effect<SkillInstallResult, SkillLibraryError>;
    /** Reinstall a skill the CLI installed, from the source its lock records. */
    readonly update: (
      input: InstalledSkillInput,
    ) => Effect.Effect<SkillInstallResult, SkillLibraryError>;
    /**
     * Remove a skill from the agents' skill folders at one level: through the
     * CLI when it installed the skill, else each folder's copy of that name.
     */
    readonly remove: (input: InstalledSkillInput) => Effect.Effect<void, SkillLibraryError>;
    /** Pack the folder an agent reports for a skill, to copy it to another environment. */
    readonly exportSkill: (
      input: SkillExportInput,
    ) => Effect.Effect<SkillBundle, SkillLibraryError>;
    /**
     * Put a copied skill in place. One the CLI installed from a remote source
     * is installed from there again, so it can be updated; otherwise, or when
     * that fails, its files go into `.agents/skills` with links for the agents
     * that read their own folder, as an install would make.
     */
    readonly importSkill: (input: SkillImportInput) => Effect.Effect<void, SkillLibraryError>;
  }
>()("t3/skills/SkillLibrary") {}

/** A lock entry, as both lock versions write it. */
const LockEntry = Schema.Struct({
  source: Schema.String,
  sourceType: Schema.optional(Schema.String),
  sourceUrl: Schema.optional(Schema.String),
  ref: Schema.optional(Schema.String),
  skillPath: Schema.optional(Schema.String),
});
type LockEntry = typeof LockEntry.Type;
const decodeLock = Schema.decodeUnknownOption(
  fromLenientJson(Schema.Struct({ skills: Schema.Record(Schema.String, LockEntry) })),
);

/** The folder the CLI installs a skill into: its name lowercased, other characters as `-`. */
function skillFolderName(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9._]+/g, "-")
      .replace(/^[.-]+|[.-]+$/g, "")
      .slice(0, 255) || "unnamed-skill"
  );
}

/**
 * A lock's entry for a skill folder. Locks key entries by the skill's own
 * name (`Git Review`), which installs into its sanitized folder (`git-review`).
 */
function lockEntryFor(
  lock: ReadonlyMap<string, LockEntry>,
  name: string,
): { readonly key: string; readonly entry: LockEntry } | undefined {
  const exact = lock.get(name);
  if (exact !== undefined) return { key: name, entry: exact };
  const folder = skillFolderName(name);
  for (const [key, entry] of lock) {
    if (skillFolderName(key) === folder) return { key, entry };
  }
  return undefined;
}

const SCRIPT_EXTENSION = /\.(?:sh|bash|zsh|fish|ps1|bat|cmd|py|rb|pl|js|mjs|cjs|ts|mts|php)$/i;
/** Bounds on the walk of one skill folder, so a huge tree costs a fixed amount. */
const MAX_FILES = 500;
const MAX_DIRECTORIES = 200;
/** Folders an installer or VCS leaves behind, never part of the skill. */
const SKIPPED_DIRECTORIES = new Set([".git", "node_modules"]);

/*
 * Where to reinstall a locked skill from. A port of the CLI's own update
 * (`update-source.ts` in vercel-labs/skills 1.7.1), so Update here and
 * `npx skills update` fetch the same thing.
 */

/** Only GitHub-style shorthands and GitHub or GitLab URLs can take a folder after them. */
function takesSubpath(source: string): boolean {
  if (source.startsWith("git@") || source.startsWith("ssh://") || source.endsWith(".git")) {
    return false;
  }
  if (!/^https?:\/\//.test(source)) return true;
  return /^https?:\/\/(?:github|gitlab)\.com\//.test(source);
}

/**
 * A source other than GitHub, as a project lock records it. Older locks wrote
 * GitLab and generic Git sources as a bare `group/repo`, which would be read
 * as GitHub, so those need the recorded URL.
 */
function nonGithubSource(entry: LockEntry): string | null {
  if (entry.sourceUrl !== undefined) return entry.sourceUrl;
  const bare = !entry.source.includes(":") && !/^[./]/.test(entry.source);
  return (entry.sourceType === "git" || entry.sourceType === "gitlab") && bare
    ? null
    : entry.source;
}

/**
 * The CLI's `add` source for one locked skill: its folder in the source at the
 * recorded ref, or the whole repository with `fullDepth` when the source can't
 * take a folder. Null when the lock doesn't say which host it came from.
 */
export function lockedInstallSource(
  entry: LockEntry,
  level: "home" | "project",
): { readonly source: string; readonly fullDepth: boolean } | null {
  const github = entry.sourceType === undefined || entry.sourceType === "github";
  const source =
    level === "project" || !github
      ? nonGithubSource(entry)
      : entry.skillPath === undefined
        ? (entry.sourceUrl ?? entry.source)
        : entry.source;
  if (source === null) return null;
  const ref = entry.ref === undefined ? "" : `#${entry.ref}`;
  const folder = entry.skillPath?.replace(/\/?SKILL\.md$/i, "") ?? "";
  if (folder !== "" && takesSubpath(source)) {
    return { source: `${source}/${folder}${ref}`, fullDepth: false };
  }
  return { source: `${source}${ref}`, fullDepth: folder !== "" };
}

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const cli = yield* SkillsCli.SkillsCli;
  // Each CLI run rewrites a whole lock file without locking it, so two at once
  // can drop each other's entries. Installs are rare; run them one at a time.
  const changes = yield* Semaphore.make(1);
  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
  const projectService = yield* ProjectService.ProjectService;
  const environment = yield* HostProcess.Environment;

  const home = environment.HOME?.trim() || environment.USERPROFILE?.trim() || "";
  const globalLockPath = environment.XDG_STATE_HOME?.trim()
    ? path.join(environment.XDG_STATE_HOME.trim(), "skills", ".skill-lock.json")
    : path.join(home, ".agents", ".skill-lock.json");

  const readLock = (file: string) =>
    fileSystem.readFileString(file).pipe(
      Effect.map((text) =>
        Option.match(decodeLock(text), {
          onNone: () => new Map<string, LockEntry>(),
          onSome: (lock) => new Map(Object.entries(lock.skills)),
        }),
      ),
      Effect.orElseSucceed(() => new Map<string, LockEntry>()),
    );

  const realPath = (target: string) =>
    fileSystem.realPath(target).pipe(Effect.orElseSucceed(() => target));

  /** Where a target's installs live, and its lock file. */
  const targetPaths = (target: SkillInstallTarget) => {
    const root = target.kind === "environment" ? home : target.cwd;
    return {
      root,
      folder: path.join(root, STANDARD_SKILL_FOLDER),
      lock: target.kind === "environment" ? globalLockPath : path.join(root, "skills-lock.json"),
    };
  };

  /** The project's root as the registry stores it, refusing an unregistered folder. */
  const resolveTarget = Effect.fnUntraced(function* (target: SkillInstallTarget) {
    if (target.kind === "environment") return target;
    const project = yield* projectService.getByWorkspaceRoot(target.cwd).pipe(
      Effect.map(Option.getOrUndefined),
      Effect.orElseSucceed(() => undefined),
    );
    if (project === undefined) {
      return yield* new SkillLibraryError({
        reason: "projectNotRegistered",
        message: "That folder isn't a project on this environment.",
      });
    }
    return { kind: "project", cwd: project.workspaceRoot } satisfies SkillInstallTarget;
  });

  const enabledProviders = providerRegistry.getProviders.pipe(
    Effect.map((providers) => providers.filter((provider) => provider.enabled)),
  );

  /** Ask the agents to rescan, so lists and the composer show the change. */
  const refreshAgents = (target: SkillInstallTarget) =>
    Effect.gen(function* () {
      const providers = yield* enabledProviders;
      // A project's skill list includes the global skills, so a global change
      // rescans every project an agent has listed, not just its own folders.
      const scansByCwd = new Map<string, Array<ServerProvider["instanceId"]>>();
      for (const provider of providers) {
        const cwds =
          target.kind === "environment"
            ? (provider.workspaceSnapshots ?? []).map((snapshot) => snapshot.cwd)
            : [target.cwd];
        for (const cwd of cwds)
          scansByCwd.set(cwd, [...(scansByCwd.get(cwd) ?? []), provider.instanceId]);
      }
      yield* Effect.forEach(
        target.kind === "environment" ? providers : [],
        (provider) => providerRegistry.refreshInstance(provider.instanceId),
        { concurrency: "unbounded", discard: true },
      );
      // A fresh scan drops every other agent's snapshot of its folder. So one
      // agent scans fresh, which drops the rest's stale lists (and clears its
      // own caches), then the others rescan without dropping it in turn. A
      // scan whose starting snapshot changed is discarded, so one folder's
      // agents scan one after another. Different folders scan in parallel.
      yield* Effect.forEach(
        scansByCwd,
        ([cwd, instanceIds]) =>
          Effect.forEach(
            instanceIds,
            (instanceId, index) =>
              providerRegistry.refreshWorkspaceSnapshot({ instanceId, cwd, fresh: index === 0 }),
            { discard: true },
          ),
        { concurrency: "unbounded", discard: true },
      );
    });

  /** A skill folder's files, breadth first and bounded; links are listed, never followed. */
  const listFiles = Effect.fnUntraced(function* (root: string) {
    const files: SkillFileEntry[] = [];
    const pending = [""];
    let directories = 0;
    let truncated = false;
    while (pending.length > 0) {
      const relative = pending.shift() ?? "";
      directories += 1;
      const names = yield* fileSystem
        .readDirectory(path.join(root, relative))
        .pipe(Effect.orElseSucceed((): string[] => []));
      for (const name of names.toSorted()) {
        const childPath = relative === "" ? name : `${relative}/${name}`;
        const absolute = path.join(root, childPath);
        const link = yield* fileSystem.readLink(absolute).pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        );
        const info = link
          ? undefined
          : yield* fileSystem.stat(absolute).pipe(Effect.orElseSucceed(() => undefined));
        if (info?.type === "Directory") {
          if (SKIPPED_DIRECTORIES.has(name)) continue;
          if (directories + pending.length >= MAX_DIRECTORIES) truncated = true;
          else pending.push(childPath);
          continue;
        }
        if (!link && info?.type !== "File") continue;
        if (files.length >= MAX_FILES) return { files, truncated: true };
        const executable = info !== undefined && (info.mode & 0o111) !== 0;
        files.push({
          path: childPath,
          size: info === undefined ? 0 : Number(info.size),
          executable,
          script: executable || childPath.startsWith("bin/") || SCRIPT_EXTENSION.test(childPath),
        });
      }
    }
    return { files, truncated };
  });

  const hasScripts = (files: ReadonlyArray<SkillFileEntry>) => files.some((file) => file.script);

  /** The agents' skill folders at a level, as written and after links. */
  const skillRoots = (target: SkillInstallTarget) =>
    Effect.forEach(
      agentSkillFolderRoots(target.kind === "environment" ? "home" : "project").map((folder) =>
        path.join(targetPaths(target).root, folder),
      ),
      (folder) => realPath(folder).pipe(Effect.map((real) => [folder, real])),
    ).pipe(Effect.map((pairs) => [...new Set(pairs.flat())]));

  const sha256 = (text: string) =>
    crypto.digest("SHA-256", new TextEncoder().encode(text)).pipe(
      Effect.map(Hex.encode),
      Effect.orElseSucceed(() => ""),
    );

  const inspect: SkillLibrary["Service"]["inspect"] = Effect.fn("SkillLibrary.inspect")(
    function* (input) {
      const providers = yield* enabledProviders;
      const reported = new Set<string>();
      for (const provider of providers) {
        const snapshot =
          input.cwd === undefined
            ? undefined
            : provider.workspaceSnapshots?.find((candidate) => candidate.cwd === input.cwd);
        for (const skill of snapshot?.skills ?? provider.skills) {
          if (path.isAbsolute(skill.path) && path.basename(skill.path) === "SKILL.md") {
            reported.add(skill.path);
          }
        }
      }

      const targets: ReadonlyArray<SkillInstallTarget> = [
        { kind: "environment" },
        ...(input.cwd === undefined ? [] : [{ kind: "project" as const, cwd: input.cwd }]),
      ];
      const installs = yield* Effect.forEach(targets, (target) =>
        Effect.gen(function* () {
          const paths = targetPaths(target);
          return {
            target,
            folder: yield* realPath(paths.folder),
            lock: yield* readLock(paths.lock),
            roots: yield* skillRoots(target),
          };
        }),
      );

      const folders = yield* Effect.forEach(
        [...reported],
        (skillPath) =>
          Effect.gen(function* () {
            const contents = yield* fileSystem
              .readFileString(skillPath)
              .pipe(Effect.orElseSucceed(() => undefined));
            if (contents === undefined) return undefined;
            const reportedFolder = path.dirname(skillPath);
            const folder = yield* realPath(reportedFolder);
            const name = path.basename(folder);
            // Where the agent found it, before links: `~/.claude/skills/x` can
            // link to `~/.agents/skills/x`, and either makes it the user's own.
            const parent = path.dirname(reportedFolder);
            const location = installs.find(
              (candidate) =>
                candidate.roots.includes(parent) || candidate.roots.includes(path.dirname(folder)),
            )?.target;
            const install = installs.find(
              (candidate) =>
                path.dirname(folder) === candidate.folder &&
                lockEntryFor(candidate.lock, name) !== undefined,
            );
            const entry =
              install === undefined ? undefined : lockEntryFor(install.lock, name)?.entry;
            const { files, truncated } = yield* listFiles(folder);
            return {
              path: skillPath,
              folder,
              hash: yield* sha256(contents),
              files,
              filesTruncated: truncated,
              scripts: hasScripts(files),
              ...(location === undefined ? {} : { location }),
              ...(install === undefined || entry === undefined
                ? {}
                : { installed: { target: install.target, source: entry.source } }),
            } satisfies SkillFolderInfo;
          }),
        { concurrency: 8 },
      );
      return { folders: folders.filter((folder) => folder !== undefined) };
    },
  );

  const describeSkill = (contents: string) => {
    const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(contents);
    try {
      const parsed: unknown = match === null ? undefined : parseYamlDocument(match[1] ?? "");
      const description =
        typeof parsed === "object" && parsed !== null && "description" in parsed
          ? parsed.description
          : undefined;
      return typeof description === "string" ? description.trim() : "";
    } catch {
      return "";
    }
  };

  const cliFailed = (message: string) => new SkillLibraryError({ reason: "cliFailed", message });

  const runAdd = (input: SkillsCli.SkillsCliAddInput) =>
    cli.add(input).pipe(
      Effect.catchTags({
        SkillsCliError: (error) => Effect.fail(cliFailed(error.message)),
      }),
    );

  const preview: SkillLibrary["Service"]["preview"] = Effect.fn("SkillLibrary.preview")(
    function* (input) {
      return yield* Effect.scoped(
        Effect.gen(function* () {
          const scratch = yield* fileSystem
            .makeTempDirectoryScoped({ prefix: "t3-skills-preview-" })
            .pipe(Effect.mapError(() => cliFailed("Couldn't make a folder to read the source.")));
          const results = yield* runAdd({
            source: input.source,
            skills: ["*"],
            agents: ["universal"],
            global: false,
            cwd: scratch,
          });
          const installed = results.filter((result) => result.status === "installed");
          if (installed.length === 0) {
            const failure = results.find((result) => result.error)?.error;
            return yield* new SkillLibraryError({
              reason: failure === undefined || failure === null ? "noSkills" : "cliFailed",
              message: failure ?? "No skills were found in that source.",
            });
          }
          const folder = path.join(scratch, STANDARD_SKILL_FOLDER);
          const folders = yield* fileSystem
            .readDirectory(folder)
            .pipe(Effect.orElseSucceed((): string[] => []));
          // The CLI's own name for each skill, which `--skill` matches, by the folder it chose.
          const nameByFolder = new Map(
            installed.flatMap((result) =>
              result.name === undefined
                ? []
                : [[skillFolderName(result.name), result.name] as const],
            ),
          );
          const skills = yield* Effect.forEach(folders.toSorted(), (skillFolder) =>
            Effect.gen(function* () {
              const root = path.join(folder, skillFolder);
              const contents = yield* fileSystem
                .readFileString(path.join(root, "SKILL.md"))
                .pipe(Effect.orElseSucceed(() => ""));
              const { files, truncated } = yield* listFiles(root);
              return {
                name: nameByFolder.get(skillFolder) ?? skillFolder,
                folder: skillFolder,
                description: describeSkill(contents),
                files,
                filesTruncated: truncated,
                scripts: hasScripts(files),
              };
            }),
          );
          return { skills };
        }),
      );
    },
  );

  const outcomes = (results: ReadonlyArray<SkillsCli.SkillsCliAddResult>) => ({
    outcomes: results.map((result) => ({
      name: result.name ?? "",
      status: result.status,
      ...(result.error === undefined || result.error === null ? {} : { error: result.error }),
    })),
  });

  const installInto = (
    target: SkillInstallTarget,
    source: string,
    skills: ReadonlyArray<string>,
    fullDepth = false,
  ) =>
    Effect.gen(function* () {
      const drivers: ReadonlyArray<ProviderDriverKind> = (yield* enabledProviders).map(
        (provider: ServerProvider) => provider.driver,
      );
      const results = yield* runAdd({
        source,
        skills,
        agents: skillsCliInstallAgents(drivers, target.kind === "environment" ? "home" : "project"),
        global: target.kind === "environment",
        fullDepth,
        cwd: targetPaths(target).root,
      });
      yield* refreshAgents(target);
      return outcomes(results);
    });

  const install: SkillLibrary["Service"]["install"] = Effect.fn("SkillLibrary.install")(
    function* (input) {
      const target = yield* resolveTarget(input.target);
      return yield* installInto(target, input.source, input.skills).pipe(changes.withPermits(1));
    },
  );

  /** The lock entry for a skill, by its CLI name or its folder, and the name the lock uses. */
  const lockedEntry = (target: SkillInstallTarget, name: string) =>
    readLock(targetPaths(target).lock).pipe(
      Effect.flatMap((lock) => {
        const found = lockEntryFor(lock, name);
        return found === undefined
          ? Effect.fail(
              new SkillLibraryError({
                reason: "notInstalled",
                message: "Only skills installed from a source can be updated here.",
              }),
            )
          : Effect.succeed(found);
      }),
    );

  const update: SkillLibrary["Service"]["update"] = Effect.fn("SkillLibrary.update")(
    function* (input) {
      const target = yield* resolveTarget(input.target);
      return yield* updateLocked(target, input.name).pipe(changes.withPermits(1));
    },
  );

  const updateLocked = (target: SkillInstallTarget, name: string) =>
    Effect.gen(function* () {
      const { key, entry } = yield* lockedEntry(target, name);
      const from = lockedInstallSource(entry, target.kind === "environment" ? "home" : "project");
      if (from === null) {
        return yield* new SkillLibraryError({
          reason: "notInstalled",
          message:
            "This skill's lock doesn't record which host it came from. Install it again from its URL.",
        });
      }
      // The CLI matches `--skill` against the skill's own name, which the lock keys by.
      return yield* installInto(target, from.source, [key], from.fullDepth);
    });

  const remove: SkillLibrary["Service"]["remove"] = Effect.fn("SkillLibrary.remove")(
    function* (input) {
      const target = yield* resolveTarget(input.target);
      yield* removeLocked(target, input.name).pipe(changes.withPermits(1));
    },
  );

  const removeLocked = (target: SkillInstallTarget, name: string) =>
    Effect.gen(function* () {
      const locked = lockEntryFor(yield* readLock(targetPaths(target).lock), name);
      if (locked === undefined) return yield* removeUnlocked(target, name);
      const { key } = locked;
      const paths = targetPaths(target);
      yield* cli
        .remove({
          skills: [key],
          global: target.kind === "environment",
          cwd: paths.root,
        })
        .pipe(
          Effect.catchTags({
            SkillsCliError: (error) => Effect.fail(cliFailed(error.message)),
          }),
        );
      yield* refreshAgents(target);
      // The CLI reports a skill it couldn't delete without failing, so check what's left.
      const folderLeft = yield* fileSystem
        .exists(path.join(paths.folder, skillFolderName(key)))
        .pipe(Effect.orElseSucceed(() => false));
      const lockLeft = (yield* readLock(paths.lock)).has(key);
      if (folderLeft || lockLeft) {
        return yield* cliFailed(
          `Couldn't remove ${name}. Check the permissions of ${folderLeft ? paths.folder : paths.lock}.`,
        );
      }
    });

  /**
   * A skill no lock records, put in place by hand or by another tool: delete
   * each folder an enabled agent reports for that name directly inside one of
   * the level's agent skill folders, links first. Only reported folders count,
   * so a name can't reach anything else.
   */
  const removeUnlocked = (target: SkillInstallTarget, name: string) =>
    Effect.gen(function* () {
      const roots = yield* skillRoots(target);
      const wanted = name.trim().toLowerCase();
      const reported = new Set<string>();
      for (const provider of yield* enabledProviders) {
        const lists = [
          ...(target.kind === "environment" ? [provider.skills] : []),
          ...(provider.workspaceSnapshots ?? [])
            .filter((snapshot) => target.kind === "environment" || snapshot.cwd === target.cwd)
            .map((snapshot) => snapshot.skills),
        ];
        for (const skill of lists.flat()) {
          if (skill.name.trim().toLowerCase() !== wanted || !path.isAbsolute(skill.path)) continue;
          const folder = path.dirname(skill.path);
          if (!roots.includes(path.dirname(folder))) continue;
          reported.add(folder);
          // A link's folder goes too when it is one of the user's own.
          const real = yield* realPath(folder);
          if (roots.includes(path.dirname(real))) reported.add(real);
        }
      }
      if (reported.size === 0) {
        return yield* new SkillLibraryError({
          reason: "notInstalled",
          message: `No skill named ${name} is in the agents' skill folders here.`,
        });
      }
      // Links go first, so none is left pointing at a deleted folder.
      const isLink = (folder: string) =>
        fileSystem.readLink(folder).pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        );
      const links = yield* Effect.filter([...reported], isLink);
      const folders = [...links, ...[...reported].filter((folder) => !links.includes(folder))];
      yield* Effect.forEach(
        folders,
        (folder) =>
          fileSystem
            .remove(folder, { recursive: true })
            .pipe(
              Effect.mapError(() =>
                cliFailed(
                  `Couldn't remove ${name}. Check the permissions of ${path.dirname(folder)}.`,
                ),
              ),
            ),
        { discard: true },
      );
      yield* refreshAgents(target);
    });

  /**
   * The folder an enabled agent reports for a skill in one of the level's
   * agent skill folders, after links. Plugin and built-in skills aren't there.
   */
  const reportedFolder = (target: SkillInstallTarget, name: string) =>
    Effect.gen(function* () {
      const wanted = name.trim().toLowerCase();
      const roots = yield* skillRoots(target);
      for (const provider of yield* enabledProviders) {
        const skills =
          target.kind === "environment"
            ? provider.skills
            : (provider.workspaceSnapshots?.find((snapshot) => snapshot.cwd === target.cwd)
                ?.skills ?? []);
        for (const skill of skills) {
          if (skill.name.trim().toLowerCase() !== wanted) continue;
          if (!path.isAbsolute(skill.path) || path.basename(skill.path) !== "SKILL.md") continue;
          const folder = path.dirname(skill.path);
          const real = yield* realPath(folder);
          if (roots.includes(path.dirname(folder)) || roots.includes(path.dirname(real)))
            return real;
        }
      }
      return yield* new SkillLibraryError({
        reason: "notInstalled",
        message: `No agent here reports a skill named ${name}.`,
      });
    });

  const tooLarge = (message: string) => new SkillLibraryError({ reason: "tooLarge", message });

  const exportSkill: SkillLibrary["Service"]["exportSkill"] = Effect.fn("SkillLibrary.exportSkill")(
    function* (input) {
      const target = yield* resolveTarget(input.target);
      const folder = yield* reportedFolder(target, input.name);
      const { files, truncated } = yield* listFiles(folder);
      if (truncated || files.length > MAX_SKILL_BUNDLE_FILES) {
        return yield* tooLarge(`${input.name} has too many files to copy.`);
      }
      let bytes = 0;
      const bundled = yield* Effect.forEach(files, (file) =>
        Effect.gen(function* () {
          bytes += file.size;
          if (bytes > MAX_SKILL_BUNDLE_BYTES) {
            return yield* tooLarge(`${input.name} is too large to copy between environments.`);
          }
          const contents = yield* fileSystem
            .readFile(path.join(folder, file.path))
            .pipe(Effect.mapError(() => tooLarge(`Couldn't read ${file.path} in ${input.name}.`)));
          return {
            path: file.path,
            contents: Base64.encode(contents),
            executable: file.executable,
          };
        }),
      );
      // Links aren't followed by the walk, so a folder of only links has nothing to copy.
      if (!bundled.some((file) => file.path === "SKILL.md")) {
        return yield* tooLarge(`${input.name} has no SKILL.md to copy.`);
      }
      // A remote source the CLI recorded here lets the target install it properly.
      const paths = targetPaths(target);
      const locked =
        path.dirname(folder) === (yield* realPath(paths.folder))
          ? lockEntryFor(yield* readLock(paths.lock), path.basename(folder))
          : undefined;
      const remote =
        locked !== undefined &&
        locked.entry.sourceType !== "local" &&
        locked.entry.sourceType !== "node_modules"
          ? lockedInstallSource(locked.entry, target.kind === "environment" ? "home" : "project")
          : null;
      return {
        folder: skillFolderName(path.basename(folder)),
        files: bundled,
        ...(remote === null || locked === undefined
          ? {}
          : { install: { source: remote.source, skill: locked.key, fullDepth: remote.fullDepth } }),
      };
    },
  );

  const importSkill: SkillLibrary["Service"]["importSkill"] = Effect.fn("SkillLibrary.importSkill")(
    function* (input) {
      const target = yield* resolveTarget(input.target);
      yield* importLocked(target, input.bundle).pipe(changes.withPermits(1));
    },
  );

  const importLocked = (target: SkillInstallTarget, bundle: SkillBundle) =>
    Effect.gen(function* () {
      const paths = targetPaths(target);
      const folderName = skillFolderName(bundle.folder);
      const destination = path.join(paths.folder, folderName);
      const drivers = (yield* enabledProviders).map((provider) => provider.driver);
      const links = skillLinkFolders(
        drivers,
        target.kind === "environment" ? "home" : "project",
      ).map((folder) => path.join(paths.root, folder, folderName));
      const taken = yield* Effect.filter([destination, ...links], (candidate) =>
        fileSystem.exists(candidate).pipe(Effect.orElseSucceed(() => false)),
      );
      if (taken.length > 0) {
        return yield* new SkillLibraryError({
          reason: "exists",
          message: `A skill named ${bundle.folder} is already at ${taken[0]}.`,
        });
      }
      if (bundle.install !== undefined) {
        const installed = yield* installInto(
          target,
          bundle.install.source,
          [bundle.install.skill],
          bundle.install.fullDepth,
        ).pipe(
          Effect.map(
            (result) =>
              result.outcomes.length > 0 &&
              result.outcomes.every((outcome) => outcome.status === "installed"),
          ),
          Effect.orElseSucceed(() => false),
        );
        if (installed) return;
        // The source may be private or offline from here: the files still work.
        yield* fileSystem.remove(destination, { recursive: true }).pipe(Effect.ignore);
      }
      const failed = (message: string) => cliFailed(message);
      const write = Effect.gen(function* () {
        let bytes = 0;
        for (const file of bundle.files) {
          // Bundles come from another environment: keep every path inside the folder.
          const relative = path.normalize(file.path);
          const absolute = path.resolve(destination, relative);
          if (path.isAbsolute(relative) || !absolute.startsWith(destination + path.sep)) {
            return yield* failed(`${file.path} isn't a path inside the skill.`);
          }
          const contents = Base64.decode(file.contents);
          if (contents._tag === "Failure") return yield* failed(`${file.path} isn't valid base64.`);
          bytes += contents.success.byteLength;
          if (bytes > MAX_SKILL_BUNDLE_BYTES)
            return yield* tooLarge(`${bundle.folder} is too large.`);
          yield* fileSystem.makeDirectory(path.dirname(absolute), { recursive: true });
          yield* fileSystem.writeFile(absolute, contents.success);
          if (file.executable) yield* fileSystem.chmod(absolute, 0o755);
        }
        for (const link of links) {
          yield* fileSystem.makeDirectory(path.dirname(link), { recursive: true });
          yield* fileSystem.symlink(destination, link);
        }
      }).pipe(
        Effect.catchTags({
          PlatformError: (error) =>
            Effect.fail(failed(`Couldn't write ${bundle.folder}: ${error.message}`)),
        }),
        // A half-written skill is worse than none.
        Effect.onError(() =>
          Effect.forEach([...links, destination], (leftover) =>
            fileSystem.remove(leftover, { recursive: true }).pipe(Effect.ignore),
          ),
        ),
      );
      yield* write;
      yield* refreshAgents(target);
    });

  return SkillLibrary.of({
    inspect,
    preview,
    install,
    update,
    remove,
    exportSkill,
    importSkill,
  });
});

export const layer = Layer.effect(SkillLibrary, make).pipe(Layer.provide(SkillsCli.layer));
