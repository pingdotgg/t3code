import {
  type GitCommandError,
  PROJECT_TRACKED_FOLDERS_MAX,
  type ProjectId,
  type ProjectTrackedFolder,
  WORKSPACE_HOME_GIT_INIT_PREVIEW_FILES_MAX,
  type WorkspaceHomeGitInitInput,
  type WorkspaceHomeGitInitPreview,
  type WorkspaceInitializeHomeGitResult,
  type WorkspaceListRepositoriesInput,
  type WorkspaceListRepositoriesResult,
  WorkspaceRepositoriesError,
  type WorkspaceScannedFolder,
  type WorkspaceScanFoldersInput,
  type WorkspaceScanFoldersResult,
} from "@t3tools/contracts";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { fromLenientJson } from "@t3tools/shared/schemaJson";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { isWithinRoot } from "./KnownWorkspaces.ts";
import { type TaskFolderRecord, TaskFolderStore } from "./TaskFolders.ts";

/** A Git repo a thread works in. */
export interface ThreadRepository {
  readonly name: string;
  /** Where Git runs: the task folder worktree, else the real checkout. */
  readonly cwd: string;
  /** The home folder or the project's tracked path. */
  readonly originalPath: string;
  /** From the thread's cwd, with `/` separators. Empty for home. */
  readonly relativePath: string;
  readonly kind: "home" | "repository";
}

/** A plain tracked folder outside home: read-only reference, never a writable root. */
export interface ThreadReferenceFolder {
  readonly name: string;
  readonly path: string;
}

export interface ThreadWorkspace {
  /** The agent cwd: the home folder, or the home worktree. */
  readonly cwd: string;
  /** Home first when it is a Git repo, then tracked Git folders. */
  readonly repositories: ReadonlyArray<ThreadRepository>;
  readonly references: ReadonlyArray<ThreadReferenceFolder>;
  readonly taskFolder: TaskFolderRecord | null;
}

/** True when the thread reaches more than its home repo; single-repo paths must stay unchanged. */
export const isMultiRepoWorkspace = (workspace: ThreadWorkspace) =>
  workspace.repositories.some((repository) => repository.kind === "repository") ||
  workspace.references.length > 0;

/**
 * Resolves which repos a thread works in from the project's tracked folders and the thread's
 * task folder. Git detection runs per call; callers that need it often should keep the result.
 */
export class WorkspaceRepositories extends Context.Service<
  WorkspaceRepositories,
  {
    readonly resolveThreadWorkspace: (input: {
      readonly projectId: ProjectId;
      readonly worktreePath: string | null;
    }) => Effect.Effect<ThreadWorkspace, WorkspaceRepositoriesError>;
    readonly listForClient: (
      input: WorkspaceListRepositoriesInput,
    ) => Effect.Effect<WorkspaceListRepositoriesResult, WorkspaceRepositoriesError>;
    readonly scanFolders: (
      input: WorkspaceScanFoldersInput,
    ) => Effect.Effect<WorkspaceScanFoldersResult, WorkspaceRepositoriesError>;
    readonly previewHomeGitInit: (
      input: WorkspaceHomeGitInitInput,
    ) => Effect.Effect<WorkspaceHomeGitInitPreview, WorkspaceRepositoriesError>;
    readonly initializeHomeGit: (
      input: WorkspaceHomeGitInitInput,
    ) => Effect.Effect<WorkspaceInitializeHomeGitResult, WorkspaceRepositoriesError>;
  }
>()("t3/workspace/WorkspaceRepositories") {}

const GIT_DETECTION_CONCURRENCY = 4;
const HOME_GIT_INIT_COMMIT_MESSAGE = "Initialize home for T3 Code worktrees";
const ENV_FILES_IGNORE_ENTRY = ".env*";
const CODE_WORKSPACE_EXTENSION = ".code-workspace";

