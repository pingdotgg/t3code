import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  type CommandId,
  EnvironmentId,
  ProjectMcpFailure,
  type Project,
  ProjectId,
  ProviderInstanceId,
  type ServerSettings,
  ServerSettingsError,
  ThreadId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import { makeKeyedSerialExecutor } from "../orchestration-v2/KeyedSerialExecutor.ts";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as T3ProjectFileLoader from "../project/T3ProjectFileLoader.ts";
import * as ServerSettingsService from "../serverSettings.ts";
import * as SourceControlRepositoryService from "../sourceControl/SourceControlRepositoryService.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import { ProjectMcpService } from "./ProjectMcpService.ts";
import * as ProjectMcp from "./ProjectMcpService.ts";

const scope: McpInvocationScope = {
  environmentId: EnvironmentId.make("environment-project-mcp"),
  threadId: ThreadId.make("thread-project-mcp"),
  providerSessionId: "provider-session-project-mcp",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
};

const now = "2026-08-29T12:00:00.000Z" as const;

const makeProject = (input: {
  readonly id: ProjectId;
  readonly title: string;
  readonly workspaceRoot: string;
}): Project => ({
  id: input.id,
  title: input.title,
  workspaceRoot: input.workspaceRoot,
  repositoryIdentity: null,
  faviconPath: null,
  defaultModelSelection: null,
  defaultThreadEnvMode: null,
  scripts: [],
  createdAt: now,
  updatedAt: now,
  deletedAt: null,
});

it.effect("creates, reads, and updates project defaults through the project MCP service", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make<ReadonlyMap<ProjectId, Project>>(new Map());
    const createdInputs = yield* Ref.make<ReadonlyArray<ProjectService.ProjectCreateInput>>([]);
    const updatedInputs = yield* Ref.make<ReadonlyArray<ProjectService.ProjectUpdateInput>>([]);

    const projectService = ProjectService.ProjectService.of({
      create: (input) =>
        Effect.gen(function* () {
          yield* Ref.update(createdInputs, (current) => [...current, input]);
          const project = {
            ...makeProject({
              id: input.projectId,
              title: input.title,
              workspaceRoot: input.workspaceRoot,
            }),
            defaultModelSelection: input.defaultModelSelection ?? null,
            defaultThreadEnvMode: input.defaultThreadEnvMode ?? null,
            faviconPath: input.faviconPath ?? null,
            scripts: [...(input.scripts ?? [])],
          } satisfies Project;
          yield* Ref.update(state, (current) => new Map(current).set(project.id, project));
          return project;
        }),
      bootstrap: () => Effect.die("unused"),
      update: (input) =>
        Effect.gen(function* () {
          yield* Ref.update(updatedInputs, (current) => [...current, input]);
          const current = (yield* Ref.get(state)).get(input.projectId)!;
          const project = {
            ...current,
            ...(input.title === undefined ? {} : { title: input.title }),
            ...(input.workspaceRoot === undefined ? {} : { workspaceRoot: input.workspaceRoot }),
            ...(input.defaultModelSelection === undefined
              ? {}
              : { defaultModelSelection: input.defaultModelSelection }),
            ...(input.defaultThreadEnvMode === undefined
              ? {}
              : { defaultThreadEnvMode: input.defaultThreadEnvMode }),
            ...(input.faviconPath === undefined ? {} : { faviconPath: input.faviconPath }),
            ...(input.scripts === undefined ? {} : { scripts: [...input.scripts] }),
          } satisfies Project;
          yield* Ref.update(state, (projects) => new Map(projects).set(project.id, project));
          return project;
        }),
      delete: () => Effect.die("unused"),
      getById: (projectId) =>
        Ref.get(state).pipe(
          Effect.map((projects) => Option.fromNullishOr(projects.get(projectId))),
        ),
      getByWorkspaceRoot: () => Effect.succeed(Option.none()),
      snapshot: Ref.get(state).pipe(
        Effect.map((projects) => ({ projects: [...projects.values()], updatedAt: now })),
      ),
    });
    const testLayer = ProjectMcp.layer.pipe(
      Layer.provide(Layer.succeed(ProjectService.ProjectService, projectService)),
      Layer.provide(
        Layer.mock(T3ProjectFileLoader.T3ProjectFileLoader)({
          load: () => Effect.succeed(Option.some({ defaultThreadEnvMode: "worktree" })),
        }),
      ),
      Layer.provide(
        Layer.mock(ServerSettingsService.ServerSettingsService)({
          getSettings: Effect.succeed({
            defaultThreadEnvMode: "local",
          } as ServerSettings),
        }),
      ),
      Layer.provide(Layer.mock(SourceControlRepositoryService.SourceControlRepositoryService)({})),
      Layer.provide(Layer.mock(ThreadManagementService)({})),
      Layer.provide(NodeServices.layer),
    );

    yield* Effect.gen(function* () {
      const service = yield* ProjectMcpService;
      const invalidKey = yield* service
        .create(scope, {
          title: "Invalid key",
          source: { type: "existing_directory", workspaceRoot: "/work/invalid-key" },
          clientRequestId: "create-\ud800-project",
        })
        .pipe(Effect.flip);
      expect(invalidKey.code).toBe("invalid_request");
      expect(yield* Ref.get(createdInputs)).toEqual([]);

      const created = yield* service.create(scope, {
        title: "Created project",
        source: {
          type: "existing_directory",
          workspaceRoot: "/work/created",
          createIfMissing: true,
        },
        defaultThreadEnvMode: "local",
        faviconPath: "/work/created/icon.svg",
        clientRequestId: "create-project",
      });
      expect(created.projectFileDefaultThreadEnvMode).toBe("worktree");
      expect(created.globalDefaultThreadEnvMode).toBe("local");
      expect(created.effectiveDefaultThreadEnvMode).toBe("local");
      expect((yield* Ref.get(createdInputs))[0]?.createWorkspaceRootIfMissing).toBe(true);

      const updated = yield* service.update(scope, {
        projectId: created.id,
        defaultThreadEnvMode: null,
        faviconPath: null,
        clientRequestId: "update-project",
      });
      expect(updated.defaultThreadEnvMode).toBeNull();
      expect(updated.faviconPath).toBeNull();
      expect(updated.effectiveDefaultThreadEnvMode).toBe("worktree");
      expect((yield* Ref.get(updatedInputs))[0]).toMatchObject({
        defaultThreadEnvMode: null,
        faviconPath: null,
      });
      expect(String((yield* Ref.get(updatedInputs))[0]?.commandId)).toContain(
        encodeURIComponent(created.id),
      );
    }).pipe(Effect.provide(testLayer));
  }),
);

