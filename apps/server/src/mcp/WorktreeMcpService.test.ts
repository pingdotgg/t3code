import { describe, expect, it, vi } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  EnvironmentId,
  GitManagerError,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
  type Project,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  WorktreeMcpHandoffInput,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import * as GitManager from "../git/GitManager.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import {
  OrchestratorDispatchError,
  OrchestratorProjectionError,
} from "../orchestration-v2/Orchestrator.ts";
import {
  ThreadManagementService,
  ThreadManagementThreadArchivedError,
  type ThreadManagementSendResult,
} from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import { VcsStatusBroadcaster } from "../vcs/VcsStatusBroadcaster.ts";
import type * as McpInvocationContext from "./McpInvocationContext.ts";
import { layer as worktreeMcpServiceLayer, WorktreeMcpService } from "./WorktreeMcpService.ts";

const environmentId = EnvironmentId.make("environment-worktree-test");
const threadId = ThreadId.make("thread-worktree-test");
const projectId = ProjectId.make("project-worktree-test");
const workspaceRoot = "/repo/project";

const makeScope = (
  capabilities: ReadonlySet<McpInvocationContext.McpCapability>,
): McpInvocationContext.McpInvocationScope => ({
  environmentId,
  threadId,
  providerSessionId: "provider-session-worktree-test",
  providerInstanceId: ProviderInstanceId.make("claudeAgent"),
  capabilities,
  issuedAt: 1,
});

interface ThreadFixture {
  readonly branch?: string | null;
  readonly worktreePath?: string | null;
  readonly archivedAt?: string | null;
  readonly deletedAt?: string | null;
}

const makeProjection = (overrides: ThreadFixture = {}): OrchestrationV2ThreadProjection =>
  ({
    thread: {
      id: threadId,
      projectId,
      title: "Worktree test thread",
      branch: null,
      worktreePath: null,
      archivedAt: null,
      deletedAt: null,
      ...overrides,
    },
  }) as OrchestrationV2ThreadProjection;

const shellFixture = (
  overrides: Partial<OrchestrationV2ThreadShell>,
): OrchestrationV2ThreadShell => {
  const timestamp = DateTime.makeUnsafe("2026-01-01T00:00:00.000Z");
  return {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId,
    title: "Worktree test thread",
    providerInstanceId: ProviderInstanceId.make("claudeAgent"),
    modelSelection: {
      instanceId: ProviderInstanceId.make("claudeAgent"),
      model: "test-model",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    lineage: {
      parentThreadId: null,
      relationshipToParent: null,
      rootThreadId: threadId,
    },
    forkedFrom: null,
    activeProviderThreadId: null,
    latestRunId: null,
    activeRunId: null,
    status: "idle",
    pendingRuntimeRequest: null,
    latestVisibleMessage: null,
    latestUserMessageAt: null,
    hasActionableProposedPlan: false,
    itemCount: 0,
    visibleItemCount: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    ...overrides,
  };
};

const project: Project = {
  id: projectId,
  title: "Worktree test project",
  workspaceRoot,
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  deletedAt: null,
} as Project;

interface HarnessOptions {
  readonly thread?: ThreadFixture | null;
  readonly threadReadError?: "projection" | "dispatch";
  readonly capabilities?: ReadonlySet<McpInvocationContext.McpCapability>;
  readonly currentBranch?: string | null;
  readonly notARepo?: boolean;
  readonly newWorktreesStartFromOrigin?: boolean;
  readonly setupScript?: "started" | "no-script" | "fails" | "dies";
  readonly dispatchFails?: boolean;
  readonly threadAfterFailedDispatch?: {
    readonly branch: string | null;
    readonly worktreePath: string | null;
  };
  readonly dispatchDies?: boolean;
  readonly dispatchInterrupts?: boolean;
  readonly dispatchGate?: Effect.Effect<void>;
  readonly threadAttachedOnRecheck?: boolean;
  readonly threadAttachedOnCall?: number;
  readonly threadArchivedOnRecheck?: boolean;
  readonly threadArchivedOnCall?: number;
  readonly threadDeletedOnCall?: number;
  readonly threadReadFailsOnRecheck?: boolean;
  readonly threadReadFailsAfterDispatch?: boolean;
  readonly threadReadFailsOnCall?: number;
  readonly continuation?: "queued" | "fails" | "dies";
  readonly projectMissing?: boolean;
  readonly projectReadFails?: boolean;
  readonly existingBranchWorktreePath?: string | null;
  readonly pathSemantics?: "win32" | "posix";
  readonly createWorktreeFails?: boolean;
  readonly fetchRemoteFails?: boolean;
  readonly resolveRemoteFails?: boolean;
  readonly resolvedCommits?: ReadonlyArray<string>;
  readonly resolveCommitGate?: Effect.Effect<void>;
  readonly removeWorktreeFails?: boolean;
  readonly createWorktreeGate?: Effect.Effect<void>;
  readonly refs?: ReadonlyArray<{
    readonly name: string;
    readonly current: boolean;
    readonly isDefault: boolean;
    readonly isRemote?: boolean;
    readonly worktreePath: string | null;
  }>;
  readonly worktrees?: ReadonlyArray<{
    readonly path: string;
    readonly refName: string | null;
  }>;
  readonly worktreeInventories?: Readonly<
    Record<
      string,
      {
        readonly repositoryCommonDir: string;
        readonly currentWorktreeRoot: string | null;
        readonly worktrees: ReadonlyArray<{
          readonly path: string;
          readonly refName: string | null;
        }>;
      }
    >
  >;
  readonly projectWorktreeRoot?: string;
  readonly workspaceAliases?: Readonly<Record<string, string>>;
  readonly projectWorkspaceRoot?: string;
  readonly useRealNonRepositoryWorkflow?: boolean;
  readonly workspaceStatuses?: Readonly<
    Record<string, { branch: string | null; dirty?: boolean; isRepo?: boolean }>
  >;
  readonly worktreeInventoryFailsFor?: ReadonlySet<string>;
  readonly localStatusFailsOnCall?: number;
  readonly localStatusFailure?: "typed" | "defect" | "interrupt";
  readonly dirtyOnLocalStatusCall?: number;
  readonly projectThreads?: ReadonlyArray<{
    readonly id: ThreadId;
    readonly title: string;
    readonly branch: string | null;
    readonly worktreePath: string | null;
    readonly status?: "idle" | "running";
    readonly active?: boolean;
  }>;
  readonly otherProjectThread?: {
    readonly projectId: ProjectId;
    readonly workspaceRoot: string;
    readonly id: ThreadId;
    readonly title: string;
    readonly branch: string | null;
    readonly worktreePath: string | null;
    readonly active?: boolean;
  };
  readonly archivedProjectThread?: {
    readonly id: ThreadId;
    readonly title: string;
    readonly branch: string | null;
    readonly worktreePath: string | null;
  };
  readonly switchRefFails?: boolean;
  readonly switchRefFailsAfterMutation?: boolean;
  readonly switchRefFailureBranch?: string | null;
  readonly switchRefRollbackFails?: boolean;
  readonly switchRefGate?: Effect.Effect<void>;
  readonly switchRefResultBranch?: string | null;
  readonly refChangeAfterSwitch?: string | null;
  readonly createRefFails?: boolean;
  readonly recordDispatchedBindings?: boolean;
}

const makeHarness = (options: HarnessOptions = {}) => {
  const thread = options.thread === undefined ? {} : options.thread;
  const scope = makeScope(options.capabilities ?? new Set(["preview", "worktree"]));
  const dispatchedWorktreePaths = new Map<ThreadId, string | null>();
  const dispatch = vi.fn((command: Parameters<ThreadManagementService["Service"]["dispatch"]>[0]) =>
    (options.dispatchGate ?? Effect.void).pipe(
      Effect.andThen(
        options.dispatchInterrupts
          ? (Effect.failCause(Cause.interrupt()) as never)
          : options.dispatchDies
            ? Effect.die(new Error("dispatch defect"))
            : options.dispatchFails
              ? (Effect.fail("simulated dispatch failure") as never)
              : Effect.sync(() => {
                  if (
                    options.recordDispatchedBindings === true &&
                    command.type === "thread.metadata.update" &&
                    command.threadId !== undefined
                  ) {
                    dispatchedWorktreePaths.set(command.threadId, command.worktreePath ?? null);
                  }
                  return { sequence: 1, storedEvents: [] };
                }),
      ),
    ),
  );
  const listLocalBranchNames = vi.fn((_: string) =>
    Effect.succeed(
      options.existingBranchWorktreePath === undefined
        ? ["dev"]
        : ["dev", "feature/taken", "feature/taken-idle"],
    ),
  );
  const getThreadProjection = vi.fn((id: ThreadId) => {
    if (options.threadReadError === "dispatch") {
      return Effect.fail(
        new OrchestratorDispatchError({
          commandId: CommandId.make("command:test:read"),
          commandType: "thread.metadata.update",
        }),
      ) as never;
    }
    if (options.threadReadFailsOnCall === getThreadProjection.mock.calls.length) {
      return Effect.fail(
        new OrchestratorDispatchError({
          commandId: CommandId.make("command:test:targeted-read"),
          commandType: "thread.metadata.update",
        }),
      ) as never;
    }
    if (options.threadReadFailsOnRecheck === true && getThreadProjection.mock.calls.length > 1) {
      return Effect.fail(
        new OrchestratorDispatchError({
          commandId: CommandId.make("command:test:recheck"),
          commandType: "thread.metadata.update",
        }),
      ) as never;
    }
    if (options.threadReadFailsAfterDispatch === true && dispatch.mock.calls.length > 0) {
      return Effect.fail(
        new OrchestratorDispatchError({
          commandId: CommandId.make("command:test:post-dispatch-read"),
          commandType: "thread.metadata.update",
        }),
      ) as never;
    }
    if (
      options.threadArchivedOnCall !== undefined &&
      getThreadProjection.mock.calls.length >= options.threadArchivedOnCall &&
      thread !== null
    ) {
      return Effect.succeed(makeProjection({ ...thread, archivedAt: "2026-01-02T00:00:00.000Z" }));
    }
    if (
      options.threadDeletedOnCall !== undefined &&
      getThreadProjection.mock.calls.length >= options.threadDeletedOnCall &&
      thread !== null
    ) {
      return Effect.succeed(makeProjection({ ...thread, deletedAt: "2026-01-02T00:00:00.000Z" }));
    }
    if (
      options.threadAttachedOnCall !== undefined &&
      getThreadProjection.mock.calls.length >= options.threadAttachedOnCall &&
      thread !== null
    ) {
      return Effect.succeed(
        makeProjection({ ...thread, worktreePath: "/worktrees/project/raced" }),
      );
    }
    if (
      options.threadAttachedOnRecheck === true &&
      getThreadProjection.mock.calls.length > 1 &&
      thread !== null
    ) {
      return Effect.succeed(
        makeProjection({ ...thread, worktreePath: "/worktrees/project/raced" }),
      );
    }
    if (
      options.threadArchivedOnRecheck === true &&
      getThreadProjection.mock.calls.length > 1 &&
      thread !== null
    ) {
      return Effect.succeed(makeProjection({ ...thread, archivedAt: "2026-01-02T00:00:00.000Z" }));
    }
    if (
      options.threadAfterFailedDispatch !== undefined &&
      dispatch.mock.calls.length > 0 &&
      thread !== null
    ) {
      return Effect.succeed(makeProjection({ ...thread, ...options.threadAfterFailedDispatch }));
    }
    if (id === threadId && thread !== null) {
      return Effect.succeed(
        makeProjection(
          dispatchedWorktreePaths.has(id)
            ? { ...thread, worktreePath: dispatchedWorktreePaths.get(id) ?? null }
            : thread,
        ),
      );
    }
    const projectThread = options.projectThreads?.find((item) => item.id === id);
    if (projectThread !== undefined) {
      const projection = makeProjection({
        branch: projectThread.branch,
        worktreePath: dispatchedWorktreePaths.get(id) ?? projectThread.worktreePath,
      });
      return Effect.succeed({
        ...projection,
        thread: {
          ...projection.thread,
          id: projectThread.id,
          title: projectThread.title,
          activeRunId: projectThread.active === true ? "run-active" : null,
        },
      });
    }
    return Effect.fail(new OrchestratorProjectionError({ threadId: id }));
  });
  const sendToThread = vi.fn((_: unknown) => {
    switch (options.continuation ?? "queued") {
      case "fails":
        return Effect.fail(
          new ThreadManagementThreadArchivedError({
            threadId,
          }),
        );
      case "dies":
        return Effect.die(new Error("send defect"));
      default:
        return Effect.succeed({ delivery: "queued" } as ThreadManagementSendResult);
    }
  });
  const configuredProject = {
    ...project,
    workspaceRoot: options.projectWorkspaceRoot ?? project.workspaceRoot,
  };
  const getById = vi.fn((id: ProjectId) =>
    options.projectReadFails
      ? (Effect.fail("simulated project read failure") as never)
      : Effect.succeed(
          id === projectId && options.projectMissing !== true
            ? Option.some(configuredProject)
            : id === options.otherProjectThread?.projectId
              ? Option.some({
                  ...project,
                  id,
                  workspaceRoot: options.otherProjectThread.workspaceRoot,
                })
              : Option.none(),
        ),
  );
  const projectThreadShells: Array<OrchestrationV2ThreadShell> = (
    options.projectThreads ?? [
      {
        id: threadId,
        title: "Worktree test thread",
        branch: thread?.branch ?? null,
        worktreePath: thread?.worktreePath ?? null,
      },
    ]
  ).map((item) =>
    shellFixture({
      id: item.id,
      projectId,
      title: item.title,
      branch: item.branch,
      worktreePath: item.worktreePath,
      status: item.status ?? (item.active === true ? "running" : "idle"),
      activeRunId: item.active === true ? RunId.make("run-active") : null,
      lineage: {
        parentThreadId: null,
        relationshipToParent: null,
        rootThreadId: item.id,
      },
    }),
  );
  if (options.otherProjectThread !== undefined) {
    projectThreadShells.push(
      shellFixture({
        id: options.otherProjectThread.id,
        projectId: options.otherProjectThread.projectId,
        title: options.otherProjectThread.title,
        branch: options.otherProjectThread.branch,
        worktreePath: options.otherProjectThread.worktreePath,
        activeRunId: options.otherProjectThread.active === true ? RunId.make("run-active") : null,
        status: options.otherProjectThread.active === true ? "running" : "idle",
        lineage: {
          parentThreadId: null,
          relationshipToParent: null,
          rootThreadId: options.otherProjectThread.id,
        },
      }),
    );
  }
  const archivedThreadShells =
    options.archivedProjectThread === undefined
      ? []
      : [
          shellFixture({
            id: options.archivedProjectThread.id,
            projectId,
            title: options.archivedProjectThread.title,
            branch: options.archivedProjectThread.branch,
            worktreePath: options.archivedProjectThread.worktreePath,
            activeRunId: null,
            archivedAt: DateTime.makeUnsafe("2026-01-02T00:00:00.000Z"),
            lineage: {
              parentThreadId: null,
              relationshipToParent: null,
              rootThreadId: options.archivedProjectThread.id,
            },
          }),
        ];
  const listProjectThreads = vi.fn((input: { readonly projectId: ProjectId }) =>
    Effect.succeed(projectThreadShells.filter((item) => item.projectId === input.projectId)),
  );
  const getShellSnapshot = vi.fn(() =>
    Effect.succeed({
      schemaVersion: 1,
      snapshotSequence: 1,
      threads: projectThreadShells.map((thread) => ({
        ...thread,
        worktreePath: dispatchedWorktreePaths.get(thread.id) ?? thread.worktreePath,
      })),
      archivedThreads: archivedThreadShells,
    } as never),
  );
  const removeWorktree = vi.fn((_: unknown) =>
    options.removeWorktreeFails
      ? (Effect.fail("simulated worktree removal failure") as never)
      : Effect.void,
  );
  const deleteLocalBranch = vi.fn((_: unknown) => Effect.void);
  const fetchRemote = vi.fn((_: unknown) =>
    options.fetchRemoteFails ? (Effect.fail("simulated fetch failure") as never) : Effect.void,
  );
  const resolveRemoteTrackingCommit = vi.fn((_: unknown) =>
    options.resolveRemoteFails
      ? (Effect.fail("simulated remote resolve failure") as never)
      : Effect.succeed({ commitSha: "abc123", remoteRefName: "origin/dev" }),
  );
  let resolveCommitCallCount = 0;
  const resolveCommit = vi.fn((_: unknown) => {
    const commitSha =
      options.resolvedCommits?.[
        Math.min(resolveCommitCallCount, (options.resolvedCommits?.length ?? 1) - 1)
      ] ?? "commit-test";
    resolveCommitCallCount += 1;
    return (options.resolveCommitGate ?? Effect.void).pipe(Effect.as({ commitSha }));
  });
  const workspaceStatuses = new Map(
    Object.entries(
      options.workspaceStatuses ?? {
        [workspaceRoot]: {
          branch: options.currentBranch === undefined ? "dev" : options.currentBranch,
        },
      },
    ),
  );
  const createWorktree = vi.fn(
    (input: { readonly newRefName?: string | undefined; readonly path: string | null }) =>
      options.createWorktreeFails
        ? (Effect.fail("simulated worktree creation failure") as never)
        : (options.createWorktreeGate ?? Effect.void).pipe(
            Effect.andThen(
              Effect.sync(() => {
                const worktreePath = input.path ?? `/worktrees/project/${input.newRefName}`;
                const refName = input.newRefName ?? "detached";
                workspaceStatuses.set(worktreePath, { branch: refName, dirty: false });
                return {
                  worktree: {
                    path: worktreePath,
                    refName,
                  },
                };
              }),
            ),
          ),
  );
  const listRefs = vi.fn((input: { readonly query?: string | undefined }) => {
    const refs =
      options.refs !== undefined
        ? options.refs.filter((ref) =>
            input.query === undefined ? true : ref.name.includes(input.query),
          )
        : options.existingBranchWorktreePath === undefined
          ? []
          : [
              {
                name: input.query ?? "",
                current: false,
                isDefault: false,
                worktreePath: options.existingBranchWorktreePath,
              },
            ];
    return Effect.succeed({
      refs,
      isRepo: true,
      hasPrimaryRemote: true,
      nextCursor: null,
      totalCount:
        options.refs?.length ?? (options.existingBranchWorktreePath === undefined ? 0 : 1),
    });
  });
  const configuredWorktrees =
    options.worktrees ??
    (options.refs ?? []).flatMap((ref) =>
      ref.worktreePath === null ? [] : [{ path: ref.worktreePath, refName: ref.name }],
    );
  const projectWorktreeRoot = options.projectWorktreeRoot ?? workspaceRoot;
  const listedWorktrees = configuredWorktrees.some(
    (worktree) => worktree.path === projectWorktreeRoot,
  )
    ? configuredWorktrees
    : [
        {
          path: projectWorktreeRoot,
          refName: options.currentBranch === undefined ? "dev" : options.currentBranch,
        },
        ...configuredWorktrees,
      ];
  const listWorktrees = vi.fn((cwd: string) =>
    options.worktreeInventoryFailsFor?.has(cwd) === true
      ? (Effect.fail("simulated worktree inventory failure") as never)
      : Effect.succeed(
          options.worktreeInventories?.[cwd] ?? {
            repositoryCommonDir: "/repo/.git",
            currentWorktreeRoot:
              options.workspaceAliases?.[cwd] ??
              listedWorktrees.find((worktree) => worktree.path === cwd)?.path ??
              (cwd.startsWith(`${projectWorktreeRoot}/`) ? projectWorktreeRoot : cwd),
            worktrees: listedWorktrees,
          },
        ),
  );
  let localStatusCallCount = 0;
  const localStatus = vi.fn((input: { readonly cwd: string }) => {
    localStatusCallCount += 1;
    if (localStatusCallCount === 1 && options.localStatusFailure === "defect") {
      return Effect.die(new Error("simulated local status defect"));
    }
    if (localStatusCallCount === 1 && options.localStatusFailure === "interrupt") {
      return Effect.interrupt;
    }
    if (localStatusCallCount === 1 && options.localStatusFailure === "typed") {
      return Effect.fail(
        new GitManagerError({
          operation: "WorktreeMcpService.test.localStatus",
          cwd: input.cwd,
          detail: "simulated local status failure",
        }),
      );
    }
    if (options.localStatusFailsOnCall === localStatusCallCount) {
      return Effect.fail("simulated local status failure") as never;
    }
    const current = workspaceStatuses.get(input.cwd);
    return Effect.succeed({
      isRepo: current?.isRepo ?? options.notARepo !== true,
      hasPrimaryRemote: true,
      isDefaultRef: false,
      refName:
        current === undefined
          ? options.currentBranch === undefined
            ? "dev"
            : options.currentBranch
          : current.branch,
      hasWorkingTreeChanges:
        options.dirtyOnLocalStatusCall === localStatusCallCount ? true : (current?.dirty ?? false),
      workingTree: { files: [], insertions: 0, deletions: 0 },
    });
  });
  let switchCallCount = 0;
  const switchRef = vi.fn((input: { readonly cwd: string; readonly refName: string }) =>
    (options.switchRefGate ?? Effect.void).pipe(
      Effect.andThen(
        Effect.suspend(() => {
          switchCallCount += 1;
          if (options.switchRefFailsAfterMutation === true && switchCallCount === 1) {
            workspaceStatuses.set(input.cwd, {
              branch:
                options.switchRefFailureBranch === undefined
                  ? input.refName
                  : options.switchRefFailureBranch,
              dirty: false,
            });
            return Effect.fail("simulated switch failure after mutation") as never;
          }
          if (
            options.switchRefFails === true ||
            (options.switchRefRollbackFails === true && switchCallCount > 1)
          ) {
            return Effect.fail("simulated switch failure") as never;
          }
          const resolvedBranch =
            options.switchRefResultBranch === undefined
              ? input.refName
              : options.switchRefResultBranch;
          workspaceStatuses.set(input.cwd, {
            branch:
              options.refChangeAfterSwitch === undefined
                ? resolvedBranch
                : options.refChangeAfterSwitch,
            dirty: false,
          });
          return Effect.succeed({ refName: resolvedBranch });
        }),
      ),
    ),
  );
  const createRef = vi.fn((_: unknown) =>
    options.createRefFails === true
      ? (Effect.fail("simulated create ref failure") as never)
      : Effect.succeed({ refName: "created" }),
  );
  const invalidateLocalStatus = vi.fn((_: string) => Effect.void);
  const refreshStatus = vi.fn((_: string) => Effect.die("refreshStatus stub"));
  const runForThread = vi.fn((input: { readonly worktreePath: string }) => {
    switch (options.setupScript ?? "started") {
      case "no-script":
        return Effect.succeed({ status: "no-script" } as const);
      case "dies":
        return Effect.die(new Error("setup runner defect"));
      case "fails":
        return Effect.fail(
          new ProjectSetupScriptRunner.ProjectSetupScriptProjectNotFoundError({
            threadId,
            worktreePath: input.worktreePath,
          }),
        );
      default:
        return Effect.succeed({
          status: "started",
          scriptId: "setup",
          scriptName: "Setup",
          terminalId: "setup-terminal",
          cwd: input.worktreePath,
        } as const);
    }
  });

  // Optional deterministic Path semantics: providing this BEFORE the general
  // mocks means the service resolves Path here rather than from NodeServices,
  // so absolute-path validation is testable independently of the host OS. The
  // The minimal per-platform semantics are inlined so the test does not
  // depend on the host's path module.
  const win32IsAbsolute = (value: string) => /^(?:[a-zA-Z]:[\\/]|[\\/])/.test(value);
  const posixIsAbsolute = (value: string) => value.startsWith("/");
  const serviceLayer =
    options.pathSemantics === undefined
      ? worktreeMcpServiceLayer
      : worktreeMcpServiceLayer.pipe(
          Layer.provide(
            Layer.succeed(Path.Path, {
              isAbsolute: options.pathSemantics === "win32" ? win32IsAbsolute : posixIsAbsolute,
              normalize: (value: string) => value,
              resolve: (value: string) => value,
            } as unknown as Path.Path),
          ),
        );
  const gitWorkflowLayer = options.useRealNonRepositoryWorkflow
    ? GitWorkflowService.layer.pipe(
        Layer.provide(
          Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
            detect: () => Effect.succeed(null),
            resolve: () => Effect.fail("not a repository") as never,
          }),
        ),
        Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
        Layer.provide(
          Layer.mock(GitManager.GitManager)({
            invalidateLocalStatus: () => Effect.void,
            invalidateRemoteStatus: () => Effect.void,
            invalidateStatus: () => Effect.void,
            resolvePullRequest: () => Effect.die("unexpected resolvePullRequest"),
            preparePullRequestThread: () => Effect.die("unexpected preparePullRequestThread"),
          }),
        ),
      )
    : Layer.mock(GitWorkflowService.GitWorkflowService)({
        listRefs,
        listWorktrees,
        listLocalBranchNames,
        localStatus,
        invalidateLocalStatus,
        fetchRemote,
        resolveRemoteTrackingCommit,
        resolveCommit,
        createWorktree,
        removeWorktree,
        deleteLocalBranch,
        switchRef,
        createRef,
      } satisfies Partial<GitWorkflowService.GitWorkflowService["Service"]>);
  const layer = serviceLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ThreadManagementService)({
          dispatch,
          getShellSnapshot,
          getThreadProjection,
          listProjectThreads,
          sendToThread,
        } satisfies Partial<ThreadManagementService["Service"]>),
        Layer.mock(ProjectService.ProjectService)({
          getById,
        } satisfies Partial<ProjectService.ProjectService["Service"]>),
        ServerSettings.layerTest({
          newWorktreesStartFromOrigin: options.newWorktreesStartFromOrigin ?? false,
        }),
        gitWorkflowLayer,
        Layer.mock(ProjectSetupScriptRunner.ProjectSetupScriptRunner)({
          runForThread,
        } satisfies Partial<ProjectSetupScriptRunner.ProjectSetupScriptRunner["Service"]>),
        Layer.mock(VcsStatusBroadcaster)({
          refreshStatus,
        } satisfies Partial<VcsStatusBroadcaster["Service"]>),
        NodeServices.layer,
      ),
    ),
  );

  return {
    layer,
    scope,
    dispatch,
    sendToThread,
    fetchRemote,
    resolveRemoteTrackingCommit,
    resolveCommit,
    createWorktree,
    removeWorktree,
    deleteLocalBranch,
    localStatus,
    listRefs,
    listWorktrees,
    listProjectThreads,
    switchRef,
    createRef,
    invalidateLocalStatus,
    refreshStatus,
    runForThread,
  };
};

