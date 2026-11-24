import {
  AuthStandardClientScopes,
  CommandId,
  EnvironmentHttpCommonError,
  PROJECT_TRACKED_FOLDERS_MAX,
  type ProjectMutation,
  type ProjectSnapshot,
  ProjectId,
} from "@t3tools/contracts";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Console from "effect/Console";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import { Argument, Command, Flag, GlobalFlag } from "effect/cli";
import { FetchHttpClient, HttpClient, HttpClientError } from "effect/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";

import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import type * as RuntimeLayer from "../orchestration-v2/runtimeLayer.ts";
import * as ProjectEnrichmentService from "../project/ProjectEnrichmentService.ts";
import * as ProjectFaviconResolver from "../project/ProjectFaviconResolver.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { projectMutationOperation } from "../project/ProjectMutation.ts";
import * as T3ProjectFileLoader from "../project/T3ProjectFileLoader.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import { discoverFolders, mergeProjectFolders } from "../workspace/WorkspaceFolders.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { type CliAuthLocationFlags, projectLocationFlags, resolveCliAuthConfig } from "./config.ts";
import * as RunningServer from "./runningServer.ts";

type ProjectMutationTarget = {
  readonly id: ProjectId;
  readonly title: string;
  readonly workspaceRoot: string;
};

type ProjectCliDispatchCommand = ProjectMutation;

const isEnvironmentHttpCommonError = Schema.is(EnvironmentHttpCommonError);

export class ProjectCommandIdGenerationError extends Schema.TaggedError<ProjectCommandIdGenerationError>()(
  "ProjectCommandIdGenerationError",
  {
    operation: Schema.Literal("generateProjectCommandId"),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Failed to generate a project command identifier.";
  }
}

export class ProjectLiveServerDeclaredResponseError extends Schema.TaggedError<ProjectLiveServerDeclaredResponseError>()(
  "ProjectLiveServerDeclaredResponseError",
  {
    operation: Schema.Literal("callLiveServer"),
    code: Schema.String,
    traceId: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Server request failed (${this.code}, trace ${this.traceId}).`;
  }
}

export class ProjectLiveServerUndeclaredStatusError extends Schema.TaggedError<ProjectLiveServerUndeclaredStatusError>()(
  "ProjectLiveServerUndeclaredStatusError",
  {
    operation: Schema.Literal("callLiveServer"),
    status: Schema.Int,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Server request failed with undeclared status ${this.status}.`;
  }
}

export class ProjectTitleEmptyError extends Schema.TaggedError<ProjectTitleEmptyError>()(
  "ProjectTitleEmptyError",
  {
    operation: Schema.Literal("validateProjectTitle"),
    title: Schema.String,
  },
) {
  override get message(): string {
    return "Project title cannot be empty.";
  }
}

export class ProjectIdentifierEmptyError extends Schema.TaggedError<ProjectIdentifierEmptyError>()(
  "ProjectIdentifierEmptyError",
  {
    operation: Schema.Literal("resolveProjectTarget"),
    identifier: Schema.String,
  },
) {
  override get message(): string {
    return "Project identifier cannot be empty.";
  }
}

export class ProjectNotFoundError extends Schema.TaggedError<ProjectNotFoundError>()(
  "ProjectNotFoundError",
  {
    operation: Schema.Literal("resolveProjectTarget"),
    identifier: Schema.String,
    normalizedWorkspaceRoot: Schema.optional(Schema.String),
    activeProjectCount: Schema.Number,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `No active project found for '${this.identifier}'.`;
  }
}

export class ProjectAlreadyExistsError extends Schema.TaggedError<ProjectAlreadyExistsError>()(
  "ProjectAlreadyExistsError",
  {
    operation: Schema.Literal("addProject"),
    projectId: ProjectId,
    workspaceRoot: Schema.String,
  },
) {
  override get message(): string {
    return `An active project already exists for '${this.workspaceRoot}'.`;
  }
}

