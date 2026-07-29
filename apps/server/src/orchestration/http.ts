import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  EnvironmentConflictError,
  EnvironmentHttpApi,
  GitCommandError,
  MessageId,
  ProjectId,
  ThreadId,
  type EnvironmentInternalError,
  type EnvironmentRequestInvalidError,
  type EnvironmentResourceNotFoundError,
} from "@t3tools/contracts";
import { buildTemporaryWorktreeBranchName } from "@t3tools/shared/git";
import * as NodeCrypto from "node:crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as OrchestrationEngine from "./Services/OrchestrationEngine.ts";
import * as ServerSettings from "../serverSettings.ts";
import { normalizeDispatchCommand } from "./Normalizer.ts";
import {
  annotateEnvironmentRequest,
  failEnvironmentConflict,
  failEnvironmentInternal,
  failEnvironmentInvalidRequest,
  failEnvironmentNotFound,
  requireEnvironmentScope,
} from "../auth/http.ts";
import {
  isExpectedClientDispatchError,
  make as makeOrchestrationCommandDispatcher,
} from "./Services/OrchestrationCommandDispatcher.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";
import {
  listRemotePendingInteractions,
  respondToRemotePendingInteraction,
} from "./PendingInteractionService.ts";

const isGitCommandError = Schema.is(GitCommandError);

function findGitCommandError(cause: unknown, seen = new Set<unknown>()): GitCommandError | null {
  if (isGitCommandError(cause)) {
    return cause;
  }
  if (typeof cause !== "object" || cause === null || seen.has(cause)) {
    return null;
  }
  seen.add(cause);
  if ("cause" in cause) {
    const nestedCause = findGitCommandError(cause.cause, seen);
    if (nestedCause !== null) {
      return nestedCause;
    }
  }
  if ("error" in cause) {
    const nestedError = findGitCommandError(cause.error, seen);
    if (nestedError !== null) {
      return nestedError;
    }
  }
  if ("errors" in cause && Array.isArray(cause.errors)) {
    for (const nested of cause.errors) {
      const nestedError = findGitCommandError(nested, seen);
      if (nestedError !== null) {
        return nestedError;
      }
    }
  }
  if ("reasons" in cause && Array.isArray(cause.reasons)) {
    for (const reason of cause.reasons) {
      const nestedError = findGitCommandError(reason, seen);
      if (nestedError !== null) {
        return nestedError;
      }
    }
  }
  return null;
}

const WORKTREE_CONFLICT_MESSAGES = {
  worktree_branch_exists:
    "The requested branch already exists locally. Remove its existing worktree and branch, or choose a different branch.",
  worktree_ref_in_use:
    "The requested branch is already checked out in another worktree. Archive or remove that worktree, or choose a different branch.",
  worktree_path_exists:
    "The requested worktree path already exists. Remove or archive the existing worktree, or choose a different branch.",
  worktree_registration_conflict:
    "Git has a stale or locked worktree registration for the requested path. Inspect the registered worktrees, then unlock, remove, or prune the stale registration before retrying.",
} as const;

export const failEnvironmentDispatch = (
  cause: unknown,
): Effect.Effect<
  never,
  EnvironmentConflictError | EnvironmentInternalError | EnvironmentRequestInvalidError,
  never
> => {
  if (isExpectedClientDispatchError(cause)) {
    return failEnvironmentInvalidRequest("invalid_command", cause);
  }
  const gitError = findGitCommandError(cause);
  const failureKind = gitError?.failureKind;
  if (failureKind !== undefined && failureKind !== "unknown") {
    return failEnvironmentConflict(failureKind, WORKTREE_CONFLICT_MESSAGES[failureKind], cause);
  }
  return failEnvironmentInternal("orchestration_dispatch_failed", cause);
};

const failPendingInteractionResponse = (
  cause: unknown,
): Effect.Effect<
  never,
  EnvironmentInternalError | EnvironmentRequestInvalidError | EnvironmentResourceNotFoundError,
  never
> => {
  const tag =
    typeof cause === "object" && cause !== null && "_tag" in cause ? cause._tag : undefined;
  if (tag === "PendingInteractionUnavailableError") {
    return failEnvironmentNotFound("pending_interaction_not_found");
  }
  if (tag === "PendingInteractionInvalidResponseError") {
    return failEnvironmentInvalidRequest("invalid_interaction");
  }
  // The public error and the server log stay generic: persistence, provider,
  // and validation causes can carry sensitive local context.
  return failEnvironmentInternal("pending_interaction_response_failed");
};