const expectTypedFailure = (exit: Exit.Exit<unknown, unknown>, expected: object): void => {
  if (!Exit.isFailure(exit)) {
    expect.fail(`Expected a failure exit, got: ${JSON.stringify(exit)}`);
  }
  const reason = exit.cause.reasons[0];
  if (reason?._tag !== "Fail") {
    expect.fail(`Expected a typed Fail cause, got: ${reason?._tag ?? "no reason"}`);
  }
  expect(reason.error).toMatchObject(expected);
};

// Resolves the service once from the harness layer; used by tests that must
// make several calls against the SAME instance (the in-flight guard lives in
// the layer's closure, so a fresh layer per call would never see it).
const resolveService = (harness: ReturnType<typeof makeHarness>) =>
  Effect.gen(function* () {
    return yield* WorktreeMcpService;
  }).pipe(Effect.provide(harness.layer));

const runHandoff = (
  harness: ReturnType<typeof makeHarness>,
  input: Parameters<WorktreeMcpService["Service"]["handoff"]>[1],
) =>
  Effect.gen(function* () {
    const service = yield* WorktreeMcpService;
    return yield* service.handoff(harness.scope, input);
  }).pipe(Effect.provide(harness.layer));

const runStatus = (harness: ReturnType<typeof makeHarness>) =>
  Effect.gen(function* () {
    const service = yield* WorktreeMcpService;
    return yield* service.status(harness.scope);
  }).pipe(Effect.provide(harness.layer));

const runList = (
  harness: ReturnType<typeof makeHarness>,
  input: Parameters<WorktreeMcpService["Service"]["listWorktrees"]>[1] = {},
) =>
  Effect.gen(function* () {
    const service = yield* WorktreeMcpService;
    return yield* service.listWorktrees(harness.scope, input);
  }).pipe(Effect.provide(harness.layer));

const runCheckout = (
  harness: ReturnType<typeof makeHarness>,
  input: Parameters<WorktreeMcpService["Service"]["checkout"]>[1],
) =>
  Effect.gen(function* () {
    const service = yield* WorktreeMcpService;
    return yield* service.checkout(harness.scope, input);
  }).pipe(Effect.provide(harness.layer));