it.effect("loads response settings before committing project mutations", () =>
  Effect.gen(function* () {
    const createCalls = yield* Ref.make(0);
    const testLayer = ProjectMcp.layer.pipe(
      Layer.provide(
        Layer.mock(ProjectService.ProjectService)({
          getById: () => Effect.succeed(Option.none()),
          create: () => Ref.update(createCalls, (count) => count + 1).pipe(Effect.as({} as never)),
        }),
      ),
      Layer.provide(Layer.mock(T3ProjectFileLoader.T3ProjectFileLoader)({})),
      Layer.provide(
        Layer.mock(ServerSettingsService.ServerSettingsService)({
          getSettings: Effect.fail(
            new ServerSettingsError({
              settingsPath: "/test/settings.json",
              operation: "read-file",
              cause: "settings unavailable",
            }),
          ),
        }),
      ),
      Layer.provide(Layer.mock(SourceControlRepositoryService.SourceControlRepositoryService)({})),
      Layer.provide(Layer.mock(ThreadManagementService)({})),
      Layer.provide(NodeServices.layer),
    );

    yield* Effect.gen(function* () {
      const service = yield* ProjectMcpService;
      const error = yield* service
        .create(scope, {
          title: "Uncommitted project",
          source: { type: "existing_directory", workspaceRoot: "/work/uncommitted" },
          clientRequestId: "settings-failure",
        })
        .pipe(Effect.flip);
      expect(error.code).toBe("operation_failed");
      expect(yield* Ref.get(createCalls)).toBe(0);
    }).pipe(Effect.provide(testLayer));
  }),
);