export const orchestrationHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "orchestration",
  Effect.fnUntraced(function* (handlers) {
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
    const orchestrationCommandDispatcher = yield* makeOrchestrationCommandDispatcher;
    const gitWorkflow = yield* GitWorkflowService.GitWorkflowService;
    const orchestrationEngine = yield* OrchestrationEngine.OrchestrationEngineService;
    const serverSettings = yield* ServerSettings.ServerSettingsService;

    return handlers
      .handle(
        "snapshot",
        Effect.fn("environment.orchestration.snapshot")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          return yield* projectionSnapshotQuery
            .getSnapshot()
            .pipe(
              Effect.catch((cause) =>
                failEnvironmentInternal("orchestration_snapshot_failed", cause),
              ),
            );
        }),
      )
      .handle(
        "shellSnapshot",
        Effect.fn("environment.orchestration.shellSnapshot")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          return yield* projectionSnapshotQuery
            .getShellSnapshot()
            .pipe(
              Effect.catch((cause) =>
                failEnvironmentInternal("orchestration_snapshot_failed", cause),
              ),
            );
        }),
      )
      .handle(
        "threadSnapshot",
        Effect.fn("environment.orchestration.threadSnapshot")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          const snapshot = yield* projectionSnapshotQuery
            .getThreadDetailSnapshot(args.params.threadId)
            .pipe(
              Effect.catch((cause) =>
                failEnvironmentInternal("orchestration_thread_snapshot_failed", cause),
              ),
            );
          if (Option.isNone(snapshot)) {
            return yield* failEnvironmentNotFound("thread_not_found");
          }
          return snapshot.value;
        }),
      )
      .handle(
        "create",
        Effect.fn("environment.orchestration.create")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          const principal = yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          const identity = NodeCrypto.createHash("sha256")
            .update(`${principal.sessionId}\0${args.payload.idempotencyKey}`, "utf8")
            .digest("hex");
          const commandId = CommandId.make(`cli-create:${identity}`);
          const threadId = ThreadId.make(`cli-thread:${identity}`);
          const existingReceipt = yield* orchestrationEngine
            .getCommandReceipt(commandId)
            .pipe(
              Effect.catch((cause) =>
                failEnvironmentInternal("orchestration_dispatch_failed", cause),
              ),
            );
          if (Option.isSome(existingReceipt)) {
            if (
              existingReceipt.value.status !== "accepted" ||
              existingReceipt.value.aggregateId !== threadId
            ) {
              return yield* failEnvironmentInvalidRequest("invalid_command");
            }
            return {
              threadId,
              commandId,
              sequence: existingReceipt.value.resultSequence,
              replayed: true,
            };
          }

          const shell = yield* projectionSnapshotQuery
            .getShellSnapshot()
            .pipe(
              Effect.catch((cause) =>
                failEnvironmentInternal("orchestration_snapshot_failed", cause),
              ),
            );
          const project = shell.projects.find(
            (candidate) =>
              candidate.id === args.payload.project ||
              candidate.workspaceRoot === args.payload.project,
          );
          if (project === undefined) {
            return yield* failEnvironmentInvalidRequest("invalid_command");
          }
          if (project.defaultModelSelection === null) {
            return yield* failEnvironmentInvalidRequest("invalid_command");
          }

          const refs =
            args.payload.baseBranch === undefined
              ? yield* gitWorkflow
                  .listRefs({
                    cwd: project.workspaceRoot,
                    refKind: "local",
                    limit: 250,
                  })
                  .pipe(
                    Effect.catch((cause) =>
                      failEnvironmentInvalidRequest("invalid_command", cause),
                    ),
                  )
              : null;
          const status =
            args.payload.baseBranch === undefined &&
            refs?.refs.find((ref) => ref.isDefault && !ref.isRemote) === undefined
              ? yield* gitWorkflow
                  .localStatus({ cwd: project.workspaceRoot })
                  .pipe(
                    Effect.catch((cause) =>
                      failEnvironmentInvalidRequest("invalid_command", cause),
                    ),
                  )
              : null;
          const baseBranch =
            args.payload.baseBranch ??
            refs?.refs.find((ref) => ref.isDefault && !ref.isRemote)?.name ??
            status?.refName;
          if (baseBranch === undefined || baseBranch === null) {
            return yield* failEnvironmentInvalidRequest("invalid_command");
          }

          const settings = yield* serverSettings.getSettings.pipe(
            Effect.catch((cause) => failEnvironmentInternal("internal_error", cause)),
          );
          const createdAt = DateTime.formatIso(yield* DateTime.now);
          const branch =
            args.payload.branch ?? buildTemporaryWorktreeBranchName(() => identity.slice(0, 8));
          const result = yield* orchestrationCommandDispatcher
            .dispatch({
              type: "thread.turn.start",
              commandId,
              threadId,
              message: {
                messageId: MessageId.make(commandId),
                role: "user",
                text: args.payload.message,
                attachments: [],
              },
              modelSelection: project.defaultModelSelection,
              titleSeed: args.payload.title ?? args.payload.message.slice(0, 80),
              runtimeMode: args.payload.runtimeMode ?? DEFAULT_RUNTIME_MODE,
              interactionMode: args.payload.interactionMode ?? DEFAULT_PROVIDER_INTERACTION_MODE,
              bootstrap: {
                createThread: {
                  projectId: ProjectId.make(project.id),
                  title: args.payload.title ?? args.payload.message.slice(0, 80),
                  modelSelection: project.defaultModelSelection,
                  runtimeMode: args.payload.runtimeMode ?? DEFAULT_RUNTIME_MODE,
                  interactionMode:
                    args.payload.interactionMode ?? DEFAULT_PROVIDER_INTERACTION_MODE,
                  branch: null,
                  worktreePath: null,
                  createdAt,
                },
                prepareWorktree: {
                  projectCwd: project.workspaceRoot,
                  baseBranch,
                  branch,
                  startFromOrigin:
                    args.payload.startFromOrigin ?? settings.newWorktreesStartFromOrigin,
                },
                runSetupScript: project.scripts.some((script) => script.runOnWorktreeCreate),
              },
              createdAt,
            })
            .pipe(Effect.catch(failEnvironmentDispatch));
          return {
            threadId,
            commandId,
            sequence: result.sequence,
            replayed: false,
          };
        }),
      )
      .handle(
        "dispatch",
        Effect.fn("environment.orchestration.dispatch")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          if (
            args.payload.type === "thread.approval.respond" ||
            args.payload.type === "thread.user-input.respond"
          ) {
            return yield* failEnvironmentInvalidRequest("invalid_command");
          }
          const normalizedCommand = yield* normalizeDispatchCommand(args.payload).pipe(
            Effect.catch((cause) => failEnvironmentInvalidRequest("invalid_command", cause)),
          );
          return yield* orchestrationCommandDispatcher
            .dispatch(normalizedCommand)
            .pipe(Effect.catch(failEnvironmentDispatch));
        }),
      )
      .handle(
        "pendingInteractions",
        Effect.fn("environment.orchestration.pendingInteractions")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          return yield* listRemotePendingInteractions(
            args.query.threadId === undefined ? {} : { threadId: args.query.threadId },
          ).pipe(Effect.catch(() => failEnvironmentInternal("pending_interactions_read_failed")));
        }),
      )
      .handle(
        "answerPendingInteraction",
        Effect.fn("environment.orchestration.answerPendingInteraction")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          const principal = yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          return yield* respondToRemotePendingInteraction({
            authSessionId: principal.sessionId,
            threadId: args.payload.threadId,
            requestId: args.payload.requestId,
            idempotencyKey: args.payload.idempotencyKey,
            action: "answer",
            answers: args.payload.answers,
            dispatcher: orchestrationCommandDispatcher,
          }).pipe(Effect.catch(failPendingInteractionResponse));
        }),
      )
      .handle(
        "approvePendingInteraction",
        Effect.fn("environment.orchestration.approvePendingInteraction")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          const principal = yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          return yield* respondToRemotePendingInteraction({
            authSessionId: principal.sessionId,
            threadId: args.payload.threadId,
            requestId: args.payload.requestId,
            idempotencyKey: args.payload.idempotencyKey,
            action: "approve",
            dispatcher: orchestrationCommandDispatcher,
          }).pipe(Effect.catch(failPendingInteractionResponse));
        }),
      )
      .handle(
        "rejectPendingInteraction",
        Effect.fn("environment.orchestration.rejectPendingInteraction")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          const principal = yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          return yield* respondToRemotePendingInteraction({
            authSessionId: principal.sessionId,
            threadId: args.payload.threadId,
            requestId: args.payload.requestId,
            idempotencyKey: args.payload.idempotencyKey,
            action: args.payload.decision,
            dispatcher: orchestrationCommandDispatcher,
          }).pipe(Effect.catch(failPendingInteractionResponse));
        }),
      );
  }),
);