describe("t3_worktree_handoff", () => {
  it.effect("creates a worktree from the current branch and re-points the thread", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const result = yield* runHandoff(harness, { branch: "feature/handoff" });

      expect(result.branch).toBe("feature/handoff");
      expect(result.baseRef).toBe("dev");
      expect(result.startedFromOrigin).toBe(false);
      expect(result.worktreePath).toBe("/worktrees/project/feature/handoff");
      expect(result.setupScript).toMatchObject({ status: "started", scriptName: "Setup" });

      expect(harness.fetchRemote).not.toHaveBeenCalled();
      expect(harness.createWorktree).toHaveBeenCalledWith({
        cwd: workspaceRoot,
        refName: "dev",
        newRefName: "feature/handoff",
        baseRefName: "dev",
        path: null,
      });
      expect(harness.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "thread.metadata.update",
          threadId,
          branch: "feature/handoff",
          worktreePath: "/worktrees/project/feature/handoff",
          expectedWorktreePath: null,
        }),
      );
      expect(harness.runForThread).toHaveBeenCalledWith({
        threadId,
        projectId,
        projectCwd: workspaceRoot,
        worktreePath: "/worktrees/project/feature/handoff",
        project: { workspaceRoot, scripts: [] },
      });
    });
  });

  it.effect("skips the continuation when no continuationPrompt is given", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const result = yield* runHandoff(harness, { branch: "feature/no-continuation" });
      expect(result.continuation).toEqual({ status: "skipped" });
      expect(harness.sendToThread).not.toHaveBeenCalled();
    });
  });

  it.effect("queues the continuation prompt as the thread's next message", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const result = yield* runHandoff(harness, {
        branch: "feature/continue",
        continuationPrompt: "Keep fixing the login bug in the new worktree.",
      });

      expect(result.continuation).toEqual({ status: "scheduled", delivery: "queued" });
      expect(harness.sendToThread).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId,
          threadId,
          text: "Keep fixing the login bug in the new worktree.",
          mode: "queue",
          createdBy: "agent",
          creationSource: "mcp",
        }),
      );
      // The continuation must be durably queued before anything slower runs.
      expect(harness.sendToThread.mock.invocationCallOrder[0]).toBeLessThan(
        harness.runForThread.mock.invocationCallOrder[0]!,
      );
    });
  });

  it.effect("reports a continuation failure without failing the handoff", () => {
    const harness = makeHarness({ continuation: "fails" });
    return Effect.gen(function* () {
      const result = yield* runHandoff(harness, {
        branch: "feature/continue-fails",
        continuationPrompt: "Keep going.",
      });
      expect(result.continuation).toMatchObject({ status: "failed" });
      expect(result.worktreePath).toBe("/worktrees/project/feature/continue-fails");
      expect(harness.dispatch).toHaveBeenCalled();
    });
  });

  it.effect("reports a continuation defect without failing the handoff", () => {
    const harness = makeHarness({ continuation: "dies" });
    return Effect.gen(function* () {
      const result = yield* runHandoff(harness, {
        branch: "feature/continue-dies",
        continuationPrompt: "Keep going.",
      });
      expect(result.continuation).toEqual({ status: "failed", detail: "send defect" });
      expect(result.setupScript).toMatchObject({ status: "started" });
    });
  });

  it.effect("does not queue a continuation when the thread update fails", () => {
    const harness = makeHarness({ dispatchFails: true });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        runHandoff(harness, {
          branch: "feature/dispatch-fails-continue",
          continuationPrompt: "Keep going.",
        }),
      );
      expectTypedFailure(exit, { _tag: "WorktreeMcpFailure", code: "operation_failed" });
      expect(harness.sendToThread).not.toHaveBeenCalled();
    });
  });

  it.effect("starts from origin and honors explicit baseRef and path", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const result = yield* runHandoff(harness, {
        branch: "feature/from-origin",
        baseRef: "dev",
        startFromOrigin: true,
        path: "/custom/worktree/location",
        runSetupScript: false,
      });

      expect(harness.fetchRemote).toHaveBeenCalledWith({
        cwd: workspaceRoot,
        remoteName: "origin",
      });
      expect(harness.resolveRemoteTrackingCommit).toHaveBeenCalledWith({
        cwd: workspaceRoot,
        refName: "dev",
        fallbackRemoteName: "origin",
      });
      expect(harness.createWorktree).toHaveBeenCalledWith({
        cwd: workspaceRoot,
        refName: "abc123",
        newRefName: "feature/from-origin",
        baseRefName: "dev",
        path: "/custom/worktree/location",
      });
      // localStatus is always consulted now (repo pre-check), but its branch
      // must not override the explicit baseRef.
      expect(harness.localStatus).toHaveBeenCalled();
      expect(harness.runForThread).not.toHaveBeenCalled();
      expect(result.worktreePath).toBe("/custom/worktree/location");
      expect(result.startedFromOrigin).toBe(true);
      expect(result.setupScript).toEqual({ status: "skipped" });
    });
  });

  it.effect("uses the server setting for startFromOrigin when unspecified", () => {
    const harness = makeHarness({ newWorktreesStartFromOrigin: true });
    return Effect.gen(function* () {
      const result = yield* runHandoff(harness, { branch: "feature/settings-origin" });
      expect(result.startedFromOrigin).toBe(true);
      expect(harness.fetchRemote).toHaveBeenCalled();
    });
  });

  it.effect("moves an attached thread into a newly created worktree", () => {
    const harness = makeHarness({
      thread: { branch: "feature/existing", worktreePath: "/worktrees/project/existing" },
      refs: [
        {
          name: "feature/existing",
          current: true,
          isDefault: false,
          worktreePath: "/worktrees/project/existing",
        },
      ],
      workspaceStatuses: {
        "/worktrees/project/existing": { branch: "feature/existing" },
      },
    });
    return Effect.gen(function* () {
      const result = yield* runHandoff(harness, { branch: "feature/second" });
      expect(result.worktreePath).toBe("/worktrees/project/feature/second");
      expect(harness.dispatch).toHaveBeenCalledWith({
        type: "thread.metadata.update",
        commandId: expect.any(String),
        threadId,
        branch: "feature/second",
        worktreePath: "/worktrees/project/feature/second",
        expectedBranch: "feature/existing",
        expectedWorktreePath: "/worktrees/project/existing",
        expectedArchived: false,
      });
    });
  });

  it.effect("fails when the thread does not exist", () => {
    const harness = makeHarness({ thread: null });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(runHandoff(harness, { branch: "feature/missing" }));
      expectTypedFailure(exit, { _tag: "WorktreeMcpFailure", code: "thread_not_found" });
      expect(harness.createWorktree).not.toHaveBeenCalled();
    });
  });

  it.effect("treats a soft-deleted thread as not found", () => {
    const harness = makeHarness({ thread: { deletedAt: "2026-01-02T00:00:00.000Z" } });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(runHandoff(harness, { branch: "feature/deleted" }));
      expectTypedFailure(exit, { _tag: "WorktreeMcpFailure", code: "thread_not_found" });
      expect(harness.createWorktree).not.toHaveBeenCalled();
    });
  });

  it.effect("maps a non-projection orchestrator error to operation_failed", () => {
    const harness = makeHarness({ threadReadError: "dispatch" });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(runHandoff(harness, { branch: "feature/read-error" }));
      expectTypedFailure(exit, { _tag: "WorktreeMcpFailure", code: "operation_failed" });
      expect(harness.createWorktree).not.toHaveBeenCalled();
    });
  });

  it.effect("fails when the project does not exist", () => {
    const harness = makeHarness({ projectMissing: true });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(runHandoff(harness, { branch: "feature/no-project" }));
      expectTypedFailure(exit, { _tag: "WorktreeMcpFailure", code: "project_not_found" });
      expect(harness.createWorktree).not.toHaveBeenCalled();
    });
  });

  it.effect("maps a project read error to operation_failed", () => {
    const harness = makeHarness({ projectReadFails: true });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(runHandoff(harness, { branch: "feature/project-error" }));
      expectTypedFailure(exit, { _tag: "WorktreeMcpFailure", code: "operation_failed" });
      expect(harness.createWorktree).not.toHaveBeenCalled();
    });
  });

  it.effect("fails when the project workspace is not a git repository", () => {
    const harness = makeHarness({ notARepo: true });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(runHandoff(harness, { branch: "feature/no-repo" }));
      expectTypedFailure(exit, { _tag: "WorktreeMcpFailure", code: "invalid_request" });
      expect(harness.createWorktree).not.toHaveBeenCalled();
    });
  });

  it.effect("rejects an existing branch with an actionable error naming its checkout", () => {
    const harness = makeHarness({ existingBranchWorktreePath: "/elsewhere/checkout" });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(runHandoff(harness, { branch: "feature/taken" }));
      if (!Exit.isFailure(exit)) {
        return expect.fail("expected a failure exit");
      }
      const reason = exit.cause.reasons[0];
      expect(reason?._tag).toBe("Fail");
      const error = (reason as { readonly error: { code: string; message: string } }).error;
      expect(error.code).toBe("invalid_request");
      expect(error.message).toContain("feature/taken");
      expect(error.message).toContain("already exists");
      expect(error.message).toContain("/elsewhere/checkout");
      expect(harness.createWorktree).not.toHaveBeenCalled();
      expect(harness.fetchRemote).not.toHaveBeenCalled();
    });
  });

  it.effect("rejects an existing branch that is not checked out anywhere", () => {
    const harness = makeHarness({ existingBranchWorktreePath: null });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(runHandoff(harness, { branch: "feature/taken-idle" }));
      expectTypedFailure(exit, { _tag: "WorktreeMcpFailure", code: "invalid_request" });
      expect(harness.createWorktree).not.toHaveBeenCalled();
    });
  });

  it.effect("does not trip the pre-flight on similarly named branches", () => {
    const harness = makeHarness({ existingBranchWorktreePath: null });
    return Effect.gen(function* () {
      // "feature/taken" exists in the mock branch list; "feature/take" does
      // not, and a substring-based check would wrongly match it.
      const result = yield* runHandoff(harness, { branch: "feature/take" });
      expect(result.branch).toBe("feature/take");
      expect(harness.createWorktree).toHaveBeenCalledTimes(1);
    });
  });

  it.effect("rejects a non-repository workspace even when baseRef is explicit", () => {
    const harness = makeHarness({ notARepo: true });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        runHandoff(harness, { branch: "feature/no-repo-baseref", baseRef: "dev" }),
      );
      expectTypedFailure(exit, { _tag: "WorktreeMcpFailure", code: "invalid_request" });
      expect(harness.createWorktree).not.toHaveBeenCalled();
    });
  });

  it.effect("propagates an interrupted dispatch without rolling back the worktree", () => {
    const harness = makeHarness({ dispatchInterrupts: true });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(runHandoff(harness, { branch: "feature/dispatch-int" }));
      if (!Exit.isFailure(exit)) {
        return expect.fail("expected a failure exit");
      }
      // Whether the binding committed is unknown on interruption, so the
      // worktree must not be force-deleted and no typed failure is invented.
      expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
      expect(harness.removeWorktree).not.toHaveBeenCalled();
    });
  });

  it.effect("maps a worktree creation failure to operation_failed", () => {
    const harness = makeHarness({ createWorktreeFails: true });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(runHandoff(harness, { branch: "feature/create-fails" }));
      expectTypedFailure(exit, { _tag: "WorktreeMcpFailure", code: "operation_failed" });
      expect(harness.dispatch).not.toHaveBeenCalled();
      expect(harness.removeWorktree).not.toHaveBeenCalled();
    });
  });

  it.effect("maps an origin fetch failure to operation_failed", () => {
    const harness = makeHarness({ fetchRemoteFails: true });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        runHandoff(harness, { branch: "feature/fetch-fails", startFromOrigin: true }),
      );
      expectTypedFailure(exit, { _tag: "WorktreeMcpFailure", code: "operation_failed" });
      expect(harness.createWorktree).not.toHaveBeenCalled();
    });
  });

  it.effect("maps a remote-tracking resolve failure to operation_failed", () => {
    const harness = makeHarness({ resolveRemoteFails: true });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        runHandoff(harness, { branch: "feature/resolve-fails", startFromOrigin: true }),
      );
      expectTypedFailure(exit, { _tag: "WorktreeMcpFailure", code: "operation_failed" });
      expect(harness.createWorktree).not.toHaveBeenCalled();
    });
  });

  it.effect("removes the created worktree when the thread update dies with a defect", () => {
    const harness = makeHarness({ dispatchDies: true });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(runHandoff(harness, { branch: "feature/dispatch-defect" }));
      expectTypedFailure(exit, { _tag: "WorktreeMcpFailure", code: "operation_failed" });
      expect(harness.removeWorktree).toHaveBeenCalledWith({
        cwd: workspaceRoot,
        path: "/worktrees/project/feature/dispatch-defect",
        force: true,
      });
    });
  });

  it.effect("keeps a worktree whose binding committed before dispatch failed", () => {
    const worktreePath = "/worktrees/project/feature/committed-dispatch";
    const harness = makeHarness({
      dispatchFails: true,
      threadAfterFailedDispatch: {
        branch: "feature/committed-dispatch",
        worktreePath,
      },
    });
    return Effect.gen(function* () {
      const result = yield* runHandoff(harness, { branch: "feature/committed-dispatch" });
      expect(result.worktreePath).toBe(worktreePath);
      expect(harness.removeWorktree).not.toHaveBeenCalled();
    });
  });

  it.effect("preserves a new worktree when a failed binding outcome cannot be verified", () => {
    const harness = makeHarness({ dispatchFails: true, threadReadFailsOnCall: 3 });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(runHandoff(harness, { branch: "feature/unknown-dispatch" }));
      expectTypedFailure(exit, {
        _tag: "WorktreeMcpFailure",
        code: "partial_failure",
        partial: {
          workspacePath: "/worktrees/project/feature/unknown-dispatch",
          actualBranch: "feature/unknown-dispatch",
          rollback: "not_possible",
        },
      });
      expect(harness.removeWorktree).not.toHaveBeenCalled();
    });
  });

  it.effect("retains a created worktree whose HEAD changed before failed-binding cleanup", () => {
    const harness = makeHarness({
      dispatchFails: true,
      resolvedCommits: ["creation-commit", "concurrent-clean-commit"],
    });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        runHandoff(harness, { branch: "feature/concurrent-clean-commit" }),
      );
      expectTypedFailure(exit, {
        _tag: "WorktreeMcpFailure",
        code: "partial_failure",
        partial: { rollback: "not_possible" },
      });
      expect(harness.removeWorktree).not.toHaveBeenCalled();
    });
  });

  it.effect("retains the created worktree when the caller binding changes during creation", () => {
    const harness = makeHarness({ threadAttachedOnRecheck: true });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(runHandoff(harness, { branch: "feature/raced" }));
      expectTypedFailure(exit, {
        _tag: "WorktreeMcpFailure",
        code: "partial_failure",
        partial: { rollback: "not_possible" },
      });
      expect(harness.createWorktree).toHaveBeenCalledTimes(1);
      expect(harness.removeWorktree).not.toHaveBeenCalled();
      expect(harness.deleteLocalBranch).not.toHaveBeenCalled();
      expect(harness.dispatch).not.toHaveBeenCalled();
    });
  });

  it.effect("retains the created worktree when recheck ownership is unavailable", () => {
    const harness = makeHarness({ threadReadFailsOnRecheck: true });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(runHandoff(harness, { branch: "feature/recheck-fails" }));
      expectTypedFailure(exit, {
        _tag: "WorktreeMcpFailure",
        code: "partial_failure",
        partial: { rollback: "not_possible" },
      });
      expect(harness.removeWorktree).not.toHaveBeenCalled();
      expect(harness.dispatch).not.toHaveBeenCalled();
    });
  });

  it.effect("backs out when the thread is archived during worktree creation", () => {
    const harness = makeHarness({ threadArchivedOnRecheck: true });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(runHandoff(harness, { branch: "feature/archived-race" }));
      expectTypedFailure(exit, { _tag: "WorktreeMcpFailure", code: "invalid_request" });
      expect(harness.dispatch).not.toHaveBeenCalled();
      // The created worktree must not be left orphaned.
      expect(harness.removeWorktree).toHaveBeenCalledWith({
        cwd: workspaceRoot,
        path: "/worktrees/project/feature/archived-race",
        force: true,
      });
    });
  });

  it.effect("rejects a handoff for an archived thread", () => {
    const harness = makeHarness({ thread: { archivedAt: "2026-01-02T00:00:00.000Z" } });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(runHandoff(harness, { branch: "feature/archived" }));
      expectTypedFailure(exit, { _tag: "WorktreeMcpFailure", code: "invalid_request" });
      expect(harness.createWorktree).not.toHaveBeenCalled();
    });
  });

  it.effect("queues the continuation even when interrupted during the binding dispatch", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>();
      const dispatchStarted = yield* Deferred.make<void>();
      const harness = makeHarness({
        dispatchGate: Deferred.succeed(dispatchStarted, undefined).pipe(
          Effect.andThen(Deferred.await(gate)),
        ),
      });

      // Interrupt arrives while the metadata dispatch is in flight; the
      // binding-plus-continuation section must run to completion anyway so the
      // continuation is never lost between the commit and the queue.
      const fiber = yield* Effect.forkChild(
        runHandoff(harness, {
          branch: "feature/interrupted",
          continuationPrompt: "Keep going in the worktree.",
        }),
      );
      yield* Deferred.await(dispatchStarted);
      const interruption = yield* Effect.forkChild(Fiber.interrupt(fiber));
      yield* Effect.yieldNow;
      yield* Deferred.succeed(gate, undefined);
      yield* Fiber.await(fiber);
      yield* Fiber.join(interruption);

      expect(harness.dispatch).toHaveBeenCalledTimes(1);
      expect(harness.sendToThread).toHaveBeenCalledTimes(1);
      // The setup script must also survive the pending interrupt; otherwise
      // the continuation run starts in a worktree that was never set up.
      expect(harness.runForThread).toHaveBeenCalledTimes(1);
    }),
  );

  it.effect("still fails with a typed error when the rollback removal also fails", () => {
    const harness = makeHarness({ dispatchFails: true, removeWorktreeFails: true });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(runHandoff(harness, { branch: "feature/rollback-fails" }));
      expectTypedFailure(exit, {
        _tag: "WorktreeMcpFailure",
        code: "partial_failure",
        partial: { rollback: "failed" },
      });
      expect(harness.removeWorktree).toHaveBeenCalledTimes(1);
      expect(harness.deleteLocalBranch).not.toHaveBeenCalled();
    });
  });

  it.effect("retains the created branch after removing a failed handoff worktree", () => {
    const harness = makeHarness({ dispatchFails: true });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        runHandoff(harness, { branch: "feature/rollback-branch-fails" }),
      );
      expectTypedFailure(exit, { _tag: "WorktreeMcpFailure", code: "operation_failed" });
      expect(harness.removeWorktree).toHaveBeenCalledTimes(1);
      expect(harness.deleteLocalBranch).not.toHaveBeenCalled();
    });
  });

  it.effect("accepts a Windows drive path under win32 path semantics", () => {
    const harness = makeHarness({ pathSemantics: "win32" });
    return Effect.gen(function* () {
      const result = yield* runHandoff(harness, {
        branch: "feature/windows-path",
        path: "C:\\worktrees\\custom",
      });
      expect(result.worktreePath).toBe("C:\\worktrees\\custom");
      expect(harness.createWorktree).toHaveBeenCalledWith(
        expect.objectContaining({ path: "C:\\worktrees\\custom" }),
      );
    });
  });

  it.effect("rejects a Windows drive path under posix path semantics", () => {
    const harness = makeHarness({ pathSemantics: "posix" });
    return Effect.gen(function* () {
      // The schema-level pattern admits drive paths cross-platform; the
      // runtime check reflects the host the worktree would be created on.
      const exit = yield* Effect.exit(
        runHandoff(harness, { branch: "feature/windows-path", path: "C:\\worktrees\\custom" }),
      );
      expectTypedFailure(exit, { _tag: "WorktreeMcpFailure", code: "invalid_request" });
      expect(harness.createWorktree).not.toHaveBeenCalled();
    });
  });

  it.effect("releases the per-thread guard after a failed handoff", () => {
    const harness = makeHarness({ dispatchFails: true });
    return Effect.gen(function* () {
      const service = yield* resolveService(harness);

      const first = yield* Effect.exit(
        service.handoff(harness.scope, { branch: "feature/guard-1" }),
      );
      expectTypedFailure(first, { _tag: "WorktreeMcpFailure", code: "operation_failed" });
      // A leaked guard would surface as handoff_in_progress here.
      const second = yield* Effect.exit(
        service.handoff(harness.scope, { branch: "feature/guard-2" }),
      );
      expectTypedFailure(second, { _tag: "WorktreeMcpFailure", code: "operation_failed" });
      expect(harness.createWorktree).toHaveBeenCalledTimes(2);
    });
  });

  it.effect("retains a created worktree when checkout binds it before handoff admission", () =>
    Effect.gen(function* () {
      const targetPath = "/worktrees/project/handoff-checkout-race";
      const otherThreadId = ThreadId.make("thread-handoff-checkout-race");
      const createEntered = yield* Deferred.make<void>();
      const releaseCreate = yield* Deferred.make<void>();
      const harness = makeHarness({
        thread: { branch: "dev", worktreePath: null },
        refs: [
          {
            name: "dev",
            current: true,
            isDefault: true,
            worktreePath: workspaceRoot,
          },
          {
            name: "feature/handoff-checkout-race",
            current: false,
            isDefault: false,
            worktreePath: targetPath,
          },
        ],
        worktrees: [
          { path: workspaceRoot, refName: "dev" },
          { path: targetPath, refName: "feature/handoff-checkout-race" },
        ],
        workspaceStatuses: {
          [workspaceRoot]: { branch: "dev" },
          [targetPath]: { branch: "feature/handoff-checkout-race" },
        },
        projectThreads: [
          { id: threadId, title: "Handoff caller", branch: "dev", worktreePath: null },
          { id: otherThreadId, title: "Checkout caller", branch: "dev", worktreePath: null },
        ],
        recordDispatchedBindings: true,
        createWorktreeGate: Deferred.succeed(createEntered, undefined).pipe(
          Effect.andThen(Deferred.await(releaseCreate)),
        ),
      });
      const service = yield* resolveService(harness);

      return yield* Effect.gen(function* () {
        const handoffFiber = yield* Effect.forkChild(
          service.handoff(harness.scope, {
            branch: "feature/handoff-checkout-race",
            path: targetPath,
          }),
          { startImmediately: true },
        );
        yield* Deferred.await(createEntered);
        const checkout = yield* service.checkout(
          { ...harness.scope, threadId: otherThreadId },
          { target: { type: "worktree", path: targetPath } },
        );
        expect(checkout.current.workspacePath).toBe(targetPath);

        yield* Deferred.succeed(releaseCreate, undefined);
        const handoffExit = yield* Fiber.await(handoffFiber);
        expectTypedFailure(handoffExit, {
          _tag: "WorktreeMcpFailure",
          code: "partial_failure",
          partial: { workspacePath: targetPath, rollback: "not_possible" },
        });
        expect(harness.removeWorktree).not.toHaveBeenCalled();
        expect(harness.dispatch).toHaveBeenCalledTimes(1);
      }).pipe(Effect.ensuring(Deferred.succeed(releaseCreate, undefined)));
    }),
  );

  it.effect("fails when the worktree capability is missing", () => {
    const harness = makeHarness({ capabilities: new Set(["preview"]) });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(runHandoff(harness, { branch: "feature/no-capability" }));
      expectTypedFailure(exit, { _tag: "WorktreeMcpFailure", code: "capability_denied" });
    });
  });

  it.effect("serializes concurrent handoffs for the same thread", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>();
      const harness = makeHarness({ createWorktreeGate: Deferred.await(gate) });

      const service = yield* resolveService(harness);

      // First handoff acquires the per-thread guard and blocks on the gate.
      const first = yield* Effect.forkChild(
        Effect.exit(service.handoff(harness.scope, { branch: "feature/race-1" })),
      );
      yield* Effect.yieldNow;

      // Second handoff for the same thread must be refused while the first
      // is still in flight.
      const second = yield* Effect.exit(
        service.handoff(harness.scope, { branch: "feature/race-2" }),
      );
      expectTypedFailure(second, { _tag: "WorktreeMcpFailure", code: "handoff_in_progress" });

      yield* Deferred.succeed(gate, undefined);
      const firstExit = yield* Fiber.join(first);
      expect(Exit.isSuccess(firstExit)).toBe(true);
      expect(harness.createWorktree).toHaveBeenCalledTimes(1);
    }),
  );

  it.effect("removes the created worktree when the thread update fails", () => {
    const harness = makeHarness({ dispatchFails: true });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(runHandoff(harness, { branch: "feature/dispatch-fails" }));
      expectTypedFailure(exit, { _tag: "WorktreeMcpFailure", code: "operation_failed" });
      expect(harness.createWorktree).toHaveBeenCalledTimes(1);
      expect(harness.removeWorktree).toHaveBeenCalledWith({
        cwd: workspaceRoot,
        path: "/worktrees/project/feature/dispatch-fails",
        force: true,
      });
    });
  });

  it.effect("rejects a relative path", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        runHandoff(harness, { branch: "feature/relative-path", path: "worktrees/nested" }),
      );
      expectTypedFailure(exit, { _tag: "WorktreeMcpFailure", code: "invalid_request" });
      expect(harness.createWorktree).not.toHaveBeenCalled();
    });
  });

  it.effect("fails when baseRef is omitted and HEAD is detached", () => {
    const harness = makeHarness({ currentBranch: null });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(runHandoff(harness, { branch: "feature/detached" }));
      expectTypedFailure(exit, { _tag: "WorktreeMcpFailure", code: "invalid_request" });
    });
  });

  it.effect("reports setup script failure without failing the handoff", () => {
    const harness = makeHarness({ setupScript: "fails" });
    return Effect.gen(function* () {
      const result = yield* runHandoff(harness, { branch: "feature/setup-fails" });
      expect(result.setupScript.status).toBe("failed");
      expect(harness.dispatch).toHaveBeenCalled();
    });
  });

  it.effect("reports a setup script defect without failing the handoff", () => {
    const harness = makeHarness({ setupScript: "dies" });
    return Effect.gen(function* () {
      const result = yield* runHandoff(harness, { branch: "feature/setup-dies" });
      expect(result.setupScript).toEqual({ status: "failed", detail: "setup runner defect" });
      expect(harness.dispatch).toHaveBeenCalled();
    });
  });
});

