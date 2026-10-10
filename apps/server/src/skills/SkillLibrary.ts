/**
 * SkillLibrary - installs skills from a source and describes the skill
 * folders the environment's agents report.
 *
 * Installs go through the `skills` CLI (see SkillsCli.ts), into
 * `.agents/skills` at home or in a project, with links for agents that read
 * their own folder. The CLI's lock files (`~/.agents/.skill-lock.json`, or
 * `$XDG_STATE_HOME/skills/.skill-lock.json`, and a project's
 * `skills-lock.json`) record where each install came from; this module reads
 * them to group skills by source and to update or remove only what the CLI
 * installed. Turning skills on or off stays in settings.
 *
 * @module SkillLibrary
 */
import {
  type InstalledSkillInput,
  type ProviderDriverKind,
  type ServerProvider,
  type SkillFileEntry,
  type SkillFolderInfo,
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
  skillsCliInstallAgents,
} from "@t3tools/provider-core/server/AgentSkillFolders";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import { fromLenientJson } from "@t3tools/shared/schemaJson";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
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
    /** Remove a skill the CLI installed, with every agent's link to it. */
    readonly remove: (input: InstalledSkillInput) => Effect.Effect<void, SkillLibraryError>;
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
  const environment = yield* HostProcessEnvironment;

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
      const scans = providers.flatMap((provider) =>
        target.kind === "environment"
          ? (provider.workspaceSnapshots ?? []).map((snapshot) => ({
              instanceId: provider.instanceId,
              cwd: snapshot.cwd,
            }))
          : [{ instanceId: provider.instanceId, cwd: target.cwd }],
      );
      yield* Effect.forEach(
        target.kind === "environment" ? providers : [],
        (provider) => providerRegistry.refreshInstance(provider.instanceId),
        { concurrency: "unbounded", discard: true },
      );
      yield* Effect.forEach(
        scans,
        (scan) => providerRegistry.refreshWorkspaceSnapshot({ ...scan, fresh: true }),
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
        files.push({
          path: childPath,
          size: info === undefined ? 0 : Number(info.size),
          executable: info !== undefined && (info.mode & 0o111) !== 0,
        });
      }
    }
    return { files, truncated };
  });

  const hasScripts = (files: ReadonlyArray<SkillFileEntry>) =>
    files.some((file) => file.executable || SCRIPT_EXTENSION.test(file.path));

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
            const folder = yield* realPath(path.dirname(skillPath));
            const name = path.basename(folder);
            const install = installs.find(
              (candidate) => path.dirname(folder) === candidate.folder && candidate.lock.has(name),
            );
            const entry = install?.lock.get(name);
            const { files, truncated } = yield* listFiles(folder);
            return {
              path: skillPath,
              folder,
              hash: yield* sha256(contents),
              files,
              filesTruncated: truncated,
              scripts: hasScripts(files),
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
          const names = yield* fileSystem
            .readDirectory(folder)
            .pipe(Effect.orElseSucceed((): string[] => []));
          const skills = yield* Effect.forEach(names.toSorted(), (name) =>
            Effect.gen(function* () {
              const root = path.join(folder, name);
              const contents = yield* fileSystem
                .readFileString(path.join(root, "SKILL.md"))
                .pipe(Effect.orElseSucceed(() => ""));
              const { files, truncated } = yield* listFiles(root);
              return {
                name,
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

  const lockedEntry = (target: SkillInstallTarget, name: string) =>
    readLock(targetPaths(target).lock).pipe(
      Effect.flatMap((lock) => {
        const entry = lock.get(name);
        return entry === undefined
          ? Effect.fail(
              new SkillLibraryError({
                reason: "notInstalled",
                message: "Only skills installed from a source can be updated or removed here.",
              }),
            )
          : Effect.succeed(entry);
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
      const entry = yield* lockedEntry(target, name);
      const from = lockedInstallSource(entry, target.kind === "environment" ? "home" : "project");
      if (from === null) {
        return yield* new SkillLibraryError({
          reason: "notInstalled",
          message:
            "This skill's lock doesn't record which host it came from. Install it again from its URL.",
        });
      }
      return yield* installInto(target, from.source, [name], from.fullDepth);
    });

  const remove: SkillLibrary["Service"]["remove"] = Effect.fn("SkillLibrary.remove")(
    function* (input) {
      const target = yield* resolveTarget(input.target);
      yield* removeLocked(target, input.name).pipe(changes.withPermits(1));
    },
  );

  const removeLocked = (target: SkillInstallTarget, name: string) =>
    Effect.gen(function* () {
      yield* lockedEntry(target, name);
      const paths = targetPaths(target);
      yield* cli
        .remove({
          skills: [name],
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
        .exists(path.join(paths.folder, name))
        .pipe(Effect.orElseSucceed(() => false));
      const lockLeft = (yield* readLock(paths.lock)).has(name);
      if (folderLeft || lockLeft) {
        return yield* cliFailed(
          `Couldn't remove ${name}. Check the permissions of ${folderLeft ? paths.folder : paths.lock}.`,
        );
      }
    });

  return SkillLibrary.of({ inspect, preview, install, update, remove });
});

export const layer = Layer.effect(SkillLibrary, make).pipe(Layer.provide(SkillsCli.layer));
