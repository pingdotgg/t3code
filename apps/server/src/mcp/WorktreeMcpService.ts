import {
  CommandId,
  type GitCommandError,
  MessageId,
  type ProjectId,
  type ProviderSessionId,
  WorktreeMcpFailure,
  type WorktreeMcpContinuationStatus,
  type WorktreeMcpHandoffInput,
  type WorktreeMcpHandoffResult,
  type WorktreeMcpReleaseInput,
  type WorktreeMcpReleaseResult,
  type WorktreeMcpSetupScriptStatus,
  type WorktreeMcpStatusResult,
  type VcsListRefsInput,
  type VcsListRefsResult,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as PlatformError from "effect/PlatformError";
import * as Schedule from "effect/Schedule";

import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import type { McpInvocationScope, McpThreadInvocationScope } from "./McpInvocationContext.ts";

export class WorktreeMcpService extends Context.Service<
  WorktreeMcpService,
  {
    readonly handoff: (
      scope: McpInvocationScope,
      input: WorktreeMcpHandoffInput,
    ) => Effect.Effect<WorktreeMcpHandoffResult, WorktreeMcpFailure>;
    readonly release: (
      scope: McpInvocationScope,
      input: WorktreeMcpReleaseInput,
    ) => Effect.Effect<WorktreeMcpReleaseResult, WorktreeMcpFailure>;
    readonly status: (
      scope: McpInvocationScope,
    ) => Effect.Effect<WorktreeMcpStatusResult, WorktreeMcpFailure>;
    readonly listRefs: (
      input: Omit<VcsListRefsInput, "cwd"> & {
        readonly worktreePath: string | null;
        readonly workspaceRoot: string;
      },
    ) => Effect.Effect<VcsListRefsResult, GitCommandError | PlatformError.PlatformError>;
  }
>()("t3/mcp/WorktreeMcpService") {}

function failure(code: WorktreeMcpFailure["code"], message: string): WorktreeMcpFailure {
  return new WorktreeMcpFailure({ code, message });
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}

const asOperationFailed = (prefix: string) =>
  Effect.mapError((error: unknown) =>
    failure("operation_failed", `${prefix}: ${errorMessage(error)}`),
  );

// Covers a provider session that takes a while to exit, and Windows processes that briefly hold the folder.
const RELEASE_RETRY = { times: 60, schedule: Schedule.spaced("2 seconds") } as const;

const make = Effect.gen(function* () {
  const random = yield* SecureRandom.SecureRandom;
  const fileSystem = yield* FileSystem.FileSystem;
  const threadManagement = yield* ThreadManagementService.ThreadManagementService;
  const projects = yield* ProjectService.ProjectService;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const gitWorkflow = yield* GitWorkflowService.GitWorkflowService;
  const gitDriver = yield* GitVcsDriver.GitVcsDriver;
  const providerSessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
  const setupScriptRunner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
  const vcsStatusBroadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;

  // Serialize handoffs and releases per thread to avoid creating two worktrees and orphaning one.
  const threadsInFlight = new Set<string>();

  const requireThreadScope = (scope: McpInvocationScope) =>
    scope.thread === undefined
      ? Effect.fail(
          failure(
            "thread_credential_required",
            "Worktree handoff, release, and status act as the calling T3 thread, so they need an agent running inside T3 Code.",
          ),
        )
      : Effect.succeed(scope as McpThreadInvocationScope);

  const requireCapability = (scope: McpInvocationScope) =>
    scope.capabilities.has("worktree")
      ? Effect.void
      : Effect.fail(
          failure("capability_denied", "This MCP credential does not grant worktree capabilities."),
        );

  const loadThread = (
    scope: McpThreadInvocationScope,
    fields: ReadonlyArray<"providerSessions"> = [],
  ) =>
    threadManagement.getThreadRecords(scope.thread.threadId, fields).pipe(
      Effect.mapError((error) =>
        error._tag === "OrchestratorProjectionError"
          ? failure("thread_not_found", `Thread '${scope.thread.threadId}' was not found.`)
          : failure(
              "operation_failed",
              `Unable to read thread ${scope.thread.threadId}: ${errorMessage(error)}`,
            ),
      ),
      Effect.filterOrFail(
        (projection) => projection.thread.deletedAt === null,
        () => failure("thread_not_found", `Thread '${scope.thread.threadId}' was not found.`),
      ),
    );

  const loadProject = (scope: McpThreadInvocationScope, projectId: ProjectId) =>
    projects.getById(projectId).pipe(
      asOperationFailed(`Unable to read project ${projectId}`),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              failure(
                "project_not_found",
                `Project '${projectId}' was not found for thread '${scope.thread.threadId}'.`,
              ),
            ),
          onSome: Effect.succeed,
        }),
      ),
    );

  const readDefaultStartFromOrigin = (projectId: ProjectId) =>
    serverSettings.getSettings.pipe(
      Effect.map(
        (settings) =>
          resolveProjectSettings(settings, projectId).settings.newWorktreesStartFromOrigin,
      ),
      asOperationFailed("Unable to read server settings"),
    );

  const handoffIds = (scope: McpThreadInvocationScope) =>
    random.uuidV4().pipe(
      Effect.map((uuid) => {
        const part = (kind: string, operation: string) =>
          [kind, "mcp", encodeURIComponent(scope.thread.providerSessionId), operation, uuid].join(
            ":",
          );
        return {
          commandId: CommandId.make(part("command", "worktree-handoff")),
          continuationMessageId: MessageId.make(part("message", "worktree-continuation")),
        };
      }),
      Effect.orDie,
    );

  const performHandoff = Effect.fn("WorktreeMcpService.performHandoff")(function* (
    scope: McpThreadInvocationScope,
    input: WorktreeMcpHandoffInput,
  ) {
    const alreadyInWorktree = (worktreePath: string) =>
      failure(
        "already_in_worktree",
        `Thread '${scope.thread.threadId}' is already attached to worktree '${worktreePath}'.`,
      );

    const projection = yield* loadThread(scope);
    if (projection.thread.worktreePath !== null) {
      return yield* alreadyInWorktree(projection.thread.worktreePath);
    }
    if (projection.thread.archivedAt !== null) {
      return yield* failure(
        "invalid_request",
        `Thread '${scope.thread.threadId}' is archived and cannot be handed off to a worktree.`,
      );
    }

    const project = yield* loadProject(scope, projection.thread.projectId);
    const projectCwd = project.workspaceRoot;

    const localStatus = yield* gitWorkflow
      .localStatus({ cwd: projectCwd })
      .pipe(asOperationFailed("Unable to read git status"));
    if (!localStatus.isRepo) {
      return yield* failure(
        "invalid_request",
        `Project workspace '${projectCwd}' is not a git repository.`,
      );
    }

    const localBranchNames = yield* gitWorkflow
      .listLocalBranchNames(projectCwd)
      .pipe(asOperationFailed("Unable to list branches"));
    if (localBranchNames.includes(input.branch)) {
      const existingRef = yield* gitWorkflow
        .listRefs({ cwd: projectCwd, query: input.branch, refKind: "local" })
        .pipe(
          Effect.map((result) =>
            result.refs.find((ref) => ref.name === input.branch && ref.isRemote !== true),
          ),
          Effect.orElseSucceed(() => undefined),
        );
      const checkoutPath = existingRef?.worktreePath ?? null;
      return yield* failure(
        "invalid_request",
        `Branch '${input.branch}' already exists${
          checkoutPath === null ? "" : ` and is checked out at '${checkoutPath}'`
        }. Choose a different branch name, or delete the existing branch${
          checkoutPath === null ? "" : " and its worktree"
        } first.`,
      );
    }

    let baseRef = input.baseRef;
    if (baseRef === undefined) {
      if (localStatus.refName === null) {
        return yield* failure(
          "invalid_request",
          "Could not determine the current branch of the project workspace (detached HEAD?). Pass baseRef explicitly.",
        );
      }
      baseRef = localStatus.refName;
    }

    const startFromOrigin =
      input.startFromOrigin ?? (yield* readDefaultStartFromOrigin(project.id));

    let worktreeBaseRef = baseRef;
    let baseRefName = baseRef;
    let startedFromOrigin = false;
    if (startFromOrigin) {
      const resolvedRemoteBase = yield* gitWorkflow
        .fetchWorktreeBaseCommit({ cwd: projectCwd, refName: baseRef })
        .pipe(asOperationFailed(`Unable to fetch the remote base of '${baseRef}'`));
      if (resolvedRemoteBase !== null) {
        worktreeBaseRef = resolvedRemoteBase.commitSha;
        baseRefName = `refs/remotes/${resolvedRemoteBase.remoteRefName}`;
        startedFromOrigin = true;
      }
    }

    const ids = yield* handoffIds(scope);

    // Mask interruption after worktree creation through setup; binding can detach and interrupt the caller.
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const worktree = yield* restore(
          gitWorkflow
            .createWorktree({
              cwd: projectCwd,
              refName: worktreeBaseRef,
              newRefName: input.branch,
              baseRefName,
              path: null,
            })
            .pipe(asOperationFailed("Unable to create the worktree")),
        );
        const worktreePath = worktree.worktree.path;

        const reportFailed = (logMessage: string) =>
          Effect.catchCause((cause: Cause.Cause<unknown>) => {
            const detail = errorMessage(Cause.squash(cause));
            return Effect.logWarning(logMessage, {
              threadId: scope.thread.threadId,
              worktreePath,
              detail,
            }).pipe(Effect.as({ status: "failed", detail } as const));
          });

        const removeCreatedWorktree = Effect.suspend(() =>
          gitWorkflow.removeWorktree({ cwd: projectCwd, path: worktreePath, force: true }).pipe(
            Effect.andThen(
              Effect.suspend(() =>
                gitWorkflow.deleteLocalBranch({
                  cwd: projectCwd,
                  refName: worktree.worktree.refName,
                  force: true,
                }),
              ),
            ),
          ),
        ).pipe(Effect.ignoreCause({ log: true }));

        const recheckAndBind = Effect.gen(function* () {
          // A concurrent UI binding may have landed during git work; do not orphan a second worktree.
          const recheck = yield* loadThread(scope);
          if (recheck.thread.worktreePath !== null) {
            return yield* alreadyInWorktree(recheck.thread.worktreePath);
          }
          if (recheck.thread.archivedAt !== null) {
            return yield* failure(
              "invalid_request",
              `Thread '${scope.thread.threadId}' was archived while the worktree was being created; the handoff was rolled back.`,
            );
          }
          return yield* threadManagement
            .dispatch({
              type: "thread.metadata.update",
              commandId: ids.commandId,
              threadId: scope.thread.threadId,
              branch: worktree.worktree.refName,
              worktreePath,
              expectedWorktreePath: null,
              // Binding detaches the session and ends the caller; a later send could lose the race.
              ...(input.continuationPrompt === undefined
                ? {}
                : {
                    continuation: {
                      messageId: ids.continuationMessageId,
                      text: input.continuationPrompt,
                    },
                  }),
            })
            .pipe(
              Effect.catchCause((cause) =>
                Cause.hasInterruptsOnly(cause)
                  ? Effect.failCause(cause as Cause.Cause<never>)
                  : Effect.fail(
                      failure(
                        "operation_failed",
                        `Unable to re-point the thread at the worktree: ${errorMessage(Cause.squash(cause))}`,
                      ),
                    ),
              ),
            );
        }).pipe(
          // Do not remove on interruption alone; the thread binding may already have committed.
          Effect.onError((cause) =>
            Cause.hasInterruptsOnly(cause) ? Effect.void : removeCreatedWorktree,
          ),
        );

        const bound = yield* recheckAndBind;
        const continuation: WorktreeMcpContinuationStatus =
          input.continuationPrompt === undefined
            ? { status: "skipped" }
            : {
                status: "scheduled",
                delivery: bound.storedEvents.some(
                  ({ event }) => event.type === "run.created" && event.payload.status !== "queued",
                )
                  ? "started"
                  : "queued",
              };

        yield* vcsStatusBroadcaster
          .refreshStatus(worktreePath)
          .pipe(Effect.ignoreCause({ log: true }), Effect.forkDetach);

        let setupScript: WorktreeMcpSetupScriptStatus = { status: "skipped" };
        if (input.runSetupScript ?? true) {
          setupScript = yield* setupScriptRunner
            .runForThread({
              threadId: scope.thread.threadId,
              projectId: projection.thread.projectId,
              projectCwd,
              worktreePath,
              project: {
                id: project.id,
                workspaceRoot: project.workspaceRoot,
                scripts: project.scripts,
              },
            })
            .pipe(
              Effect.map((result): WorktreeMcpSetupScriptStatus =>
                result.status === "started"
                  ? {
                      status: "started",
                      scriptName: result.scriptName,
                      terminalId: result.terminalId,
                    }
                  : result.status === "skipped-for-link"
                    ? { status: "skipped" }
                    : { status: "no-script" },
              ),
              reportFailed("worktree handoff setup script failed"),
            );
        }

        const result: WorktreeMcpHandoffResult = {
          worktreePath,
          branch: worktree.worktree.refName,
          baseRef,
          startedFromOrigin,
          setupScript,
          continuation,
          note:
            continuation.status === "scheduled"
              ? "Handoff recorded. Changing the workspace detaches this provider session, so the current turn ends shortly after this call; the queued continuation prompt then starts the next turn inside the worktree with the conversation preserved. The worktree is not removed automatically when the thread is deleted."
              : "Handoff recorded. Changing the workspace detaches this provider session, so the current turn ends shortly after this call; the conversation continues inside the worktree when the thread receives its next message. Pass continuationPrompt to resume automatically. The worktree is not removed automatically when the thread is deleted.",
        };
        return result;
      }),
    );
  });

  const handoff: WorktreeMcpService["Service"]["handoff"] = Effect.fn("WorktreeMcpService.handoff")(
    function* (callerScope, input) {
      yield* requireCapability(callerScope);
      const scope = yield* requireThreadScope(callerScope);
      return yield* exclusive(scope, performHandoff(scope, input));
    },
  );

  // Acquire and register cleanup atomically so cancellation cannot strand the guard until restart.
  const exclusive = <A>(
    scope: McpThreadInvocationScope,
    effect: Effect.Effect<A, WorktreeMcpFailure>,
  ): Effect.Effect<A, WorktreeMcpFailure> =>
    Effect.uninterruptibleMask((restore) =>
      Effect.suspend(() => {
        if (threadsInFlight.has(scope.thread.threadId)) {
          return Effect.fail(
            failure(
              "handoff_in_progress",
              `A worktree handoff or release is already in progress for thread '${scope.thread.threadId}'.`,
            ),
          );
        }
        threadsInFlight.add(scope.thread.threadId);
        return restore(effect).pipe(
          Effect.ensuring(Effect.sync(() => threadsInFlight.delete(scope.thread.threadId))),
        );
      }),
    );

  // Runs detached: the binding change ends the caller's session, and on Windows its process holds the folder until it exits.
  const removeReleasedWorktree = Effect.fn("WorktreeMcpService.removeReleasedWorktree")(
    function* (input: {
      readonly projectCwd: string;
      readonly worktreePath: string;
      readonly branch: string | null;
      readonly providerSessionIds: ReadonlyArray<ProviderSessionId>;
      readonly force: boolean;
      readonly deleteBranch: boolean;
    }) {
      // Removal still runs if a session outlasts the wait; its own retries cover a brief hold.
      yield* Effect.forEach(input.providerSessionIds, providerSessions.isLive).pipe(
        Effect.filterOrFail(
          (live) => !live.includes(true),
          () => "provider session is still open",
        ),
        Effect.retry(RELEASE_RETRY),
        Effect.ignore,
      );
      yield* gitWorkflow
        .removeWorktree({ cwd: input.projectCwd, path: input.worktreePath, force: input.force })
        .pipe(Effect.retry(RELEASE_RETRY));
      if (input.deleteBranch && input.branch !== null) {
        yield* gitWorkflow.deleteLocalBranch({
          cwd: input.projectCwd,
          refName: input.branch,
          force: true,
        });
      }
      yield* vcsStatusBroadcaster
        .refreshStatus(input.projectCwd)
        .pipe(Effect.ignoreCause({ log: true }));
    },
    (effect, input) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("worktree release could not remove the worktree", {
            worktreePath: input.worktreePath,
            detail: errorMessage(Cause.squash(cause)),
          }),
        ),
      ),
  );

  const performRelease = Effect.fn("WorktreeMcpService.performRelease")(function* (
    scope: McpThreadInvocationScope,
    input: WorktreeMcpReleaseInput,
  ) {
    const projection = yield* loadThread(scope, ["providerSessions"]);
    const worktreePath = projection.thread.worktreePath;
    if (worktreePath === null) {
      return yield* failure(
        "not_in_worktree",
        `Thread '${scope.thread.threadId}' is not attached to a worktree.`,
      );
    }
    const project = yield* loadProject(scope, projection.thread.projectId);
    const projectCwd = project.workspaceRoot;
    if (worktreePath === projectCwd) {
      return yield* failure(
        "invalid_request",
        `Thread '${scope.thread.threadId}' runs in the project root, not a separate worktree.`,
      );
    }
    const force = input.force === true;
    const exists = yield* fileSystem
      .exists(worktreePath)
      .pipe(asOperationFailed("Unable to check the worktree folder"));
    // Subagent threads can share the parent's checkout.
    const sharedWith = (yield* threadManagement
      .listProjectThreads({ projectId: project.id, includeSubagents: true })
      .pipe(asOperationFailed("Unable to list the project's threads"))).filter(
      (thread) => thread.worktreePath === worktreePath && thread.id !== scope.thread.threadId,
    ).length;

    let branch = projection.thread.branch;
    if (exists && sharedWith === 0) {
      const status = yield* gitWorkflow
        .localStatus({ cwd: worktreePath })
        .pipe(asOperationFailed("Unable to read the worktree's git status"));
      branch = status.refName ?? branch;
      if (!force && status.hasWorkingTreeChanges) {
        return yield* failure(
          "unsaved_work",
          `Worktree '${worktreePath}' has uncommitted changes. Commit and push them, or pass force: true to discard them.`,
        );
      }
      if (!force) {
        // Commits only this checkout reaches: on no remote and no other local branch.
        const unpushed = yield* gitDriver
          .execute({
            operation: "WorktreeMcpService.countUnpushedCommits",
            cwd: worktreePath,
            args: [
              "rev-list",
              "--count",
              "HEAD",
              "--not",
              ...(status.refName === null ? [] : [`--exclude=${status.refName}`]),
              "--branches",
              "--remotes",
            ],
          })
          .pipe(
            Effect.map((result) => Number.parseInt(result.stdout.trim(), 10)),
            asOperationFailed("Unable to count unpushed commits"),
          );
        if (unpushed > 0) {
          return yield* failure(
            "unsaved_work",
            `Worktree '${worktreePath}' has ${unpushed} commit${unpushed === 1 ? "" : "s"} on no remote or other branch. Push them, or pass force: true to discard them.`,
          );
        }
      }
    }

    const commandId = yield* random.uuidV4().pipe(
      Effect.map((uuid) =>
        CommandId.make(
          [
            "command",
            "mcp",
            encodeURIComponent(scope.thread.providerSessionId),
            "worktree-release",
            uuid,
          ].join(":"),
        ),
      ),
      Effect.orDie,
    );
    const removal: WorktreeMcpReleaseResult["removal"] =
      sharedWith > 0 ? "kept-shared" : exists ? "scheduled" : "already-gone";

    // The binding change detaches the caller, so schedule removal in the same uninterruptible step.
    return yield* Effect.uninterruptible(
      Effect.gen(function* () {
        // Clearing the binding also stops the next turn from recreating the checkout.
        yield* threadManagement
          .dispatch({
            type: "thread.metadata.update",
            commandId,
            threadId: scope.thread.threadId,
            branch: null,
            worktreePath: null,
            expectedWorktreePath: worktreePath,
          })
          .pipe(asOperationFailed("Unable to re-point the thread at the project root"));
        if (removal !== "kept-shared") {
          // A folder already gone can still leave Git metadata to prune and a branch to delete.
          yield* removeReleasedWorktree({
            projectCwd,
            worktreePath,
            branch,
            providerSessionIds: projection.providerSessions.map((session) => session.id),
            force,
            deleteBranch: input.deleteBranch === true,
          }).pipe(Effect.forkDetach);
        }
        const result: WorktreeMcpReleaseResult = {
          worktreePath,
          branch,
          removal,
          note:
            removal === "kept-shared"
              ? `Released. The thread now runs in the project root and this session ends shortly after this call. The worktree stays because ${sharedWith} other thread${sharedWith === 1 ? " uses" : "s use"} it.`
              : "Released. The thread now runs in the project root and this session ends shortly after this call. T3 removes the worktree once the session has left it. A folder it cannot remove shows up in the storage cleanup report.",
        };
        return result;
      }),
    );
  });

  const release: WorktreeMcpService["Service"]["release"] = Effect.fn("WorktreeMcpService.release")(
    function* (callerScope, input) {
      yield* requireCapability(callerScope);
      const scope = yield* requireThreadScope(callerScope);
      return yield* exclusive(scope, performRelease(scope, input));
    },
  );

  const status: WorktreeMcpService["Service"]["status"] = Effect.fn("WorktreeMcpService.status")(
    function* (callerScope) {
      yield* requireCapability(callerScope);
      const scope = yield* requireThreadScope(callerScope);
      const projection = yield* loadThread(scope);
      const project = yield* loadProject(scope, projection.thread.projectId);

      const defaultStartFromOrigin = yield* readDefaultStartFromOrigin(project.id);

      // Storage cleanup and manual removal leave the binding behind.
      const worktreePath = projection.thread.worktreePath;
      const missing =
        worktreePath !== null &&
        !(yield* fileSystem.exists(worktreePath).pipe(Effect.orElseSucceed(() => true)));

      const result: WorktreeMcpStatusResult = {
        attached: worktreePath !== null,
        worktreePath,
        missing,
        branch: projection.thread.branch,
        projectWorkspaceRoot: project.workspaceRoot,
        defaultStartFromOrigin,
      };
      return result;
    },
  );

  const listRefs: WorktreeMcpService["Service"]["listRefs"] = Effect.fn(
    "WorktreeMcpService.listRefs",
  )(function* ({ worktreePath, workspaceRoot, ...refs }) {
    // Storage cleanup removes a worktree but keeps its path on the thread.
    const cwd =
      worktreePath !== null && (yield* fileSystem.exists(worktreePath))
        ? worktreePath
        : workspaceRoot;
    return yield* gitWorkflow.listRefs({ ...refs, cwd });
  });

  return WorktreeMcpService.of({ handoff, release, status, listRefs });
});

export const layer: Layer.Layer<
  WorktreeMcpService,
  never,
  | SecureRandom.SecureRandom
  | FileSystem.FileSystem
  | ThreadManagementService.ThreadManagementService
  | ProjectService.ProjectService
  | ServerSettings.ServerSettingsService
  | GitWorkflowService.GitWorkflowService
  | GitVcsDriver.GitVcsDriver
  | ProviderSessionManager.ProviderSessionManagerV2
  | ProjectSetupScriptRunner.ProjectSetupScriptRunner
  | VcsStatusBroadcaster.VcsStatusBroadcaster
> = Layer.effect(WorktreeMcpService, make);