export class ProjectTooManyTrackedFoldersError extends Schema.TaggedError<ProjectTooManyTrackedFoldersError>()(
  "ProjectTooManyTrackedFoldersError",
  {
    operation: Schema.Literal("addProject"),
    count: Schema.Number,
    max: Schema.Number,
  },
) {
  override get message(): string {
    return `--track names ${this.count} folders, but a project tracks at most ${this.max}.`;
  }
}

export const ProjectCommandError = Schema.Union([
  ProjectCommandIdGenerationError,
  ProjectLiveServerDeclaredResponseError,
  ProjectLiveServerUndeclaredStatusError,
  ProjectTitleEmptyError,
  ProjectIdentifierEmptyError,
  ProjectNotFoundError,
  ProjectAlreadyExistsError,
  ProjectTooManyTrackedFoldersError,
]);
export type ProjectCommandError = typeof ProjectCommandError.Type;

/** Names a server's error answer; unanswered requests pass through for `changeState`. */
function projectCommandErrorFromServerAnswer<E>(cause: E) {
  if (isEnvironmentHttpCommonError(cause)) {
    return new ProjectLiveServerDeclaredResponseError({
      operation: "callLiveServer",
      code: cause.code,
      traceId: cause.traceId,
      cause,
    });
  }
  if (HttpClientError.isHttpClientError(cause) && cause.response !== undefined) {
    return new ProjectLiveServerUndeclaredStatusError({
      operation: "callLiveServer",
      status: cause.response.status,
      cause,
    });
  }
  return cause;
}

const projectCommandUuid = SecureRandom.SecureRandom.pipe(
  Effect.flatMap((random) => random.uuidV4()),
  Effect.mapError(
    (cause) =>
      new ProjectCommandIdGenerationError({
        operation: "generateProjectCommandId",
        cause,
      }),
  ),
);

const makeProjectCliRuntimeLayer = (layerProjectService: typeof RuntimeLayer.layerProjectService) =>
  layerProjectService.pipe(
    Layer.provideMerge(ProjectEnrichmentService.layer),
    Layer.provideMerge(RepositoryIdentityResolver.layer),
    Layer.provideMerge(
      ProjectFaviconResolver.layer.pipe(
        Layer.provide(WorkspacePaths.layer),
        Layer.provide(T3ProjectFileLoader.layer),
      ),
    ),
    Layer.provideMerge(WorkspacePaths.layer),
    Layer.provideMerge(
      ServerSettings.layer.pipe(
        Layer.provide(Layer.merge(ServerSecretStore.layer, ManagedPolicy.layer)),
      ),
    ),
    // Built after acquireServerOwnership; layerCliConfig would contend with this process's own lock.
    Layer.provideMerge(SqlitePersistence.layerConfig),
  );

const normalizeWorkspaceRootForProjectCommand = Effect.fn(
  "normalizeWorkspaceRootForProjectCommand",
)(function* (workspaceRoot: string) {
  const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
  return yield* workspacePaths.normalizeWorkspaceRoot(workspaceRoot);
});

const resolveProjectTitle = Effect.fn("resolveProjectTitle")(function* (
  workspaceRoot: string,
  explicitTitle?: string,
) {
  if (explicitTitle !== undefined) {
    const trimmed = explicitTitle.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
    return yield* new ProjectTitleEmptyError({
      operation: "validateProjectTitle",
      title: explicitTitle,
    });
  }

  const path = yield* Path.Path;
  const basename = path.basename(workspaceRoot).trim();
  return basename.length > 0 ? basename : "project";
});

