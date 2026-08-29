import {
  CommandId,
  type Project,
  ProjectId,
  ProjectMcpFailure,
  type ProjectMcpCreateInput,
  type ProjectMcpDeleteInput,
  type ProjectMcpDeleteResult,
  type ProjectMcpListInput,
  type ProjectMcpListResult,
  type ProjectMcpProject,
  type ProjectMcpProjectSummary,
  type ProjectMcpUpdateInput,
  type ServerSettings as ServerSettingsValue,
} from "@t3tools/contracts";
import { resolveDefaultThreadEnvMode } from "@t3tools/shared/threadEnvMode";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { makeKeyedSerialExecutor } from "../orchestration-v2/KeyedSerialExecutor.ts";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as T3ProjectFileLoader from "../project/T3ProjectFileLoader.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SourceControlRepositoryService from "../sourceControl/SourceControlRepositoryService.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";

export class ProjectMcpService extends Context.Service<
  ProjectMcpService,
  {
    readonly list: (
      scope: McpInvocationScope,
      input: ProjectMcpListInput,
    ) => Effect.Effect<ProjectMcpListResult, ProjectMcpFailure>;
    readonly read: (
      scope: McpInvocationScope,
      projectId: ProjectId,
    ) => Effect.Effect<ProjectMcpProject, ProjectMcpFailure>;
    readonly create: (
      scope: McpInvocationScope,
      input: ProjectMcpCreateInput,
    ) => Effect.Effect<ProjectMcpProject, ProjectMcpFailure>;
    readonly update: (
      scope: McpInvocationScope,
      input: ProjectMcpUpdateInput,
    ) => Effect.Effect<ProjectMcpProject, ProjectMcpFailure>;
    readonly delete: (
      scope: McpInvocationScope,
      input: ProjectMcpDeleteInput,
    ) => Effect.Effect<ProjectMcpDeleteResult, ProjectMcpFailure>;
  }
>()("t3/mcp/ProjectMcpService") {}