it.effect("clones before registration and requires explicit cascading for nonempty projects", () =>
  Effect.gen(function* () {
    const projectId = ProjectId.make("project:mcp:provider-session-project-mcp:clone-and-delete");
    const project = makeProject({
      id: projectId,
      title: "Cloned project",
      workspaceRoot: "/work/cloned",
    });
    const state = yield* Ref.make<Project | null>(null);
    const cloneInputs = yield* Ref.make<ReadonlyArray<{ readonly destinationPath: string }>>([]);
    const deletedThreadCommands = yield* Ref.make<ReadonlyArray<CommandId>>([]);
    const deletedProjects = yield* Ref.make<ReadonlyArray<ProjectId>>([]);
    const lockedProjects = yield* Ref.make<ReadonlyArray<ProjectId>>([]);
    const testLayer = ProjectMcp.layer.pipe(
      Layer.provide(
        Layer.mock(ProjectService.ProjectService)({
          create: (input) =>
            Effect.gen(function* () {
              const created = makeProject({
                id: input.projectId,
                title: input.title,
                workspaceRoot: input.workspaceRoot,
              });
              yield* Ref.set(state, created);
              return created;
            }),
          getById: () => Ref.get(state).pipe(Effect.map(Option.fromNullishOr)),
          delete: ({ projectId }) =>
            Effect.gen(function* () {
              yield* Ref.update(deletedProjects, (current) => [...current, projectId]);
              const deleted = { ...project, deletedAt: now } satisfies Project;
              yield* Ref.set(state, deleted);
              return deleted;
            }),
        }),
      ),
      Layer.provide(
        Layer.mock(T3ProjectFileLoader.T3ProjectFileLoader)({
          load: () => Effect.succeed(Option.none()),
        }),
      ),
      Layer.provide(
        Layer.mock(ServerSettingsService.ServerSettingsService)({
          getSettings: Effect.succeed({ defaultThreadEnvMode: "local" } as ServerSettings),
        }),
      ),
      Layer.provide(
        Layer.mock(SourceControlRepositoryService.SourceControlRepositoryService)({
          cloneRepository: (input) =>
            Ref.update(cloneInputs, (current) => [
              ...current,
              { destinationPath: input.destinationPath },
            ]).pipe(
              Effect.as({
                cwd: "/work/cloned",
                remoteUrl: "https://example.com/acme/repo.git",
                repository: null,
              }),
            ),
        }),
      ),
      Layer.provide(
        Layer.mock(ThreadManagementService)({
          withProjectMutationLock: (lockedProjectId, effect) =>
            Ref.update(lockedProjects, (current) => [...current, lockedProjectId]).pipe(
              Effect.andThen(effect),
            ),
          getShellSnapshot: (options) =>
            Effect.succeed({
              schemaVersion: 1,
              snapshotSequence: 1,
              threads:
                options?.location === "archive"
                  ? []
                  : [
                      {
                        id: ThreadId.make("thread-in-project"),
                        projectId,
                      } as never,
                    ],
              archivedThreads:
                options?.location === "archive"
                  ? [
                      {
                        id: ThreadId.make("archived-subagent-in-project"),
                        projectId,
                        lineage: { relationshipToParent: "subagent" },
                      } as never,
                    ]
                  : [],
            }),
          dispatch: (command) =>
            command.type === "thread.delete"
              ? Ref.update(deletedThreadCommands, (current) => [
                  ...current,
                  command.commandId,
                ]).pipe(Effect.as({} as never))
              : Effect.die("unexpected command"),
        }),
      ),
      Layer.provide(NodeServices.layer),
    );

    yield* Effect.gen(function* () {
      const service = yield* ProjectMcpService;
      const created = yield* service.create(scope, {
        title: project.title,
        source: {
          type: "clone",
          destinationPath: "/work/cloned",
          remoteUrl: "https://example.com/acme/repo.git",
        },
        clientRequestId: "clone-and-delete",
      });
      expect(created.workspaceRoot).toBe("/work/cloned");
      expect(yield* Ref.get(cloneInputs)).toEqual([{ destinationPath: "/work/cloned" }]);

      const refusal = yield* service
        .delete(scope, { projectId, clientRequestId: "delete-refused" })
        .pipe(Effect.flip);
      expect(refusal.code).toBe("project_not_empty");

      const deleted = yield* service.delete(scope, {
        projectId,
        cascadeThreads: true,
        clientRequestId: "delete-cascade",
      });
      expect(deleted).toMatchObject({
        projectId,
        deleted: true,
        alreadyDeleted: false,
        deletedThreadCount: 2,
        workspaceRoot: "/work/cloned",
        workspaceFilesDeleted: false,
      });
      expect(yield* Ref.get(deletedThreadCommands)).toHaveLength(2);
      expect(yield* Ref.get(deletedProjects)).toEqual([projectId]);

      const replayed = yield* service.delete(scope, {
        projectId,
        cascadeThreads: true,
        clientRequestId: "delete-cascade",
      });
      expect(replayed).toMatchObject({
        deleted: true,
        alreadyDeleted: true,
        deletedThreadCount: 0,
        workspaceFilesDeleted: false,
      });
      expect(yield* Ref.get(deletedProjects)).toEqual([projectId]);
      expect(yield* Ref.get(lockedProjects)).toEqual([projectId, projectId, projectId]);
    }).pipe(Effect.provide(testLayer));
  }),
);