const findActiveProjectTarget = Effect.fn("findActiveProjectTarget")(function* (input: {
  readonly snapshot: ProjectSnapshot;
  readonly identifier: string;
}) {
  const trimmedIdentifier = input.identifier.trim();
  if (trimmedIdentifier.length === 0) {
    return yield* new ProjectIdentifierEmptyError({
      operation: "resolveProjectTarget",
      identifier: input.identifier,
    });
  }

  const activeProjects = input.snapshot.projects.filter((project) => project.deletedAt === null);
  const exactIdMatch = activeProjects.find((project) => project.id === trimmedIdentifier);
  if (exactIdMatch) {
    return {
      id: exactIdMatch.id,
      title: exactIdMatch.title,
      workspaceRoot: exactIdMatch.workspaceRoot,
    } satisfies ProjectMutationTarget;
  }

  const normalizedWorkspaceRootResult = yield* Effect.result(
    normalizeWorkspaceRootForProjectCommand(trimmedIdentifier),
  );
  // A stored workspace path still identifies its project after the directory is gone, so a
  // relative or trailing-slash path resolves the same way it would while the directory exists.
  const normalizedWorkspaceRoot =
    normalizedWorkspaceRootResult._tag === "Success"
      ? normalizedWorkspaceRootResult.success
      : normalizedWorkspaceRootResult.failure.normalizedWorkspaceRoot;

  const exactWorkspaceMatch = activeProjects.find(
    (project) => project.workspaceRoot === normalizedWorkspaceRoot,
  );

  const resolved = exactWorkspaceMatch;
  if (!resolved) {
    return yield* new ProjectNotFoundError({
      operation: "resolveProjectTarget",
      identifier: trimmedIdentifier,
      activeProjectCount: activeProjects.length,
      normalizedWorkspaceRoot,
      ...(normalizedWorkspaceRootResult._tag === "Failure"
        ? { cause: normalizedWorkspaceRootResult.failure }
        : {}),
    });
  }

  return {
    id: resolved.id,
    title: resolved.title,
    workspaceRoot: resolved.workspaceRoot,
  } satisfies ProjectMutationTarget;
});

const runProjectMutation = Effect.fn("runProjectMutation")(function* (
  flags: CliAuthLocationFlags,
  run: (input: {
    readonly snapshot: ProjectSnapshot;
    readonly dispatch: (
      command: ProjectCliDispatchCommand,
    ) => Effect.Effect<void, Error, FileSystem.FileSystem | HttpClient.HttpClient | Path.Path>;
  }) => Effect.Effect<
    string,
    Error,
    | SecureRandom.SecureRandom
    | FileSystem.FileSystem
    | HttpClient.HttpClient
    | Path.Path
    | WorkspacePaths.WorkspacePaths
  >,
) {
  const logLevel = yield* GlobalFlag.LogLevel;
  const config = yield* resolveCliAuthConfig(flags, logLevel);
  const minimumLogLevel = config.logLevel;

  return yield* Effect.gen(function* () {
    const output = yield* RunningServer.changeState({
      scopes: AuthStandardClientScopes,
      viaServer: Effect.fn("project.viaServer")(function* (client) {
        return yield* run({
          snapshot: yield* client.projects.snapshot({ headers: {} }),
          dispatch: (command) =>
            client.projects.mutate({ headers: {}, payload: command } as Parameters<
              typeof client.projects.mutate
            >[0]),
        });
      }, Effect.mapError(projectCommandErrorFromServerAnswer)),
      locally: Effect.promise(() => import("../orchestration-v2/runtimeLayer.ts")).pipe(
        Effect.flatMap(({ layerProjectService }) =>
          Effect.gen(function* () {
            const projects = yield* ProjectService.ProjectService;
            return yield* run({
              snapshot: yield* projects.snapshot,
              dispatch: (command) =>
                projectMutationOperation(projects, command).pipe(Effect.asVoid),
            });
          }).pipe(
            Effect.provide(
              makeProjectCliRuntimeLayer(layerProjectService).pipe(
                Layer.provide(ServerConfig.layer(config)),
                Layer.provide(Layer.succeed(References.MinimumLogLevel, minimumLogLevel)),
              ),
            ),
          ),
        ),
      ),
    });
    yield* Console.log(output);
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.mergeAll(EnvironmentAuth.layerRuntime, WorkspacePaths.layer).pipe(
        Layer.provideMerge(FetchHttpClient.layer),
        Layer.provideMerge(ServerConfig.layer(config)),
        Layer.provide(Layer.succeed(References.MinimumLogLevel, minimumLogLevel)),
      ),
    ),
  );
});