describe("t3_worktree_status", () => {
  it.effect("reports a plain project directory as not a repository", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const plainDirectory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-worktree-status-non-repo-",
      });
      const canonicalPlainDirectory = yield* fileSystem.realPath(plainDirectory);
      const harness = makeHarness({
        projectWorkspaceRoot: canonicalPlainDirectory,
        useRealNonRepositoryWorkflow: true,
      });

      const result = yield* runStatus(harness);

      expect(result).toMatchObject({
        attached: false,
        projectWorkspaceRoot: canonicalPlainDirectory,
        actualWorkspace: {
          workspacePath: canonicalPlainDirectory,
          branch: null,
          isRepo: false,
          hasWorkingTreeChanges: false,
        },
        agreement: "not_repository",
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("reports an unattached thread", () => {
    const harness = makeHarness({ newWorktreesStartFromOrigin: true });
    return Effect.gen(function* () {
      const result = yield* runStatus(harness);
      expect(result).toMatchObject({
        attached: false,
        worktreePath: null,
        branch: null,
        projectWorkspaceRoot: workspaceRoot,
        defaultStartFromOrigin: true,
        recordedWorkspace: { branch: null, worktreePath: null },
        actualWorkspace: {
          workspacePath: workspaceRoot,
          branch: "dev",
          hasWorkingTreeChanges: false,
        },
        agreement: "branch_mismatch",
      });
    });
  });

  it.effect("reports an attached thread's worktree and branch", () => {
    const worktreePath = "/worktrees/project/existing";
    const harness = makeHarness({
      thread: {
        worktreePath,
        branch: "feature/existing",
      },
      refs: [
        {
          name: "feature/existing",
          current: true,
          isDefault: false,
          worktreePath,
        },
      ],
      workspaceStatuses: { [worktreePath]: { branch: "feature/existing" } },
    });
    return Effect.gen(function* () {
      const result = yield* runStatus(harness);
      expect(result).toMatchObject({
        attached: true,
        worktreePath,
        branch: "feature/existing",
        defaultStartFromOrigin: false,
        actualWorkspace: { workspacePath: worktreePath, branch: "feature/existing", isRepo: true },
        agreement: "in_sync",
      });
    });
  });

  it.effect("reports a recorded worktree that is no longer registered", () => {
    const worktreePath = "/worktrees/project/missing";
    const harness = makeHarness({
      thread: { worktreePath, branch: "feature/missing" },
      workspaceStatuses: { [worktreePath]: { branch: null } },
    });
    return Effect.gen(function* () {
      const result = yield* runStatus(harness);
      expect(result.agreement).toBe("workspace_missing");
      expect(result.recordedWorkspace).toEqual({
        branch: "feature/missing",
        worktreePath,
      });
    });
  });

  it.effect("reports a missing saved worktree even when inventory discovery fails", () => {
    const missingPath = "/worktrees/project/deleted";
    const harness = makeHarness({
      thread: { worktreePath: missingPath, branch: "feature/deleted" },
      workspaceStatuses: {
        [workspaceRoot]: { branch: "dev" },
        [missingPath]: { branch: null, isRepo: false },
      },
      worktreeInventoryFailsFor: new Set([missingPath]),
    });
    return Effect.gen(function* () {
      const result = yield* runStatus(harness);
      expect(result).toMatchObject({
        attached: true,
        worktreePath: missingPath,
        branch: "feature/deleted",
        actualWorkspace: {
          workspacePath: missingPath,
          branch: null,
          isRepo: false,
        },
        agreement: "workspace_missing",
      });
    });
  });

  it.effect("reports a recorded workspace that is not a Git repository", () => {
    const harness = makeHarness({
      thread: { branch: "dev", worktreePath: null },
      refs: [
        {
          name: "dev",
          current: true,
          isDefault: true,
          worktreePath: workspaceRoot,
        },
      ],
      notARepo: true,
    });
    return Effect.gen(function* () {
      const result = yield* runStatus(harness);
      expect(result.agreement).toBe("not_repository");
      expect(result.actualWorkspace.isRepo).toBe(false);
    });
  });

  it.effect("fails when the worktree capability is missing", () => {
    const harness = makeHarness({ capabilities: new Set(["preview"]) });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(runStatus(harness));
      expectTypedFailure(exit, { _tag: "WorktreeMcpFailure", code: "capability_denied" });
    });
  });

  it.effect("fails when the thread does not exist", () => {
    const harness = makeHarness({ thread: null });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(runStatus(harness));
      expectTypedFailure(exit, { _tag: "WorktreeMcpFailure", code: "thread_not_found" });
    });
  });

  it.effect("fails when the project does not exist", () => {
    const harness = makeHarness({ projectMissing: true });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(runStatus(harness));
      expectTypedFailure(exit, { _tag: "WorktreeMcpFailure", code: "project_not_found" });
    });
  });
});

