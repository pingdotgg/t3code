import {
  CommandId,
  MessageId,
  type ProjectId,
  type ThreadSelectProjectMcpInput,
  type ThreadSelectProjectMcpResult,
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
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import type { McpInvocationScope, McpThreadInvocationScope } from "./McpInvocationContext.ts";

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
    /** Moves a "No project" thread into a project before it has touched any files. */
    readonly selectProject: (
      scope: McpInvocationScope,
      input: ThreadSelectProjectMcpInput,
    ) => Effect.Effect<ThreadSelectProjectMcpResult, WorktreeMcpFailure>;
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
  const threadManagement = yield* ThreadManagementService.ThreadManagementService;
  const projects = yield* ProjectService.ProjectService;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const gitWorkflow = yield* GitWorkflowService.GitWorkflowService;
  const setupScriptRunner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
  const vcsStatusBroadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
  const managedFolders = yield* ManagedProjectFolders.ManagedProjectFolders;
  const fileSystem = yield* FileSystem.FileSystem;

  // Serializes workspace changes per thread: two concurrent handoffs could
  // otherwise both pass the worktreePath === null check and each create a
  // worktree, leaving one untracked on disk.
  const workspaceChangesInFlight = new Set<string>();

  const requireThreadScope = (scope: McpInvocationScope) =>
    scope.thread === undefined
      ? Effect.fail(
          failure(
            "thread_credential_required",
            "Worktree handoff, worktree status, and project selection act as the calling T3 thread, so they need an agent running inside T3 Code.",
          ),
        )
      : Effect.succeed(scope as McpThreadInvocationScope);

  const requireCapability = (scope: McpInvocationScope) =>
    scope.capabilities.has("worktree")
      ? Effect.void
      : Effect.fail(
          failure("capability_denied", "This MCP credential does not grant worktree capabilities."),
        );

  const loadThread = (scope: McpThreadInvocationScope) =>
    threadManagement.getThreadRecords(scope.thread.threadId, []).pipe(
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

  const readDefaultStartFromOrigin = serverSettings.getSettings.pipe(
    Effect.map((settings) => settings.newWorktreesStartFromOrigin),
    asOperationFailed("Unable to read server settings"),
  );

  const operationIds = (
    scope: McpThreadInvocationScope,
    operation: string,
    continuationOperation: string,
  ) =>
    crypto.randomUUIDv4().pipe(
      Effect.map((uuid) => {
        const part = (kind: string, name: string) =>
          [kind, "mcp", encodeURIComponent(scope.thread.providerSessionId), name, uuid].join(":");
        return {
          commandId: CommandId.make(part("command", operation)),
          continuationCommandId: CommandId.make(part("command", continuationOperation)),
          continuationMessageId: MessageId.make(part("message", continuationOperation)),
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

    const startFromOrigin = input.startFromOrigin ?? (yield* readDefaultStartFromOrigin);

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

    const ids = yield* operationIds(scope, "worktree-handoff", "worktree-continuation");

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
          // The projection was read before the potentially slow git work
          // above; a concurrent binding (for example from the UI) could have
          // attached the thread in the meantime. Re-check before committing so
          // the race cannot leave a second, untracked worktree.
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
          yield* threadManagement
            .dispatch({
              type: "thread.metadata.update",
              commandId: ids.commandId,
              threadId: scope.thread.threadId,
              branch: worktree.worktree.refName,
              worktreePath,
              expectedWorktreePath: null,
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
          // Interrupt-only causes skip the removal: the binding may have
          // committed, and force-deleting a worktree the thread now points at
          // would be worse than leaking one.
          Effect.onError((cause) =>
            Cause.hasInterruptsOnly(cause) ? Effect.void : removeCreatedWorktree,
          ),
        );

        // Queue the continuation right after the binding commits: the detach
        // that the metadata update schedules will terminate the calling
        // session, and a durably queued message is what guarantees the thread
        // re-launches inside the worktree.
        const queueContinuation: Effect.Effect<WorktreeMcpContinuationStatus, WorktreeMcpFailure> =
          Effect.suspend(() =>
            input.continuationPrompt === undefined
              ? Effect.succeed<WorktreeMcpContinuationStatus>({ status: "skipped" })
              : threadManagement
                  .sendToThread({
                    projectId: projection.thread.projectId,
                    commandId: ids.continuationCommandId,
                    threadId: scope.thread.threadId,
                    messageId: ids.continuationMessageId,
                    text: input.continuationPrompt,
                    attachments: [],
                    mode: "queue",
                    createdBy: "agent",
                    creationSource: "mcp",
                  })
                  .pipe(
                    Effect.map((sendResult): WorktreeMcpContinuationStatus => ({
                      status: "scheduled",
                      delivery: sendResult.delivery,
                    })),
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
              ? "Handoff recorded. This turn still runs in the previous workspace, so end it now; the queued continuation prompt then starts the next turn inside the worktree with the conversation preserved. The worktree is not removed automatically when the thread is deleted."
              : "Handoff recorded. This turn still runs in the previous workspace, so end it now; the conversation continues inside the worktree when the thread receives its next message. Pass continuationPrompt to resume automatically. The worktree is not removed automatically when the thread is deleted.",
        };
        return result;
      }),
    );
  });

  // uninterruptibleMask: the guard acquisition and the registration of the
  // releasing finalizer happen with no interruptible gap in between. An
  // interrupt landing between a bare add() and the start of an ensured effect
  // would otherwise leak the guard entry and block every future workspace
  // change for this thread until restart.
  const exclusivelyForThread = <A>(
    scope: McpThreadInvocationScope,
    operation: Effect.Effect<A, WorktreeMcpFailure>,
  ) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.suspend(() => {
        const threadId = scope.thread.threadId;
        if (workspaceChangesInFlight.has(threadId)) {
          return Effect.fail(
            failure(
              "handoff_in_progress",
              `A worktree handoff or project selection is already in progress for thread '${threadId}'.`,
            ),
          );
        }
        workspaceChangesInFlight.add(threadId);
        return restore(operation).pipe(
          Effect.ensuring(Effect.sync(() => workspaceChangesInFlight.delete(threadId))),
        );
      }),
    );

  const handoff: WorktreeMcpService["Service"]["handoff"] = Effect.fn("WorktreeMcpService.handoff")(
    function* (callerScope, input) {
      yield* requireCapability(callerScope);
      const scope = yield* requireThreadScope(callerScope);
      return yield* exclusivelyForThread(scope, performHandoff(scope, input));
    },
  );

  // A missing folder has nothing in it to lose.
  const isEmptyFolder = (folder: string) =>
    fileSystem.readDirectory(folder).pipe(
      Effect.map((entries) => entries.length === 0),
      Effect.catchIf(
        (error) => error.reason._tag === "NotFound",
        () => Effect.succeed(true),
      ),
      asOperationFailed(`Unable to read the thread's folder '${folder}'`),
    );

  const performSelectProject = Effect.fn("WorktreeMcpService.performSelectProject")(function* (
    scope: McpThreadInvocationScope,
    input: ThreadSelectProjectMcpInput,
  ) {
    const { thread } = yield* loadThread(scope);
    if (thread.archivedAt !== null) {
      return yield* failure(
        "invalid_request",
        `Thread '${thread.id}' is archived and cannot move to a project.`,
      );
    }
    if (
      thread.lineage.relationshipToParent === "subagent" ||
      !(yield* managedFolders.isScratchProject(thread.projectId))
    ) {
      return yield* failure(
        "invalid_request",
        "Only a top-level thread without a project can select its project. To work in another project, start a thread there with t3_thread_launch.",
      );
    }
    if (thread.worktreePath !== null && !(yield* isEmptyFolder(thread.worktreePath))) {
      return yield* failure(
        "invalid_request",
        `This thread already has files in '${thread.worktreePath}', so it can no longer move to a project. Start a thread in the project with t3_thread_launch and its projectId instead.`,
      );
    }
    const target = yield* loadProject(scope, input.projectId);
    if (yield* managedFolders.isScratchProject(target.id)) {
      return yield* failure(
        "invalid_request",
        "That is the project for threads without a project. Pick one of the user's projects from t3_project_list.",
      );
    }

    const ids = yield* operationIds(scope, "select-project", "select-project-continuation");
    const continuationPrompt =
      input.continuationPrompt ??
      `This thread now works in the ${target.title} project at ${target.workspaceRoot}. Continue the user's request there.`;

    // uninterruptibleMask: once the move commits, the queued continuation is
    // what starts the thread in the project, so a cancelled request must not
    // skip it.
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        yield* restore(
          threadManagement.dispatch({
            type: "thread.project.set",
            commandId: ids.commandId,
            threadId: thread.id,
            projectId: target.id,
            expectedWorktreePath: thread.worktreePath,
          }),
        ).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.failCause(cause as Cause.Cause<never>)
              : Effect.fail(
                  failure(
                    "operation_failed",
                    `Unable to move the thread to project '${target.id}': ${errorMessage(Cause.squash(cause))}`,
                  ),
                ),
          ),
        );

        const continuation = yield* threadManagement
          .sendToThread({
            projectId: target.id,
            commandId: ids.continuationCommandId,
            threadId: thread.id,
            messageId: ids.continuationMessageId,
            text: continuationPrompt,
            attachments: [],
            mode: "queue",
            createdBy: "agent",
            creationSource: "mcp",
          })
          .pipe(
            Effect.map((sendResult): WorktreeMcpContinuationStatus => ({
              status: "scheduled",
              delivery: sendResult.delivery,
            })),
            Effect.catchCause((cause) => {
              const detail = errorMessage(Cause.squash(cause));
              return Effect.logWarning("project selection continuation failed to queue", {
                threadId: thread.id,
                projectId: target.id,
                detail,
              }).pipe(Effect.as<WorktreeMcpContinuationStatus>({ status: "failed", detail }));
            }),
          );

        const result: ThreadSelectProjectMcpResult = {
          projectId: target.id,
          workspaceRoot: target.workspaceRoot,
          continuation,
          note:
            continuation.status === "scheduled"
              ? "Thread moved to the project's root. This turn still runs in the scratch folder, so end it now without touching files; the queued continuation then starts the next turn in the project with the conversation preserved. Use t3_worktree_handoff there if the work needs its own worktree."
              : "Thread moved to the project's root. This turn still runs in the scratch folder, so end it now without touching files; the conversation continues in the project when the thread receives its next message.",
        };
        return result;
      }),
    );
  });

  const selectProject: WorktreeMcpService["Service"]["selectProject"] = Effect.fn(
    "WorktreeMcpService.selectProject",
  )(function* (callerScope, input) {
    yield* requireCapability(callerScope);
    const scope = yield* requireThreadScope(callerScope);
    return yield* exclusivelyForThread(scope, performSelectProject(scope, input));
  });

  const status: WorktreeMcpService["Service"]["status"] = Effect.fn("WorktreeMcpService.status")(
    function* (callerScope) {
      yield* requireCapability(callerScope);
      const scope = yield* requireThreadScope(callerScope);
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

  return WorktreeMcpService.of({ handoff, status, selectProject });
});

export const layer: Layer.Layer<
  WorktreeMcpService,
  never,
  | Crypto.Crypto
  | ThreadManagementService.ThreadManagementService
  | ProjectService.ProjectService
  | ServerSettings.ServerSettingsService
  | GitWorkflowService.GitWorkflowService
  | ProjectSetupScriptRunner.ProjectSetupScriptRunner
  | VcsStatusBroadcaster.VcsStatusBroadcaster
  | ManagedProjectFolders.ManagedProjectFolders
  | FileSystem.FileSystem
> = Layer.effect(WorktreeMcpService, make);