it.effect("serializes project deletion against new thread claims", () =>
  Effect.gen(function* () {
    const projectId = ProjectId.make("project:mcp:delete-launch-race");
    const project = makeProject({
      id: projectId,
      title: "Delete race",
      workspaceRoot: "/work/delete-race",
    });
    const state = yield* Ref.make<Project | null>(project);
    const snapshotEntered = yield* Deferred.make<void>();
    const allowSnapshot = yield* Deferred.make<void>();
    const competingClaim = yield* Deferred.make<void>();
    const projectMutations = yield* makeKeyedSerialExecutor<ProjectId>();
    const threadManagementLayer = Layer.mock(ThreadManagementService)({
      withProjectMutationLock: projectMutations.withLock,
      getShellSnapshot: () =>
        Deferred.succeed(snapshotEntered, undefined).pipe(
          Effect.andThen(Deferred.await(allowSnapshot)),
          Effect.as({
            schemaVersion: 1,
            snapshotSequence: 1,
            threads: [],
            archivedThreads: [],
          }),
        ),
      dispatch: () => Effect.die("unexpected command"),
    });
    const testLayer = ProjectMcp.layer.pipe(
      Layer.provide(
        Layer.mock(ProjectService.ProjectService)({
          getById: () => Ref.get(state).pipe(Effect.map(Option.fromNullishOr)),
          delete: () =>
            Ref.updateAndGet(state, (current) =>
              current === null ? null : { ...current, deletedAt: now },
            ).pipe(Effect.map((deleted) => deleted!)),
        }),
      ),
      Layer.provide(Layer.mock(T3ProjectFileLoader.T3ProjectFileLoader)({})),
      Layer.provide(
        Layer.mock(ServerSettingsService.ServerSettingsService)({
          getSettings: Effect.succeed({ defaultThreadEnvMode: "local" } as ServerSettings),
        }),
      ),
      Layer.provide(Layer.mock(SourceControlRepositoryService.SourceControlRepositoryService)({})),
      Layer.provide(threadManagementLayer),
      Layer.provide(NodeServices.layer),
    );

    yield* Effect.gen(function* () {
      const service = yield* ProjectMcpService;
      const deletion = yield* Effect.forkChild(
        service.delete(scope, { projectId, clientRequestId: "delete-launch-race" }),
        { startImmediately: true },
      );
      yield* Deferred.await(snapshotEntered);
      const claim = yield* Effect.forkChild(
        projectMutations.withLock(projectId, Deferred.succeed(competingClaim, undefined)),
        { startImmediately: true },
      );
      expect(yield* Deferred.isDone(competingClaim)).toBe(false);

      yield* Deferred.succeed(allowSnapshot, undefined);
      const deleted = yield* Fiber.join(deletion);
      yield* Fiber.join(claim);
      expect(deleted.deleted).toBe(true);
      expect(yield* Deferred.isDone(competingClaim)).toBe(true);
    }).pipe(Effect.provide(testLayer));
  }),
);