describe("t3_worktree_list", () => {
  it.effect("reports actual checkout state and thread bindings for root and worktrees", () => {
    const worktreePath = "/worktrees/project/feature-list";
    const otherThreadId = ThreadId.make("thread-worktree-other");
    const harness = makeHarness({
      refs: [
        {
          name: "dev",
          current: true,
          isDefault: true,
          worktreePath: workspaceRoot,
        },
        {
          name: "feature/list",
          current: false,
          isDefault: false,
          worktreePath,
        },
      ],
      workspaceStatuses: {
        [workspaceRoot]: { branch: "dev" },
        [worktreePath]: { branch: "feature/list", dirty: true },
      },
      projectThreads: [
        {
          id: threadId,
          title: "Worktree test thread",
          branch: "dev",
          worktreePath: null,
        },
        {
          id: otherThreadId,
          title: "Other thread",
          branch: "feature/list",
          worktreePath,
          status: "running",
          active: true,
        },
      ],
    });
    return Effect.gen(function* () {
      const result = yield* runList(harness);
      expect(result.projectWorkspaceRoot).toBe(workspaceRoot);
      expect(result.repositoryCommonDir).toBe("/repo/.git");
      expect(result.projectWorktreeRoot).toBe(workspaceRoot);
      expect(result.nextCursor).toBeNull();
      expect(result.total).toBe(2);
      expect(result.worktrees).toEqual([
        {
          path: workspaceRoot,
          branch: "dev",
          actualBranch: "dev",
          isRepo: true,
          isProjectRoot: true,
          hasWorkingTreeChanges: false,
          availability: "available",
          statusError: null,
          bindings: [
            {
              threadId,
              title: "Worktree test thread",
              status: "idle",
              recordedBranch: "dev",
              recordedWorktreePath: null,
              active: false,
              callingThread: true,
            },
          ],
          bindingCount: 1,
        },
        {
          path: worktreePath,
          branch: "feature/list",
          actualBranch: "feature/list",
          isRepo: true,
          isProjectRoot: false,
          hasWorkingTreeChanges: true,
          availability: "available",
          statusError: null,
          bindings: [
            {
              threadId: otherThreadId,
              title: "Other thread",
              status: "running",
              recordedBranch: "feature/list",
              recordedWorktreePath: worktreePath,
              active: true,
              callingThread: false,
            },
          ],
          bindingCount: 1,
        },
      ]);
    });
  });

  it.effect("includes detached worktrees without inventing a branch label", () => {
    const detachedPath = "/worktrees/project/detached";
    const harness = makeHarness({
      worktrees: [
        { path: workspaceRoot, refName: "dev" },
        { path: detachedPath, refName: null },
      ],
      workspaceStatuses: {
        [workspaceRoot]: { branch: "dev" },
        [detachedPath]: { branch: null },
      },
    });
    return Effect.gen(function* () {
      const result = yield* runList(harness);
      expect(result.worktrees).toContainEqual({
        path: detachedPath,
        branch: null,
        actualBranch: null,
        isRepo: true,
        isProjectRoot: false,
        hasWorkingTreeChanges: false,
        availability: "available",
        statusError: null,
        bindings: [],
        bindingCount: 0,
      });
    });
  });

  it.effect("pages before status reads and keeps a missing checkout discoverable", () => {
    const firstPath = "/worktrees/project/a-missing";
    const secondPath = "/worktrees/project/b";
    const harness = makeHarness({
      worktrees: [
        { path: workspaceRoot, refName: "dev" },
        { path: firstPath, refName: "feature/a" },
        { path: secondPath, refName: "feature/b" },
      ],
      localStatusFailsOnCall: 1,
    });
    return Effect.gen(function* () {
      const result = yield* runList(harness, { cursor: 1, limit: 1 });
      expect(result).toMatchObject({ total: 3, nextCursor: 2 });
      expect(result.worktrees).toEqual([
        expect.objectContaining({
          path: firstPath,
          availability: "missing",
          actualBranch: null,
          isRepo: false,
        }),
      ]);
      expect(harness.localStatus).toHaveBeenCalledTimes(1);
    });
  });

  it.effect("reports typed status failures without swallowing defects or interruption", () =>
    Effect.gen(function* () {
      const typedResult = yield* runList(makeHarness({ localStatusFailure: "typed" }), {
        limit: 1,
      });
      expect(typedResult.worktrees[0]).toMatchObject({ availability: "missing" });

      const defectExit = yield* Effect.exit(
        runList(makeHarness({ localStatusFailure: "defect" }), { limit: 1 }),
      );
      expect(Exit.isFailure(defectExit)).toBe(true);
      if (Exit.isFailure(defectExit)) {
        expect(Cause.hasDies(defectExit.cause)).toBe(true);
      }

      const interruptExit = yield* Effect.exit(
        runList(makeHarness({ localStatusFailure: "interrupt" }), { limit: 1 }),
      );
      expect(Exit.isFailure(interruptExit)).toBe(true);
      if (Exit.isFailure(interruptExit)) {
        expect(Cause.hasInterruptsOnly(interruptExit.cause)).toBe(true);
      }
    }),
  );

  it.effect("marks a stale checkout missing when status reports a non-repository path", () => {
    const stalePath = "/worktrees/project/stale";
    const harness = makeHarness({
      worktrees: [
        { path: workspaceRoot, refName: "dev" },
        { path: stalePath, refName: "feature/stale" },
      ],
      workspaceStatuses: {
        [workspaceRoot]: { branch: "dev" },
        [stalePath]: { branch: null, isRepo: false },
      },
    });
    return Effect.gen(function* () {
      const result = yield* runList(harness);
      expect(result.worktrees).toContainEqual(
        expect.objectContaining({
          path: stalePath,
          availability: "missing",
          statusError: "Worktree path does not exist.",
          actualBranch: null,
          isRepo: false,
        }),
      );
    });
  });

  it.effect("bounds returned bindings while reporting the total", () => {
    const otherOne = ThreadId.make("thread-binding-one");
    const otherTwo = ThreadId.make("thread-binding-two");
    const harness = makeHarness({
      worktrees: [{ path: workspaceRoot, refName: "dev" }],
      projectThreads: [
        { id: threadId, title: "Caller", branch: "dev", worktreePath: null },
        { id: otherOne, title: "Other one", branch: "dev", worktreePath: null },
        { id: otherTwo, title: "Other two", branch: "dev", worktreePath: null },
      ],
    });
    return Effect.gen(function* () {
      const result = yield* runList(harness, { bindingLimit: 1 });
      expect(result.worktrees[0]?.bindingCount).toBe(3);
      expect(result.worktrees[0]?.bindings).toHaveLength(1);
    });
  });

  it.effect("includes archived thread bindings retained on a physical checkout", () => {
    const archivedThreadId = ThreadId.make("thread-archived-list-owner");
    const harness = makeHarness({
      worktrees: [{ path: workspaceRoot, refName: "dev" }],
      archivedProjectThread: {
        id: archivedThreadId,
        title: "Archived checkout owner",
        branch: "dev",
        worktreePath: workspaceRoot,
      },
    });
    return Effect.gen(function* () {
      const result = yield* runList(harness, { limit: 1 });

      expect(result.worktrees[0]).toMatchObject({
        path: workspaceRoot,
        bindingCount: 2,
        bindings: expect.arrayContaining([
          expect.objectContaining({
            threadId: archivedThreadId,
            recordedWorktreePath: workspaceRoot,
            active: false,
          }),
        ]),
      });
    });
  });

  it.effect("attributes a nested recorded cwd to its physical worktree root", () => {
    const nestedPath = `${workspaceRoot}/packages/app`;
    const harness = makeHarness({
      worktrees: [{ path: workspaceRoot, refName: "dev" }],
      projectThreads: [
        {
          id: threadId,
          title: "Nested caller",
          branch: "dev",
          worktreePath: nestedPath,
        },
      ],
    });
    return Effect.gen(function* () {
      const result = yield* runList(harness, { limit: 1 });

      expect(result.worktrees[0]).toMatchObject({
        path: workspaceRoot,
        bindingCount: 1,
        bindings: [
          {
            threadId,
            recordedWorktreePath: nestedPath,
            callingThread: true,
          },
        ],
      });
      expect(harness.localStatus).toHaveBeenCalledTimes(1);
      expect(harness.listWorktrees).toHaveBeenCalledTimes(2);
    });
  });

  it.effect("does not attribute a nested independent repository to the project worktree", () => {
    const nestedPath = `${workspaceRoot}/vendor/independent`;
    const harness = makeHarness({
      worktrees: [{ path: workspaceRoot, refName: "dev" }],
      projectThreads: [
        {
          id: threadId,
          title: "Nested independent repository",
          branch: "main",
          worktreePath: nestedPath,
        },
      ],
      worktreeInventories: {
        [nestedPath]: {
          repositoryCommonDir: `${nestedPath}/.git`,
          currentWorktreeRoot: nestedPath,
          worktrees: [{ path: nestedPath, refName: "main" }],
        },
      },
    });
    return Effect.gen(function* () {
      const result = yield* runList(harness, { limit: 1 });

      expect(result.worktrees[0]).toMatchObject({
        path: workspaceRoot,
        bindingCount: 0,
        bindings: [],
      });
      expect(harness.localStatus).toHaveBeenCalledTimes(1);
      expect(harness.listWorktrees).toHaveBeenCalledTimes(2);
    });
  });
  it.effect("bounds nested binding identity reads by the requested page", () => {
    const nestedOne = `${workspaceRoot}/packages/one`;
    const nestedTwo = `${workspaceRoot}/packages/two`;
    const nestedThree = `${workspaceRoot}/packages/three`;
    const harness = makeHarness({
      worktrees: [{ path: workspaceRoot, refName: "dev" }],
      projectThreads: [
        { id: threadId, title: "Caller", branch: "dev", worktreePath: null },
        {
          id: ThreadId.make("thread-nested-binding-one"),
          title: "Nested one",
          branch: "dev",
          worktreePath: nestedOne,
        },
        {
          id: ThreadId.make("thread-nested-binding-two"),
          title: "Nested two",
          branch: "dev",
          worktreePath: nestedTwo,
        },
        {
          id: ThreadId.make("thread-nested-binding-three"),
          title: "Nested three",
          branch: "dev",
          worktreePath: nestedThree,
        },
      ],
    });
    return Effect.gen(function* () {
      const result = yield* runList(harness, { limit: 1, bindingLimit: 1 });

      expect(result.bindingPathResolution).toEqual({
        totalCandidates: 3,
        attemptedCandidates: 1,
        truncated: true,
        complete: false,
      });
      expect(result.worktrees[0]?.bindingCount).toBe(2);
      expect(harness.listWorktrees).toHaveBeenCalledTimes(2);
    });
  });

  it.effect("resolves only nested binding candidates for the selected worktree page", () => {
    const firstWorktree = "/worktrees/project-a";
    const secondWorktree = "/worktrees/project-b";
    const firstNestedPath = `${firstWorktree}/packages/app`;
    const secondNestedPath = `${secondWorktree}/packages/app`;
    const listedWorktrees = [
      { path: workspaceRoot, refName: "dev" },
      { path: firstWorktree, refName: "feature/a" },
      { path: secondWorktree, refName: "feature/b" },
    ];
    const harness = makeHarness({
      worktrees: listedWorktrees,
      projectThreads: [
        {
          id: ThreadId.make("thread-off-page-nested-binding"),
          title: "Off-page nested binding",
          branch: "feature/a",
          worktreePath: firstNestedPath,
        },
        {
          id: threadId,
          title: "Selected-page nested binding",
          branch: "feature/b",
          worktreePath: secondNestedPath,
        },
      ],
      worktreeInventories: {
        [firstNestedPath]: {
          repositoryCommonDir: "/repo/.git",
          currentWorktreeRoot: firstWorktree,
          worktrees: listedWorktrees,
        },
        [secondNestedPath]: {
          repositoryCommonDir: "/repo/.git",
          currentWorktreeRoot: secondWorktree,
          worktrees: listedWorktrees,
        },
      },
    });
    return Effect.gen(function* () {
      const result = yield* runList(harness, { cursor: 2, limit: 1, bindingLimit: 1 });

      expect(result.bindingPathResolution).toEqual({
        totalCandidates: 1,
        attemptedCandidates: 1,
        truncated: false,
        complete: true,
      });
      expect(result.worktrees[0]).toMatchObject({
        path: secondWorktree,
        bindingCount: 1,
        bindings: [expect.objectContaining({ threadId })],
      });
      expect(harness.listWorktrees).toHaveBeenCalledTimes(2);
      expect(harness.listWorktrees).not.toHaveBeenCalledWith(firstNestedPath);
      expect(harness.listWorktrees).toHaveBeenCalledWith(secondNestedPath);
    });
  });

  it.effect("reports incomplete binding counts when a candidate inventory read fails", () => {
    const nestedPath = `${workspaceRoot}/packages/unreadable`;
    const harness = makeHarness({
      worktrees: [{ path: workspaceRoot, refName: "dev" }],
      projectThreads: [
        {
          id: threadId,
          title: "Unreadable nested binding",
          branch: "dev",
          worktreePath: nestedPath,
        },
      ],
      worktreeInventoryFailsFor: new Set([nestedPath]),
    });
    return Effect.gen(function* () {
      const result = yield* runList(harness, { limit: 1 });

      expect(result.bindingPathResolution).toEqual({
        totalCandidates: 1,
        attemptedCandidates: 1,
        truncated: false,
        complete: false,
      });
      expect(result.worktrees[0]).toMatchObject({
        path: workspaceRoot,
        bindingCount: 0,
        bindings: [],
      });
    });
  });
});

