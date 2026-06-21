import {
  type CommandId,
  ModelSelection,
  ProjectId,
  type Project,
  type ProjectScript,
  type ProjectSnapshot,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionProjects from "../persistence/Services/ProjectionProjects.ts";
import * as ProjectFaviconResolver from "./ProjectFaviconResolver.ts";
import * as RepositoryIdentityResolver from "./RepositoryIdentityResolver.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";

export interface ProjectCreateInput {
  readonly commandId: CommandId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly workspaceRoot: string;
  readonly createWorkspaceRootIfMissing?: boolean;
  readonly defaultModelSelection?: ModelSelection | null;
  readonly scripts?: ReadonlyArray<ProjectScript>;
}

export interface ProjectUpdateInput {
  readonly commandId: CommandId;
  readonly projectId: ProjectId;
  readonly title?: string;
  readonly workspaceRoot?: string;
  readonly defaultModelSelection?: ModelSelection | null;
  readonly scripts?: ReadonlyArray<ProjectScript>;
}

export interface ProjectBootstrapInput extends ProjectCreateInput {}

export interface ProjectDeleteInput {
  readonly commandId: CommandId;
  readonly projectId: ProjectId;
}

export class ProjectNotFoundError extends Schema.TaggedErrorClass<ProjectNotFoundError>()(
  "ProjectNotFoundError",
  { projectId: ProjectId },
) {
  override get message(): string {
    return `Project ${this.projectId} was not found.`;
  }
}

export class ProjectConflictError extends Schema.TaggedErrorClass<ProjectConflictError>()(
  "ProjectConflictError",
  {
    projectId: ProjectId,
    workspaceRoot: Schema.String,
    conflictingProjectId: ProjectId,
  },
) {
  override get message(): string {
    return `Workspace ${this.workspaceRoot} already belongs to project ${this.conflictingProjectId}.`;
  }
}

export class ProjectOperationError extends Schema.TaggedErrorClass<ProjectOperationError>()(
  "ProjectOperationError",
  {
    operation: Schema.Literals([
      "normalize-workspace",
      "read-project",
      "list-projects",
      "dispatch-project-command",
      "resolve-favicon",
    ]),
    projectId: Schema.optional(ProjectId),
    workspaceRoot: Schema.optional(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Project operation '${this.operation}' failed${this.projectId === undefined ? "" : ` for ${this.projectId}`}.`;
  }
}

export type ProjectServiceError =
  | ProjectNotFoundError
  | ProjectConflictError
  | ProjectOperationError;

export class ProjectService extends Context.Service<
  ProjectService,
  {
    readonly create: (input: ProjectCreateInput) => Effect.Effect<Project, ProjectServiceError>;
    readonly bootstrap: (
      input: ProjectBootstrapInput,
    ) => Effect.Effect<
      { readonly project: Project; readonly created: boolean },
      ProjectServiceError
    >;
    readonly update: (input: ProjectUpdateInput) => Effect.Effect<Project, ProjectServiceError>;
    readonly delete: (input: ProjectDeleteInput) => Effect.Effect<Project, ProjectServiceError>;
    readonly getById: (
      projectId: ProjectId,
      options?: { readonly includeDeleted?: boolean },
    ) => Effect.Effect<Option.Option<Project>, ProjectOperationError>;
    readonly getByWorkspaceRoot: (
      workspaceRoot: string,
      options?: { readonly includeDeleted?: boolean },
    ) => Effect.Effect<Option.Option<Project>, ProjectOperationError>;
    readonly snapshot: Effect.Effect<ProjectSnapshot, ProjectOperationError>;
  }
>()("t3/project/ProjectService") {}

export const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const projects = yield* ProjectionProjects.ProjectionProjectRepository;
  const repositoryIdentityResolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
  const faviconResolver = yield* ProjectFaviconResolver.ProjectFaviconResolver;
  const workspacePaths = yield* WorkspacePaths.WorkspacePaths;

  const hydrate = Effect.fn("ProjectService.hydrate")(function* (
    row: ProjectionProjects.ProjectionProject,
  ): Effect.fn.Return<Project, ProjectOperationError> {
    const repositoryIdentity = yield* repositoryIdentityResolver.resolve(row.workspaceRoot);
    const faviconPath = yield* faviconResolver.resolvePath(row.workspaceRoot).pipe(
      Effect.mapError(
        (cause) =>
          new ProjectOperationError({
            operation: "resolve-favicon",
            projectId: row.projectId,
            workspaceRoot: row.workspaceRoot,
            cause,
          }),
      ),
    );
    return {
      id: row.projectId,
      title: row.title,
      workspaceRoot: row.workspaceRoot,
      repositoryIdentity,
      faviconPath,
      defaultModelSelection: row.defaultModelSelection,
      scripts: row.scripts,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      deletedAt: row.deletedAt,
    };
  });

  const readRows = Effect.fn("ProjectService.readRows")(function* () {
    return yield* projects
      .listAll()
      .pipe(
        Effect.mapError(
          (cause) => new ProjectOperationError({ operation: "list-projects", cause }),
        ),
      );
  });

  const getById: ProjectService["Service"]["getById"] = Effect.fn("ProjectService.getById")(
    function* (projectId, options) {
      const row = yield* projects
        .getById({ projectId })
        .pipe(
          Effect.mapError(
            (cause) => new ProjectOperationError({ operation: "read-project", projectId, cause }),
          ),
        );
      if (Option.isNone(row) || (row.value.deletedAt !== null && !options?.includeDeleted)) {
        return Option.none();
      }
      return Option.some(yield* hydrate(row.value));
    },
  );

  const getByWorkspaceRoot: ProjectService["Service"]["getByWorkspaceRoot"] = Effect.fn(
    "ProjectService.getByWorkspaceRoot",
  )(function* (workspaceRoot, options) {
    const normalized = yield* workspacePaths.normalizeWorkspaceRoot(workspaceRoot).pipe(
      Effect.mapError(
        (cause) =>
          new ProjectOperationError({
            operation: "normalize-workspace",
            workspaceRoot,
            cause,
          }),
      ),
    );
    const row = (yield* readRows()).find(
      (candidate) =>
        candidate.workspaceRoot === normalized &&
        (options?.includeDeleted === true || candidate.deletedAt === null),
    );
    return row === undefined ? Option.none() : Option.some(yield* hydrate(row));
  });

  const readCommitted = Effect.fn("ProjectService.readCommitted")(function* (projectId: ProjectId) {
    const row = yield* projects
      .getById({ projectId })
      .pipe(
        Effect.mapError(
          (cause) => new ProjectOperationError({ operation: "read-project", projectId, cause }),
        ),
      );
    if (Option.isNone(row)) {
      return yield* new ProjectOperationError({
        operation: "read-project",
        projectId,
        cause: "The accepted project command did not produce a project projection.",
      });
    }
    return yield* hydrate(row.value);
  });

  const dispatch = <A>(
    projectId: ProjectId,
    command: Parameters<OrchestrationEngineService["Service"]["dispatch"]>[0],
    onCommitted: Effect.Effect<A, ProjectOperationError>,
  ) =>
    engine.dispatch(command).pipe(
      Effect.mapError(
        (cause) =>
          new ProjectOperationError({
            operation: "dispatch-project-command",
            projectId,
            cause,
          }),
      ),
      Effect.andThen(onCommitted),
    );

  const assertWorkspaceAvailable = Effect.fn("ProjectService.assertWorkspaceAvailable")(function* (
    projectId: ProjectId,
    workspaceRoot: string,
  ) {
    const conflicting = (yield* readRows()).find(
      (candidate) =>
        candidate.deletedAt === null &&
        candidate.projectId !== projectId &&
        candidate.workspaceRoot === workspaceRoot,
    );
    if (conflicting !== undefined) {
      return yield* new ProjectConflictError({
        projectId,
        workspaceRoot,
        conflictingProjectId: conflicting.projectId,
      });
    }
  });

  const create: ProjectService["Service"]["create"] = Effect.fn("ProjectService.create")(
    function* (input) {
      const workspaceRoot = yield* workspacePaths
        .normalizeWorkspaceRoot(input.workspaceRoot, {
          createIfMissing: input.createWorkspaceRootIfMissing ?? false,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new ProjectOperationError({
                operation: "normalize-workspace",
                projectId: input.projectId,
                workspaceRoot: input.workspaceRoot,
                cause,
              }),
          ),
        );
      yield* assertWorkspaceAvailable(input.projectId, workspaceRoot);
      const now = DateTime.formatIso(yield* DateTime.now);
      return yield* dispatch(
        input.projectId,
        {
          type: "project.create",
          commandId: input.commandId,
          projectId: input.projectId,
          title: input.title,
          workspaceRoot,
          defaultModelSelection: input.defaultModelSelection ?? null,
          scripts: [...(input.scripts ?? [])],
          createdAt: now,
        },
        readCommitted(input.projectId),
      );
    },
  );

  const update: ProjectService["Service"]["update"] = Effect.fn("ProjectService.update")(
    function* (input) {
      const existing = yield* projects.getById({ projectId: input.projectId }).pipe(
        Effect.mapError(
          (cause) =>
            new ProjectOperationError({
              operation: "read-project",
              projectId: input.projectId,
              cause,
            }),
        ),
      );
      if (Option.isNone(existing) || existing.value.deletedAt !== null) {
        return yield* new ProjectNotFoundError({ projectId: input.projectId });
      }
      const workspaceRoot =
        input.workspaceRoot === undefined
          ? existing.value.workspaceRoot
          : yield* workspacePaths.normalizeWorkspaceRoot(input.workspaceRoot).pipe(
              Effect.mapError(
                (cause) =>
                  new ProjectOperationError({
                    operation: "normalize-workspace",
                    projectId: input.projectId,
                    workspaceRoot: input.workspaceRoot,
                    cause,
                  }),
              ),
            );
      yield* assertWorkspaceAvailable(input.projectId, workspaceRoot);
      return yield* dispatch(
        input.projectId,
        {
          type: "project.meta.update",
          commandId: input.commandId,
          projectId: input.projectId,
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(workspaceRoot === existing.value.workspaceRoot ? {} : { workspaceRoot }),
          ...(input.defaultModelSelection === undefined
            ? {}
            : { defaultModelSelection: input.defaultModelSelection }),
          ...(input.scripts === undefined ? {} : { scripts: [...input.scripts] }),
        },
        readCommitted(input.projectId),
      );
    },
  );

  const bootstrap: ProjectService["Service"]["bootstrap"] = Effect.fn("ProjectService.bootstrap")(
    function* (input) {
      const existing = yield* getByWorkspaceRoot(input.workspaceRoot);
      if (Option.isSome(existing)) return { project: existing.value, created: false };
      return { project: yield* create(input), created: true };
    },
  );

  const deleteProject: ProjectService["Service"]["delete"] = Effect.fn("ProjectService.delete")(
    function* (input) {
      const { projectId } = input;
      const existing = yield* projects
        .getById({ projectId })
        .pipe(
          Effect.mapError(
            (cause) => new ProjectOperationError({ operation: "read-project", projectId, cause }),
          ),
        );
      if (Option.isNone(existing) || existing.value.deletedAt !== null) {
        return yield* new ProjectNotFoundError({ projectId });
      }
      return yield* dispatch(
        projectId,
        {
          type: "project.delete",
          commandId: input.commandId,
          projectId,
        },
        readCommitted(projectId),
      );
    },
  );

  const snapshot = Effect.gen(function* () {
    const rows = (yield* readRows()).filter((row) => row.deletedAt === null);
    const hydrated = yield* Effect.forEach(rows, hydrate, { concurrency: 8 });
    return {
      projects: hydrated,
      updatedAt: DateTime.formatIso(yield* DateTime.now),
    } satisfies ProjectSnapshot;
  });

  return ProjectService.of({
    create,
    bootstrap,
    update,
    delete: deleteProject,
    getById,
    getByWorkspaceRoot,
    snapshot,
  });
});

export const layer = Layer.effect(ProjectService, make);