const CodeWorkspaceDocument = Schema.Struct({
  folders: Schema.optional(
    Schema.Array(
      Schema.Struct({ path: Schema.optional(Schema.String), name: Schema.optional(Schema.String) }),
    ),
  ),
});
const decodeCodeWorkspace = Schema.decodeUnknownEffect(fromLenientJson(CodeWorkspaceDocument));

/** Submodule paths a `.gitmodules` file declares, relative to its folder with `/` separators. */
export const parseGitmodulesPaths = (text: string): ReadonlyArray<string> =>
  text.split(/\r?\n/).flatMap((line) => {
    const value = /^\s*path\s*=\s*(.*?)\s*$/.exec(line)?.[1];
    if (value === undefined) return [];
    const unquoted = value.startsWith('"')
      ? value.slice(1, value.indexOf('"', 1) === -1 ? undefined : value.indexOf('"', 1))
      : value.replace(/\s+[#;].*$/, "");
    const normalized = unquoted.replaceAll("\\", "/").replace(/\/+$/, "");
    return normalized === "" ? [] : [normalized];
  });

interface ResolvedWorkspace extends ThreadWorkspace {
  /** Repositories gone from disk; the client offers Locate or Remove. */
  readonly missingRepositories: ReadonlyArray<ThreadRepository>;
}

/** @public */
export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const projectStore = yield* ProjectStore.ProjectStoreV2;
  const taskFolders = yield* TaskFolderStore;
  const homeGitInitLock = yield* Semaphore.make(1);

  const failure = (operation: string, detail: string) =>
    new WorkspaceRepositoriesError({ operation, detail });
  const toPosix = (from: string, to: string) => path.relative(from, to).split(path.sep).join("/");
  const exists = (target: string) =>
    fileSystem.exists(target).pipe(Effect.orElseSucceed(() => false));
  const realPathOrSelf = (target: string) =>
    fileSystem.realPath(target).pipe(Effect.orElseSucceed(() => target));

  const runGit = (
    operation: string,
    cwd: string,
    args: ReadonlyArray<string>,
    env?: NodeJS.ProcessEnv,
  ) =>
    git.execute({
      operation: `WorkspaceRepositories.${operation}`,
      cwd,
      args,
      allowNonZeroExit: true,
      timeoutMs: 60_000,
      maxOutputBytes: 16 * 1024 * 1024,
      ...(env === undefined ? {} : { env }),
    });

  /** The top of the Git repo holding `cwd`, or null outside one. */
  const gitToplevel = Effect.fn("WorkspaceRepositories.gitToplevel")(function* (cwd: string) {
    const result = yield* git
      .execute({
        operation: "WorkspaceRepositories.gitToplevel",
        cwd,
        args: ["rev-parse", "--show-toplevel"],
        allowNonZeroExit: true,
        timeoutMs: 5_000,
        maxOutputBytes: 16_384,
      })
      .pipe(Effect.option);
    if (Option.isNone(result) || result.value.exitCode !== 0) return null;
    return result.value.stdout.trim() || null;
  });

  const classifyFolder = Effect.fn("WorkspaceRepositories.classifyFolder")(function* (
    folder: string,
  ) {
    if (!(yield* exists(folder))) return "missing" as const;
    const toplevel = yield* gitToplevel(folder);
    if (toplevel === null) return "plain" as const;
    return (yield* realPathOrSelf(toplevel)) === (yield* realPathOrSelf(folder))
      ? ("git" as const)
      : ("plain" as const);
  });

  const classifyFolders = (folders: ReadonlyArray<ProjectTrackedFolder>) =>
    Effect.forEach(
      folders,
      (folder) => classifyFolder(folder.path).pipe(Effect.map((state) => ({ folder, state }))),
      { concurrency: GIT_DETECTION_CONCURRENCY },
    );

  const loadProject = Effect.fn("WorkspaceRepositories.loadProject")(function* (
    projectId: ProjectId,
    operation: string,
  ) {
    const row = yield* projectStore
      .get(projectId)
      .pipe(Effect.mapError(() => failure(operation, "Failed to read the project.")));
    if (Option.isNone(row)) return yield* failure(operation, `Project ${projectId} was not found.`);
    return row.value;
  });

  const resolveWorkspace = Effect.fn("WorkspaceRepositories.resolveWorkspace")(function* (
    row: ProjectStore.ProjectRow,
    worktreePath: string | null,
  ): Effect.fn.Return<ResolvedWorkspace, WorkspaceRepositoriesError> {
    const home = row.workspaceRoot;
    const cwd = worktreePath === null ? home : path.resolve(worktreePath);
    const outsideHome = row.trackedFolders.filter(
      (folder) => !isWithinRoot(path, folder.path, home),
    );
    const toReference = ({ folder }: { readonly folder: ProjectTrackedFolder }) => ({
      name: folder.name,
      path: folder.path,
    });
    const record =
      worktreePath === null
        ? null
        : Option.getOrNull(
            yield* taskFolders
              .findContaining(cwd)
              .pipe(
                Effect.mapError(() =>
                  failure("resolveThreadWorkspace", "Failed to read task folders."),
                ),
              ),
          );

    if (record !== null && record.projectId === row.projectId) {
      const rows = yield* Effect.forEach(
        record.repositories,
        (repository) =>
          exists(repository.worktreePath).pipe(
            Effect.map((present) => ({
              present,
              repository: {
                name: repository.name,
                cwd: repository.worktreePath,
                originalPath: repository.originalPath,
                relativePath: toPosix(cwd, repository.worktreePath),
                kind: repository.kind,
              } satisfies ThreadRepository,
            })),
          ),
        { concurrency: GIT_DETECTION_CONCURRENCY },
      );
      const inTaskFolder = new Set(
        record.repositories.map((repository) => repository.originalPath),
      );
      const references = (yield* classifyFolders(
        outsideHome.filter((folder) => !inTaskFolder.has(folder.path)),
      )).filter(({ state }) => state === "plain");
      return {
        cwd,
        repositories: rows.filter((entry) => entry.present).map((entry) => entry.repository),
        missingRepositories: rows
          .filter((entry) => !entry.present)
          .map((entry) => entry.repository),
        references: references.map(toReference),
        taskFolder: record,
      };
    }

    const homeRepositories: ReadonlyArray<ThreadRepository> =
      (yield* gitToplevel(cwd)) === null
        ? []
        : [
            {
              name: path.basename(home) || row.title,
              cwd,
              originalPath: home,
              relativePath: "",
              kind: "home",
            },
          ];
    if (row.trackedFolders.length === 0) {
      return {
        cwd,
        repositories: homeRepositories,
        missingRepositories: [],
        references: [],
        taskFolder: null,
      };
    }
    // An isolated worktree never reaches the shared checkouts, only the read-only references.
    const classified = yield* classifyFolders(
      worktreePath === null ? row.trackedFolders : outsideHome,
    );
    const toRepository = ({ folder }: { readonly folder: ProjectTrackedFolder }) =>
      ({
        name: folder.name,
        cwd: folder.path,
        originalPath: folder.path,
        relativePath: toPosix(cwd, folder.path),
        kind: "repository",
      }) satisfies ThreadRepository;
    return {
      cwd,
      repositories:
        worktreePath === null
          ? [
              ...homeRepositories,
              ...classified.filter(({ state }) => state === "git").map(toRepository),
            ]
          : homeRepositories,
      missingRepositories:
        worktreePath === null
          ? classified.filter(({ state }) => state === "missing").map(toRepository)
          : [],
      references: classified
        .filter(({ folder, state }) => state === "plain" && !isWithinRoot(path, folder.path, home))
        .map(toReference),
      taskFolder: null,
    };
  });

  const resolveThreadWorkspace: WorkspaceRepositories["Service"]["resolveThreadWorkspace"] =
    Effect.fn("WorkspaceRepositories.resolveThreadWorkspace")(function* (input) {
      const row = yield* loadProject(input.projectId, "resolveThreadWorkspace");
      const { missingRepositories: _missing, ...workspace } = yield* resolveWorkspace(
        row,
        input.worktreePath,
      );
      return workspace;
    });

  const listForClient: WorkspaceRepositories["Service"]["listForClient"] = Effect.fn(
    "WorkspaceRepositories.listForClient",
  )(function* (input) {
    const row = yield* loadProject(input.projectId, "listRepositories");
    const cwd = path.resolve(input.cwd);
    const resolved = yield* resolveWorkspace(row, cwd === row.workspaceRoot ? null : cwd);
    return {
      repositories: [
        ...resolved.repositories.map((repository) => ({ ...repository, missing: false })),
        ...resolved.missingRepositories.map((repository) => ({ ...repository, missing: true })),
      ],
      references: resolved.references.map((reference) => ({ ...reference, missing: false })),
      taskFolder:
        resolved.taskFolder === null
          ? null
          : {
              root: resolved.taskFolder.root,
              homeWorktreePath: resolved.taskFolder.homeWorktreePath,
            },
    };
  });

  const readSubmodulePaths = (home: string) =>
    fileSystem.readFileString(path.join(home, ".gitmodules")).pipe(
      Effect.map((text) => new Set(parseGitmodulesPaths(text))),
      Effect.orElseSucceed((): ReadonlySet<string> => new Set()),
    );

  const readCodeWorkspaceFolders = Effect.fn("WorkspaceRepositories.readCodeWorkspaceFolders")(
    function* (root: string, fileName: string) {
      const document = yield* fileSystem
        .readFileString(path.join(root, fileName))
        .pipe(Effect.flatMap(decodeCodeWorkspace), Effect.option);
      if (Option.isNone(document)) {
        yield* Effect.logWarning("Ignoring an unreadable workspace file", { root, fileName });
        return null;
      }
      return (document.value.folders ?? []).flatMap((folder) => {
        if (folder.path === undefined || folder.path.trim() === "") return [];
        const folderPath = path.resolve(root, folder.path.trim());
        return [{ path: folderPath, name: folder.name?.trim() || path.basename(folderPath) }];
      });
    },
  );

  const scanFolders: WorkspaceRepositories["Service"]["scanFolders"] = Effect.fn(
    "WorkspaceRepositories.scanFolders",
  )(function* (input) {
    const root = path.resolve(
      expandHomePath(input.workspaceRoot.trim(), yield* HostProcess.HomeDirectory),
    );
    const names = (yield* fileSystem
      .readDirectory(root)
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []))).toSorted();
    const codeWorkspaceFile = names.find((name) => name.endsWith(CODE_WORKSPACE_EXTENSION)) ?? null;
    const listed =
      codeWorkspaceFile === null ? null : yield* readCodeWorkspaceFolders(root, codeWorkspaceFile);
    const children = yield* Effect.forEach(
      names.filter((name) => !name.startsWith(".") && name !== "node_modules"),
      (name) => {
        const folderPath = path.join(root, name);
        return Effect.all([
          fileSystem.stat(folderPath).pipe(
            Effect.map((info) => info.type === "Directory"),
            Effect.orElseSucceed(() => false),
          ),
          exists(path.join(folderPath, ".git")),
        ]).pipe(
          Effect.map(([isDirectory, hasGitEntry]) =>
            isDirectory && hasGitEntry ? [{ path: folderPath, name }] : [],
          ),
        );
      },
      { concurrency: GIT_DETECTION_CONCURRENCY },
    );
    const submodules = yield* readSubmodulePaths(root);
    const seen = new Set<string>();
    const candidates = [
      ...(listed ?? []).map((folder) => ({ ...folder, source: "code-workspace" as const })),
      ...children.flat().map((folder) => ({ ...folder, source: "child" as const })),
    ].filter((folder) => {
      if (seen.has(folder.path) || isWithinRoot(path, root, folder.path)) return false;
      seen.add(folder.path);
      return !(isWithinRoot(path, folder.path, root) && submodules.has(toPosix(root, folder.path)));
    });
    const present = yield* Effect.filter(candidates, (folder) => exists(folder.path), {
      concurrency: GIT_DETECTION_CONCURRENCY,
    });
    // Cap before Git detection so a folder of many repos costs at most the cap in Git calls.
    const folders = yield* Effect.forEach(
      present
        .toSorted((left, right) => left.path.localeCompare(right.path))
        .slice(0, PROJECT_TRACKED_FOLDERS_MAX),
      (folder) =>
        classifyFolder(folder.path).pipe(
          Effect.map((state): WorkspaceScannedFolder => ({
            ...folder,
            isGitRepository: state === "git",
          })),
        ),
      { concurrency: GIT_DETECTION_CONCURRENCY },
    );
    return {
      homeIsGitRepository: (yield* gitToplevel(root)) !== null,
      codeWorkspaceFile:
        listed === null || codeWorkspaceFile === null ? null : path.join(root, codeWorkspaceFile),
      folders,
    };
  });

  /** Plain-folder homes only: the lines the first commit's `.gitignore` gains. */
  const prepareHomeGitInit = Effect.fn("WorkspaceRepositories.prepareHomeGitInit")(function* (
    projectId: ProjectId,
    operation: string,
  ) {
    const row = yield* loadProject(projectId, operation);
    const home = row.workspaceRoot;
    if (!(yield* exists(home))) {
      return yield* failure(operation, `The home folder ${home} does not exist.`);
    }
    if ((yield* gitToplevel(home)) !== null) {
      return yield* failure(operation, "The home folder is already inside a Git repository.");
    }
    const childRepositories = (yield* classifyFolders(
      row.trackedFolders.filter((folder) => isWithinRoot(path, folder.path, home)),
    )).filter(({ state }) => state === "git");
    // Anchored so a same-named folder deeper in home still lands in the commit.
    const ignoreEntries = [
      ...childRepositories.map(({ folder }) => `/${toPosix(home, folder.path)}/`),
      ENV_FILES_IGNORE_ENTRY,
    ];
    return { home, ignoreEntries };
  });

  const gitFailure = (operation: string, step: string) => (result: GitVcsDriver.ExecuteGitResult) =>
    result.exitCode === 0
      ? Effect.succeed(result)
      : Effect.fail(
          failure(
            operation,
            `git ${step} failed: ${result.stderr.trim() || `exit ${result.exitCode}`}`,
          ),
        );
  const mapGitError = (operation: string) =>
    Effect.mapError((error: GitCommandError | WorkspaceRepositoriesError) =>
      error._tag === "WorkspaceRepositoriesError" ? error : failure(operation, error.detail),
    );

  const previewHomeGitInit: WorkspaceRepositories["Service"]["previewHomeGitInit"] = Effect.fn(
    "WorkspaceRepositories.previewHomeGitInit",
  )(function* (input) {
    const operation = "previewHomeGitInit";
    const { home, ignoreEntries } = yield* prepareHomeGitInit(input.projectId, operation);
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const scratch = yield* fileSystem
          .makeTempDirectoryScoped({ prefix: "t3code-home-git-preview-" })
          .pipe(Effect.mapError(() => failure(operation, "Failed to create a temporary folder.")));
        const gitDir = path.join(scratch, "git");
        const env = { GIT_DIR: gitDir, GIT_WORK_TREE: home };
        yield* runGit("previewHomeGitInit.init", scratch, ["init", "--quiet"], {
          GIT_DIR: gitDir,
        }).pipe(Effect.flatMap(gitFailure(operation, "init")));
        const scratchEntries = isWithinRoot(path, scratch, home)
          ? [`/${toPosix(home, scratch)}/`]
          : [];
        yield* fileSystem
          .writeFileString(
            path.join(gitDir, "info", "exclude"),
            `${[...ignoreEntries, ...scratchEntries].join("\n")}\n`,
          )
          .pipe(Effect.mapError(() => failure(operation, "Failed to write the preview excludes.")));
        const listing = yield* runGit(
          "previewHomeGitInit.add",
          home,
          ["add", "-A", "--dry-run"],
          env,
        ).pipe(Effect.flatMap(gitFailure(operation, "add --dry-run")));
        const added = listing.stdout
          .split("\n")
          .flatMap((line) =>
            line.startsWith("add '") && line.endsWith("'") ? [line.slice(5, -1)] : [],
          );
        const files = added.includes(".gitignore") ? added : [...added, ".gitignore"].toSorted();
        return {
          files: files.slice(0, WORKSPACE_HOME_GIT_INIT_PREVIEW_FILES_MAX),
          fileCount: files.length,
          ignoreEntries,
        };
      }),
    ).pipe(mapGitError(operation));
  });

  const initializeHomeGit: WorkspaceRepositories["Service"]["initializeHomeGit"] = Effect.fn(
    "WorkspaceRepositories.initializeHomeGit",
  )(function* (input) {
    const operation = "initializeHomeGit";
    return yield* homeGitInitLock
      .withPermits(1)(
        Effect.gen(function* () {
          const { home, ignoreEntries } = yield* prepareHomeGitInit(input.projectId, operation);
          for (const identity of ["GIT_AUTHOR_IDENT", "GIT_COMMITTER_IDENT"]) {
            const result = yield* runGit("initializeHomeGit.identity", home, ["var", identity]);
            if (result.exitCode !== 0) {
              return yield* failure(
                operation,
                'Git has no user identity. Run git config --global user.name "Your Name" and git config --global user.email "you@example.com", then try again.',
              );
            }
          }
          yield* runGit("initializeHomeGit.init", home, ["init", "--quiet"]).pipe(
            Effect.flatMap(gitFailure(operation, "init")),
          );
          const gitignorePath = path.join(home, ".gitignore");
          const existing = yield* fileSystem
            .readFileString(gitignorePath)
            .pipe(Effect.orElseSucceed(() => ""));
          const present = new Set(existing.split(/\r?\n/).map((line) => line.trim()));
          const missing = ignoreEntries.filter((entry) => !present.has(entry));
          if (missing.length > 0) {
            const separator = existing === "" || existing.endsWith("\n") ? "" : "\n";
            yield* fileSystem
              .writeFileString(gitignorePath, `${existing}${separator}${missing.join("\n")}\n`)
              .pipe(Effect.mapError(() => failure(operation, "Failed to write .gitignore.")));
          }
          yield* runGit("initializeHomeGit.add", home, ["add", "-A"]).pipe(
            Effect.flatMap(gitFailure(operation, "add")),
          );
          yield* runGit("initializeHomeGit.commit", home, [
            "commit",
            "--quiet",
            "--no-verify",
            "-m",
            HOME_GIT_INIT_COMMIT_MESSAGE,
          ]).pipe(Effect.flatMap(gitFailure(operation, "commit")));
          const head = yield* runGit("initializeHomeGit.head", home, ["rev-parse", "HEAD"]).pipe(
            Effect.flatMap(gitFailure(operation, "rev-parse")),
          );
          const listed = yield* runGit("initializeHomeGit.files", home, ["ls-files", "-z"]).pipe(
            Effect.flatMap(gitFailure(operation, "ls-files")),
          );
          return {
            commitSha: head.stdout.trim(),
            fileCount: listed.stdout.split("\0").filter((entry) => entry.length > 0).length,
          };
        }),
      )
      .pipe(mapGitError(operation));
  });

  return WorkspaceRepositories.of({
    resolveThreadWorkspace,
    listForClient,
    scanFolders,
    previewHomeGitInit,
    initializeHomeGit,
  });
});

export const layer = Layer.effect(WorkspaceRepositories, make);