describe("t3_thread_checkout", () => {
  const rootRefs = [
    {
      name: "dev",
      current: true,
      isDefault: true,
      worktreePath: workspaceRoot,
    },
    {
      name: "feature/checkout",
      current: false,
      isDefault: false,
      worktreePath: null,
    },
  ] as const;

  it.effect("switches the actual branch before updating the durable binding", () => {
    const harness = makeHarness({
      thread: { branch: "dev", worktreePath: null },
      refs: rootRefs,
      workspaceStatuses: { [workspaceRoot]: { branch: "dev" } },
    });
    return Effect.gen(function* () {
      const result = yield* runCheckout(harness, {
        target: { type: "branch", branch: "feature/checkout" },
      });
      expect(result.checkoutAction).toBe("switched");
      expect(result.current).toMatchObject({
        workspacePath: workspaceRoot,
        recordedBranch: "feature/checkout",
        actualBranch: "feature/checkout",
      });
      expect(harness.switchRef).toHaveBeenCalledWith({
        cwd: workspaceRoot,
        refName: "feature/checkout",
      });
      expect(harness.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "thread.metadata.update",
          branch: "feature/checkout",
          worktreePath: null,
          expectedBranch: "dev",
          expectedWorktreePath: null,
        }),
      );
      expect(harness.switchRef.mock.invocationCallOrder[0]).toBeLessThan(
        harness.dispatch.mock.invocationCallOrder[0]!,
      );
      expect(harness.refreshStatus).toHaveBeenCalledWith(workspaceRoot);
    });
  });

  it.effect(
    "asks Git to resolve a remote ref even when a same-named local branch is current",
    () => {
      const harness = makeHarness({
        thread: { branch: "feature", worktreePath: null },
        refs: [
          {
            name: "feature",
            current: true,
            isDefault: false,
            worktreePath: workspaceRoot,
          },
          {
            name: "origin/feature",
            current: false,
            isDefault: false,
            isRemote: true,
            worktreePath: null,
          },
        ],
        workspaceStatuses: { [workspaceRoot]: { branch: "feature" } },
        switchRefResultBranch: "feature",
      });
      return Effect.gen(function* () {
        const result = yield* runCheckout(harness, {
          target: { type: "branch", branch: "origin/feature" },
        });
        expect(result.checkoutAction).toBe("switched");
        expect(result.current.actualBranch).toBe("feature");
        expect(harness.switchRef).toHaveBeenCalledWith({
          cwd: workspaceRoot,
          refName: "origin/feature",
        });
      });
    },
  );

  it.effect("records a verified detached checkout of an explicit remote ref", () => {
    const remoteCommit = "remote-feature-commit";
    const harness = makeHarness({
      thread: { branch: "feature", worktreePath: null },
      refs: [
        {
          name: "feature",
          current: true,
          isDefault: false,
          worktreePath: workspaceRoot,
        },
        {
          name: "origin/feature",
          current: false,
          isDefault: false,
          isRemote: true,
          worktreePath: null,
        },
      ],
      workspaceStatuses: { [workspaceRoot]: { branch: "feature" } },
      switchRefResultBranch: null,
      resolvedCommits: ["local-feature-commit", remoteCommit, remoteCommit],
    });
    return Effect.gen(function* () {
      const result = yield* runCheckout(harness, {
        target: { type: "branch", branch: "origin/feature" },
      });

      expect(result.checkoutAction).toBe("switched");
      expect(result.current).toMatchObject({ recordedBranch: null, actualBranch: null });
      expect(harness.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "thread.metadata.update",
          branch: null,
          expectedArchived: false,
        }),
      );
    });
  });

  it.effect("refuses to bind when Git changes again after resolving the requested ref", () => {
    const harness = makeHarness({
      thread: { branch: "dev", worktreePath: null },
      refs: rootRefs,
      workspaceStatuses: { [workspaceRoot]: { branch: "dev" } },
      switchRefResultBranch: "feature/checkout",
      refChangeAfterSwitch: "feature/intervening",
    });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        runCheckout(harness, {
          target: { type: "branch", branch: "feature/checkout" },
        }),
      );
      expectTypedFailure(exit, {
        _tag: "WorktreeMcpFailure",
        code: "partial_failure",
        partial: {
          actualBranch: "feature/intervening",
          rollback: "not_possible",
        },
      });
      expect(harness.dispatch).not.toHaveBeenCalled();
      expect(harness.switchRef).toHaveBeenCalledTimes(1);
    });
  });

  it.effect("rechecks the caller binding after commit resolution and before Git mutation", () => {
    const harness = makeHarness({
      thread: { branch: "dev", worktreePath: null },
      refs: rootRefs,
      workspaceStatuses: { [workspaceRoot]: { branch: "dev" } },
      threadAttachedOnCall: 3,
    });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        runCheckout(harness, {
          target: { type: "branch", branch: "feature/checkout" },
        }),
      );

      expectTypedFailure(exit, {
        _tag: "WorktreeMcpFailure",
        code: "checkout_in_progress",
      });
      expect(harness.resolveCommit).toHaveBeenCalledTimes(2);
      expect(harness.switchRef).not.toHaveBeenCalled();
      expect(harness.dispatch).not.toHaveBeenCalled();
    });
  });

  for (const [state, option] of [
    ["archived", { threadArchivedOnCall: 4 }],
    ["deleted", { threadDeletedOnCall: 4 }],
  ] as const) {
    it.effect(`preserves Git state when the thread is ${state} before binding`, () => {
      const harness = makeHarness({
        thread: { branch: "dev", worktreePath: null },
        refs: rootRefs,
        workspaceStatuses: { [workspaceRoot]: { branch: "dev" } },
        ...option,
      });
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(
          runCheckout(harness, {
            target: { type: "branch", branch: "feature/checkout" },
          }),
        );
        expectTypedFailure(exit, {
          _tag: "WorktreeMcpFailure",
          code: "partial_failure",
          partial: { actualBranch: "feature/checkout", rollback: "not_possible" },
        });
        expect(harness.switchRef).toHaveBeenCalledTimes(1);
        expect(harness.dispatch).not.toHaveBeenCalled();
        expect(harness.sendToThread).not.toHaveBeenCalled();
      });
    });
  }

  it.effect("creates and checks out a new branch in the current workspace", () => {
    const harness = makeHarness({
      thread: { branch: "dev", worktreePath: null },
      refs: rootRefs,
      workspaceStatuses: { [workspaceRoot]: { branch: "dev" } },
    });
    return Effect.gen(function* () {
      const result = yield* runCheckout(harness, {
        target: { type: "branch", branch: "feature/created", create: true },
      });
      expect(result.checkoutAction).toBe("created");
      expect(result.current).toMatchObject({
        recordedBranch: "feature/created",
        actualBranch: "feature/created",
      });
      expect(harness.createRef).toHaveBeenCalledWith({
        cwd: workspaceRoot,
        refName: "feature/created",
        switchRef: false,
      });
      expect(harness.switchRef).toHaveBeenCalledWith({
        cwd: workspaceRoot,
        refName: "feature/created",
      });
    });
  });

  it.effect("retains a created branch when a later binding operation fails", () => {
    const harness = makeHarness({
      thread: { branch: "dev", worktreePath: null },
      refs: rootRefs,
      workspaceStatuses: { [workspaceRoot]: { branch: "dev" } },
      dispatchFails: true,
    });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        runCheckout(harness, {
          target: { type: "branch", branch: "feature/created-rollback", create: true },
        }),
      );

      expectTypedFailure(exit, { _tag: "WorktreeMcpFailure", code: "operation_failed" });
      expect(harness.switchRef).toHaveBeenNthCalledWith(2, {
        cwd: workspaceRoot,
        refName: "dev",
      });
      expect(harness.deleteLocalBranch).not.toHaveBeenCalled();
    });
  });

  it.effect("reuses an existing worktree and queues continuation after binding", () => {
    const worktreePath = "/worktrees/project/feature-checkout";
    const harness = makeHarness({
      thread: { branch: "dev", worktreePath: null },
      refs: [
        rootRefs[0],
        {
          name: "feature/checkout",
          current: false,
          isDefault: false,
          worktreePath,
        },
      ],
      workspaceStatuses: {
        [workspaceRoot]: { branch: "dev" },
        [worktreePath]: { branch: "feature/checkout" },
      },
    });
    return Effect.gen(function* () {
      const result = yield* runCheckout(harness, {
        target: { type: "branch", branch: "feature/checkout" },
        continuationPrompt: "Continue in the reused worktree.",
      });
      expect(result.checkoutAction).toBe("reused");
      expect(result.workspaceChanged).toBe(true);
      expect(result.callerTurnEnds).toBe(true);
      expect(result.continuation).toEqual({ status: "scheduled", delivery: "queued" });
      expect(harness.switchRef).not.toHaveBeenCalled();
      expect(harness.dispatch.mock.invocationCallOrder[0]).toBeLessThan(
        harness.sendToThread.mock.invocationCallOrder[0]!,
      );
    });
  });

  it.effect("returns an attached thread to the project root", () => {
    const worktreePath = "/worktrees/project/feature-checkout";
    const harness = makeHarness({
      thread: { branch: "feature/checkout", worktreePath },
      refs: [
        rootRefs[0],
        {
          name: "feature/checkout",
          current: true,
          isDefault: false,
          worktreePath,
        },
      ],
      workspaceStatuses: {
        [workspaceRoot]: { branch: "dev" },
        [worktreePath]: { branch: "feature/checkout" },
      },
    });
    return Effect.gen(function* () {
      const result = yield* runCheckout(harness, { target: { type: "project_root" } });
      expect(result.current).toMatchObject({
        workspacePath: workspaceRoot,
        recordedBranch: "dev",
        recordedWorktreePath: null,
        actualBranch: "dev",
      });
      expect(result.workspaceChanged).toBe(true);
      expect(harness.switchRef).not.toHaveBeenCalled();
    });
  });

  it.effect("repairs a missing saved worktree by returning to the project root", () => {
    const missingPath = "/worktrees/project/deleted";
    const harness = makeHarness({
      thread: { branch: "feature/deleted", worktreePath: missingPath },
      refs: rootRefs,
      worktrees: [{ path: workspaceRoot, refName: "dev" }],
      workspaceStatuses: {
        [workspaceRoot]: { branch: "dev" },
        [missingPath]: { branch: null, isRepo: false },
      },
      worktreeInventoryFailsFor: new Set([missingPath]),
    });
    return Effect.gen(function* () {
      const result = yield* runCheckout(harness, { target: { type: "project_root" } });

      expect(result.previous).toMatchObject({
        workspacePath: missingPath,
        recordedBranch: "feature/deleted",
        actualBranch: null,
      });
      expect(result.current).toMatchObject({
        workspacePath: workspaceRoot,
        recordedBranch: "dev",
        recordedWorktreePath: null,
        actualBranch: "dev",
      });
      expect(harness.switchRef).not.toHaveBeenCalled();
      expect(harness.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          expectedBranch: "feature/deleted",
          expectedWorktreePath: missingPath,
          branch: "dev",
          worktreePath: null,
        }),
      );
    });
  });

  it.effect("repairs a missing saved worktree by reusing a listed checkout", () => {
    const missingPath = "/worktrees/project/deleted";
    const targetPath = "/worktrees/project/existing";
    const harness = makeHarness({
      thread: { branch: "feature/deleted", worktreePath: missingPath },
      refs: [
        rootRefs[0],
        {
          name: "feature/existing",
          current: true,
          isDefault: false,
          worktreePath: targetPath,
        },
      ],
      worktrees: [
        { path: workspaceRoot, refName: "dev" },
        { path: targetPath, refName: "feature/existing" },
      ],
      workspaceStatuses: {
        [workspaceRoot]: { branch: "dev" },
        [missingPath]: { branch: null, isRepo: false },
        [targetPath]: { branch: "feature/existing" },
      },
      worktreeInventoryFailsFor: new Set([missingPath]),
    });
    return Effect.gen(function* () {
      const result = yield* runCheckout(harness, {
        target: { type: "worktree", path: targetPath },
      });

      expect(result.checkoutAction).toBe("reused");
      expect(result.previous.workspacePath).toBe(missingPath);
      expect(result.current).toMatchObject({
        workspacePath: targetPath,
        recordedBranch: "feature/existing",
        recordedWorktreePath: targetPath,
      });
      expect(harness.switchRef).not.toHaveBeenCalled();
    });
  });

  it.effect("repairs a missing saved worktree by creating from the healthy project root", () => {
    const missingPath = "/worktrees/project/deleted";
    const harness = makeHarness({
      thread: { branch: "feature/deleted", worktreePath: missingPath },
      refs: rootRefs,
      worktrees: [{ path: workspaceRoot, refName: "dev" }],
      workspaceStatuses: {
        [workspaceRoot]: { branch: "dev" },
        [missingPath]: { branch: null, isRepo: false },
      },
      worktreeInventoryFailsFor: new Set([missingPath]),
    });
    return Effect.gen(function* () {
      const result = yield* runCheckout(harness, {
        target: { type: "new_worktree", branch: "feature/recovered" },
      });

      expect(result.previous.actualBranch).toBeNull();
      expect(result.current.recordedWorktreePath).toBe("/worktrees/project/feature/recovered");
      expect(harness.createWorktree).toHaveBeenCalledWith(
        expect.objectContaining({
          cwd: workspaceRoot,
          refName: "dev",
          newRefName: "feature/recovered",
        }),
      );
      expect(harness.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          expectedBranch: "feature/deleted",
          expectedWorktreePath: missingPath,
        }),
      );
    });
  });

  it.effect("fails closed when the recorded checkout inventory succeeds but status fails", () => {
    const harness = makeHarness({
      thread: { branch: "dev", worktreePath: null },
      refs: rootRefs,
      worktrees: [{ path: workspaceRoot, refName: "dev" }],
      workspaceStatuses: { [workspaceRoot]: { branch: "dev" } },
      localStatusFailsOnCall: 1,
    });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        runCheckout(harness, {
          target: { type: "branch", branch: "feature/checkout" },
        }),
      );

      expectTypedFailure(exit, { _tag: "WorktreeMcpFailure", code: "operation_failed" });
      expect(harness.switchRef).not.toHaveBeenCalled();
      expect(harness.createRef).not.toHaveBeenCalled();
      expect(harness.dispatch).not.toHaveBeenCalled();
    });
  });

  it.effect("applies branch existence checks to project-root targets", () => {
    const harness = makeHarness({
      thread: { branch: "dev", worktreePath: null },
      refs: rootRefs,
      workspaceStatuses: { [workspaceRoot]: { branch: "dev" } },
    });
    return Effect.gen(function* () {
      const existingExit = yield* Effect.exit(
        runCheckout(harness, {
          target: { type: "project_root", branch: "feature/checkout", create: true },
        }),
      );
      expectTypedFailure(existingExit, {
        _tag: "WorktreeMcpFailure",
        code: "invalid_request",
        message:
          "Local branch 'feature/checkout' already exists. Omit target.create to check it out.",
      });

      const missingExit = yield* Effect.exit(
        runCheckout(harness, {
          target: { type: "project_root", branch: "feature/missing" },
        }),
      );
      expectTypedFailure(missingExit, {
        _tag: "WorktreeMcpFailure",
        code: "invalid_request",
        message:
          "Branch or remote ref 'feature/missing' does not exist. Pass target.create=true to create a local branch from the project root.",
      });
      expect(harness.switchRef).not.toHaveBeenCalled();
      expect(harness.createRef).not.toHaveBeenCalled();
    });
  });

  it.effect("creates a new worktree for an already attached thread", () => {
    const sourcePath = "/worktrees/project/source";
    const harness = makeHarness({
      thread: { branch: "feature/source", worktreePath: sourcePath },
      refs: [
        {
          name: "dev",
          current: true,
          isDefault: true,
          worktreePath: workspaceRoot,
        },
        {
          name: "feature/source",
          current: true,
          isDefault: false,
          worktreePath: sourcePath,
        },
      ],
      workspaceStatuses: {
        [workspaceRoot]: { branch: "dev" },
        [sourcePath]: { branch: "feature/source" },
      },
    });
    return Effect.gen(function* () {
      const result = yield* runCheckout(harness, {
        target: { type: "new_worktree", branch: "feature/new-checkout" },
        continuationPrompt: "Continue in the new worktree.",
      });
      expect(result.checkoutAction).toBe("created");
      expect(result.current.recordedWorktreePath).toBe("/worktrees/project/feature/new-checkout");
      expect(result.current.actualBranch).toBe("feature/new-checkout");
      expect(result.continuation).toEqual({ status: "scheduled", delivery: "queued" });
      expect(harness.createWorktree).toHaveBeenCalledWith(
        expect.objectContaining({ refName: "feature/source" }),
      );
      expect(harness.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          expectedBranch: "feature/source",
          expectedWorktreePath: sourcePath,
        }),
      );
    });
  });

  it.effect("does not turn a completed new-worktree handoff into a status-read failure", () => {
    const harness = makeHarness({
      thread: { branch: "dev", worktreePath: null },
      workspaceStatuses: { [workspaceRoot]: { branch: "dev" } },
      localStatusFailsOnCall: 3,
    });
    return Effect.gen(function* () {
      const result = yield* runCheckout(harness, {
        target: { type: "new_worktree", branch: "feature/completed-handoff" },
      });
      expect(result.current.actualBranch).toBe("feature/completed-handoff");
      expect(harness.localStatus).toHaveBeenCalledTimes(2);
    });
  });

  it.effect("reuses a detached worktree without inventing a branch", () => {
    const detachedPath = "/worktrees/project/detached";
    const harness = makeHarness({
      thread: { branch: "dev", worktreePath: null },
      refs: [rootRefs[0]],
      worktrees: [
        { path: workspaceRoot, refName: "dev" },
        { path: detachedPath, refName: null },
      ],
      workspaceStatuses: {
        [workspaceRoot]: { branch: "dev" },
        [detachedPath]: { branch: null },
      },
    });
    return Effect.gen(function* () {
      const result = yield* runCheckout(harness, {
        target: { type: "worktree", path: detachedPath },
      });
      expect(result.current).toMatchObject({
        workspacePath: detachedPath,
        recordedBranch: null,
        recordedWorktreePath: detachedPath,
        actualBranch: null,
      });
      expect(harness.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({ branch: null, worktreePath: detachedPath }),
      );
    });
  });

  it.effect("rejects dirty files before switching branches", () => {
    const harness = makeHarness({
      thread: { branch: "dev", worktreePath: null },
      refs: rootRefs,
      workspaceStatuses: { [workspaceRoot]: { branch: "dev", dirty: true } },
    });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        runCheckout(harness, {
          target: { type: "branch", branch: "feature/checkout" },
        }),
      );
      expectTypedFailure(exit, { _tag: "WorktreeMcpFailure", code: "dirty_workspace" });
      expect(harness.switchRef).not.toHaveBeenCalled();
      expect(harness.dispatch).not.toHaveBeenCalled();
    });
  });

  it.effect("rejects a worktree bound to another idle thread", () => {
    const worktreePath = "/worktrees/project/shared";
    const harness = makeHarness({
      thread: { branch: "dev", worktreePath: null },
      refs: [
        rootRefs[0],
        {
          name: "feature/shared",
          current: false,
          isDefault: false,
          worktreePath,
        },
      ],
      workspaceStatuses: {
        [workspaceRoot]: { branch: "dev" },
        [worktreePath]: { branch: "feature/shared" },
      },
      projectThreads: [
        { id: threadId, title: "Caller", branch: "dev", worktreePath: null },
        {
          id: ThreadId.make("thread-worktree-shared"),
          title: "Shared owner",
          branch: "feature/shared",
          worktreePath,
        },
      ],
    });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        runCheckout(harness, { target: { type: "worktree", path: worktreePath } }),
      );
      expectTypedFailure(exit, { _tag: "WorktreeMcpFailure", code: "workspace_shared" });
    });
  });

  it.effect("rejects a physical worktree bound through another project alias", () => {
    const targetPath = "/worktrees/project/cross-project";
    const otherProjectRoot = "/aliases/other-project";
    const otherProjectId = ProjectId.make("project-other");
    const harness = makeHarness({
      thread: { branch: "dev", worktreePath: null },
      refs: [
        rootRefs[0],
        {
          name: "feature/cross-project",
          current: false,
          isDefault: false,
          worktreePath: targetPath,
        },
      ],
      workspaceStatuses: {
        [workspaceRoot]: { branch: "dev" },
        [targetPath]: { branch: "feature/cross-project" },
      },
      workspaceAliases: { [otherProjectRoot]: targetPath },
      otherProjectThread: {
        projectId: otherProjectId,
        workspaceRoot: otherProjectRoot,
        id: ThreadId.make("thread-other-project-owner"),
        title: "Other project owner",
        branch: "feature/cross-project",
        worktreePath: null,
      },
    });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        runCheckout(harness, { target: { type: "worktree", path: targetPath } }),
      );
      expectTypedFailure(exit, { _tag: "WorktreeMcpFailure", code: "workspace_shared" });
      expect(harness.dispatch).not.toHaveBeenCalled();
    });
  });

  it.effect("ignores an unrelated plain-directory project while checking workspace owners", () => {
    const plainProjectRoot = "/plain/unrelated-project";
    const otherProjectId = ProjectId.make("project-plain-directory");
    const harness = makeHarness({
      thread: { branch: "dev", worktreePath: null },
      refs: rootRefs,
      workspaceStatuses: {
        [workspaceRoot]: { branch: "dev" },
        [plainProjectRoot]: { branch: null, isRepo: false },
      },
      worktreeInventoryFailsFor: new Set([plainProjectRoot]),
      otherProjectThread: {
        projectId: otherProjectId,
        workspaceRoot: plainProjectRoot,
        id: ThreadId.make("thread-plain-directory"),
        title: "Plain directory thread",
        branch: null,
        worktreePath: null,
      },
    });
    return Effect.gen(function* () {
      const result = yield* runCheckout(harness, {
        target: { type: "branch", branch: "feature/checkout" },
      });

      expect(result.current.actualBranch).toBe("feature/checkout");
      expect(harness.dispatch).toHaveBeenCalledTimes(1);
    });
  });

  it.effect("fails closed when a nested checkout owner's Git identity cannot be resolved", () => {
    const nestedProjectRoot = "/repo/packages/server";
    const otherProjectId = ProjectId.make("project-unresolved-nested-owner");
    const harness = makeHarness({
      thread: { branch: "dev", worktreePath: null },
      refs: rootRefs,
      workspaceStatuses: {
        [workspaceRoot]: { branch: "dev" },
        [nestedProjectRoot]: { branch: "dev", isRepo: true },
      },
      worktreeInventoryFailsFor: new Set([nestedProjectRoot]),
      otherProjectThread: {
        projectId: otherProjectId,
        workspaceRoot: nestedProjectRoot,
        id: ThreadId.make("thread-unresolved-nested-owner"),
        title: "Unresolved nested owner",
        branch: "dev",
        worktreePath: null,
      },
    });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        runCheckout(harness, {
          target: { type: "branch", branch: "feature/checkout" },
        }),
      );

      expectTypedFailure(exit, { _tag: "WorktreeMcpFailure", code: "operation_failed" });
      expect(harness.switchRef).not.toHaveBeenCalled();
      expect(harness.dispatch).not.toHaveBeenCalled();
    });
  });

  it.effect("fails closed when a same-repository owner has no physical checkout identity", () => {
    const nestedProjectRoot = "/repo/packages/server";
    const otherProjectId = ProjectId.make("project-null-checkout-owner");
    const harness = makeHarness({
      thread: { branch: "dev", worktreePath: null },
      refs: rootRefs,
      workspaceStatuses: {
        [workspaceRoot]: { branch: "dev" },
        [nestedProjectRoot]: { branch: "dev", isRepo: true },
      },
      worktreeInventories: {
        [nestedProjectRoot]: {
          repositoryCommonDir: "/repo/.git",
          currentWorktreeRoot: null,
          worktrees: [{ path: workspaceRoot, refName: "dev" }],
        },
      },
      otherProjectThread: {
        projectId: otherProjectId,
        workspaceRoot: nestedProjectRoot,
        id: ThreadId.make("thread-null-checkout-owner"),
        title: "Unresolved checkout owner",
        branch: "dev",
        worktreePath: null,
      },
    });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        runCheckout(harness, {
          target: { type: "branch", branch: "feature/checkout" },
        }),
      );

      expectTypedFailure(exit, { _tag: "WorktreeMcpFailure", code: "operation_failed" });
      expect(harness.switchRef).not.toHaveBeenCalled();
      expect(harness.dispatch).not.toHaveBeenCalled();
    });
  });

  it.effect("rejects a physical worktree retained by an archived thread", () => {
    const targetPath = "/worktrees/project/archived-owner";
    const harness = makeHarness({
      thread: { branch: "dev", worktreePath: null },
      refs: [
        rootRefs[0],
        {
          name: "feature/archived-owner",
          current: false,
          isDefault: false,
          worktreePath: targetPath,
        },
      ],
      workspaceStatuses: {
        [workspaceRoot]: { branch: "dev" },
        [targetPath]: { branch: "feature/archived-owner" },
      },
      archivedProjectThread: {
        id: ThreadId.make("thread-archived-worktree-owner"),
        title: "Archived owner",
        branch: "feature/archived-owner",
        worktreePath: targetPath,
      },
    });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        runCheckout(harness, { target: { type: "worktree", path: targetPath } }),
      );
      expectTypedFailure(exit, { _tag: "WorktreeMcpFailure", code: "workspace_shared" });
      expect(harness.dispatch).not.toHaveBeenCalled();
    });
  });

  it.effect("rejects switching the shared project root while another thread is active", () => {
    const harness = makeHarness({
      thread: { branch: "dev", worktreePath: null },
      refs: rootRefs,
      workspaceStatuses: { [workspaceRoot]: { branch: "dev" } },
      projectThreads: [
        { id: threadId, title: "Caller", branch: "dev", worktreePath: null },
        {
          id: ThreadId.make("thread-root-active"),
          title: "Root owner",
          branch: "dev",
          worktreePath: null,
          status: "running",
          active: true,
        },
      ],
    });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        runCheckout(harness, {
          target: { type: "branch", branch: "feature/checkout" },
        }),
      );
      expectTypedFailure(exit, { _tag: "WorktreeMcpFailure", code: "workspace_in_use" });
    });
  });

  it.effect("rejects switching a project root shared with another idle thread", () => {
    const harness = makeHarness({
      thread: { branch: "dev", worktreePath: null },
      refs: rootRefs,
      workspaceStatuses: { [workspaceRoot]: { branch: "dev" } },
      projectThreads: [
        { id: threadId, title: "Caller", branch: "dev", worktreePath: null },
        {
          id: ThreadId.make("thread-root-idle"),
          title: "Idle root owner",
          branch: "dev",
          worktreePath: null,
        },
      ],
    });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        runCheckout(harness, {
          target: { type: "branch", branch: "feature/checkout" },
        }),
      );
      expectTypedFailure(exit, { _tag: "WorktreeMcpFailure", code: "workspace_shared" });
      expect(harness.switchRef).not.toHaveBeenCalled();
    });
  });

  it.effect("rejects paths outside the project worktree list", () => {
    const harness = makeHarness({
      thread: { branch: "dev", worktreePath: null },
      refs: rootRefs,
    });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        runCheckout(harness, {
          target: { type: "worktree", path: "/other/repository" },
        }),
      );
      expectTypedFailure(exit, { _tag: "WorktreeMcpFailure", code: "scope_mismatch" });
    });
  });

  it.effect("rechecks the durable binding before changing Git", () => {
    const harness = makeHarness({
      thread: { branch: "dev", worktreePath: null },
      refs: rootRefs,
      workspaceStatuses: { [workspaceRoot]: { branch: "dev" } },
      threadAttachedOnRecheck: true,
    });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        runCheckout(harness, {
          target: { type: "branch", branch: "feature/checkout" },
        }),
      );
      expectTypedFailure(exit, { _tag: "WorktreeMcpFailure", code: "checkout_in_progress" });
      expect(harness.switchRef).not.toHaveBeenCalled();
      expect(harness.dispatch).not.toHaveBeenCalled();
    });
  });

  it.effect("cancels guarded checkout reads before mutation and releases both guards", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const gateArmed = yield* Ref.make(true);
      const harness = makeHarness({
        thread: { branch: "dev", worktreePath: null },
        refs: rootRefs,
        workspaceStatuses: { [workspaceRoot]: { branch: "dev" } },
        resolveCommitGate: Effect.gen(function* () {
          if (yield* Ref.getAndSet(gateArmed, false)) {
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(release);
          }
        }),
      });
      const service = yield* resolveService(harness);
      const checkoutInput = {
        target: { type: "branch", branch: "feature/checkout" },
      } as const;
      return yield* Effect.gen(function* () {
        const first = yield* Effect.forkChild(service.checkout(harness.scope, checkoutInput), {
          startImmediately: true,
        });
        yield* Deferred.await(entered);
        first.interruptUnsafe();
        yield* Deferred.succeed(release, undefined);
        const interrupted = yield* Fiber.await(first);
        expect(Exit.isFailure(interrupted)).toBe(true);
        expect(harness.createRef).not.toHaveBeenCalled();
        expect(harness.switchRef).not.toHaveBeenCalled();
        expect(harness.dispatch).not.toHaveBeenCalled();

        const retry = yield* service.checkout(harness.scope, checkoutInput);
        expect(retry.checkoutAction).toBe("switched");
        expect(harness.switchRef).toHaveBeenCalledTimes(1);
        expect(harness.dispatch).toHaveBeenCalledTimes(1);
      }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)));
    }),
  );

  it.effect("rolls the git branch back when the durable binding fails", () => {
    const harness = makeHarness({
      thread: { branch: "dev", worktreePath: null },
      refs: rootRefs,
      workspaceStatuses: { [workspaceRoot]: { branch: "dev" } },
      dispatchFails: true,
    });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        runCheckout(harness, {
          target: { type: "branch", branch: "feature/checkout" },
        }),
      );
      expectTypedFailure(exit, { _tag: "WorktreeMcpFailure", code: "operation_failed" });
      expect(harness.switchRef).toHaveBeenNthCalledWith(2, {
        cwd: workspaceRoot,
        refName: "dev",
      });
    });
  });

  it.effect("keeps a checkout whose durable binding committed before dispatch failed", () => {
    const harness = makeHarness({
      thread: { branch: "dev", worktreePath: null },
      refs: rootRefs,
      workspaceStatuses: { [workspaceRoot]: { branch: "dev" } },
      dispatchFails: true,
      threadAfterFailedDispatch: { branch: "feature/checkout", worktreePath: null },
    });
    return Effect.gen(function* () {
      const result = yield* runCheckout(harness, {
        target: { type: "branch", branch: "feature/checkout" },
      });
      expect(result.checkoutAction).toBe("switched");
      expect(result.current).toMatchObject({
        recordedBranch: "feature/checkout",
        actualBranch: "feature/checkout",
      });
      expect(harness.switchRef).toHaveBeenCalledTimes(1);
    });
  });

  it.effect("does not roll Git back when a failed binding outcome cannot be verified", () => {
    const harness = makeHarness({
      thread: { branch: "dev", worktreePath: null },
      refs: rootRefs,
      workspaceStatuses: { [workspaceRoot]: { branch: "dev" } },
      dispatchFails: true,
      threadReadFailsAfterDispatch: true,
    });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        runCheckout(harness, {
          target: { type: "branch", branch: "feature/checkout" },
        }),
      );
      expectTypedFailure(exit, {
        _tag: "WorktreeMcpFailure",
        code: "partial_failure",
        partial: {
          workspacePath: workspaceRoot,
          recordedBranch: "dev",
          actualBranch: "feature/checkout",
          rollback: "not_possible",
        },
      });
      expect(harness.switchRef).toHaveBeenCalledTimes(1);
    });
  });

  it.effect("does not roll Git back over another actor's durable binding", () => {
    const harness = makeHarness({
      thread: { branch: "dev", worktreePath: null },
      refs: rootRefs,
      workspaceStatuses: { [workspaceRoot]: { branch: "dev" } },
      dispatchFails: true,
      threadAfterFailedDispatch: { branch: "feature/other-actor", worktreePath: null },
    });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        runCheckout(harness, {
          target: { type: "branch", branch: "feature/checkout" },
        }),
      );
      expectTypedFailure(exit, {
        _tag: "WorktreeMcpFailure",
        code: "partial_failure",
        partial: {
          recordedBranch: "feature/other-actor",
          rollback: "not_possible",
        },
      });
      expect(harness.switchRef).toHaveBeenCalledTimes(1);
    });
  });

  it.effect("does not claim a local switch changed before its first commit capture", () => {
    const harness = makeHarness({
      thread: { branch: "dev", worktreePath: null },
      refs: rootRefs,
      workspaceStatuses: { [workspaceRoot]: { branch: "dev" } },
      dispatchFails: true,
      resolvedCommits: ["before", "requested", "intervening", "intervening"],
    });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        runCheckout(harness, {
          target: { type: "branch", branch: "feature/checkout" },
        }),
      );
      expectTypedFailure(exit, {
        _tag: "WorktreeMcpFailure",
        code: "partial_failure",
        partial: {
          actualBranch: "feature/checkout",
          rollback: "not_possible",
        },
      });
      expect(harness.switchRef).toHaveBeenCalledTimes(1);
      expect(harness.dispatch).not.toHaveBeenCalled();
    });
  });

  for (const [change, options] of [
    ["a new commit", { resolvedCommits: ["before", "selected", "selected", "intervening"] }],
    ["new dirty files", { dirtyOnLocalStatusCall: 5 }],
  ] as const) {
    it.effect(`does not roll Git back over ${change}`, () => {
      const harness = makeHarness({
        thread: { branch: "dev", worktreePath: null },
        refs: rootRefs,
        workspaceStatuses: { [workspaceRoot]: { branch: "dev" } },
        dispatchFails: true,
        ...options,
      });
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(
          runCheckout(harness, {
            target: { type: "branch", branch: "feature/checkout" },
          }),
        );
        expectTypedFailure(exit, {
          _tag: "WorktreeMcpFailure",
          code: "partial_failure",
          partial: { actualBranch: "feature/checkout", rollback: "not_possible" },
        });
        expect(harness.switchRef).toHaveBeenCalledTimes(1);
      });
    });
  }

  it.effect("rolls back when checkout reports failure after changing the branch", () => {
    const harness = makeHarness({
      thread: { branch: "dev", worktreePath: null },
      refs: rootRefs,
      workspaceStatuses: { [workspaceRoot]: { branch: "dev" } },
      switchRefFailsAfterMutation: true,
    });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        runCheckout(harness, {
          target: { type: "branch", branch: "feature/checkout" },
        }),
      );
      expectTypedFailure(exit, { _tag: "WorktreeMcpFailure", code: "operation_failed" });
      expect(harness.switchRef).toHaveBeenNthCalledWith(2, {
        cwd: workspaceRoot,
        refName: "dev",
      });
      expect(harness.dispatch).not.toHaveBeenCalled();
    });
  });

  it.effect("preserves unrelated Git state observed immediately after a failed switch", () => {
    const harness = makeHarness({
      thread: { branch: "dev", worktreePath: null },
      refs: rootRefs,
      workspaceStatuses: { [workspaceRoot]: { branch: "dev" } },
      switchRefFailsAfterMutation: true,
      switchRefFailureBranch: "feature/other-actor",
      resolvedCommits: ["before", "requested", "other-actor"],
    });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        runCheckout(harness, {
          target: { type: "branch", branch: "feature/checkout" },
        }),
      );
      expectTypedFailure(exit, {
        _tag: "WorktreeMcpFailure",
        code: "partial_failure",
        partial: {
          actualBranch: "feature/other-actor",
          rollback: "not_possible",
        },
      });
      expect(harness.switchRef).toHaveBeenCalledTimes(1);
      expect(harness.dispatch).not.toHaveBeenCalled();
    });
  });

  it.effect("preserves the switched branch when its resulting state cannot be verified", () => {
    const harness = makeHarness({
      thread: { branch: "dev", worktreePath: null },
      refs: rootRefs,
      workspaceStatuses: { [workspaceRoot]: { branch: "dev" } },
      localStatusFailsOnCall: 4,
    });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        runCheckout(harness, {
          target: { type: "branch", branch: "feature/checkout" },
        }),
      );
      expectTypedFailure(exit, {
        _tag: "WorktreeMcpFailure",
        code: "partial_failure",
        partial: { actualBranch: null, rollback: "not_possible" },
      });
      expect(harness.switchRef).toHaveBeenCalledTimes(1);
      expect(harness.dispatch).not.toHaveBeenCalled();
    });
  });

  it.effect("reports partial state when binding and rollback both fail", () => {
    const harness = makeHarness({
      thread: { branch: "dev", worktreePath: null },
      refs: rootRefs,
      workspaceStatuses: { [workspaceRoot]: { branch: "dev" } },
      dispatchFails: true,
      switchRefRollbackFails: true,
    });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        runCheckout(harness, {
          target: { type: "branch", branch: "feature/checkout" },
        }),
      );
      expectTypedFailure(exit, {
        _tag: "WorktreeMcpFailure",
        code: "partial_failure",
        partial: {
          workspacePath: workspaceRoot,
          recordedBranch: "dev",
          actualBranch: "feature/checkout",
          rollback: "failed",
        },
      });
    });
  });

  it.effect("treats a retry already on the recorded checkout as unchanged", () => {
    const harness = makeHarness({
      thread: { branch: "feature/checkout", worktreePath: null },
      refs: rootRefs,
      workspaceStatuses: { [workspaceRoot]: { branch: "feature/checkout" } },
    });
    return Effect.gen(function* () {
      const result = yield* runCheckout(harness, {
        target: { type: "branch", branch: "feature/checkout" },
      });
      expect(result.checkoutAction).toBe("unchanged");
      expect(harness.switchRef).not.toHaveBeenCalled();
      expect(harness.dispatch).not.toHaveBeenCalled();
    });
  });

  it.effect("serializes concurrent checkout and handoff requests per thread", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>();
      const harness = makeHarness({ createWorktreeGate: Deferred.await(gate) });
      const service = yield* resolveService(harness);
      const first = yield* Effect.forkChild(
        service.checkout(harness.scope, {
          target: { type: "new_worktree", branch: "feature/guard-checkout" },
        }),
      );
      yield* Effect.yieldNow;
      const second = yield* Effect.exit(
        service.handoff(harness.scope, { branch: "feature/guard-handoff" }),
      );
      expectTypedFailure(second, {
        _tag: "WorktreeMcpFailure",
        code: "handoff_in_progress",
      });
      yield* Deferred.succeed(gate, undefined);
      yield* Fiber.join(first);
    }),
  );

  it.effect("serializes two threads targeting alias paths for the same physical worktree", () =>
    Effect.gen(function* () {
      const targetPath = "/worktrees/project/shared-target";
      const aliasPath = "/aliases/shared-target";
      const otherThreadId = ThreadId.make("thread-worktree-concurrent");
      const dispatchGate = yield* Deferred.make<void>();
      const dispatchStarted = yield* Deferred.make<void>();
      const harness = makeHarness({
        thread: { branch: "dev", worktreePath: null },
        refs: [
          rootRefs[0],
          {
            name: "feature/shared-target",
            current: false,
            isDefault: false,
            worktreePath: targetPath,
          },
        ],
        workspaceStatuses: {
          [workspaceRoot]: { branch: "dev" },
          [targetPath]: { branch: "feature/shared-target" },
        },
        workspaceAliases: { [aliasPath]: targetPath },
        projectThreads: [
          { id: threadId, title: "Caller", branch: "dev", worktreePath: null },
          { id: otherThreadId, title: "Other", branch: "dev", worktreePath: null },
        ],
        dispatchGate: Deferred.succeed(dispatchStarted, undefined).pipe(
          Effect.andThen(Deferred.await(dispatchGate)),
        ),
      });
      const service = yield* resolveService(harness);
      const first = yield* Effect.forkChild(
        service.checkout(harness.scope, {
          target: { type: "worktree", path: aliasPath },
        }),
      );
      yield* Deferred.await(dispatchStarted);
      const second = yield* Effect.exit(
        service.checkout(
          { ...harness.scope, threadId: otherThreadId },
          { target: { type: "worktree", path: targetPath } },
        ),
      );
      expectTypedFailure(second, {
        _tag: "WorktreeMcpFailure",
        code: "checkout_in_progress",
      });
      yield* Deferred.succeed(dispatchGate, undefined);
      yield* Fiber.join(first);
    }),
  );
});