const projectAddCommand = Command.make("add", {
  ...projectLocationFlags,
  workspaceRoot: Argument.String("path").pipe(
    Argument.withDescription("Workspace root to add as a project."),
  ),
  title: Flag.String("title").pipe(Flag.withDescription("Optional project title."), Flag.optional),
  track: Flag.String("track").pipe(
    Flag.withDescription(
      "A folder outside the path that the project also works in. Repositories inside the path are found on their own. Repeat for more.",
    ),
    Flag.atLeast(0),
  ),
}).pipe(
  Command.withDescription("Add a project."),
  Command.withHandler((flags) =>
    runProjectMutation(
      flags,
      Effect.fn("projectAddMutation")(function* ({
        snapshot,
        dispatch,
      }: {
        readonly snapshot: ProjectSnapshot;
        readonly dispatch: (
          command: ProjectCliDispatchCommand,
        ) => Effect.Effect<void, Error, FileSystem.FileSystem | HttpClient.HttpClient | Path.Path>;
      }) {
        const workspaceRoot = yield* normalizeWorkspaceRootForProjectCommand(flags.workspaceRoot);
        const existingProject = snapshot.projects.find(
          (project) => project.deletedAt === null && project.workspaceRoot === workspaceRoot,
        );
        const path = yield* Path.Path;
        const home = yield* HostProcess.HomeDirectory;
        const named = flags.track
          .map((folder) => {
            const resolved = path.resolve(expandHomePath(folder, home));
            return {
              path: resolved,
              name: (path.basename(resolved) || resolved).slice(0, 128).trim(),
            };
          })
          .filter(
            (folder, index, all) => all.findIndex((other) => other.path === folder.path) === index,
          );
        // Re-adding an archived project's folder restores it, matching the clients.
        if (existingProject?.archivedAt != null) {
          const title = Option.isSome(flags.title)
            ? yield* resolveProjectTitle(workspaceRoot, flags.title.value)
            : undefined;
          // An update replaces the whole list of added folders.
          const kept = (existingProject.trackedFolders ?? [])
            .filter((folder) => folder.discovered !== true)
            .map((folder) => ({ path: folder.path, name: folder.name }));
          const added = named.filter(
            (folder) => !kept.some((existing) => existing.path === folder.path),
          );
          if (kept.length + added.length > PROJECT_TRACKED_FOLDERS_MAX) {
            return yield* new ProjectTooManyTrackedFoldersError({
              operation: "addProject",
              count: kept.length + added.length,
              max: PROJECT_TRACKED_FOLDERS_MAX,
            });
          }
          yield* dispatch({
            type: "project.update",
            commandId: CommandId.make(yield* projectCommandUuid),
            projectId: existingProject.id,
            archived: false,
            ...(title === undefined ? {} : { title }),
            ...(added.length === 0 ? {} : { trackedFolders: [...kept, ...added] }),
          });
          const unarchived = `Unarchived project ${existingProject.id} (${title ?? existingProject.title}) at ${workspaceRoot}.`;
          return added.length === 0
            ? unarchived
            : `${unarchived} It now also covers ${added.length} more ${added.length === 1 ? "folder" : "folders"}.`;
        }
        if (existingProject) {
          return yield* new ProjectAlreadyExistsError({
            operation: "addProject",
            projectId: existingProject.id,
            workspaceRoot,
          });
        }

        const title = yield* resolveProjectTitle(workspaceRoot, Option.getOrUndefined(flags.title));
        // Found here, not by a running server: this command runs on the server's machine.
        const found = yield* discoverFolders(workspaceRoot);
        if (named.length > PROJECT_TRACKED_FOLDERS_MAX) {
          return yield* new ProjectTooManyTrackedFoldersError({
            operation: "addProject",
            count: named.length,
            max: PROJECT_TRACKED_FOLDERS_MAX,
          });
        }
        const trackedFolders = mergeProjectFolders(found, named);
        const projectId = ProjectId.make(yield* projectCommandUuid);
        yield* dispatch({
          type: "project.create",
          commandId: CommandId.make(yield* projectCommandUuid),
          projectId,
          title,
          workspaceRoot,
          ...(trackedFolders.length === 0 ? {} : { trackedFolders }),
        });
        const added = `Added project ${projectId} (${title}) at ${workspaceRoot}.`;
        if (trackedFolders.length > 0) {
          return `${added} It also covers ${trackedFolders.length} other ${trackedFolders.length === 1 ? "folder" : "folders"}.`;
        }
        return added;
      }),
    ),
  ),
);

