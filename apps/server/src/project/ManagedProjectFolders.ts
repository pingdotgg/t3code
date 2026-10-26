import {
  CommandId,
  type GitManagerServiceError,
  ProjectId,
  type ThreadId,
  VcsProcessSpawnError,
} from "@t3tools/contracts";
import { newProjectFolderName } from "@t3tools/shared/path";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as ProjectService from "./ProjectService.ts";

export class ScratchUnavailableError extends Schema.TaggedError<ScratchUnavailableError>()(
  "ScratchUnavailableError",
  {},
) {
  override get message(): string {
    return "Threads without a project are not available on this environment.";
  }
}

export class ScratchFolderError extends Schema.TaggedError<ScratchFolderError>()(
  "ScratchFolderError",
  {
    folder: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Failed to create the folder for threads without a project.";
  }
}

export class ScratchProjectError extends Schema.TaggedError<ScratchProjectError>()(
  "ScratchProjectError",
  {
    workspaceRoot: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Failed to create the project for threads without a project.";
  }
}

export type ScratchError = ScratchUnavailableError | ScratchFolderError | ScratchProjectError;

export class NamedProjectFolderError extends Schema.TaggedError<NamedProjectFolderError>()(
  "NamedProjectFolderError",
  {
    folder: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Failed to create the project folder.";
  }
}

export class NamedProjectCreateError extends Schema.TaggedError<NamedProjectCreateError>()(
  "NamedProjectCreateError",
  {
    workspaceRoot: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Failed to create the project.";
  }
}

export type NamedProjectError = NamedProjectFolderError | NamedProjectCreateError;

export class ManagedProjectFolders extends Context.Service<
  ManagedProjectFolders,
  {
    readonly scratchRoot: Effect.Effect<Option.Option<string>>;
    readonly ensureScratchProject: Effect.Effect<{ readonly projectId: ProjectId }, ScratchError>;
    readonly isScratchProject: (projectId: ProjectId) => Effect.Effect<boolean>;
    readonly folderForThread: (input: {
      readonly projectId: ProjectId;
      readonly threadId: ThreadId;
      readonly text: string;
    }) => Effect.Effect<Option.Option<string>, ScratchFolderError>;
    readonly namedProjectsRoot: string;
    /** Removes failed/cancelled creations' folders only while no project owns them. */
    readonly createNamedProject: (input: { readonly name: string }) => Effect.Effect<
      {
        readonly projectId: ProjectId;
        readonly workspaceRoot: string;
        readonly commitError?: string;
      },
      NamedProjectError
    >;
  }
>()("t3/project/ManagedProjectFolders") {}

const folderWords = (text: string) =>
  text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .slice(0, 5)
    .join("-")
    .slice(0, 48)
    .replace(/-+$/, "");

const ICON_BACKGROUNDS = [
  "#dc2626",
  "#ea580c",
  "#d97706",
  "#16a34a",
  "#059669",
  "#0d9488",
  "#0891b2",
  "#0284c7",
  "#2563eb",
  "#4f46e5",
  "#7c3aed",
  "#9333ea",
  "#c026d3",
  "#db2777",
  "#e11d48",
] as const;

const MAX_NAMED_FOLDER_ATTEMPTS = 100;

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

// ProjectFaviconResolver finds assets/icon.svg on every clone.
function namedProjectIconSvg(name: string): string {
  const words = name.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const initials =
    words
      .slice(0, 2)
      .map((word) => Array.from(word)[0] ?? "")
      .join("")
      .toUpperCase() ||
    Array.from(name.trim())[0] ||
    "?";
  let hash = 0;
  for (const char of name) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) >>> 0;
  const background = ICON_BACKGROUNDS[hash % ICON_BACKGROUNDS.length];
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">`,
    `  <rect width="64" height="64" rx="14" fill="${background}"/>`,
    `  <text x="32" y="32" dy="0.35em" text-anchor="middle" font-family="ui-sans-serif, system-ui, -apple-system, sans-serif" font-size="${initials.length > 1 ? 26 : 32}" font-weight="600" fill="#ffffff">${escapeXml(initials)}</text>`,
    `</svg>`,
    "",
  ].join("\n");
}

function namedProjectReadme(name: string): string {
  return [
    `<img src="assets/icon.svg" width="64" height="64" alt="">`,
    "",
    `# ${name}`,
    "",
    "Created in [T3 Code](https://t3.codes).",
    "",
  ].join("\n");
}

function describeCommitFailure(stderr: string): string {
  if (/identity unknown|tell me who you are|no (name|email) was given/i.test(stderr)) {
    return "Git has no name or email on this machine. Set user.name and user.email, then commit.";
  }
  const lines = stderr
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.at(-1) ?? "Git could not make the first commit.";
}

const isVcsProcessSpawnError = Schema.is(VcsProcessSpawnError);

