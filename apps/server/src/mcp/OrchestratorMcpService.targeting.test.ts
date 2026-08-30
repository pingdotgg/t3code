import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
  type Project,
  type ServerProvider,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";

import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { ScheduledTaskService } from "../scheduledTasks/ScheduledTaskService.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import * as OrchestratorMcp from "./OrchestratorMcpService.ts";

const parentProjectId = ProjectId.make("project:mcp-parent");
const targetProjectId = ProjectId.make("project:mcp-target");
const nestedProjectId = ProjectId.make("project:mcp-nested-target");
const parentThreadId = ThreadId.make("thread:mcp-parent");
const targetThreadId = ThreadId.make("thread:mcp-target");
const providerInstanceId = ProviderInstanceId.make("codex");
const nowIso = "2026-08-29T12:00:00.000Z" as const;
const now = DateTime.makeUnsafe(nowIso);

const scope: McpInvocationScope = {
  environmentId: EnvironmentId.make("environment:mcp-project-targeting"),
  threadId: parentThreadId,
  providerSessionId: "provider-session:mcp-project-targeting",
  providerInstanceId,
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
};

const targetProject = {
  id: targetProjectId,
  title: "Target project",
  workspaceRoot: "/target/project",
  repositoryIdentity: null,
  faviconPath: null,
  defaultModelSelection: null,
  defaultThreadEnvMode: "worktree",
  scripts: [],
  createdAt: nowIso,
  updatedAt: nowIso,
  deletedAt: null,
} satisfies Project;

const parentProject = {
  ...targetProject,
  id: parentProjectId,
  title: "Parent project",
  workspaceRoot: "/caller/project",
} satisfies Project;

const fakeGitHandle = (cwd: string): VcsDriverRegistry.VcsDriverHandle => {
  const target = cwd.startsWith("/target/");
  const rootPath = target
    ? "/target/project"
    : cwd === "/caller/worktree"
      ? "/caller/worktree"
      : "/caller/project";
  return {
    kind: "git",
    repository: {
      kind: "git",
      rootPath,
      metadataPath: target ? "/target/project/.git" : "/caller/project/.git",
      freshness: { source: "live-local", observedAt: now, expiresAt: Option.none() },
    },
    driver: {
      execute: ({ cwd: executionCwd }: { readonly cwd: string }) =>
        Effect.succeed({
          exitCode: 0,
          stdout: executionCwd.startsWith("/target/") ? "target-main\n" : "caller-branch\n",
          stderr: "",
          stdoutTruncated: false,
          stderrTruncated: false,
        }),
    } as never,
  };
};

const provider = {
  instanceId: providerInstanceId,
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: "test",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-08-29T12:00:00.000Z",
  models: [{ slug: "gpt-test", name: "GPT Test", isCustom: false, capabilities: null }],
  slashCommands: [],
  skills: [],
} satisfies ServerProvider;

function projection(input: {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly worktreePath: string | null;
  readonly active?: boolean;
}): OrchestrationV2ThreadProjection {
  const runId = RunId.make(`run:${input.threadId}`);
  return {
    thread: {
      id: input.threadId,
      projectId: input.projectId,
      title: input.title,
      createdBy: "agent",
      creationSource: "mcp",
      modelSelection: { instanceId: providerInstanceId, model: "gpt-test" },
      runtimeMode: input.threadId === parentThreadId ? "full-access" : "approval-required",
      interactionMode: "default",
      branch: "caller-branch",
      worktreePath: input.worktreePath,
      lineage: {
        parentThreadId: null,
        relationshipToParent: null,
        rootThreadId: input.threadId,
      },
      archivedAt: null,
      deletedAt: null,
      providerInstanceId,
      createdAt: now,
      updatedAt: now,
    },
    runs: input.active
      ? [
          {
            id: runId,
            ordinal: 1,
            status: "running",
            rootNodeId: NodeId.make(`node:${input.threadId}`),
            providerInstanceId,
            modelSelection: { instanceId: providerInstanceId, model: "gpt-test" },
            requestedAt: now,
            startedAt: now,
            completedAt: null,
          } as never,
        ]
      : [],
    visibleTurnItems: [],
    runtimeRequests: [],
    messages: [],
    contextTransfers: [],
    subagents: [],
    updatedAt: now,
  } as unknown as OrchestrationV2ThreadProjection;
}

