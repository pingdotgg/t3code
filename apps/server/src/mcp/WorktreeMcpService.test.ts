import { describe, expect, it, vi } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  EnvironmentId,
  type OrchestrationV2ThreadProjection,
  type Project,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  WorktreeMcpHandoffInput,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import {
  OrchestratorDispatchError,
  OrchestratorProjectionError,
} from "../orchestration-v2/Orchestrator.ts";
import {
  ThreadManagementError,
  ThreadManagementService,
  type ThreadManagementSendResult,
} from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
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
  readonly dispatchDies?: boolean;
  readonly dispatchInterrupts?: boolean;
  readonly dispatchGate?: Effect.Effect<void>;
  readonly threadAttachedOnRecheck?: boolean;
  readonly threadArchivedOnRecheck?: boolean;
  readonly threadReadFailsOnRecheck?: boolean;
  readonly continuation?: "queued" | "fails" | "dies";
  readonly projectMissing?: boolean;
  readonly projectReadFails?: boolean;
  readonly existingBranchWorktreePath?: string | null;
  readonly pathSemantics?: "win32" | "posix";
  readonly createWorktreeFails?: boolean;
  readonly fetchRemoteFails?: boolean;
  readonly resolveRemoteFails?: boolean;
  readonly removeWorktreeFails?: boolean;
  readonly createWorktreeGate?: Effect.Effect<void>;
}