const isGitMissing = (error: GitManagerServiceError) =>
  error._tag === "GitManagerError" &&
  isVcsProcessSpawnError(error.cause) &&
  PlatformError.isPlatformError(error.cause.cause) &&
  error.cause.cause.reason._tag === "NotFound";

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const gitWorkflow = yield* GitWorkflow.GitWorkflowService;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const projects = yield* ProjectService.ProjectService;
  const crypto = yield* Crypto.Crypto;

  // Non-recursive mkdir atomically claims a name; racers move on after AlreadyExists.
  const claimFreeFolder = Effect.fnUntraced(function* <E>(
    folderFor: (attempt: number) => Effect.Effect<Option.Option<string>, E>,
    onError: (folder: string, cause: PlatformError.PlatformError) => E,
  ) {
    for (let attempt = 1; ; attempt++) {
      const folder = yield* folderFor(attempt);
      if (Option.isNone(folder)) return folder;
      const claimed = yield* fileSystem.makeDirectory(folder.value).pipe(
        Effect.as(true),
        Effect.catchIf(
          (error) => error.reason._tag === "AlreadyExists",
          () => Effect.succeed(false),
        ),
        Effect.mapError((cause) => onError(folder.value, cause)),
      );
      if (claimed) return folder;
    }
  });

  // Scratch inside a checkout would inherit its git status and checkpoints; require a data dir outside work trees.
  const [probe, invalidate] = yield* Effect.cachedInvalidateWithTTL(
    gitWorkflow.isRepository(config.baseDir).pipe(
      Effect.catchIf(isGitMissing, () => Effect.succeed(false)),
      Effect.map((isRepository) =>
        isRepository ? Option.none<string>() : Option.some(path.resolve(config.baseDir, "scratch")),
      ),
      Effect.catchCause((cause) =>
        Cause.hasInterrupts(cause) ? Effect.interrupt : Effect.succeed(Option.none<string>()),
      ),
    ),
    Duration.infinity,
  );
  const scratchRoot = probe.pipe(Effect.onInterrupt(() => invalidate));

  const makeScratchFolder = (folder: string) =>
    fileSystem
      .makeDirectory(folder, { recursive: true })
      .pipe(Effect.mapError((cause) => new ScratchFolderError({ folder, cause })));

  const ensureScratchProject: ManagedProjectFolders["Service"]["ensureScratchProject"] = Effect.gen(
    function* () {
      const workspaceRoot = yield* scratchRoot.pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(new ScratchUnavailableError()),
            onSome: Effect.succeed,
          }),
        ),
      );
      yield* makeScratchFolder(workspaceRoot);
      const id = yield* crypto
        .randomUUIDv4()
        .pipe(Effect.mapError((cause) => new ScratchProjectError({ workspaceRoot, cause })));
      const bootstrapped = yield* projects
        .bootstrap({
          commandId: CommandId.make(`scratch-project:${id}`),
          projectId: ProjectId.make(id),
          title: "No project",
          workspaceRoot,
        })
        .pipe(
          // bootstrap reads before locking; racing creates return the winner in a conflict.
          Effect.catchTags({
            ProjectConflictError: (conflict) =>
              Effect.succeed({
                project: { id: conflict.conflictingProjectId },
                created: false,
              }),
          }),
          Effect.mapError((cause) => new ScratchProjectError({ workspaceRoot, cause })),
        );
      if (bootstrapped.created) {
        // Set once at create, so a user's own icon choice is never overwritten.
        yield* projects
          .update({
            commandId: CommandId.make(`scratch-project-icon:${id}`),
            projectId: bootstrapped.project.id,
            projectIcon: { kind: "lucide", name: "message-square-dashed", color: "gray" },
          })
          .pipe(Effect.mapError((cause) => new ScratchProjectError({ workspaceRoot, cause })));
      }
      return { projectId: bootstrapped.project.id };
    },
  );

  const isScratchRoot = (projectId: ProjectId, root: string) =>
    projects.getById(projectId).pipe(
      Effect.map(
        Option.exists((project) => path.resolve(project.workspaceRoot) === path.resolve(root)),
      ),
      Effect.orElseSucceed(() => false),
    );

  const isScratchProject: ManagedProjectFolders["Service"]["isScratchProject"] = (projectId) =>
    scratchRoot.pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.succeed(false),
          onSome: (root) => isScratchRoot(projectId, root),
        }),
      ),
    );

  const folderForThread: ManagedProjectFolders["Service"]["folderForThread"] = Effect.fn(
    "ManagedProjectFolders.folderForThread",
  )(function* (input) {
    const root = yield* scratchRoot;
    if (Option.isNone(root)) return Option.none();
    if (!(yield* isScratchRoot(input.projectId, root.value))) return Option.none();
    const date = DateTime.formatIso(yield* DateTime.now).slice(0, 10);
    const words = folderWords(input.text);
    const id = input.threadId.toLowerCase().replace(/[^a-z0-9]/g, "");
    const folderFor = (idPart: string) =>
      path.join(root.value, [date, words, idPart].filter(Boolean).join("-"));
    yield* makeScratchFolder(root.value);
    const fullFolder = folderFor(id);
    return yield* claimFreeFolder(
      (attempt) =>
        attempt === 1
          ? Effect.succeedSome(folderFor(id.slice(-8)))
          : attempt === 2
            ? Effect.succeedSome(fullFolder)
            : crypto.randomUUIDv4().pipe(
                Effect.map((uuid) => Option.some(`${fullFolder}-${uuid.slice(0, 8)}`)),
                Effect.mapError((cause) => new ScratchFolderError({ folder: fullFolder, cause })),
              ),
      (folder, cause) => new ScratchFolderError({ folder, cause }),
    );
  });

  const namedProjectsRoot = path.resolve(config.baseDir, "projects");

  const claimNamedFolder = Effect.fn("ManagedProjectFolders.claimNamedFolder")(function* (
    name: string,
  ) {
    yield* fileSystem
      .makeDirectory(namedProjectsRoot, { recursive: true })
      .pipe(
        Effect.mapError(
          (cause) => new NamedProjectFolderError({ folder: namedProjectsRoot, cause }),
        ),
      );
    const folderName = newProjectFolderName(name);
    const claimed = yield* claimFreeFolder(
      (attempt) =>
        Effect.succeed(
          attempt > MAX_NAMED_FOLDER_ATTEMPTS
            ? Option.none()
            : Option.some(
                path.join(
                  namedProjectsRoot,
                  attempt === 1 ? folderName : `${folderName}-${attempt}`,
                ),
              ),
        ),
      (folder, cause) => new NamedProjectFolderError({ folder, cause }),
    );
    if (Option.isSome(claimed)) return claimed.value;
    return yield* new NamedProjectFolderError({
      folder: path.join(namedProjectsRoot, folderName),
      cause: `Every folder name for "${folderName}" is taken.`,
    });
  });

  const scaffoldRepository = Effect.fn("ManagedProjectFolders.scaffoldRepository")(function* (
    cwd: string,
    name: string,
  ) {
    const branch =
      (yield* git
        .readConfigValue(cwd, "init.defaultBranch")
        .pipe(Effect.orElseSucceed(() => null))) ?? "main";
    yield* git.execute({
      operation: "ManagedProjectFolders.init",
      cwd,
      args: ["init", `--initial-branch=${branch}`],
      timeoutMs: 10_000,
    });
    yield* fileSystem.writeFileString(path.join(cwd, "README.md"), namedProjectReadme(name));
    yield* fileSystem.makeDirectory(path.join(cwd, "assets"));
    yield* fileSystem.writeFileString(
      path.join(cwd, "assets", "icon.svg"),
      namedProjectIconSvg(name),
    );
    // Force explicit filenames so global ignore rules cannot drop them.
    yield* git.execute({
      operation: "ManagedProjectFolders.add",
      cwd,
      args: ["add", "--force", "--", "README.md", "assets/icon.svg"],
      timeoutMs: 10_000,
    });
    return yield* git
      .execute({
        operation: "ManagedProjectFolders.commit",
        cwd,
        args: ["commit", "--message", "Initial commit"],
        allowNonZeroExit: true,
        timeoutMs: 30_000,
      })
      .pipe(
        Effect.map((result) =>
          result.exitCode === 0 ? undefined : describeCommitFailure(result.stderr),
        ),
        Effect.catch((error) => Effect.succeed(error.message)),
      );
  });

  const createNamedProject: ManagedProjectFolders["Service"]["createNamedProject"] = Effect.fn(
    "ManagedProjectFolders.createNamedProject",
  )(function* (input) {
    const workspaceRoot = yield* claimNamedFolder(input.name);
    const removeFolder = fileSystem.remove(workspaceRoot, { recursive: true }).pipe(Effect.ignore);
    const prepared = yield* Effect.all([
      scaffoldRepository(workspaceRoot, input.name).pipe(
        Effect.mapError((cause) => new NamedProjectFolderError({ folder: workspaceRoot, cause })),
      ),
      crypto
        .randomUUIDv4()
        .pipe(Effect.mapError((cause) => new NamedProjectCreateError({ workspaceRoot, cause }))),
    ]).pipe(Effect.onExit((exit) => (Exit.isSuccess(exit) ? Effect.void : removeFolder)));
    const [commitError, id] = prepared;
    const project = yield* projects
      .create({
        commandId: CommandId.make(`named-project:${id}`),
        projectId: ProjectId.make(id),
        title: input.name,
        workspaceRoot,
      })
      .pipe(
        // Re-check ownership before deleting rejected creations; interruption after commit or conflicts can leave an owner.
        Effect.tapError((error) =>
          error._tag === "ProjectConflictError"
            ? Effect.void
            : projects.getByWorkspaceRoot(workspaceRoot).pipe(
                Effect.flatMap((owner) => (Option.isNone(owner) ? removeFolder : Effect.void)),
                Effect.ignore,
              ),
        ),
        Effect.mapError((cause) => new NamedProjectCreateError({ workspaceRoot, cause })),
      );
    return {
      projectId: project.id,
      workspaceRoot,
      ...(commitError === undefined ? {} : { commitError }),
    };
  });

  return ManagedProjectFolders.of({
    scratchRoot,
    ensureScratchProject,
    isScratchProject,
    folderForThread,
    namedProjectsRoot,
    createNamedProject,
  });
});

export const layer = Layer.effect(ManagedProjectFolders, make);