it.effect("paginates summaries before loading project files and reads settings once", () =>
  Effect.gen(function* () {
    const projectFileLoads = yield* Ref.make<ReadonlyArray<string>>([]);
    const settingsLoads = yield* Ref.make(0);
    const projects = Array.from({ length: 40 }, (_, index) =>
      makeProject({
        id: ProjectId.make(`project:page:${index.toString().padStart(2, "0")}`),
        title: `Project ${index}`,
        workspaceRoot: `/work/project-${index}`,
      }),
    );
    const testLayer = ProjectMcp.layer.pipe(
      Layer.provide(
        Layer.mock(ProjectService.ProjectService)({
          snapshot: Effect.succeed({ projects, updatedAt: now }),
        }),
      ),
      Layer.provide(
        Layer.mock(T3ProjectFileLoader.T3ProjectFileLoader)({
          load: (workspaceRoot) =>
            Ref.update(projectFileLoads, (current) => [...current, workspaceRoot]).pipe(
              Effect.as(Option.none()),
            ),
        }),
      ),
      Layer.provide(
        Layer.mock(ServerSettingsService.ServerSettingsService)({
          getSettings: Ref.updateAndGet(settingsLoads, (count) => count + 1).pipe(
            Effect.as({ defaultThreadEnvMode: "local" } as ServerSettings),
          ),
        }),
      ),
      Layer.provide(Layer.mock(SourceControlRepositoryService.SourceControlRepositoryService)({})),
      Layer.provide(Layer.mock(ThreadManagementService)({})),
      Layer.provide(NodeServices.layer),
    );

    yield* Effect.gen(function* () {
      const service = yield* ProjectMcpService;
      const page = yield* service.list(scope, { cursor: 10, limit: 5 });
      expect(page).toMatchObject({ nextCursor: 15, totalCount: 40 });
      expect(page.projects.map((project) => project.id)).toEqual(
        projects.slice(10, 15).map((project) => project.id),
      );
      expect(page.projects.every((project) => !("scripts" in project))).toBe(true);
      expect(yield* Ref.get(projectFileLoads)).toEqual(
        projects.slice(10, 15).map((project) => project.workspaceRoot),
      );
      expect(yield* Ref.get(settingsLoads)).toBe(1);
    }).pipe(Effect.provide(testLayer));
  }),
);

it.effect("serializes overlapping create retries with the same idempotency key", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make<Project | null>(null);
    const cloneCalls = yield* Ref.make(0);
    const createCalls = yield* Ref.make(0);
    const createEntered = yield* Deferred.make<void>();
    const allowCreate = yield* Deferred.make<void>();
    const testLayer = ProjectMcp.layer.pipe(
      Layer.provide(
        Layer.mock(ProjectService.ProjectService)({
          getById: () => Ref.get(state).pipe(Effect.map(Option.fromNullishOr)),
          create: (input) =>
            Effect.gen(function* () {
              yield* Ref.update(createCalls, (count) => count + 1);
              yield* Deferred.succeed(createEntered, undefined);
              yield* Deferred.await(allowCreate);
              const created = makeProject({
                id: input.projectId,
                title: input.title,
                workspaceRoot: input.workspaceRoot,
              });
              yield* Ref.set(state, created);
              return created;
            }),
        }),
      ),
      Layer.provide(
        Layer.mock(T3ProjectFileLoader.T3ProjectFileLoader)({
          load: () => Effect.succeed(Option.none()),
        }),
      ),
      Layer.provide(
        Layer.mock(ServerSettingsService.ServerSettingsService)({
          getSettings: Effect.succeed({ defaultThreadEnvMode: "local" } as ServerSettings),
        }),
      ),
      Layer.provide(
        Layer.mock(SourceControlRepositoryService.SourceControlRepositoryService)({
          cloneRepository: () =>
            Ref.update(cloneCalls, (count) => count + 1).pipe(
              Effect.as({
                cwd: "/work/overlap",
                remoteUrl: "https://example.com/acme/repo.git",
                repository: null,
              }),
            ),
        }),
      ),
      Layer.provide(Layer.mock(ThreadManagementService)({})),
      Layer.provide(NodeServices.layer),
    );
    const input = {
      title: "Overlapping clone",
      source: {
        type: "clone" as const,
        destinationPath: "/work/overlap",
        remoteUrl: "https://example.com/acme/repo.git",
      },
      clientRequestId: "overlapping-create",
    };

    yield* Effect.gen(function* () {
      const service = yield* ProjectMcpService;
      const first = yield* Effect.forkChild(service.create(scope, input), {
        startImmediately: true,
      });
      yield* Deferred.await(createEntered);
      const second = yield* Effect.forkChild(service.create(scope, input), {
        startImmediately: true,
      });
      yield* Deferred.succeed(allowCreate, undefined);
      const [firstResult, secondResult] = yield* Effect.all([
        Fiber.join(first),
        Fiber.join(second),
      ]);
      expect(firstResult.id).toBe(secondResult.id);
      expect(yield* Ref.get(cloneCalls)).toBe(1);
      expect(yield* Ref.get(createCalls)).toBe(1);
    }).pipe(Effect.provide(testLayer));
  }),
);