function failure(code: ProjectMcpFailure["code"], message: string): ProjectMcpFailure {
  return new ProjectMcpFailure({ code, message });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stablePart(value: string): string {
  return encodeURIComponent(value);
}

function stableCommandId(input: {
  readonly scope: McpInvocationScope;
  readonly requestKey: string;
  readonly operation: string;
  readonly suffix?: string;
}): CommandId {
  return CommandId.make(
    [
      "command",
      "mcp",
      stablePart(input.scope.providerSessionId),
      stablePart(input.operation),
      stablePart(input.requestKey),
      ...(input.suffix === undefined ? [] : [stablePart(input.suffix)]),
    ].join(":"),
  );
}

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const projects = yield* ProjectService.ProjectService;
  const projectFiles = yield* T3ProjectFileLoader.T3ProjectFileLoader;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const sourceControl = yield* SourceControlRepositoryService.SourceControlRepositoryService;
  const threads = yield* ThreadManagementService;
  const projectCreates = yield* makeKeyedSerialExecutor<ProjectId>();

  const requireCapability = (scope: McpInvocationScope) =>
    scope.capabilities.has("orchestration")
      ? Effect.void
      : Effect.fail(
          failure(
            "capability_denied",
            "This MCP credential does not grant orchestration capabilities.",
          ),
        );

  const requestKey = (clientRequestId: string | undefined) =>
    clientRequestId === undefined
      ? crypto.randomUUIDv4.pipe(Effect.orDie)
      : clientRequestId.isWellFormed()
        ? Effect.succeed(clientRequestId)
        : Effect.fail(
            failure("invalid_request", "clientRequestId must contain well-formed Unicode."),
          );

  const loadSettings = serverSettings.getSettings.pipe(
    Effect.mapError((error) =>
      failure("operation_failed", `Unable to read server settings: ${errorMessage(error)}`),
    ),
  );

  const projectWorkspaceDefaults = Effect.fn("ProjectMcpService.projectWorkspaceDefaults")(
    function* (project: Project, settings: ServerSettingsValue) {
      const projectFile = yield* projectFiles.load(project.workspaceRoot);
      const projectFileDefaultThreadEnvMode = Option.isSome(projectFile)
        ? (projectFile.value.defaultThreadEnvMode ?? null)
        : null;
      return {
        projectFileDefaultThreadEnvMode,
        globalDefaultThreadEnvMode: settings.defaultThreadEnvMode,
        effectiveDefaultThreadEnvMode: resolveDefaultThreadEnvMode({
          projectSetting: project.defaultThreadEnvMode,
          projectFile: projectFileDefaultThreadEnvMode,
          globalDefault: settings.defaultThreadEnvMode,
        }),
      } as const;
    },
  );

  const projectView = Effect.fn("ProjectMcpService.projectView")(function* (
    project: Project,
    settings: ServerSettingsValue,
  ) {
    return {
      ...project,
      ...(yield* projectWorkspaceDefaults(project, settings)),
    } satisfies ProjectMcpProject;
  });

  const projectSummary = Effect.fn("ProjectMcpService.projectSummary")(function* (
    project: Project,
    settings: ServerSettingsValue,
  ) {
    return {
      id: project.id,
      title: project.title,
      workspaceRoot: project.workspaceRoot,
      ...(project.repositoryIdentity === undefined
        ? {}
        : { repositoryIdentity: project.repositoryIdentity }),
      ...(project.faviconPath === undefined ? {} : { faviconPath: project.faviconPath }),
      defaultModelSelection: project.defaultModelSelection,
      ...(project.defaultThreadEnvMode === undefined
        ? {}
        : { defaultThreadEnvMode: project.defaultThreadEnvMode }),
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
      ...(yield* projectWorkspaceDefaults(project, settings)),
    } satisfies ProjectMcpProjectSummary;
  });

  const loadProject = Effect.fn("ProjectMcpService.loadProject")(function* (projectId: ProjectId) {
    const project = yield* projects
      .getById(projectId)
      .pipe(
        Effect.mapError((error) =>
          failure(
            "operation_failed",
            `Unable to read project ${projectId}: ${errorMessage(error)}`,
          ),
        ),
      );
    if (Option.isNone(project)) {
      return yield* failure("project_not_found", `Project '${projectId}' was not found.`);
    }
    return project.value;
  });

  const list: ProjectMcpService["Service"]["list"] = (scope, input) =>
    Effect.gen(function* () {
      yield* requireCapability(scope);
      const snapshot = yield* projects.snapshot.pipe(
        Effect.mapError((error) =>
          failure("operation_failed", `Unable to list projects: ${errorMessage(error)}`),
        ),
      );
      const settings = yield* loadSettings;
      const cursor = input.cursor ?? 0;
      const limit = input.limit ?? 25;
      const sorted = snapshot.projects.toSorted(
        (left, right) =>
          right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id),
      );
      const page = sorted.slice(cursor, cursor + limit);
      const nextCursor = cursor + page.length < sorted.length ? cursor + page.length : null;
      return {
        projects: yield* Effect.forEach(page, (project) => projectSummary(project, settings), {
          concurrency: 8,
        }),
        nextCursor,
        totalCount: sorted.length,
      };
    });

  const read: ProjectMcpService["Service"]["read"] = (scope, projectId) =>
    Effect.gen(function* () {
      yield* requireCapability(scope);
      return yield* projectView(yield* loadProject(projectId), yield* loadSettings);
    });

  const create: ProjectMcpService["Service"]["create"] = (scope, input) =>
    Effect.gen(function* () {
      yield* requireCapability(scope);
      const key = yield* requestKey(input.clientRequestId);
      const projectId = ProjectId.make(
        ["project", "mcp", stablePart(scope.providerSessionId), stablePart(key)].join(":"),
      );
      return yield* projectCreates.withLock(
        projectId,
        Effect.gen(function* () {
          const existing = yield* projects
            .getById(projectId, { includeDeleted: true })
            .pipe(
              Effect.mapError((error) =>
                failure(
                  "operation_failed",
                  `Unable to retry project creation: ${errorMessage(error)}`,
                ),
              ),
            );
          if (Option.isSome(existing)) {
            if (existing.value.deletedAt !== null) {
              return yield* failure(
                "project_deleted",
                `Project '${projectId}' created by this clientRequestId was deleted. Use a new clientRequestId to create a new project; the deleted record will not be resurrected.`,
              );
            }
            return yield* projectView(existing.value, yield* loadSettings);
          }
          const settings = yield* loadSettings;

          let workspaceRoot: string;
          let createWorkspaceRootIfMissing = false;
          if (input.source.type === "existing_directory") {
            workspaceRoot = input.source.workspaceRoot;
            createWorkspaceRootIfMissing = input.source.createIfMissing ?? false;
          } else {
            const hasRemoteUrl = input.source.remoteUrl !== undefined;
            const hasRepository =
              input.source.provider !== undefined && input.source.repository !== undefined;
            if (hasRemoteUrl === hasRepository) {
              return yield* failure(
                "invalid_request",
                "Clone creation requires either remoteUrl or both provider and repository.",
              );
            }
            const cloned = yield* sourceControl
              .cloneRepository({
                destinationPath: input.source.destinationPath,
                ...(input.source.remoteUrl === undefined
                  ? {}
                  : { remoteUrl: input.source.remoteUrl }),
                ...(input.source.provider === undefined ? {} : { provider: input.source.provider }),
                ...(input.source.repository === undefined
                  ? {}
                  : { repository: input.source.repository }),
                ...(input.source.protocol === undefined ? {} : { protocol: input.source.protocol }),
              })
              .pipe(
                Effect.mapError((error) =>
                  failure("operation_failed", `Unable to clone project: ${errorMessage(error)}`),
                ),
              );
            workspaceRoot = cloned.cwd;
          }

          const project = yield* projects
            .create({
              commandId: stableCommandId({ scope, requestKey: key, operation: "project-create" }),
              projectId,
              title: input.title,
              workspaceRoot,
              ...(createWorkspaceRootIfMissing ? { createWorkspaceRootIfMissing: true } : {}),
              ...(input.defaultModelSelection === undefined
                ? {}
                : { defaultModelSelection: input.defaultModelSelection }),
              ...(input.defaultThreadEnvMode === undefined
                ? {}
                : { defaultThreadEnvMode: input.defaultThreadEnvMode }),
              ...(input.faviconPath === undefined ? {} : { faviconPath: input.faviconPath }),
              ...(input.scripts === undefined ? {} : { scripts: input.scripts }),
            })
            .pipe(
              Effect.mapError((error) =>
                failure("operation_failed", `Unable to create project: ${errorMessage(error)}`),
              ),
            );
          return yield* projectView(project, settings);
        }),
      );
    });

  const update: ProjectMcpService["Service"]["update"] = (scope, input) =>
    Effect.gen(function* () {
      yield* requireCapability(scope);
      if (
        input.title === undefined &&
        input.workspaceRoot === undefined &&
        input.defaultModelSelection === undefined &&
        input.defaultThreadEnvMode === undefined &&
        input.faviconPath === undefined &&
        input.scripts === undefined
      ) {
        return yield* failure("invalid_request", "Provide at least one project field to update.");
      }
      const key = yield* requestKey(input.clientRequestId);
      const settings = yield* loadSettings;
      const project = yield* projects
        .update({
          commandId: stableCommandId({
            scope,
            requestKey: key,
            operation: "project-update",
            suffix: input.projectId,
          }),
          projectId: input.projectId,
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(input.workspaceRoot === undefined ? {} : { workspaceRoot: input.workspaceRoot }),
          ...(input.defaultModelSelection === undefined
            ? {}
            : { defaultModelSelection: input.defaultModelSelection }),
          ...(input.defaultThreadEnvMode === undefined
            ? {}
            : { defaultThreadEnvMode: input.defaultThreadEnvMode }),
          ...(input.faviconPath === undefined ? {} : { faviconPath: input.faviconPath }),
          ...(input.scripts === undefined ? {} : { scripts: input.scripts }),
        })
        .pipe(
          Effect.mapError((error) =>
            error._tag === "ProjectNotFoundError"
              ? failure("project_not_found", error.message)
              : failure("operation_failed", `Unable to update project: ${errorMessage(error)}`),
          ),
        );
      return yield* projectView(project, settings);
    });

  const deleteProjectUnderLock: ProjectMcpService["Service"]["delete"] = (scope, input) =>
    Effect.gen(function* () {
      yield* requireCapability(scope);
      const projectOption = yield* projects
        .getById(input.projectId, { includeDeleted: true })
        .pipe(
          Effect.mapError((error) =>
            failure(
              "operation_failed",
              `Unable to read project ${input.projectId}: ${errorMessage(error)}`,
            ),
          ),
        );
      if (Option.isNone(projectOption)) {
        return yield* failure("project_not_found", `Project '${input.projectId}' was not found.`);
      }
      const project = projectOption.value;
      if (project.deletedAt !== null) {
        return {
          projectId: input.projectId,
          deleted: true,
          alreadyDeleted: true,
          deletedThreadCount: 0,
          workspaceRoot: project.workspaceRoot,
          workspaceFilesDeleted: false,
        } satisfies ProjectMcpDeleteResult;
      }
      const [active, archived] = yield* Effect.all([
        threads.getShellSnapshot({ location: "active" }),
        threads.getShellSnapshot({ location: "archive" }),
      ]).pipe(
        Effect.mapError((error) =>
          failure("operation_failed", `Unable to inspect project threads: ${errorMessage(error)}`),
        ),
      );
      const projectThreads = [
        ...new Map(
          [
            ...active.threads,
            ...active.archivedThreads,
            ...archived.threads,
            ...archived.archivedThreads,
          ]
            .filter((thread) => thread.projectId === input.projectId)
            .map((thread) => [thread.id, thread] as const),
        ).values(),
      ];
      if (projectThreads.length > 0 && input.cascadeThreads !== true) {
        return yield* failure(
          "project_not_empty",
          `Project '${input.projectId}' has ${projectThreads.length} thread${projectThreads.length === 1 ? "" : "s"}. Retry with cascadeThreads=true to delete their records first. Workspace files will remain untouched.`,
        );
      }
      const key = yield* requestKey(input.clientRequestId);
      yield* Effect.forEach(
        projectThreads,
        (thread) =>
          threads.dispatch({
            type: "thread.delete",
            commandId: stableCommandId({
              scope,
              requestKey: key,
              operation: "project-delete-thread",
              suffix: thread.id,
            }),
            threadId: thread.id,
          }),
        { concurrency: 1, discard: true },
      ).pipe(
        Effect.mapError((error) =>
          failure("operation_failed", `Unable to delete project threads: ${errorMessage(error)}`),
        ),
      );
      yield* projects
        .delete({
          commandId: stableCommandId({
            scope,
            requestKey: key,
            operation: "project-delete",
            suffix: input.projectId,
          }),
          projectId: input.projectId,
        })
        .pipe(
          Effect.mapError((error) =>
            failure("operation_failed", `Unable to delete project: ${errorMessage(error)}`),
          ),
        );
      return {
        projectId: input.projectId,
        deleted: true,
        alreadyDeleted: false,
        deletedThreadCount: projectThreads.length,
        workspaceRoot: project.workspaceRoot,
        workspaceFilesDeleted: false,
      } satisfies ProjectMcpDeleteResult;
    });

  const deleteProject: ProjectMcpService["Service"]["delete"] = (scope, input) =>
    threads.withProjectMutationLock(input.projectId, deleteProjectUnderLock(scope, input));

  return ProjectMcpService.of({ list, read, create, update, delete: deleteProject });
});

export const layer: Layer.Layer<
  ProjectMcpService,
  never,
  | Crypto.Crypto
  | ProjectService.ProjectService
  | T3ProjectFileLoader.T3ProjectFileLoader
  | ServerSettings.ServerSettingsService
  | SourceControlRepositoryService.SourceControlRepositoryService
  | ThreadManagementService
> = Layer.effect(ProjectMcpService, make);
