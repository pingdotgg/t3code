import {
  CommandId,
  MessageId,
  type ProjectId,
  WorktreeMcpFailure,
  type WorktreeMcpContinuationStatus,
  type WorktreeMcpHandoffInput,
  type WorktreeMcpHandoffResult,
  type WorktreeMcpSetupScriptStatus,
  type WorktreeMcpStatusResult,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";

export class WorktreeMcpService extends Context.Service<
  WorktreeMcpService,
  {
    readonly handoff: (
      scope: McpInvocationScope,
      input: WorktreeMcpHandoffInput,
    ) => Effect.Effect<WorktreeMcpHandoffResult, WorktreeMcpFailure>;
    readonly status: (
      scope: McpInvocationScope,
    ) => Effect.Effect<WorktreeMcpStatusResult, WorktreeMcpFailure>;
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

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const path = yield* Path.Path;
  const threadManagement = yield* ThreadManagementService;
  const projects = yield* ProjectService.ProjectService;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const gitWorkflow = yield* GitWorkflowService.GitWorkflowService;
  const setupScriptRunner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
  const vcsStatusBroadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;

  // Serializes handoffs per thread: two concurrent calls could otherwise both
  // pass the worktreePath === null check and each create a worktree, leaving
  // one untracked on disk.
  const handoffThreadsInFlight = new Set<string>();

  const requireCapability = (scope: McpInvocationScope) =>
    scope.capabilities.has("worktree")
      ? Effect.void
      : Effect.fail(
          failure("capability_denied", "This MCP credential does not grant worktree capabilities."),
        );

  const loadThread = (scope: McpInvocationScope) =>
    threadManagement.getThreadProjection(scope.threadId).pipe(
      Effect.mapError((error) =>
        error._tag === "OrchestratorProjectionError"
          ? failure("thread_not_found", `Thread '${scope.threadId}' was not found.`)
          : failure(
              "operation_failed",
              `Unable to read thread ${scope.threadId}: ${errorMessage(error)}`,
            ),
      ),
      Effect.filterOrFail(
        (projection) => projection.thread.deletedAt === null,
        () => failure("thread_not_found", `Thread '${scope.threadId}' was not found.`),
      ),
    );

  const loadProject = (scope: McpInvocationScope, projectId: ProjectId) =>
    projects.getById(projectId).pipe(
      asOperationFailed(`Unable to read project ${projectId}`),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              failure(
                "project_not_found",
                `Project '${projectId}' was not found for thread '${scope.threadId}'.`,
              ),
            ),
          onSome: Effect.succeed,
        }),
      ),
    );

  const readDefaultStartFromOrigin = serverSettings.getSettings.pipe(
    Effect.map((settings) => settings.newWorktreesStartFromOrigin),
    asOperationFailed("Unable to read server settings"),
  );

  const handoffIds = (scope: McpInvocationScope) =>
    crypto.randomUUIDv4.pipe(
      Effect.map((uuid) => {
        const part = (kind: string, operation: string) =>
          [kind, "mcp", encodeURIComponent(scope.providerSessionId), operation, uuid].join(":");
        return {
          commandId: CommandId.make(part("command", "worktree-handoff")),
          continuationCommandId: CommandId.make(part("command", "worktree-continuation")),
          continuationMessageId: MessageId.make(part("message", "worktree-continuation")),
        };
      }),
      Effect.orDie,
    );

  const performHandoff = Effect.fn("WorktreeMcpService.performHandoff")(function* (
    scope: McpInvocationScope,
    input: WorktreeMcpHandoffInput,
  ) {
    const alreadyInWorktree = (worktreePath: string) =>
      failure(
        "already_in_worktree",
        `Thread '${scope.threadId}' is already attached to worktree '${worktreePath}'.`,
      );

    const projection = yield* loadThread(scope);
    if (projection.thread.worktreePath !== null) {
      return yield* alreadyInWorktree(projection.thread.worktreePath);
    }
    // An archived thread would accept the binding but refuse the continuation
    // message (and any other follow-up), so reject the handoff outright.
    if (projection.thread.archivedAt !== null) {
      return yield* failure(
        "invalid_request",
        `Thread '${scope.threadId}' is archived and cannot be handed off to a worktree.`,
      );
    }

    const project = yield* loadProject(scope, projection.thread.projectId);
    const projectCwd = project.workspaceRoot;

    if (input.path !== undefined && !path.isAbsolute(input.path)) {
      return yield* failure(
        "invalid_request",
        `path must be an absolute filesystem path, got '${input.path}'. A relative path would be created relative to the project workspace but stored verbatim as the thread's worktree binding.`,
      );
    }

    // The repo check runs regardless of whether baseRef was supplied, so a
    // non-repository workspace fails with an actionable error instead of an
    // opaque git failure further down.
    const localStatus = yield* gitWorkflow
      .localStatus({ cwd: projectCwd })
      .pipe(asOperationFailed("Unable to read git status"));
    if (!localStatus.isRepo) {
      return yield* failure(
        "invalid_request",
        `Project workspace '${projectCwd}' is not a git repository.`,
      );
    }

    // Fail fast with an actionable message when the branch already exists:
    // the git driver deliberately keeps stderr out of its errors, so letting
    // `git worktree add` fail would surface only an opaque failure. The
    // existence check uses the complete local branch list (exact match); the
    // paginated substring search only enriches the message with the checkout
    // location when available.
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

    const startFromOrigin = input.startFromOrigin ?? (yield* readDefaultStartFromOrigin);

    let worktreeBaseRef = baseRef;
    if (startFromOrigin) {
      yield* gitWorkflow
        .fetchRemote({ cwd: projectCwd, remoteName: "origin" })
        .pipe(asOperationFailed("Unable to fetch origin"));
      const resolvedRemoteBase = yield* gitWorkflow
        .resolveRemoteTrackingCommit({
          cwd: projectCwd,
          refName: baseRef,
          fallbackRemoteName: "origin",
        })
        .pipe(asOperationFailed(`Unable to resolve the remote-tracking commit of '${baseRef}'`));
      worktreeBaseRef = resolvedRemoteBase.commitSha;
    }

    const ids = yield* handoffIds(scope);

    // uninterruptibleMask: only the potentially slow worktree creation itself
    // stays interruptible (restore). From the moment it succeeds, through the
    // binding, continuation queue, setup script launch, and result
    // construction, there is no interruptible gap: a client cancel can
    // therefore neither orphan the created worktree before the rollback is
    // armed, nor skip setting up a worktree the thread was just bound to
    // (once the binding commits, the scheduled session detach can sever this
    // request's connection and interrupt the fiber).
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const worktree = yield* restore(
          gitWorkflow
            .createWorktree({
              cwd: projectCwd,
              refName: worktreeBaseRef,
              newRefName: input.branch,
              baseRefName: baseRef,
              path: input.path ?? null,
            })
            .pipe(asOperationFailed("Unable to create the worktree")),
        );
        const worktreePath = worktree.worktree.path;

        // Shared shape for "the handoff already succeeded, so report the failure
        // in the result instead of failing the call" (continuation, setup script).
        const reportFailed = (logMessage: string) =>
          Effect.catchCause((cause: Cause.Cause<unknown>) => {
            const detail = errorMessage(Cause.squash(cause));
            return Effect.logWarning(logMessage, {
              threadId: scope.threadId,
              worktreePath,
              detail,
            }).pipe(Effect.as({ status: "failed", detail } as const));
          });

        // suspend: build the removal call only if cleanup actually runs.
        const removeCreatedWorktree = Effect.suspend(() =>
          gitWorkflow.removeWorktree({ cwd: projectCwd, path: worktreePath, force: true }),
        ).pipe(Effect.ignoreCause({ log: true }));

        const recheckAndBind = Effect.gen(function* () {
          // The projection was read before the potentially slow git work
          // above; a concurrent binding (for example from the UI) could have
          // attached the thread in the meantime. Re-check before committing so
          // the race cannot leave a second, untracked worktree.
          const recheck = yield* loadThread(scope);
          if (recheck.thread.worktreePath !== null) {
            return yield* alreadyInWorktree(recheck.thread.worktreePath);
          }
          // Mirror the up-front archived check: the thread may have been
          // archived during the slow git work, and an archived thread must
          // not be bound to a fresh worktree it can never use.
          if (recheck.thread.archivedAt !== null) {
            return yield* failure(
              "invalid_request",
              `Thread '${scope.threadId}' was archived while the worktree was being created; the handoff was rolled back.`,
            );
          }
          yield* threadManagement
            .dispatch({
              type: "thread.metadata.update",
              commandId: ids.commandId,
              threadId: scope.threadId,
              branch: worktree.worktree.refName,
              worktreePath,
            })
            .pipe(
              Effect.catchCause((cause) =>
                // Interrupt-only causes propagate unchanged: whether the
                // dispatch committed is unknown, so neither a typed failure
                // nor a rollback would be correct. Failures and defects
                // (including mixed causes) map to a typed operation_failed.
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
          // onError: the worktree was already created, so any failure between
          // here and the committed binding (recheck read, recheck race,
          // dispatch typed failure or defect) must remove it again so a failed
          // handoff leaves nothing behind on disk. Interrupt-only causes skip
          // the removal: the binding may have committed, and force-deleting a
          // worktree the thread now points at would be worse than leaking one.
          Effect.onError((cause) =>
            Cause.hasInterruptsOnly(cause) ? Effect.void : removeCreatedWorktree,
          ),
        );

        // Queue the continuation right after the binding commits: the detach
        // that the metadata update schedules will terminate the calling
        // session, and a durably queued message is what guarantees the thread
        // re-launches inside the worktree. When the dying run reaches a
        // terminal state the orchestrator promotes the queued run, which
        // derives its cwd from the updated projection.
        // suspend: build the send effect only when the binding has succeeded,
        // so a failed dispatch never even constructs the continuation call.
        const queueContinuation: Effect.Effect<WorktreeMcpContinuationStatus, WorktreeMcpFailure> =
          Effect.suspend(() =>
            input.continuationPrompt === undefined
              ? Effect.succeed<WorktreeMcpContinuationStatus>({ status: "skipped" })
              : threadManagement
                  .sendToThread({
                    projectId: projection.thread.projectId,
                    commandId: ids.continuationCommandId,
                    threadId: scope.threadId,
                    messageId: ids.continuationMessageId,
                    text: input.continuationPrompt,
                    attachments: [],
                    mode: "queue",
                    createdBy: "agent",
                    creationSource: "mcp",
                  })
                  .pipe(
                    Effect.map(
                      (sendResult): WorktreeMcpContinuationStatus => ({
                        status: "scheduled",
                        delivery: sendResult.delivery,
                      }),
                    ),
                    // catchCause via reportFailed: the binding is already recorded,
                    // so a failed continuation must be reported, not fail the handoff.
                    reportFailed("worktree handoff continuation failed to queue"),
                  ),
          );

        const continuation = yield* recheckAndBind.pipe(Effect.andThen(queueContinuation));

        yield* vcsStatusBroadcaster
          .refreshStatus(worktreePath)
          .pipe(Effect.ignoreCause({ log: true }), Effect.forkDetach);

        let setupScript: WorktreeMcpSetupScriptStatus = { status: "skipped" };
        if (input.runSetupScript ?? true) {
          setupScript = yield* setupScriptRunner
            .runForThread({
              threadId: scope.threadId,
              projectId: projection.thread.projectId,
              projectCwd,
              worktreePath,
              project: {
                workspaceRoot: project.workspaceRoot,
                scripts: project.scripts,
              },
            })
            .pipe(
              Effect.map(
                (result): WorktreeMcpSetupScriptStatus =>
                  result.status === "started"
                    ? {
                        status: "started",
                        scriptName: result.scriptName,
                        terminalId: result.terminalId,
                      }
                    : { status: "no-script" },
              ),
              // catchCause via reportFailed: the thread is already re-pointed at the
              // worktree, so even a defect in the setup runner must not fail the handoff.
              reportFailed("worktree handoff setup script failed"),
            );
        }

        const result: WorktreeMcpHandoffResult = {
          worktreePath,
          branch: worktree.worktree.refName,
          baseRef,
          startedFromOrigin: startFromOrigin,
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
    function* (scope, input) {
      yield* requireCapability(scope);
      // uninterruptibleMask: the guard acquisition and the registration of the
      // releasing finalizer happen with no interruptible gap in between. An
      // interrupt landing between a bare add() and the start of an ensured
      // effect would otherwise leak the guard entry and block every future
      // handoff for this thread until restart.
      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.suspend(() => {
          if (handoffThreadsInFlight.has(scope.threadId)) {
            return Effect.fail(
              failure(
                "handoff_in_progress",
                `A worktree handoff is already in progress for thread '${scope.threadId}'.`,
              ),
            );
          }
          handoffThreadsInFlight.add(scope.threadId);
          return restore(performHandoff(scope, input)).pipe(
            Effect.ensuring(Effect.sync(() => handoffThreadsInFlight.delete(scope.threadId))),
          );
        }),
      );
    },
  );

  const status: WorktreeMcpService["Service"]["status"] = Effect.fn("WorktreeMcpService.status")(
    function* (scope) {
      yield* requireCapability(scope);
      const projection = yield* loadThread(scope);
      const project = yield* loadProject(scope, projection.thread.projectId);

      const defaultStartFromOrigin = yield* readDefaultStartFromOrigin;

      const result: WorktreeMcpStatusResult = {
        attached: projection.thread.worktreePath !== null,
        worktreePath: projection.thread.worktreePath,
        branch: projection.thread.branch,
        projectWorkspaceRoot: project.workspaceRoot,
        defaultStartFromOrigin,
      };
      return result;
    },
  );

  return WorktreeMcpService.of({ handoff, status });
});

export const layer: Layer.Layer<
  WorktreeMcpService,
  never,
  | Crypto.Crypto
  | Path.Path
  | ThreadManagementService
  | ProjectService.ProjectService
  | ServerSettings.ServerSettingsService
  | GitWorkflowService.GitWorkflowService
  | ProjectSetupScriptRunner.ProjectSetupScriptRunner
  | VcsStatusBroadcaster.VcsStatusBroadcaster
> = Layer.effect(WorktreeMcpService, make);