describe("WorktreeMcpHandoffInput schema", () => {
  const decode = Schema.decodeUnknownEffect(WorktreeMcpHandoffInput);

  it.effect("accepts POSIX, Windows drive, and UNC absolute paths", () =>
    Effect.gen(function* () {
      for (const path of ["/abs/posix", "C:\\abs\\drive", "C:/abs/drive", "\\\\host\\share"]) {
        const decoded = yield* decode({ branch: "feature/x", path });
        expect(decoded.path).toBe(path);
      }
    }),
  );

  it.effect("rejects relative paths", () =>
    Effect.gen(function* () {
      for (const path of ["worktrees/nested", "./nested", "../sibling"]) {
        const exit = yield* Effect.exit(decode({ branch: "feature/x", path }));
        expect(Exit.isFailure(exit), `path '${path}' should be rejected`).toBe(true);
      }
    }),
  );

  it.effect("rejects a missing or blank branch", () =>
    Effect.gen(function* () {
      expect(Exit.isFailure(yield* Effect.exit(decode({})))).toBe(true);
      expect(Exit.isFailure(yield* Effect.exit(decode({ branch: "   " })))).toBe(true);
    }),
  );

  it.effect("rejects a blank continuationPrompt", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(decode({ branch: "feature/x", continuationPrompt: " " }));
      expect(Exit.isFailure(exit)).toBe(true);
    }),
  );
});
