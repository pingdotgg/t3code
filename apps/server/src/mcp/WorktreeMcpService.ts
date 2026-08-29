import {
  CommandId,
  MessageId,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
  type ProjectId,
  type VcsRef,
  type WorktreeMcpCheckoutInput,
  type WorktreeMcpCheckoutResult,
  WorktreeMcpFailure,
  type WorktreeMcpContinuationStatus,
  type WorktreeMcpHandoffInput,
  type WorktreeMcpHandoffResult,
  type WorktreeMcpListInput,
  type WorktreeMcpListResult,
  type WorktreeMcpSetupScriptStatus,
  type WorktreeMcpStatusResult,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
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
    readonly listWorktrees: (
      scope: McpInvocationScope,
      input: WorktreeMcpListInput,
    ) => Effect.Effect<WorktreeMcpListResult, WorktreeMcpFailure>;
    readonly checkout: (
      scope: McpInvocationScope,
      input: WorktreeMcpCheckoutInput,
    ) => Effect.Effect<WorktreeMcpCheckoutResult, WorktreeMcpFailure>;
  }
>()("t3/mcp/WorktreeMcpService") {}

function failure(
  code: WorktreeMcpFailure["code"],
  message: string,
  partial?: WorktreeMcpFailure["partial"],
): WorktreeMcpFailure {
  return new WorktreeMcpFailure({ code, message, ...(partial === undefined ? {} : { partial }) });
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
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const threadManagement = yield* ThreadManagementService;
  const projects = yield* ProjectService.ProjectService;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const gitWorkflow = yield* GitWorkflowService.GitWorkflowService;
  const setupScriptRunner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
  const vcsStatusBroadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;

  // Serializes workspace transitions per thread so two calls cannot both
  // mutate Git and then race to write different durable bindings.
  const workspaceTransitionsInFlight = new Set<string>();

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

  const normalizePath = (value: string) => path.normalize(path.resolve(value));

  const canonicalizePath = (value: string) => {
    const normalized = normalizePath(value);
    return fileSystem.realPath(normalized).pipe(Effect.orElseSucceed(() => normalized));
  };

  const threadWorkspacePath = Effect.fn("WorktreeMcpService.threadWorkspacePath")(function* (
    thread: Pick<OrchestrationV2ThreadShell, "worktreePath">,
    projectWorkspaceRoot: string,
  ) {
    return yield* canonicalizePath(thread.worktreePath ?? projectWorkspaceRoot);
  });

  const loadRefs = Effect.fn("WorktreeMcpService.loadRefs")(function* (
    projectWorkspaceRoot: string,
    refKind: "all" | "local" = "all",
  ) {
    const refs: Array<VcsRef> = [];
    let cursor: number | undefined;
    do {
      const page = yield* gitWorkflow
        .listRefs({
          cwd: projectWorkspaceRoot,
          refKind,
          includeMatchingRemoteRefs: refKind === "all",
          refresh: cursor === undefined,
          limit: 200,
          ...(cursor === undefined ? {} : { cursor }),
        })
        .pipe(asOperationFailed("Unable to list project worktrees and branches"));
      if (!page.isRepo) {
        return yield* failure(
          "invalid_request",
          `Project workspace '${projectWorkspaceRoot}' is not a git repository.`,
        );
      }
      refs.push(...page.refs);
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
    return refs;
  });

  const loadWorktrees = Effect.fn("WorktreeMcpService.loadWorktrees")(function* (
    projectWorkspaceRoot: string,
  ) {
    return yield* gitWorkflow
      .listWorktrees(projectWorkspaceRoot)
      .pipe(asOperationFailed("Unable to list project worktrees"));
  });

  const loadProjectThreads = (
    projectId: ProjectId,
  ): Effect.Effect<ReadonlyArray<OrchestrationV2ThreadShell>, WorktreeMcpFailure> =>
    threadManagement
      .listProjectThreads({ projectId, includeSubagents: true })
      .pipe(asOperationFailed(`Unable to list threads in project ${projectId}`));

  const loadActiveWorkspaceBindings = Effect.fn("WorktreeMcpService.loadActiveWorkspaceBindings")(
    function* (repositoryCommonDir: string) {
      const snapshot = yield* threadManagement
        .getShellSnapshot({ location: "active" })
        .pipe(asOperationFailed("Unable to inspect active thread workspace bindings"));
      const byProject = new Map<ProjectId, Array<OrchestrationV2ThreadShell>>();
      for (const thread of snapshot.threads) {
        const projectThreads = byProject.get(thread.projectId) ?? [];
        projectThreads.push(thread);
        byProject.set(thread.projectId, projectThreads);
      }

      return yield* Effect.forEach(
        [...byProject.entries()],
        ([projectId, projectThreads]) =>
          projects.getById(projectId).pipe(
            asOperationFailed(
              `Unable to read project ${projectId} while checking workspace owners`,
            ),
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.succeed([]),
                onSome: (project) =>
                  Effect.gen(function* () {
                    const projectInventory = yield* Effect.option(
                      loadWorktrees(project.workspaceRoot),
                    );
                    return yield* Effect.forEach(projectThreads, (thread) =>
                      Effect.gen(function* () {
                        const inventory =
                          thread.worktreePath === null
                            ? projectInventory
                            : yield* Effect.option(loadWorktrees(thread.worktreePath));
                        if (
                          Option.isNone(inventory) ||
                          inventory.value.repositoryCommonDir !== repositoryCommonDir ||
                          inventory.value.currentWorktreeRoot === null
                        ) {
                          return [];
                        }
                        return [[thread, inventory.value.currentWorktreeRoot] as const];
                      }),
                    ).pipe(Effect.map((bindings) => bindings.flat()));
                  }),
              }),
            ),
          ),
        { concurrency: 4 },
      ).pipe(Effect.map((bindings) => bindings.flat()));
    },
  );

  const readWorkspaceStatus = (workspacePath: string) =>
    gitWorkflow
      .invalidateLocalStatus(workspacePath)
      .pipe(
        Effect.andThen(gitWorkflow.localStatus({ cwd: workspacePath })),
        asOperationFailed(`Unable to read git status in '${workspacePath}'`),
      );

  const readWorkspaceBranchOrNull = (workspacePath: string) =>
    readWorkspaceStatus(workspacePath).pipe(
      Effect.map((status) => status.refName),
      Effect.orElseSucceed(() => null),
    );

  const transitionIds = (scope: McpInvocationScope, operation: "worktree-handoff" | "checkout") =>
    crypto.randomUUIDv4.pipe(
      Effect.map((uuid) => {
        const part = (kind: string, suffix: string) =>
          [kind, "mcp", encodeURIComponent(scope.providerSessionId), operation, suffix, uuid].join(
            ":",
          );
        return {
          commandId: CommandId.make(part("command", "binding")),
          continuationCommandId: CommandId.make(part("command", "continuation")),
          continuationMessageId: MessageId.make(part("message", "continuation")),
        };
      }),
      Effect.orDie,
    );

  const queueContinuation = Effect.fn("WorktreeMcpService.queueContinuation")(function* (input: {
    readonly scope: McpInvocationScope;
    readonly projection: OrchestrationV2ThreadProjection;
    readonly prompt: string | undefined;
    readonly commandId: CommandId;
    readonly messageId: MessageId;
    readonly workspacePath: string;
  }): Effect.fn.Return<WorktreeMcpContinuationStatus> {
    if (input.prompt === undefined) {
      return { status: "skipped" };
    }
    return yield* threadManagement
      .sendToThread({
        projectId: input.projection.thread.projectId,
        commandId: input.commandId,
        threadId: input.scope.threadId,
        messageId: input.messageId,
        text: input.prompt,
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
        Effect.catchCause((cause) => {
          const detail = errorMessage(Cause.squash(cause));
          return Effect.logWarning("workspace transition continuation failed to queue", {
            threadId: input.scope.threadId,
            workspacePath: input.workspacePath,
            detail,
          }).pipe(Effect.as({ status: "failed", detail } as const));
        }),
      );
  });

  const performHandoff = Effect.fn("WorktreeMcpService.performHandoff")(function* (
    scope: McpInvocationScope,
    input: WorktreeMcpHandoffInput,
    initialProjection?: OrchestrationV2ThreadProjection,
  ) {
    const projection = initialProjection ?? (yield* loadThread(scope));
    // An archived thread would accept the binding but refuse the continuation
    // message (and any other follow-up), so reject the handoff outright.
    if (projection.thread.archivedAt !== null) {
      return yield* failure(
        "invalid_request",
        `Thread '${scope.threadId}' is archived and cannot be handed off to a worktree.`,
      );
    }

    const project = yield* loadProject(scope, projection.thread.projectId);
    const projectCwd = yield* canonicalizePath(project.workspaceRoot);
    const sourceCwd = yield* canonicalizePath(projection.thread.worktreePath ?? projectCwd);

    if (projection.thread.worktreePath !== null) {
      const inventory = yield* loadWorktrees(projectCwd);
      const projectWorktreePaths = new Set(inventory.worktrees.map((worktree) => worktree.path));
      if (!projectWorktreePaths.has(sourceCwd)) {
        return yield* failure(
          "scope_mismatch",
          `Thread worktree '${projection.thread.worktreePath}' is not registered in project '${projection.thread.projectId}'.`,
        );
      }
    }

    if (input.path !== undefined && !path.isAbsolute(input.path)) {
      return yield* failure(
        "invalid_request",
        `path must be an absolute filesystem path, got '${input.path}'. A relative path would be created relative to the project workspace but stored verbatim as the thread's worktree binding.`,
      );
    }

    // The repo check runs regardless of whether baseRef was supplied, so a
    // non-repository workspace fails with an actionable error instead of an
    // opaque git failure further down.
    const localStatus = yield* readWorkspaceStatus(sourceCwd);
    if (!localStatus.isRepo) {
      return yield* failure(
        "invalid_request",
        `Thread workspace '${sourceCwd}' is not a git repository.`,
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

    const ids = yield* transitionIds(scope, "worktree-handoff");

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

        // suspend: build the rollback only if cleanup actually runs. Removing
        // the worktree must succeed before deleting its freshly created branch;
        // otherwise the branch may still be checked out there.
        let createdWorktreeRemoved = false;
        const removeCreatedWorktree = Effect.suspend(() =>
          gitWorkflow.removeWorktree({ cwd: projectCwd, path: worktreePath, force: true }).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                createdWorktreeRemoved = true;
              }),
            ),
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
        );

        const recheckExit = yield* Effect.exit(
          Effect.gen(function* () {
            // The projection was read before the potentially slow git work
            // above; a concurrent binding (for example from the UI) could have
            // attached the thread in the meantime. Re-check before committing so
            // the race cannot leave a second, untracked worktree.
            const recheck = yield* loadThread(scope);
            if (
              recheck.thread.worktreePath !== projection.thread.worktreePath ||
              recheck.thread.branch !== projection.thread.branch
            ) {
              return yield* failure(
                "operation_failed",
                `Thread '${scope.threadId}' changed workspace while the new worktree was being created; the handoff was rolled back.`,
              );
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
          }),
        );
        if (Exit.isFailure(recheckExit)) {
          if (Cause.hasInterruptsOnly(recheckExit.cause)) {
            return yield* Effect.failCause(recheckExit.cause as Cause.Cause<never>);
          }
          const cleanupExit = yield* Effect.exit(removeCreatedWorktree);
          if (Exit.isFailure(cleanupExit)) {
            return yield* failure(
              "partial_failure",
              `The handoff failed before binding and the created worktree could not be removed: ${errorMessage(Cause.squash(recheckExit.cause))}`,
              {
                workspacePath: worktreePath,
                recordedBranch: projection.thread.branch,
                actualBranch: createdWorktreeRemoved ? null : worktree.worktree.refName,
                rollback: "failed",
              },
            );
          }
          return yield* Effect.failCause(recheckExit.cause);
        }

        const dispatchExit = yield* Effect.exit(
          threadManagement.dispatch({
            type: "thread.metadata.update",
            commandId: ids.commandId,
            threadId: scope.threadId,
            branch: worktree.worktree.refName,
            worktreePath,
            expectedBranch: projection.thread.branch,
            expectedWorktreePath: projection.thread.worktreePath,
            expectedArchived: false,
          }),
        );
        if (Exit.isFailure(dispatchExit)) {
          if (Cause.hasInterruptsOnly(dispatchExit.cause)) {
            return yield* Effect.failCause(dispatchExit.cause as Cause.Cause<never>);
          }
          const dispatchDetail = errorMessage(Cause.squash(dispatchExit.cause));
          const bindingAfterDispatchExit = yield* Effect.exit(loadThread(scope));
          if (Exit.isFailure(bindingAfterDispatchExit)) {
            return yield* failure(
              "partial_failure",
              `The worktree binding reported a failure and its durable outcome could not be verified: ${dispatchDetail}`,
              {
                workspacePath: worktreePath,
                recordedBranch: projection.thread.branch,
                actualBranch: worktree.worktree.refName,
                rollback: "not_possible",
              },
            );
          }
          const bindingAfterDispatch = bindingAfterDispatchExit.value.thread;
          const bindingCommitted =
            bindingAfterDispatch.branch === worktree.worktree.refName &&
            bindingAfterDispatch.worktreePath === worktreePath;
          if (bindingCommitted) {
            yield* Effect.logWarning(
              "worktree binding dispatch reported failure after the binding committed",
              {
                threadId: scope.threadId,
                worktreePath,
                detail: dispatchDetail,
              },
            );
          } else {
            const cleanupExit = yield* Effect.exit(removeCreatedWorktree);
            if (Exit.isFailure(cleanupExit)) {
              return yield* failure(
                "partial_failure",
                `The worktree binding failed and the created worktree could not be removed: ${dispatchDetail}`,
                {
                  workspacePath: worktreePath,
                  recordedBranch: bindingAfterDispatch.branch,
                  actualBranch: createdWorktreeRemoved ? null : worktree.worktree.refName,
                  rollback: "failed",
                },
              );
            }
            return yield* failure(
              "operation_failed",
              `Unable to re-point the thread at the worktree: ${dispatchDetail}`,
            );
          }
        }

        // Queue the continuation right after the binding commits: the detach
        // that the metadata update schedules will terminate the calling
        // session, and a durably queued message is what guarantees the thread
        // re-launches inside the worktree. When the dying run reaches a
        // terminal state the orchestrator promotes the queued run, which
        // derives its cwd from the updated projection.
        // suspend: build the send effect only when the binding has succeeded,
        // so a failed dispatch never even constructs the continuation call.
        const queueHandoffContinuation = Effect.suspend(() =>
          queueContinuation({
            scope,
            projection,
            prompt: input.continuationPrompt,
            commandId: ids.continuationCommandId,
            messageId: ids.continuationMessageId,
            workspacePath: worktreePath,
          }),
        );

        const continuation = yield* queueHandoffContinuation;

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
              Effect.map((result): WorktreeMcpSetupScriptStatus =>
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
          if (workspaceTransitionsInFlight.has(scope.threadId)) {
            return Effect.fail(
              failure(
                "handoff_in_progress",
                `A worktree handoff is already in progress for thread '${scope.threadId}'.`,
              ),
            );
          }
          workspaceTransitionsInFlight.add(scope.threadId);
          return restore(performHandoff(scope, input)).pipe(
            Effect.ensuring(Effect.sync(() => workspaceTransitionsInFlight.delete(scope.threadId))),
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
      const projectWorkspaceRoot = yield* canonicalizePath(project.workspaceRoot);
      const workspacePath = normalizePath(projection.thread.worktreePath ?? projectWorkspaceRoot);
      const [defaultStartFromOrigin, actual, projectInventory, workspaceInventory] =
        yield* Effect.all(
          [
            readDefaultStartFromOrigin,
            readWorkspaceStatus(workspacePath),
            loadWorktrees(projectWorkspaceRoot),
            loadWorktrees(workspacePath),
          ],
          { concurrency: 4 },
        );
      const canonicalWorkspacePath = yield* canonicalizePath(workspacePath);
      const physicalWorkspacePath = workspaceInventory.currentWorktreeRoot;
      const agreement =
        workspaceInventory.repositoryCommonDir !== projectInventory.repositoryCommonDir ||
        physicalWorkspacePath === null ||
        !projectInventory.worktrees.some((worktree) => worktree.path === physicalWorkspacePath)
          ? "workspace_missing"
          : !actual.isRepo
            ? "not_repository"
            : actual.refName !== projection.thread.branch
              ? "branch_mismatch"
              : "in_sync";

      const result: WorktreeMcpStatusResult = {
        attached: projection.thread.worktreePath !== null,
        worktreePath: projection.thread.worktreePath,
        branch: projection.thread.branch,
        projectWorkspaceRoot,
        defaultStartFromOrigin,
        recordedWorkspace: {
          branch: projection.thread.branch,
          worktreePath: projection.thread.worktreePath,
        },
        actualWorkspace: {
          workspacePath: physicalWorkspacePath ?? canonicalWorkspacePath,
          isRepo: actual.isRepo,
          branch: actual.refName,
          hasWorkingTreeChanges: actual.hasWorkingTreeChanges,
        },
        agreement,
      };
      return result;
    },
  );

  const listWorktrees: WorktreeMcpService["Service"]["listWorktrees"] = Effect.fn(
    "WorktreeMcpService.listWorktrees",
  )(function* (scope, input) {
    yield* requireCapability(scope);
    const projection = yield* loadThread(scope);
    const project = yield* loadProject(scope, projection.thread.projectId);
    const projectWorkspaceRoot = yield* canonicalizePath(project.workspaceRoot);
    const [inventory, threads] = yield* Effect.all(
      [loadWorktrees(projectWorkspaceRoot), loadProjectThreads(projection.thread.projectId)],
      { concurrency: 2 },
    );
    const projectWorktreeRoot = inventory.currentWorktreeRoot ?? projectWorkspaceRoot;

    const branchByWorkspacePath = new Map<string, string | null>();
    for (const worktree of inventory.worktrees) {
      branchByWorkspacePath.set(worktree.path, worktree.refName);
    }
    if (!branchByWorkspacePath.has(projectWorktreeRoot)) {
      branchByWorkspacePath.set(projectWorktreeRoot, null);
    }
    const allWorktrees = [...branchByWorkspacePath.entries()].toSorted(
      ([leftPath], [rightPath]) =>
        Number(rightPath === projectWorktreeRoot) - Number(leftPath === projectWorktreeRoot) ||
        leftPath.localeCompare(rightPath),
    );
    const cursor = Math.min(input.cursor ?? 0, allWorktrees.length);
    const limit = input.limit ?? 20;
    const selectedWorktrees = allWorktrees.slice(cursor, cursor + limit);
    const nextCursor =
      cursor + selectedWorktrees.length < allWorktrees.length
        ? cursor + selectedWorktrees.length
        : null;
    const bindingLimit = input.bindingLimit ?? 20;
    const recordedThreadWorkspaces = yield* Effect.forEach(threads, (thread) =>
      threadWorkspacePath(thread, projectWorktreeRoot).pipe(
        Effect.map((recordedPath) => [thread, recordedPath] as const),
      ),
    );
    const unresolvedRecordedPaths = [
      ...new Set(
        recordedThreadWorkspaces
          .map(([, recordedPath]) => recordedPath)
          .filter((recordedPath) => !branchByWorkspacePath.has(recordedPath)),
      ),
    ];
    const selectedWorkspacePaths = new Set(
      selectedWorktrees.map(([workspacePath]) => workspacePath),
    );
    const isWithinWorkspace = (workspacePath: string, candidatePath: string) => {
      const relative = path.relative(workspacePath, candidatePath);
      return (
        relative === "" ||
        (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
      );
    };
    const candidateRecordedPaths = unresolvedRecordedPaths.filter((recordedPath) => {
      const nearestListedRoot = [...branchByWorkspacePath.keys()]
        .filter((workspacePath) => isWithinWorkspace(workspacePath, recordedPath))
        .toSorted((left, right) => right.length - left.length)[0];
      return nearestListedRoot !== undefined && selectedWorkspacePaths.has(nearestListedRoot);
    });
    const bindingPathResolutionLimit = Math.min(400, selectedWorktrees.length * bindingLimit);
    const recordedPathsToResolve = candidateRecordedPaths.slice(0, bindingPathResolutionLimit);
    const physicalRootByRecordedPath = new Map<string, string>();
    const candidateResults = yield* Effect.forEach(
      recordedPathsToResolve,
      (recordedPath) =>
        Effect.option(loadWorktrees(recordedPath)).pipe(
          Effect.map((candidateInventory) => ({ recordedPath, candidateInventory })),
        ),
      { concurrency: 8 },
    );
    let failedCandidateCount = 0;
    for (const { recordedPath, candidateInventory } of candidateResults) {
      if (Option.isNone(candidateInventory)) {
        failedCandidateCount += 1;
        continue;
      }
      const candidate = candidateInventory.value;
      if (
        candidate.repositoryCommonDir === inventory.repositoryCommonDir &&
        candidate.currentWorktreeRoot !== null &&
        branchByWorkspacePath.has(candidate.currentWorktreeRoot)
      ) {
        physicalRootByRecordedPath.set(recordedPath, candidate.currentWorktreeRoot);
      }
    }
    const threadWorkspaces = recordedThreadWorkspaces.map(
      ([thread, recordedPath]) =>
        [thread, physicalRootByRecordedPath.get(recordedPath) ?? recordedPath] as const,
    );

    const worktrees = yield* Effect.forEach(
      selectedWorktrees,
      ([workspacePath, branch]) =>
        Effect.gen(function* () {
          const bindings = threadWorkspaces
            .filter(([, threadPath]) => threadPath === workspacePath)
            .map(([thread]) => ({
              threadId: thread.id,
              title: thread.title,
              status: thread.status,
              recordedBranch: thread.branch,
              recordedWorktreePath: thread.worktreePath,
              active: thread.activeRunId !== null,
              callingThread: thread.id === scope.threadId,
            }));
          const statusResult = yield* readWorkspaceStatus(workspacePath).pipe(
            Effect.match({
              onFailure: (error) => ({ _tag: "failure" as const, error }),
              onSuccess: (status) => ({ _tag: "success" as const, status }),
            }),
          );
          if (statusResult._tag === "failure") {
            const exists = yield* fileSystem
              .exists(workspacePath)
              .pipe(Effect.orElseSucceed(() => false));
            const detail = errorMessage(statusResult.error);
            yield* Effect.logWarning("unable to read listed worktree status", {
              workspacePath,
              detail,
            });
            return {
              path: workspacePath,
              branch,
              actualBranch: null,
              isRepo: false,
              isProjectRoot: workspacePath === projectWorktreeRoot,
              hasWorkingTreeChanges: false,
              availability: exists ? "unreadable" : "missing",
              statusError: detail,
              bindings: bindings.slice(0, bindingLimit),
              bindingCount: bindings.length,
            } as const;
          }
          const actual = statusResult.status;
          if (!actual.isRepo) {
            const exists = yield* fileSystem
              .exists(workspacePath)
              .pipe(Effect.orElseSucceed(() => false));
            return {
              path: workspacePath,
              branch,
              actualBranch: actual.refName,
              isRepo: false,
              isProjectRoot: workspacePath === projectWorktreeRoot,
              hasWorkingTreeChanges: actual.hasWorkingTreeChanges,
              availability: exists ? "unreadable" : "missing",
              statusError: exists ? "Path is not a Git worktree." : "Worktree path does not exist.",
              bindings: bindings.slice(0, bindingLimit),
              bindingCount: bindings.length,
            } as const;
          }
          return {
            path: workspacePath,
            branch,
            actualBranch: actual.refName,
            isRepo: actual.isRepo,
            isProjectRoot: workspacePath === projectWorktreeRoot,
            hasWorkingTreeChanges: actual.hasWorkingTreeChanges,
            availability: "available",
            statusError: null,
            bindings: bindings.slice(0, bindingLimit),
            bindingCount: bindings.length,
          } as const;
        }),
      { concurrency: 8 },
    );

    return {
      projectWorkspaceRoot,
      repositoryCommonDir: inventory.repositoryCommonDir,
      projectWorktreeRoot,
      bindingPathResolution: {
        totalCandidates: candidateRecordedPaths.length,
        attemptedCandidates: recordedPathsToResolve.length,
        truncated: recordedPathsToResolve.length < candidateRecordedPaths.length,
        complete:
          recordedPathsToResolve.length === candidateRecordedPaths.length &&
          failedCandidateCount === 0,
      },
      worktrees,
      nextCursor,
      total: allWorktrees.length,
    } satisfies WorktreeMcpListResult;
  });

  const performCheckout = Effect.fn("WorktreeMcpService.performCheckout")(function* (
    scope: McpInvocationScope,
    input: WorktreeMcpCheckoutInput,
  ) {
    const projection = yield* loadThread(scope);
    if (projection.thread.archivedAt !== null) {
      return yield* failure(
        "invalid_request",
        `Thread '${scope.threadId}' is archived and cannot change workspace.`,
      );
    }

    const project = yield* loadProject(scope, projection.thread.projectId);
    const projectWorkspaceRoot = yield* canonicalizePath(project.workspaceRoot);
    const recordedWorkspacePath = yield* canonicalizePath(
      projection.thread.worktreePath ?? projectWorkspaceRoot,
    );
    if (input.target.type === "new_worktree") {
      const previousActual = yield* readWorkspaceStatus(recordedWorkspacePath);
      const handoff = yield* performHandoff(
        scope,
        {
          branch: input.target.branch,
          ...(input.target.baseRef === undefined ? {} : { baseRef: input.target.baseRef }),
          ...(input.target.startFromOrigin === undefined
            ? {}
            : { startFromOrigin: input.target.startFromOrigin }),
          ...(input.target.path === undefined ? {} : { path: input.target.path }),
          ...(input.target.runSetupScript === undefined
            ? {}
            : { runSetupScript: input.target.runSetupScript }),
          ...(input.continuationPrompt === undefined
            ? {}
            : { continuationPrompt: input.continuationPrompt }),
        },
        projection,
      );
      return {
        previous: {
          workspacePath: recordedWorkspacePath,
          recordedBranch: projection.thread.branch,
          recordedWorktreePath: projection.thread.worktreePath,
          actualBranch: previousActual.refName,
        },
        current: {
          workspacePath: handoff.worktreePath,
          recordedBranch: handoff.branch,
          recordedWorktreePath: handoff.worktreePath,
          actualBranch: handoff.branch,
        },
        checkoutAction: "created",
        workspaceChanged: true,
        branchChanged: previousActual.refName !== handoff.branch,
        continuation: handoff.continuation,
        setupScript: handoff.setupScript,
        callerTurnEnds: true,
        note: handoff.note,
      } satisfies WorktreeMcpCheckoutResult;
    }
    const [inventory, currentInventory] = yield* Effect.all(
      [loadWorktrees(projectWorkspaceRoot), loadWorktrees(recordedWorkspacePath)],
      { concurrency: 2 },
    );
    if (inventory.repositoryCommonDir !== currentInventory.repositoryCommonDir) {
      return yield* failure(
        "scope_mismatch",
        `Thread workspace '${recordedWorkspacePath}' does not belong to the calling thread's project repository.`,
      );
    }
    const projectWorktreeRoot = inventory.currentWorktreeRoot;
    const currentWorkspacePath = currentInventory.currentWorktreeRoot;
    if (projectWorktreeRoot === null || currentWorkspacePath === null) {
      return yield* failure(
        "invalid_request",
        "Git could not resolve the physical project or thread checkout.",
      );
    }
    const [refs, threads, previousActual] = yield* Effect.all(
      [
        loadRefs(projectWorkspaceRoot),
        loadProjectThreads(projection.thread.projectId),
        readWorkspaceStatus(currentWorkspacePath),
      ],
      { concurrency: 3 },
    );

    const localRefs = refs.filter((ref) => ref.isRemote !== true);
    const workspacePaths = new Set(inventory.worktrees.map((worktree) => worktree.path));
    const localRefByName = new Map(localRefs.map((ref) => [ref.name, ref]));
    const remoteRefByName = new Map(
      refs.filter((ref) => ref.isRemote === true).map((ref) => [ref.name, ref]),
    );

    let targetWorkspacePath: string;
    let requestedBranch: string | undefined;
    let createBranch = false;
    let selectedRef: VcsRef | undefined;

    switch (input.target.type) {
      case "worktree": {
        const targetInventory = yield* loadWorktrees(input.target.path);
        targetWorkspacePath =
          targetInventory.currentWorktreeRoot ?? (yield* canonicalizePath(input.target.path));
        if (
          targetInventory.repositoryCommonDir !== inventory.repositoryCommonDir ||
          targetWorkspacePath === projectWorktreeRoot ||
          !workspacePaths.has(targetWorkspacePath)
        ) {
          return yield* failure(
            "scope_mismatch",
            targetWorkspacePath === projectWorktreeRoot
              ? "Use target.type='project_root' to return to the project's main checkout."
              : `Worktree '${input.target.path}' does not belong to project '${projection.thread.projectId}'. Call t3_worktree_list and choose one of its paths.`,
          );
        }
        break;
      }
      case "project_root": {
        targetWorkspacePath = projectWorktreeRoot;
        requestedBranch = input.target.branch;
        createBranch = input.target.create ?? false;
        if (createBranch && requestedBranch === undefined) {
          return yield* failure(
            "invalid_request",
            "target.create requires target.branch when checking out the project root.",
          );
        }
        break;
      }
      case "branch": {
        requestedBranch = input.target.branch;
        createBranch = input.target.create ?? false;
        selectedRef = localRefByName.get(requestedBranch) ?? remoteRefByName.get(requestedBranch);
        if (createBranch && localRefByName.has(requestedBranch)) {
          return yield* failure(
            "invalid_request",
            `Local branch '${requestedBranch}' already exists. Omit target.create to check it out.`,
          );
        }
        if (!createBranch && selectedRef === undefined) {
          return yield* failure(
            "invalid_request",
            `Branch or remote ref '${requestedBranch}' does not exist. Pass target.create=true to create a local branch from the current checkout.`,
          );
        }
        const workspace = input.target.workspace ?? "auto";
        const selectedWorktreePath =
          selectedRef?.isRemote === true || selectedRef?.worktreePath == null
            ? null
            : selectedRef.worktreePath;
        targetWorkspacePath =
          workspace === "project_root"
            ? projectWorktreeRoot
            : workspace === "current"
              ? currentWorkspacePath
              : (selectedWorktreePath ??
                (projection.thread.worktreePath !== null && selectedRef?.isDefault === true
                  ? projectWorktreeRoot
                  : currentWorkspacePath));
        break;
      }
    }

    if (!workspacePaths.has(targetWorkspacePath)) {
      return yield* failure(
        "scope_mismatch",
        `Checkout target '${targetWorkspacePath}' is outside the calling thread's project worktrees.`,
      );
    }

    const targetBefore =
      targetWorkspacePath === currentWorkspacePath
        ? previousActual
        : yield* readWorkspaceStatus(targetWorkspacePath);
    if (!targetBefore.isRepo) {
      return yield* failure(
        "invalid_request",
        `Checkout target '${targetWorkspacePath}' is not a git repository.`,
      );
    }

    if (input.target.type === "worktree") {
      requestedBranch = targetBefore.refName ?? undefined;
      selectedRef =
        targetBefore.refName === null ? undefined : localRefByName.get(targetBefore.refName);
    } else if (requestedBranch !== undefined) {
      selectedRef = localRefByName.get(requestedBranch) ?? remoteRefByName.get(requestedBranch);
    }

    const selectedWorktreePath =
      selectedRef?.isRemote === true || selectedRef?.worktreePath == null
        ? null
        : selectedRef.worktreePath;
    if (
      !createBranch &&
      requestedBranch !== undefined &&
      selectedWorktreePath !== null &&
      selectedWorktreePath !== targetWorkspacePath
    ) {
      return yield* failure(
        "workspace_in_use",
        `Branch '${requestedBranch}' is checked out at '${selectedWorktreePath}'. Use target.type='worktree' with that path or target.workspace='auto' to reuse it.`,
      );
    }

    const shouldMutateCheckout =
      requestedBranch !== undefined &&
      (createBranch || selectedRef?.isRemote === true || targetBefore.refName !== requestedBranch);
    const threadWorkspaces = yield* Effect.forEach(threads, (thread) =>
      threadWorkspacePath(
        thread,
        projectWorktreeRoot,
        inventory.worktrees.map((worktree) => worktree.path),
      ).pipe(Effect.map((workspacePath) => [thread, workspacePath] as const)),
    );
    const otherBindings = threadWorkspaces
      .filter(
        ([thread, workspacePath]) =>
          thread.id !== scope.threadId && workspacePath === targetWorkspacePath,
      )
      .map(([thread]) => thread);
    const activeBinding = otherBindings.find((thread) => thread.activeRunId !== null);
    if ((targetWorkspacePath !== currentWorkspacePath || shouldMutateCheckout) && activeBinding) {
      return yield* failure(
        "workspace_in_use",
        `Checkout '${targetWorkspacePath}' is in use by active thread '${activeBinding.id}' (${activeBinding.title}).`,
      );
    }
    if (
      targetWorkspacePath !== projectWorktreeRoot &&
      (targetWorkspacePath !== currentWorkspacePath || shouldMutateCheckout) &&
      otherBindings.length > 0
    ) {
      return yield* failure(
        "workspace_shared",
        `Worktree '${targetWorkspacePath}' is already bound to thread '${otherBindings[0]!.id}'. Reusing it would make two threads share one mutable checkout.`,
      );
    }
    if (
      targetWorkspacePath === projectWorktreeRoot &&
      shouldMutateCheckout &&
      otherBindings.length > 0
    ) {
      return yield* failure(
        "workspace_shared",
        `The project root is also bound to thread '${otherBindings[0]!.id}'. Switching its branch would make that thread's recorded branch disagree with Git.`,
      );
    }
    if (shouldMutateCheckout && targetBefore.hasWorkingTreeChanges) {
      return yield* failure(
        "dirty_workspace",
        `Checkout '${targetWorkspacePath}' has uncommitted files. Commit or discard them before switching branches.`,
      );
    }

    const ids = yield* transitionIds(scope, "checkout");
    const workspaceGuardKey = `workspace:${inventory.repositoryCommonDir}:${targetWorkspacePath}`;
    return yield* Effect.uninterruptibleMask(() =>
      Effect.suspend(() => {
        if (workspaceTransitionsInFlight.has(workspaceGuardKey)) {
          return Effect.fail(
            failure(
              "checkout_in_progress",
              `Another workspace transition is already in progress for '${targetWorkspacePath}'.`,
            ),
          );
        }
        workspaceTransitionsInFlight.add(workspaceGuardKey);
        return Effect.gen(function* () {
          const [latestProjection, latestInventory, latestBindings, latestTargetBefore] =
            yield* Effect.all(
              [
                loadThread(scope),
                loadWorktrees(projectWorkspaceRoot),
                loadActiveWorkspaceBindings(inventory.repositoryCommonDir),
                readWorkspaceStatus(targetWorkspacePath),
              ],
              { concurrency: 4 },
            );
          if (
            latestProjection.thread.branch !== projection.thread.branch ||
            latestProjection.thread.worktreePath !== projection.thread.worktreePath ||
            latestProjection.thread.archivedAt !== projection.thread.archivedAt
          ) {
            return yield* failure(
              "checkout_in_progress",
              `Thread '${scope.threadId}' changed workspace state while checkout was being prepared. Retry from its current binding.`,
            );
          }
          if (
            latestInventory.repositoryCommonDir !== inventory.repositoryCommonDir ||
            !latestInventory.worktrees.some((worktree) => worktree.path === targetWorkspacePath)
          ) {
            return yield* failure(
              "scope_mismatch",
              `Checkout target '${targetWorkspacePath}' is no longer registered in the calling thread's Git repository.`,
            );
          }
          if (
            latestTargetBefore.refName !== targetBefore.refName ||
            latestTargetBefore.hasWorkingTreeChanges !== targetBefore.hasWorkingTreeChanges
          ) {
            return yield* failure(
              "checkout_in_progress",
              `Checkout '${targetWorkspacePath}' changed while the transition was being prepared. Retry from its current Git state.`,
            );
          }
          if (shouldMutateCheckout && latestTargetBefore.hasWorkingTreeChanges) {
            return yield* failure(
              "dirty_workspace",
              `Checkout '${targetWorkspacePath}' has uncommitted files. Commit or discard them before switching branches.`,
            );
          }
          const latestOtherBindings = latestBindings
            .filter(
              ([thread, workspacePath]) =>
                thread.id !== scope.threadId && workspacePath === targetWorkspacePath,
            )
            .map(([thread]) => thread);
          const latestActiveBinding = latestOtherBindings.find(
            (thread) => thread.activeRunId !== null,
          );
          if (
            (targetWorkspacePath !== currentWorkspacePath || shouldMutateCheckout) &&
            latestActiveBinding
          ) {
            return yield* failure(
              "workspace_in_use",
              `Checkout '${targetWorkspacePath}' is in use by active thread '${latestActiveBinding.id}' (${latestActiveBinding.title}).`,
            );
          }
          if (
            targetWorkspacePath !== projectWorktreeRoot &&
            (targetWorkspacePath !== currentWorkspacePath || shouldMutateCheckout) &&
            latestOtherBindings.length > 0
          ) {
            return yield* failure(
              "workspace_shared",
              `Worktree '${targetWorkspacePath}' is already bound to thread '${latestOtherBindings[0]!.id}'. Reusing it would make two threads share one mutable checkout.`,
            );
          }
          if (
            targetWorkspacePath === projectWorktreeRoot &&
            shouldMutateCheckout &&
            latestOtherBindings.length > 0
          ) {
            return yield* failure(
              "workspace_shared",
              `The project root is also bound to thread '${latestOtherBindings[0]!.id}'. Switching its branch would make that thread's recorded branch disagree with Git.`,
            );
          }

          let checkoutAction: WorktreeMcpCheckoutResult["checkoutAction"] =
            targetWorkspacePath === currentWorkspacePath ? "unchanged" : "reused";
          let createdBranch: string | null = null;
          let createdBranchCommit: string | null = null;
          let resolvedBranch: string | null = targetBefore.refName;
          const targetBeforeCommit = shouldMutateCheckout
            ? yield* gitWorkflow
                .resolveCommit({ cwd: targetWorkspacePath, revision: "HEAD" })
                .pipe(asOperationFailed("Unable to record the checkout's current commit"))
            : null;
          const requestedRemoteCommit =
            shouldMutateCheckout && requestedBranch !== undefined && selectedRef?.isRemote === true
              ? yield* gitWorkflow
                  .resolveCommit({ cwd: targetWorkspacePath, revision: requestedBranch })
                  .pipe(asOperationFailed(`Unable to resolve remote ref '${requestedBranch}'`))
              : null;
          let ownedCheckoutState: {
            readonly refName: string | null;
            readonly hasWorkingTreeChanges: boolean;
            readonly commitSha: string;
          } | null = null;

          const captureCheckoutState = Effect.fn("WorktreeMcpService.captureCheckoutState")(
            function* () {
              const status = yield* readWorkspaceStatus(targetWorkspacePath);
              const commit = yield* gitWorkflow
                .resolveCommit({ cwd: targetWorkspacePath, revision: "HEAD" })
                .pipe(asOperationFailed("Unable to identify the checkout's current commit"));
              return {
                refName: status.refName,
                hasWorkingTreeChanges: status.hasWorkingTreeChanges,
                commitSha: commit.commitSha,
              };
            },
          );

          const rollbackOwnedCheckout = Effect.fn("WorktreeMcpService.rollbackOwnedCheckout")(
            function* () {
              if (!shouldMutateCheckout) {
                return "not_needed" as const;
              }
              if (ownedCheckoutState === null || targetBeforeCommit === null) {
                return "not_possible" as const;
              }
              const [latestStateExit, latestBindings, callerProjectionExit] = yield* Effect.all(
                [
                  Effect.exit(captureCheckoutState()),
                  loadActiveWorkspaceBindings(inventory.repositoryCommonDir),
                  Effect.exit(threadManagement.getThreadProjection(scope.threadId)),
                ],
                { concurrency: 3 },
              );
              const anotherOwner = latestBindings.some(
                ([thread, workspacePath]) =>
                  thread.id !== scope.threadId && workspacePath === targetWorkspacePath,
              );
              const callerStillInitial =
                Exit.isSuccess(callerProjectionExit) &&
                callerProjectionExit.value.thread.branch === projection.thread.branch &&
                callerProjectionExit.value.thread.worktreePath === projection.thread.worktreePath &&
                callerProjectionExit.value.thread.archivedAt === projection.thread.archivedAt &&
                callerProjectionExit.value.thread.deletedAt === projection.thread.deletedAt;
              if (
                Exit.isFailure(latestStateExit) ||
                latestStateExit.value.refName !== ownedCheckoutState.refName ||
                latestStateExit.value.hasWorkingTreeChanges ||
                latestStateExit.value.hasWorkingTreeChanges !==
                  ownedCheckoutState.hasWorkingTreeChanges ||
                latestStateExit.value.commitSha !== ownedCheckoutState.commitSha ||
                anotherOwner ||
                !callerStillInitial
              ) {
                return "not_possible" as const;
              }
              const checkoutChanged =
                latestStateExit.value.refName !== targetBefore.refName ||
                latestStateExit.value.commitSha !== targetBeforeCommit.commitSha;
              if (checkoutChanged && targetBefore.refName === null) {
                return "not_possible" as const;
              }
              const rollbackExit = yield* Effect.exit(
                (checkoutChanged
                  ? gitWorkflow.switchRef({
                      cwd: targetWorkspacePath,
                      refName: targetBefore.refName!,
                    })
                  : Effect.void
                ).pipe(
                  Effect.andThen(
                    createdBranch === null || createdBranchCommit === null
                      ? Effect.void
                      : gitWorkflow.deleteLocalBranch({
                          cwd: targetWorkspacePath,
                          refName: createdBranch,
                          force: true,
                          expectedCommitSha: createdBranchCommit,
                        }),
                  ),
                ),
              );
              return Exit.isSuccess(rollbackExit) ? ("rolled_back" as const) : ("failed" as const);
            },
          );

          if (shouldMutateCheckout && requestedBranch !== undefined) {
            if (createBranch) {
              yield* gitWorkflow
                .createRef({
                  cwd: targetWorkspacePath,
                  refName: requestedBranch,
                  switchRef: false,
                })
                .pipe(asOperationFailed(`Unable to create branch '${requestedBranch}'`));
              createdBranch = requestedBranch;
              createdBranchCommit = targetBeforeCommit?.commitSha ?? null;
            }
            const switchExit = yield* Effect.exit(
              gitWorkflow.switchRef({ cwd: targetWorkspacePath, refName: requestedBranch }),
            );
            if (Exit.isFailure(switchExit)) {
              const afterFailedSwitchExit = yield* Effect.exit(captureCheckoutState());
              if (Exit.isSuccess(afterFailedSwitchExit)) {
                ownedCheckoutState = afterFailedSwitchExit.value;
              }
              const rollback = yield* rollbackOwnedCheckout();
              if (rollback === "not_possible" || rollback === "failed") {
                return yield* failure(
                  "partial_failure",
                  `Branch checkout failed and rollback was ${rollback === "failed" ? "unsuccessful" : "unsafe"}: ${errorMessage(Cause.squash(switchExit.cause))}`,
                  {
                    workspacePath: targetWorkspacePath,
                    recordedBranch: projection.thread.branch,
                    actualBranch: Exit.isSuccess(afterFailedSwitchExit)
                      ? afterFailedSwitchExit.value.refName
                      : null,
                    rollback: rollback === "failed" ? "failed" : "not_possible",
                  },
                );
              }
              return yield* failure(
                "operation_failed",
                `Unable to check out '${requestedBranch}': ${errorMessage(Cause.squash(switchExit.cause))}`,
              );
            }
            resolvedBranch = switchExit.value.refName;
            if (resolvedBranch === null && selectedRef?.isRemote !== true) {
              return yield* failure(
                "partial_failure",
                `Git reported a detached checkout after selecting '${requestedBranch}'. The durable thread binding was not changed.`,
                {
                  workspacePath: targetWorkspacePath,
                  recordedBranch: projection.thread.branch,
                  actualBranch: null,
                  rollback: "not_possible",
                },
              );
            }
            checkoutAction = createBranch ? "created" : "switched";
          }

          const actualExit = yield* Effect.exit(readWorkspaceStatus(targetWorkspacePath));
          if (Exit.isFailure(actualExit)) {
            const detail = errorMessage(Cause.squash(actualExit.cause));
            if (checkoutAction === "switched" || checkoutAction === "created") {
              return yield* failure(
                "partial_failure",
                `Git checkout completed but its resulting state could not be verified, so rollback was not attempted: ${detail}`,
                {
                  workspacePath: targetWorkspacePath,
                  recordedBranch: projection.thread.branch,
                  actualBranch: null,
                  rollback: "not_possible",
                },
              );
            }
            return yield* failure(
              "operation_failed",
              `Unable to verify the selected checkout '${targetWorkspacePath}': ${detail}`,
            );
          }
          const actual = actualExit.value;
          if (
            (checkoutAction === "switched" || checkoutAction === "created") &&
            actual.refName !== resolvedBranch
          ) {
            return yield* failure(
              "partial_failure",
              `Git resolved '${requestedBranch}' to '${resolvedBranch}' but the checkout now reports '${actual.refName ?? "detached HEAD"}'. The durable thread binding was not changed.`,
              {
                workspacePath: targetWorkspacePath,
                recordedBranch: projection.thread.branch,
                actualBranch: actual.refName,
                rollback: "not_possible",
              },
            );
          }
          if (checkoutAction === "switched" || checkoutAction === "created") {
            const actualCommitExit = yield* Effect.exit(
              gitWorkflow
                .resolveCommit({ cwd: targetWorkspacePath, revision: "HEAD" })
                .pipe(asOperationFailed("Unable to identify the selected checkout commit")),
            );
            if (Exit.isFailure(actualCommitExit)) {
              return yield* failure(
                "partial_failure",
                "Git checkout completed but its commit identity could not be verified, so the durable binding was not changed and rollback was not attempted.",
                {
                  workspacePath: targetWorkspacePath,
                  recordedBranch: projection.thread.branch,
                  actualBranch: actual.refName,
                  rollback: "not_possible",
                },
              );
            }
            if (
              resolvedBranch === null &&
              requestedRemoteCommit !== null &&
              actualCommitExit.value.commitSha !== requestedRemoteCommit.commitSha
            ) {
              return yield* failure(
                "partial_failure",
                `Git detached HEAD while selecting '${requestedBranch}', but HEAD does not match the requested remote commit. The durable binding was not changed.`,
                {
                  workspacePath: targetWorkspacePath,
                  recordedBranch: projection.thread.branch,
                  actualBranch: null,
                  rollback: "not_possible",
                },
              );
            }
            ownedCheckoutState = {
              refName: actual.refName,
              hasWorkingTreeChanges: actual.hasWorkingTreeChanges,
              commitSha: actualCommitExit.value.commitSha,
            };
          }
          const nextBranch = actual.refName;
          const workspaceChanged = targetWorkspacePath !== currentWorkspacePath;
          const nextWorktreePath = workspaceChanged
            ? targetWorkspacePath === projectWorktreeRoot
              ? null
              : targetWorkspacePath
            : projection.thread.worktreePath;
          const bindingChanged =
            nextBranch !== projection.thread.branch ||
            nextWorktreePath !== projection.thread.worktreePath;

          if (bindingChanged) {
            const preCommitProjectionExit = yield* Effect.exit(loadThread(scope));
            const preCommitProjection = Exit.isSuccess(preCommitProjectionExit)
              ? preCommitProjectionExit.value
              : null;
            const metadataChanged =
              preCommitProjection === null ||
              preCommitProjection.thread.branch !== projection.thread.branch ||
              preCommitProjection.thread.worktreePath !== projection.thread.worktreePath ||
              preCommitProjection.thread.archivedAt !== projection.thread.archivedAt;
            if (metadataChanged) {
              const rollback = yield* rollbackOwnedCheckout();
              if (rollback === "failed" || rollback === "not_possible") {
                return yield* failure(
                  "partial_failure",
                  `The thread changed or disappeared after Git checkout, so its durable binding was not updated and Git rollback was ${rollback === "failed" ? "unsuccessful" : "unsafe"}.`,
                  {
                    workspacePath: targetWorkspacePath,
                    recordedBranch: projection.thread.branch,
                    actualBranch: yield* readWorkspaceBranchOrNull(targetWorkspacePath),
                    rollback: rollback === "failed" ? "failed" : "not_possible",
                  },
                );
              }
              return yield* failure(
                "checkout_in_progress",
                `Thread '${scope.threadId}' changed or disappeared before the workspace binding committed. Git state was left unchanged.`,
              );
            }
            const dispatchExit = yield* Effect.exit(
              threadManagement.dispatch({
                type: "thread.metadata.update",
                commandId: ids.commandId,
                threadId: scope.threadId,
                branch: nextBranch,
                worktreePath: nextWorktreePath,
                expectedBranch: projection.thread.branch,
                expectedWorktreePath: projection.thread.worktreePath,
                expectedArchived: false,
              }),
            );
            if (Exit.isFailure(dispatchExit)) {
              const dispatchDetail = errorMessage(Cause.squash(dispatchExit.cause));
              const bindingAfterDispatchExit = yield* Effect.exit(loadThread(scope));
              if (Exit.isFailure(bindingAfterDispatchExit)) {
                return yield* failure(
                  "partial_failure",
                  `The durable binding update reported a failure and its outcome could not be verified: ${dispatchDetail}`,
                  {
                    workspacePath: targetWorkspacePath,
                    recordedBranch: projection.thread.branch,
                    actualBranch: actual.refName,
                    rollback: "not_possible",
                  },
                );
              }
              const bindingAfterDispatch = bindingAfterDispatchExit.value.thread;
              const bindingCommitted =
                bindingAfterDispatch.branch === nextBranch &&
                bindingAfterDispatch.worktreePath === nextWorktreePath;
              if (bindingCommitted) {
                yield* Effect.logWarning(
                  "workspace binding dispatch reported failure after the binding committed",
                  {
                    threadId: scope.threadId,
                    workspacePath: targetWorkspacePath,
                    detail: dispatchDetail,
                  },
                );
              } else {
                const bindingStillInitial =
                  bindingAfterDispatch.branch === projection.thread.branch &&
                  bindingAfterDispatch.worktreePath === projection.thread.worktreePath;
                const rollback = bindingStillInitial
                  ? yield* rollbackOwnedCheckout()
                  : ("not_possible" as const);
                if (rollback === "failed" || rollback === "not_possible") {
                  return yield* failure(
                    "partial_failure",
                    `Git checkout completed but the durable binding failed, and rollback was ${rollback === "failed" ? "unsuccessful" : "unsafe"}: ${dispatchDetail}`,
                    {
                      workspacePath: targetWorkspacePath,
                      recordedBranch: bindingAfterDispatch.branch,
                      actualBranch: yield* readWorkspaceBranchOrNull(targetWorkspacePath),
                      rollback: rollback === "failed" ? "failed" : "not_possible",
                    },
                  );
                }
                return yield* failure(
                  "operation_failed",
                  `Unable to update the durable thread workspace: ${dispatchDetail}`,
                );
              }
            }
          }

          const continuation = workspaceChanged
            ? yield* queueContinuation({
                scope,
                projection,
                prompt: input.continuationPrompt,
                commandId: ids.continuationCommandId,
                messageId: ids.continuationMessageId,
                workspacePath: targetWorkspacePath,
              })
            : ({ status: "skipped" } as const);
          const previous = {
            workspacePath: currentWorkspacePath,
            recordedBranch: projection.thread.branch,
            recordedWorktreePath: projection.thread.worktreePath,
            actualBranch: previousActual.refName,
          };
          const current = {
            workspacePath: targetWorkspacePath,
            recordedBranch: nextBranch,
            recordedWorktreePath: nextWorktreePath,
            actualBranch: actual.refName,
          };
          return {
            previous,
            current,
            checkoutAction,
            workspaceChanged,
            branchChanged: previousActual.refName !== actual.refName,
            continuation,
            setupScript: { status: "skipped" },
            callerTurnEnds: workspaceChanged,
            note: workspaceChanged
              ? continuation.status === "scheduled"
                ? "Checkout and durable thread binding completed. The workspace change detaches this provider session; the queued continuation starts the next turn in the selected checkout."
                : "Checkout and durable thread binding completed. The workspace change detaches this provider session, so this turn ends after the call. Send another message to continue in the selected checkout."
              : "Checkout and durable thread binding completed without changing the provider session workspace.",
          } satisfies WorktreeMcpCheckoutResult;
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => workspaceTransitionsInFlight.delete(workspaceGuardKey)),
          ),
        );
      }),
    );
  });

  const checkout: WorktreeMcpService["Service"]["checkout"] = Effect.fn(
    "WorktreeMcpService.checkout",
  )(function* (scope, input) {
    yield* requireCapability(scope);
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.suspend(() => {
        if (workspaceTransitionsInFlight.has(scope.threadId)) {
          return Effect.fail(
            failure(
              "checkout_in_progress",
              `A workspace transition is already in progress for thread '${scope.threadId}'.`,
            ),
          );
        }
        workspaceTransitionsInFlight.add(scope.threadId);
        return restore(performCheckout(scope, input)).pipe(
          Effect.ensuring(Effect.sync(() => workspaceTransitionsInFlight.delete(scope.threadId))),
        );
      }),
    );
  });

  return WorktreeMcpService.of({ handoff, status, listWorktrees, checkout });
});

export const layer: Layer.Layer<
  WorktreeMcpService,
  never,
  | Crypto.Crypto
  | FileSystem.FileSystem
  | Path.Path
  | ThreadManagementService
  | ProjectService.ProjectService
  | ServerSettings.ServerSettingsService
  | GitWorkflowService.GitWorkflowService
  | ProjectSetupScriptRunner.ProjectSetupScriptRunner
  | VcsStatusBroadcaster.VcsStatusBroadcaster
> = Layer.effect(WorktreeMcpService, make);