const parent = projection({
  threadId: parentThreadId,
  projectId: parentProjectId,
  title: "Parent",
  worktreePath: "/caller/worktree",
  active: true,
});

const target = projection({
  threadId: targetThreadId,
  projectId: targetProjectId,
  title: "Target",
  worktreePath: null,
});

const commonDependencies = Layer.mergeAll(
  NodeServices.layer,
  Layer.succeed(
    FileSystem.FileSystem,
    FileSystem.makeNoop({ realPath: (path) => Effect.succeed(path) }),
  ),
  Layer.mock(ProviderRegistry)({ getProviders: Effect.succeed([provider]) }),
  Layer.mock(ProjectService.ProjectService)({
    getById: (projectId) =>
      Effect.succeed(
        projectId === targetProjectId
          ? Option.some(targetProject)
          : projectId === parentProjectId
            ? Option.some(parentProject)
            : Option.none(),
      ),
  }),
  Layer.mock(ScheduledTaskService)({}),
  Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
    detect: ({ cwd }) => Effect.succeed(fakeGitHandle(cwd)),
  }),
);

describe("OrchestratorMcpService project targeting", () => {
  it.effect(
    "launches cross-project threads at the target root unless a workspace is explicit",
    () =>
      Effect.gen(function* () {
        const launches = yield* Ref.make<ReadonlyArray<ThreadLaunch.ThreadLaunchInput>>([]);
        const launchLayer = Layer.mock(ThreadLaunch.ThreadLaunchService)({
          launch: (input) =>
            Ref.update(launches, (all) => [...all, input]).pipe(
              Effect.as({
                threadId: input.threadId!,
                projection: {
                  ...target,
                  thread: {
                    ...target.thread,
                    id: input.threadId!,
                    title: input.title,
                    modelSelection: input.modelSelection,
                    runtimeMode: input.runtimeMode,
                    interactionMode: input.interactionMode,
                  },
                },
                resumed: false,
                initialMessageRunId:
                  input.initialMessage === undefined ? null : (target.runs.at(-1)?.id ?? null),
              }),
            ),
        });
        const dependencies = Layer.mergeAll(
          commonDependencies,
          launchLayer,
          Layer.mock(ThreadManagementService)({
            getThreadProjection: () => Effect.succeed(parent),
            dispatch: () => Effect.succeed({} as never),
            recordServerCreatedThread: () => Effect.succeed({} as never),
          }),
        );

        const result = yield* Effect.gen(function* () {
          const service = yield* OrchestratorMcp.OrchestratorMcpService;
          return yield* service.createThreads(scope, {
            clientRequestId: "cross-project-launch",
            threads: [
              { prompt: "Reuse the current checkout" },
              { projectId: targetProjectId, prompt: "Use the project root" },
              {
                projectId: targetProjectId,
                prompt: "Create a worktree",
                workspaceStrategy: {
                  type: "new_worktree",
                  baseRef: "trunk",
                  startFromOrigin: false,
                },
              },
            ],
          });
        }).pipe(Effect.provide(OrchestratorMcp.layer.pipe(Layer.provide(dependencies))));

        assert.deepEqual(
          (yield* Ref.get(launches)).map((launch) => ({
            projectId: launch.projectId,
            workspaceStrategy: launch.workspaceStrategy,
            modelSelection: launch.modelSelection,
            runtimeMode: launch.runtimeMode,
          })),
          [
            {
              projectId: parentProjectId,
              workspaceStrategy: {
                type: "existing_worktree",
                worktreePath: "/caller/worktree",
                branch: "caller-branch",
              },
              modelSelection: parent.thread.modelSelection,
              runtimeMode: parent.thread.runtimeMode,
            },
            {
              projectId: targetProjectId,
              workspaceStrategy: { type: "root", branch: "target-main" },
              modelSelection: parent.thread.modelSelection,
              runtimeMode: parent.thread.runtimeMode,
            },
            {
              projectId: targetProjectId,
              workspaceStrategy: { type: "worktree", baseRef: "trunk", startFromOrigin: false },
              modelSelection: parent.thread.modelSelection,
              runtimeMode: parent.thread.runtimeMode,
            },
          ],
        );
        assert.deepEqual(
          result.threads.map((thread) => thread.projectId),
          [parentProjectId, targetProjectId, targetProjectId],
        );
      }),
  );

  it.effect("routes existing thread operations through the explicitly selected project", () =>
    Effect.gen(function* () {
      const routedProjectIds = yield* Ref.make<ReadonlyArray<ProjectId>>([]);
      const recordProject = (projectId: ProjectId) =>
        Ref.update(routedProjectIds, (all) => [...all, projectId]);
      const dependencies = Layer.mergeAll(
        commonDependencies,
        Layer.mock(ThreadLaunch.ThreadLaunchService)({}),
        Layer.mock(ThreadManagementService)({
          getThreadProjection: () => Effect.succeed(parent),
          getProjectThread: ({ projectId }) => recordProject(projectId).pipe(Effect.as(target)),
          listProjectThreads: ({ projectId }) => recordProject(projectId).pipe(Effect.as([])),
          sendToThread: ({ projectId }) =>
            recordProject(projectId).pipe(
              Effect.as({
                run: { id: RunId.make("run:send"), status: "running" },
                delivery: "started",
              } as never),
            ),
          waitForThread: ({ projectId }) =>
            recordProject(projectId).pipe(
              Effect.as({ threadId: targetThreadId, run: null, timedOut: false }),
            ),
          interruptThread: ({ projectId }) =>
            recordProject(projectId).pipe(Effect.as({ type: "no_active_run" })),
        }),
      );

      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcp.OrchestratorMcpService;
        yield* service.listThreads(scope, { projectId: targetProjectId });
        yield* service.readThread(scope, { projectId: targetProjectId, threadId: targetThreadId });
        yield* service.sendToThread(scope, {
          projectId: targetProjectId,
          threadId: targetThreadId,
          message: "Continue",
        });
        yield* service.waitForThread(scope, {
          projectId: targetProjectId,
          threadId: targetThreadId,
        });
        yield* service.interruptThread(scope, {
          projectId: targetProjectId,
          threadId: targetThreadId,
        });
      }).pipe(Effect.provide(OrchestratorMcp.layer.pipe(Layer.provide(dependencies))));

      assert.deepEqual(yield* Ref.get(routedProjectIds), [
        targetProjectId,
        targetProjectId,
        targetProjectId,
        targetProjectId,
        targetProjectId,
        targetProjectId,
        targetProjectId,
        targetProjectId,
      ]);
    }),
  );

  it.effect("accepts only canonical Git workspaces on their actual branch", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const vcsProcess = yield* VcsProcess.VcsProcess;
        const tempRoot = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "orchestrator-mcp-workspaces-",
        });
        const repositoryRoot = path.join(tempRoot, "repository");
        const siblingWorktree = path.join(tempRoot, "feature-worktree");
        const linkedWorktree = path.join(tempRoot, "linked-worktree");
        const nestedProjectRoot = path.join(repositoryRoot, "packages", "nested-project");
        const otherRepository = path.join(tempRoot, "other-repository");
        const plainDirectory = path.join(tempRoot, "plain-directory");

        const git = (cwd: string, args: ReadonlyArray<string>) =>
          vcsProcess.run({
            operation: "OrchestratorMcpService.targeting.test",
            command: "git",
            cwd,
            args,
            timeoutMs: 10_000,
          });
        const initializeRepository = (cwd: string) =>
          Effect.gen(function* () {
            yield* fileSystem.makeDirectory(cwd);
            yield* git(cwd, ["init", "--initial-branch=main"]);
            yield* git(cwd, ["config", "user.email", "mcp-test@example.com"]);
            yield* git(cwd, ["config", "user.name", "MCP Test"]);
            yield* fileSystem.writeFileString(path.join(cwd, "README.md"), "workspace test\n");
            yield* git(cwd, ["add", "README.md"]);
            yield* git(cwd, ["commit", "-m", "initial"]);
          });

        yield* initializeRepository(repositoryRoot);
        yield* fileSystem.makeDirectory(nestedProjectRoot, { recursive: true });
        yield* git(repositoryRoot, ["worktree", "add", "-b", "feature", siblingWorktree]);
        yield* fileSystem.symlink(siblingWorktree, linkedWorktree);
        const canonicalSiblingWorktree = yield* fileSystem.realPath(siblingWorktree);
        yield* initializeRepository(otherRepository);
        yield* fileSystem.makeDirectory(plainDirectory);

        const project = {
          ...targetProject,
          workspaceRoot: repositoryRoot,
        } satisfies Project;
        const nestedProject = {
          ...project,
          id: nestedProjectId,
          title: "Nested project",
          workspaceRoot: nestedProjectRoot,
        } satisfies Project;
        const launches = yield* Ref.make<ReadonlyArray<ThreadLaunch.ThreadLaunchInput>>([]);
        const dependencies = Layer.mergeAll(
          NodeServices.layer,
          Layer.mock(ProviderRegistry)({ getProviders: Effect.succeed([provider]) }),
          Layer.mock(ProjectService.ProjectService)({
            getById: (projectId) =>
              Effect.succeed(Option.some(projectId === nestedProjectId ? nestedProject : project)),
          }),
          Layer.mock(ScheduledTaskService)({}),
          Layer.mock(ThreadLaunch.ThreadLaunchService)({
            launch: (input) =>
              Ref.update(launches, (all) => [...all, input]).pipe(
                Effect.as({
                  threadId: input.threadId!,
                  projection: {
                    ...target,
                    thread: {
                      ...target.thread,
                      id: input.threadId!,
                      projectId: input.projectId,
                      branch: input.workspaceStrategy.branch ?? null,
                      worktreePath:
                        input.workspaceStrategy.type === "existing_worktree"
                          ? input.workspaceStrategy.worktreePath
                          : null,
                    },
                  },
                  resumed: false,
                  initialMessageRunId: null,
                }),
              ),
          }),
          Layer.mock(ThreadManagementService)({
            getThreadProjection: () => Effect.succeed(parent),
            dispatch: () => Effect.succeed({} as never),
            recordServerCreatedThread: () => Effect.succeed({} as never),
          }),
          realVcsDriverRegistryLayer,
        );

        const create = (
          clientRequestId: string,
          workspaceStrategy:
            | {
                readonly type: "root";
                readonly branch?: string;
              }
            | {
                readonly type: "existing_worktree";
                readonly worktreePath: string;
                readonly branch?: string;
              }
            | undefined,
          projectId: ProjectId = targetProjectId,
        ) =>
          Effect.gen(function* () {
            const service = yield* OrchestratorMcp.OrchestratorMcpService;
            return yield* service.createThreads(scope, {
              clientRequestId,
              threads: [
                {
                  projectId,
                  ...(workspaceStrategy === undefined ? {} : { workspaceStrategy }),
                },
              ],
            });
          }).pipe(Effect.provide(OrchestratorMcp.layer.pipe(Layer.provide(dependencies))));

        yield* create("existing-sibling", {
          type: "existing_worktree",
          worktreePath: siblingWorktree,
          branch: "feature",
        });
        yield* create("existing-symlink", {
          type: "existing_worktree",
          worktreePath: linkedWorktree,
          branch: "feature",
        });
        yield* create("root-actual-branch", { type: "root", branch: "main" });
        yield* create("nested-project-default-root", undefined, nestedProjectId);

        const accepted = yield* Ref.get(launches);
        assert.deepEqual(
          accepted.map((launch) => launch.workspaceStrategy),
          [
            {
              type: "existing_worktree",
              worktreePath: canonicalSiblingWorktree,
              branch: "feature",
            },
            {
              type: "existing_worktree",
              worktreePath: canonicalSiblingWorktree,
              branch: "feature",
            },
            { type: "root", branch: "main" },
            { type: "root", branch: "main" },
          ],
        );

        for (const [clientRequestId, workspaceStrategy] of [
          [
            "existing-other-repository",
            { type: "existing_worktree", worktreePath: otherRepository },
          ],
          ["existing-plain-directory", { type: "existing_worktree", worktreePath: plainDirectory }],
          [
            "existing-wrong-branch",
            { type: "existing_worktree", worktreePath: siblingWorktree, branch: "main" },
          ],
          ["root-wrong-branch", { type: "root", branch: "feature" }],
        ] as const) {
          const error = yield* create(clientRequestId, workspaceStrategy).pipe(Effect.flip);
          assert.equal(error.code, "invalid_request");
        }
        assert.equal((yield* Ref.get(launches)).length, 4);
      }).pipe(Effect.provide(realVcsInfrastructureLayer)),
    ),
  );
});

const realVcsProcessLayer = VcsProcess.layer.pipe(Layer.provide(NodeServices.layer));
const realVcsDriverRegistryLayer = VcsDriverRegistry.layer.pipe(
  Layer.provide(realVcsProcessLayer),
  Layer.provide(NodeServices.layer),
);
const realVcsInfrastructureLayer = Layer.mergeAll(
  NodeServices.layer,
  realVcsProcessLayer,
  realVcsDriverRegistryLayer,
);