const makeHarness = (options: HarnessOptions = {}) => {
  const thread = options.thread === undefined ? {} : options.thread;
  const scope = makeScope(options.capabilities ?? new Set(["preview", "worktree"]));
  const dispatch = vi.fn((_: unknown) =>
    (options.dispatchGate ?? Effect.void).pipe(
      Effect.andThen(
        options.dispatchInterrupts
          ? (Effect.failCause(Cause.interrupt()) as never)
          : options.dispatchDies
            ? Effect.die(new Error("dispatch defect"))
            : options.dispatchFails
              ? (Effect.fail("simulated dispatch failure") as never)
              : Effect.succeed({ sequence: 1, storedEvents: [] }),
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
    if (options.threadReadFailsOnRecheck === true && getThreadProjection.mock.calls.length > 1) {
      return Effect.fail(
        new OrchestratorDispatchError({
          commandId: CommandId.make("command:test:recheck"),
          commandType: "thread.metadata.update",
        }),
      ) as never;
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
    return id === threadId && thread !== null
      ? Effect.succeed(makeProjection(thread))
      : Effect.fail(new OrchestratorProjectionError({ threadId: id }));
  });
  const sendToThread = vi.fn((_: unknown) => {
    switch (options.continuation ?? "queued") {
      case "fails":
        return Effect.fail(
          new ThreadManagementError({
            code: "thread_not_sendable",
            message: "simulated send failure",
          }),
        );
      case "dies":
        return Effect.die(new Error("send defect"));
      default:
        return Effect.succeed({ delivery: "queued" } as ThreadManagementSendResult);
    }
  });
  const getById = vi.fn((id: ProjectId) =>
    options.projectReadFails
      ? (Effect.fail("simulated project read failure") as never)
      : Effect.succeed(
          id === projectId && options.projectMissing !== true
            ? Option.some(project)
            : Option.none(),
        ),
  );
  const removeWorktree = vi.fn((_: unknown) =>
    options.removeWorktreeFails
      ? (Effect.fail("simulated worktree removal failure") as never)
      : Effect.void,
  );
  const fetchRemote = vi.fn((_: unknown) =>
    options.fetchRemoteFails ? (Effect.fail("simulated fetch failure") as never) : Effect.void,
  );
  const resolveRemoteTrackingCommit = vi.fn((_: unknown) =>
    options.resolveRemoteFails
      ? (Effect.fail("simulated remote resolve failure") as never)
      : Effect.succeed({ commitSha: "abc123", remoteRefName: "origin/dev" }),
  );
  const createWorktree = vi.fn(
    (input: { readonly newRefName?: string | undefined; readonly path: string | null }) =>
      options.createWorktreeFails
        ? (Effect.fail("simulated worktree creation failure") as never)
        : (options.createWorktreeGate ?? Effect.void).pipe(
            Effect.andThen(
              Effect.succeed({
                worktree: {
                  path: input.path ?? `/worktrees/project/${input.newRefName}`,
                  refName: input.newRefName ?? "detached",
                },
              }),
            ),
          ),
  );
  const listRefs = vi.fn((input: { readonly query?: string | undefined }) =>
    Effect.succeed({
      refs:
        options.existingBranchWorktreePath === undefined
          ? []
          : [
              {
                name: input.query ?? "",
                current: false,
                isDefault: false,
                worktreePath: options.existingBranchWorktreePath,
              },
            ],
      isRepo: true,
      hasPrimaryRemote: true,
      nextCursor: null,
      totalCount: options.existingBranchWorktreePath === undefined ? 0 : 1,
    }),
  );
  const localStatus = vi.fn((_: unknown) =>
    Effect.succeed({
      isRepo: options.notARepo !== true,
      hasPrimaryRemote: true,
      isDefaultRef: false,
      refName: options.currentBranch === undefined ? "dev" : options.currentBranch,
      hasWorkingTreeChanges: false,
      workingTree: { files: [], insertions: 0, deletions: 0 },
    }),
  );
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
  // service only calls isAbsolute; the minimal per-platform semantics are
  // inlined so the test does not depend on the host's path module.
  const win32IsAbsolute = (value: string) => /^(?:[a-zA-Z]:[\\/]|[\\/])/.test(value);
  const posixIsAbsolute = (value: string) => value.startsWith("/");
  const serviceLayer =
    options.pathSemantics === undefined
      ? worktreeMcpServiceLayer
      : worktreeMcpServiceLayer.pipe(
          Layer.provide(
            Layer.succeed(Path.Path, {
              isAbsolute: options.pathSemantics === "win32" ? win32IsAbsolute : posixIsAbsolute,
            } as unknown as Path.Path),
          ),
        );
  const layer = serviceLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ThreadManagementService)({
          dispatch,
          getThreadProjection,
          sendToThread,
        } satisfies Partial<ThreadManagementService["Service"]>),
        Layer.mock(ProjectService.ProjectService)({
          getById,
        } satisfies Partial<ProjectService.ProjectService["Service"]>),
        ServerSettings.layerTest({
          newWorktreesStartFromOrigin: options.newWorktreesStartFromOrigin ?? false,
        }),
        Layer.mock(GitWorkflowService.GitWorkflowService)({
          listRefs,
          listLocalBranchNames,
          localStatus,
          fetchRemote,
          resolveRemoteTrackingCommit,
          createWorktree,
          removeWorktree,
        } satisfies Partial<GitWorkflowService.GitWorkflowService["Service"]>),
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
    createWorktree,
    removeWorktree,
    localStatus,
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

  it.effect("fails when the thread is already attached to a worktree", () => {
    const harness = makeHarness({
      thread: { branch: "feature/existing", worktreePath: "/worktrees/project/existing" },
    });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(runHandoff(harness, { branch: "feature/second" }));
      expectTypedFailure(exit, {
        _tag: "WorktreeMcpFailure",
        code: "already_in_worktree",
      });
      expect(harness.createWorktree).not.toHaveBeenCalled();
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

  it.effect("re-checks attachment after creating the worktree and backs out on a race", () => {
    const harness = makeHarness({ threadAttachedOnRecheck: true });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(runHandoff(harness, { branch: "feature/raced" }));
      expectTypedFailure(exit, { _tag: "WorktreeMcpFailure", code: "already_in_worktree" });
      expect(harness.createWorktree).toHaveBeenCalledTimes(1);
      // The freshly created worktree must not be left orphaned.
      expect(harness.removeWorktree).toHaveBeenCalledWith({
        cwd: workspaceRoot,
        path: "/worktrees/project/feature/raced",
        force: true,
      });
      expect(harness.dispatch).not.toHaveBeenCalled();
    });
  });

  it.effect("removes the created worktree when the recheck read fails", () => {
    const harness = makeHarness({ threadReadFailsOnRecheck: true });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(runHandoff(harness, { branch: "feature/recheck-fails" }));
      expectTypedFailure(exit, { _tag: "WorktreeMcpFailure", code: "operation_failed" });
      expect(harness.removeWorktree).toHaveBeenCalledWith({
        cwd: workspaceRoot,
        path: "/worktrees/project/feature/recheck-fails",
        force: true,
      });
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
      const harness = makeHarness({ dispatchGate: Deferred.await(gate) });

      // Interrupt arrives while the metadata dispatch is in flight; the
      // binding-plus-continuation section must run to completion anyway so the
      // continuation is never lost between the commit and the queue.
      const fiber = yield* Effect.forkChild(
        runHandoff(harness, {
          branch: "feature/interrupted",
          continuationPrompt: "Keep going in the worktree.",
        }),
      );
      yield* Effect.yieldNow;
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
      expectTypedFailure(exit, { _tag: "WorktreeMcpFailure", code: "operation_failed" });
      expect(harness.removeWorktree).toHaveBeenCalledTimes(1);
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
    const harness = makeHarness({
      thread: { worktreePath: "/worktrees/project/existing" },
    });
    return Effect.gen(function* () {
      const service = yield* resolveService(harness);

      const first = yield* Effect.exit(
        service.handoff(harness.scope, { branch: "feature/guard-1" }),
      );
      expectTypedFailure(first, { _tag: "WorktreeMcpFailure", code: "already_in_worktree" });
      // A leaked guard would surface as handoff_in_progress here.
      const second = yield* Effect.exit(
        service.handoff(harness.scope, { branch: "feature/guard-2" }),
      );
      expectTypedFailure(second, { _tag: "WorktreeMcpFailure", code: "already_in_worktree" });
    });
  });

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
  it.effect("reports an unattached thread", () => {
    const harness = makeHarness({ newWorktreesStartFromOrigin: true });
    return Effect.gen(function* () {
      const result = yield* runStatus(harness);
      expect(result).toEqual({
        attached: false,
        worktreePath: null,
        branch: null,
        projectWorkspaceRoot: workspaceRoot,
        defaultStartFromOrigin: true,
      });
    });
  });

  it.effect("reports an attached thread's worktree and branch", () => {
    const harness = makeHarness({
      thread: {
        worktreePath: "/worktrees/project/existing",
        branch: "feature/existing",
      },
    });
    return Effect.gen(function* () {
      const result = yield* runStatus(harness);
      expect(result).toMatchObject({
        attached: true,
        worktreePath: "/worktrees/project/existing",
        branch: "feature/existing",
        defaultStartFromOrigin: false,
      });
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