const projectRemoveCommand = Command.make("remove", {
  ...projectLocationFlags,
  project: Argument.String("project").pipe(
    Argument.withDescription("Project id or workspace root to remove."),
  ),
  force: Flag.Boolean("force").pipe(
    Flag.withDescription("Delete the project and all of its threads."),
    Flag.withDefault(false),
  ),
}).pipe(
  Command.withDescription("Remove a project."),
  Command.withHandler((flags) =>
    runProjectMutation(
      flags,
      Effect.fn("projectRemoveMutation")(function* ({
        snapshot,
        dispatch,
      }: {
        readonly snapshot: ProjectSnapshot;
        readonly dispatch: (
          command: ProjectCliDispatchCommand,
        ) => Effect.Effect<void, Error, FileSystem.FileSystem | HttpClient.HttpClient | Path.Path>;
      }) {
        const project = yield* findActiveProjectTarget({
          snapshot,
          identifier: flags.project,
        });
        yield* dispatch({
          type: "project.delete",
          commandId: CommandId.make(yield* projectCommandUuid),
          projectId: project.id,
          force: flags.force,
        });
        return `Removed project ${project.id} (${project.title}).`;
      }),
    ),
  ),
);

const projectRenameCommand = Command.make("rename", {
  ...projectLocationFlags,
  project: Argument.String("project").pipe(
    Argument.withDescription("Project id or workspace root to rename."),
  ),
  title: Argument.String("title").pipe(Argument.withDescription("New project title.")),
}).pipe(
  Command.withDescription("Rename a project."),
  Command.withHandler((flags) =>
    runProjectMutation(
      flags,
      Effect.fn("projectRenameMutation")(function* ({
        snapshot,
        dispatch,
      }: {
        readonly snapshot: ProjectSnapshot;
        readonly dispatch: (
          command: ProjectCliDispatchCommand,
        ) => Effect.Effect<void, Error, FileSystem.FileSystem | HttpClient.HttpClient | Path.Path>;
      }) {
        const project = yield* findActiveProjectTarget({
          snapshot,
          identifier: flags.project,
        });
        const nextTitle = yield* resolveProjectTitle(project.workspaceRoot, flags.title);
        if (nextTitle === project.title) {
          return `Project ${project.id} is already named ${nextTitle}.`;
        }

        yield* dispatch({
          type: "project.update",
          commandId: CommandId.make(yield* projectCommandUuid),
          projectId: project.id,
          title: nextTitle,
        });
        return `Renamed project ${project.id} to ${nextTitle}.`;
      }),
    ),
  ),
);

export const projectCommand = Command.make("project").pipe(
  Command.withDescription("Manage projects."),
  Command.withSubcommands([projectAddCommand, projectRemoveCommand, projectRenameCommand]),
);