it.effect("retries registration after a completed clone without changing the project id", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make<Project | null>(null);
    const cloneCalls = yield* Ref.make(0);
    const createCalls = yield* Ref.make(0);
    const testLayer = ProjectMcp.layer.pipe(
      Layer.provide(
        Layer.mock(ProjectService.ProjectService)({
          getById: () => Ref.get(state).pipe(Effect.map(Option.fromNullishOr)),
          create: (input) =>
            Ref.updateAndGet(createCalls, (count) => count + 1).pipe(
              Effect.flatMap((attempt) =>
                attempt === 1
                  ? Effect.fail(
                      new ProjectService.ProjectOperationError({
                        operation: "dispatch-project-command",
                        projectId: input.projectId,
                        cause: "registration unavailable",
                      }),
                    )
                  : Effect.sync(() =>
                      makeProject({
                        id: input.projectId,
                        title: input.title,
                        workspaceRoot: input.workspaceRoot,
                      }),
                    ).pipe(Effect.tap((project) => Ref.set(state, project))),
              ),
            ),
        }),
      ),
      Layer.provide(
        Layer.mock(T3ProjectFileLoader.T3ProjectFileLoader)({
          load: () => Effect.succeed(Option.none()),
        }),
      ),
      Layer.provide(
        Layer.mock(ServerSettingsService.ServerSettingsService)({
          getSettings: Effect.succeed({ defaultThreadEnvMode: "local" } as ServerSettings),
        }),
      ),
      Layer.provide(
        Layer.mock(SourceControlRepositoryService.SourceControlRepositoryService)({
          cloneRepository: () =>
            Ref.update(cloneCalls, (count) => count + 1).pipe(
              Effect.as({
                cwd: "/work/recovered-clone",
                remoteUrl: "https://example.com/acme/repo.git",
                repository: null,
              }),
            ),
        }),
      ),
      Layer.provide(Layer.mock(ThreadManagementService)({})),
      Layer.provide(NodeServices.layer),
    );
    const input = {
      title: "Recovered clone",
      source: {
        type: "clone" as const,
        destinationPath: "/work/recovered-clone",
        remoteUrl: "https://example.com/acme/repo.git",
      },
      clientRequestId: "retry-registration",
    };

    yield* Effect.gen(function* () {
      const service = yield* ProjectMcpService;
      const firstFailure = yield* service.create(scope, input).pipe(Effect.flip);
      expect(firstFailure).toBeInstanceOf(ProjectMcpFailure);
      const retried = yield* service.create(scope, input);
      expect(retried.id).toBe(
        ProjectId.make("project:mcp:provider-session-project-mcp:retry-registration"),
      );
      expect(yield* Ref.get(cloneCalls)).toBe(2);
      expect(yield* Ref.get(createCalls)).toBe(2);
    }).pipe(Effect.provide(testLayer));
  }),
);
