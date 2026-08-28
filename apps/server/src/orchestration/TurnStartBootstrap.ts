/**
 * Runs the bootstrap steps a `thread.turn.start` command can carry
 * (`command.bootstrap`): create the thread, prepare its git worktree, launch the
 * project setup script, then dispatch the plain turn start. A failure after the
 * thread was created rolls it back with `thread.delete`.
 *
 * Shared by every transport that dispatches client commands (WebSocket RPC and
 * the HTTP dispatch route) so both behave identically.
 */
import {
  CommandId,
  EventId,
  type OrchestrationClientOrigin,
  type OrchestrationCommand,
  OrchestrationDispatchCommandError,
  type ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";

export type TurnStartCommand = Extract<OrchestrationCommand, { type: "thread.turn.start" }>;

export interface TurnStartBootstrapDispatchOptions {
  readonly origin?: OrchestrationClientOrigin;
}

export class TurnStartBootstrap extends Context.Service<
  TurnStartBootstrap,
  {
    readonly dispatchTurnStart: (
      command: TurnStartCommand,
      options?: TurnStartBootstrapDispatchOptions,
    ) => Effect.Effect<{ readonly sequence: number }, OrchestrationDispatchCommandError>;
  }
>()("t3/orchestration/TurnStartBootstrap") {}

const isOrchestrationDispatchCommandError = Schema.is(OrchestrationDispatchCommandError);

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

/** Preserve the setup runner's broader pre-refactor message normalization. */
function setupFailureDescription(cause: unknown): string {
  if (
    typeof cause === "object" &&
    cause !== null &&
    "message" in cause &&
    typeof cause.message === "string"
  ) {
    return cause.message;
  }
  return String(cause);
}

function unexpectedCompatibilityError(error: never): never {
  throw new Error(`Unhandled compatibility error: ${String(error)}`);
}

function projectSetupScriptCompatibilityDetail(
  error: ProjectSetupScriptRunner.ProjectSetupScriptRunnerError,
): string {
  switch (error._tag) {
    case "ProjectSetupScriptOperationError":
      return setupFailureDescription(error.cause);
    case "ProjectSetupScriptProjectNotFoundError":
      return "Project was not found for setup script execution.";
    default:
      return unexpectedCompatibilityError(error);
  }
}

const toDispatchCommandError = (cause: unknown, fallbackMessage: string) =>
  isOrchestrationDispatchCommandError(cause)
    ? cause
    : new OrchestrationDispatchCommandError({
        message: cause instanceof Error ? cause.message : fallbackMessage,
        cause,
      });

const toBootstrapDispatchCommandCauseError = (cause: Cause.Cause<unknown>) => {
  const error = Cause.squash(cause);
  return isOrchestrationDispatchCommandError(error)
    ? error
    : new OrchestrationDispatchCommandError({
        message: error instanceof Error ? error.message : "Failed to bootstrap thread turn start.",
        cause,
      });
};

export const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const gitWorkflow = yield* GitWorkflowService.GitWorkflowService;
  const projectSetupScriptRunner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
  const vcsStatusBroadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
  const crypto = yield* Crypto.Crypto;

  const randomUUID = crypto.randomUUIDv4.pipe(
    Effect.mapError((cause) =>
      toDispatchCommandError(cause, "Failed to generate orchestration command identifier."),
    ),
  );
  const serverEventId = randomUUID.pipe(Effect.map(EventId.make));
  const serverCommandId = (tag: string) =>
    randomUUID.pipe(Effect.map((uuid) => CommandId.make(`server:${tag}:${uuid}`)));

  const refreshGitStatus = (cwd: string) =>
    vcsStatusBroadcaster
      .refreshStatus(cwd)
      .pipe(Effect.ignoreCause({ log: true }), Effect.forkDetach, Effect.asVoid);

  const dispatchTurnStart = (
    command: TurnStartCommand,
    options?: TurnStartBootstrapDispatchOptions,
  ): Effect.Effect<{ readonly sequence: number }, OrchestrationDispatchCommandError> =>
    Effect.gen(function* () {
      // Every sub-command the bootstrap emits carries whatever origin the
      // transport supplied: the WebSocket path passes its client origin so the
      // sub-commands attribute to the request that caused them; HTTP dispatch
      // passes none, as its plain dispatch path never has.
      const dispatch = (subCommand: OrchestrationCommand) =>
        orchestrationEngine.dispatch(subCommand, options);

      const appendSetupScriptActivity = (input: {
        readonly threadId: ThreadId;
        readonly kind: "setup-script.requested" | "setup-script.started" | "setup-script.failed";
        readonly summary: string;
        readonly createdAt: string;
        readonly payload: Record<string, unknown>;
        readonly tone: "info" | "error";
      }) =>
        Effect.all({
          commandId: serverCommandId("setup-script-activity"),
          activityId: serverEventId,
        }).pipe(
          Effect.flatMap(({ commandId, activityId }) =>
            dispatch({
              type: "thread.activity.append",
              commandId,
              threadId: input.threadId,
              activity: {
                id: activityId,
                tone: input.tone,
                kind: input.kind,
                summary: input.summary,
                payload: input.payload,
                turnId: null,
                createdAt: input.createdAt,
              },
              createdAt: input.createdAt,
            }),
          ),
        );

      const bootstrap = command.bootstrap;
      const { bootstrap: _bootstrap, ...finalTurnStartCommand } = command;
      let createdThread = false;
      let targetProjectId = bootstrap?.createThread?.projectId;
      let targetProjectCwd = bootstrap?.prepareWorktree?.projectCwd;
      let targetWorktreePath = bootstrap?.createThread?.worktreePath ?? null;

      const cleanupCreatedThread = () =>
        createdThread
          ? serverCommandId("bootstrap-thread-delete").pipe(
              Effect.flatMap((commandId) =>
                dispatch({
                  type: "thread.delete",
                  commandId,
                  threadId: command.threadId,
                }),
              ),
              Effect.as(true),
            )
          : Effect.succeed(false);

      const recordSetupScriptLaunchFailure = (input: {
        readonly error: ProjectSetupScriptRunner.ProjectSetupScriptRunnerError;
        readonly requestedAt: string;
        readonly worktreePath: string;
      }) => {
        const detail = projectSetupScriptCompatibilityDetail(input.error);
        return appendSetupScriptActivity({
          threadId: command.threadId,
          kind: "setup-script.failed",
          summary: "Setup script failed to start",
          createdAt: input.requestedAt,
          payload: {
            detail,
            worktreePath: input.worktreePath,
          },
          tone: "error",
        }).pipe(
          Effect.ignoreCause({ log: false }),
          Effect.flatMap(() =>
            Effect.logWarning("bootstrap turn start failed to launch setup script", {
              threadId: command.threadId,
              worktreePath: input.worktreePath,
              detail,
            }),
          ),
        );
      };

      const recordSetupScriptStarted = (input: {
        readonly requestedAt: string;
        readonly worktreePath: string;
        readonly scriptId: string;
        readonly scriptName: string;
        readonly terminalId: string;
      }) =>
        Effect.gen(function* () {
          const startedAt = yield* nowIso;
          const payload = {
            scriptId: input.scriptId,
            scriptName: input.scriptName,
            terminalId: input.terminalId,
            worktreePath: input.worktreePath,
          };
          yield* Effect.all([
            appendSetupScriptActivity({
              threadId: command.threadId,
              kind: "setup-script.requested",
              summary: "Starting setup script",
              createdAt: input.requestedAt,
              payload,
              tone: "info",
            }),
            appendSetupScriptActivity({
              threadId: command.threadId,
              kind: "setup-script.started",
              summary: "Setup script started",
              createdAt: startedAt,
              payload,
              tone: "info",
            }),
          ]).pipe(
            Effect.asVoid,
            Effect.catch((error) =>
              Effect.logWarning(
                "bootstrap turn start launched setup script but failed to record setup activity",
                {
                  threadId: command.threadId,
                  worktreePath: input.worktreePath,
                  scriptId: input.scriptId,
                  terminalId: input.terminalId,
                  detail: error.message,
                },
              ),
            ),
          );
        });

      const runSetupProgram = () =>
        Effect.gen(function* () {
          if (!bootstrap?.runSetupScript || !targetWorktreePath) {
            return;
          }
          const worktreePath = targetWorktreePath;
          const requestedAt = yield* nowIso;
          yield* projectSetupScriptRunner
            .runForThread({
              threadId: command.threadId,
              ...(targetProjectId ? { projectId: targetProjectId } : {}),
              ...(targetProjectCwd ? { projectCwd: targetProjectCwd } : {}),
              worktreePath,
            })
            .pipe(
              Effect.matchEffect({
                onFailure: (error) =>
                  recordSetupScriptLaunchFailure({
                    error,
                    requestedAt,
                    worktreePath,
                  }),
                onSuccess: (setupResult) => {
                  if (setupResult.status !== "started") {
                    return Effect.void;
                  }
                  return recordSetupScriptStarted({
                    requestedAt,
                    worktreePath,
                    scriptId: setupResult.scriptId,
                    scriptName: setupResult.scriptName,
                    terminalId: setupResult.terminalId,
                  });
                },
              }),
            );
        });

      const bootstrapProgram = Effect.gen(function* () {
        if (bootstrap?.createThread) {
          yield* dispatch({
            type: "thread.create",
            commandId: yield* serverCommandId("bootstrap-thread-create"),
            threadId: command.threadId,
            projectId: bootstrap.createThread.projectId,
            title: bootstrap.createThread.title,
            modelSelection: bootstrap.createThread.modelSelection,
            runtimeMode: bootstrap.createThread.runtimeMode,
            interactionMode: bootstrap.createThread.interactionMode,
            branch: bootstrap.createThread.branch,
            worktreePath: bootstrap.createThread.worktreePath,
            createdAt: bootstrap.createThread.createdAt,
          });
          createdThread = true;
        }

        if (bootstrap?.prepareWorktree) {
          let worktreeBaseRef = bootstrap.prepareWorktree.baseBranch;
          // "Start from origin" is a stored default; repos without an
          // origin remote fall back to the local base branch instead of
          // failing the whole bootstrap on `git fetch origin`.
          const startFromOrigin =
            bootstrap.prepareWorktree.startFromOrigin === true &&
            (yield* gitWorkflow.remoteExists({
              cwd: bootstrap.prepareWorktree.projectCwd,
              remoteName: "origin",
            }));
          if (startFromOrigin) {
            yield* gitWorkflow.fetchRemote({
              cwd: bootstrap.prepareWorktree.projectCwd,
              remoteName: "origin",
            });
            const resolvedRemoteBase = yield* gitWorkflow.resolveRemoteTrackingCommit({
              cwd: bootstrap.prepareWorktree.projectCwd,
              refName: bootstrap.prepareWorktree.baseBranch,
              fallbackRemoteName: "origin",
            });
            worktreeBaseRef = resolvedRemoteBase.commitSha;
          }
          const worktree = yield* gitWorkflow.createWorktree({
            cwd: bootstrap.prepareWorktree.projectCwd,
            refName: worktreeBaseRef,
            newRefName: bootstrap.prepareWorktree.branch,
            baseRefName: bootstrap.prepareWorktree.baseBranch,
            path: null,
          });
          targetWorktreePath = worktree.worktree.path;
          yield* dispatch({
            type: "thread.meta.update",
            commandId: yield* serverCommandId("bootstrap-thread-meta-update"),
            threadId: command.threadId,
            branch: worktree.worktree.refName,
            worktreePath: targetWorktreePath,
          });
          yield* refreshGitStatus(targetWorktreePath);
        }

        yield* runSetupProgram();

        return yield* dispatch(finalTurnStartCommand);
      });

      return yield* bootstrapProgram.pipe(
        Effect.catchCause((cause) => {
          const dispatchError = toBootstrapDispatchCommandCauseError(cause);
          if (Cause.hasInterruptsOnly(cause)) {
            return Effect.fail(dispatchError);
          }
          return Effect.uninterruptible(cleanupCreatedThread()).pipe(
            Effect.matchCauseEffect({
              onFailure: (cleanupCause) =>
                Effect.logWarning("bootstrap thread cleanup failed", {
                  threadId: command.threadId,
                  detail: Cause.pretty(cleanupCause),
                }).pipe(Effect.flatMap(() => Effect.fail(dispatchError))),
              onSuccess: (threadDeleted) =>
                Effect.fail(
                  threadDeleted
                    ? new OrchestrationDispatchCommandError({
                        message: dispatchError.message,
                        ...(dispatchError.cause !== undefined
                          ? { cause: dispatchError.cause }
                          : {}),
                        bootstrapThreadDisposition: "deleted",
                      })
                    : dispatchError,
                ),
            }),
          );
        }),
      );
    });

  return TurnStartBootstrap.of({ dispatchTurnStart });
});

export const layer = Layer.effect(TurnStartBootstrap, make);
