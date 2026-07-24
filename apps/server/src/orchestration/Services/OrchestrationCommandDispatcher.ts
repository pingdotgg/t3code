import {
  CommandId,
  EventId,
  type OrchestrationCommand,
  OrchestrationDispatchCommandError,
  type ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as GitWorkflowService from "../../git/GitWorkflowService.ts";
import * as ServiceUpdateCoordinator from "../../cloud/serviceUpdateCoordinator.ts";
import * as ProjectSetupScriptRunner from "../../project/ProjectSetupScriptRunner.ts";
import * as ServerRuntimeStartup from "../../serverRuntimeStartup.ts";
import * as TerminalManager from "../../terminal/Manager.ts";
import * as VcsStatusBroadcaster from "../../vcs/VcsStatusBroadcaster.ts";
import {
  OrchestrationCommandInvariantError,
  OrchestrationCommandPreviouslyRejectedError,
} from "../Errors.ts";
import * as OrchestrationEngine from "./OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "./ProjectionSnapshotQuery.ts";

const isOrchestrationDispatchCommandError = Schema.is(OrchestrationDispatchCommandError);
const isOrchestrationCommandInvariantError = Schema.is(OrchestrationCommandInvariantError);
const isOrchestrationCommandPreviouslyRejectedError = Schema.is(
  OrchestrationCommandPreviouslyRejectedError,
);

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

function unexpectedCompatibilityError(error: never): never {
  throw new Error(`Unhandled compatibility error: ${String(error)}`);
}

function legacySetupFailureDescription(cause: unknown): string {
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

function projectSetupScriptCompatibilityDetail(
  error: ProjectSetupScriptRunner.ProjectSetupScriptRunnerError,
): string {
  switch (error._tag) {
    case "ProjectSetupScriptOperationError":
      return legacySetupFailureDescription(error.cause);
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

function isExpectedClientDispatchCause(cause: unknown, seen: Set<unknown>): boolean {
  if (isOrchestrationCommandInvariantError(cause)) {
    return cause.cause === undefined;
  }
  if (isOrchestrationCommandPreviouslyRejectedError(cause)) {
    return cause.cause === undefined;
  }
  if (typeof cause !== "object" || cause === null || seen.has(cause)) {
    return false;
  }
  seen.add(cause);
  if (isOrchestrationDispatchCommandError(cause) && cause.cause !== undefined) {
    return isExpectedClientDispatchCause(cause.cause, seen);
  }
  if ("cause" in cause) {
    return isExpectedClientDispatchCause(cause.cause, seen);
  }
  return false;
}

export function isExpectedClientDispatchError(error: unknown): boolean {
  return isExpectedClientDispatchCause(error, new Set());
}

export interface OrchestrationCommandDispatcherShape {
  readonly dispatch: (
    command: OrchestrationCommand,
  ) => Effect.Effect<{ readonly sequence: number }, OrchestrationDispatchCommandError, never>;
}

interface OrchestrationCommandDispatcherDependencies {
  readonly crypto: Crypto.Crypto;
  readonly orchestrationEngine: OrchestrationEngine.OrchestrationEngineService["Service"];
  readonly projectionSnapshotQuery: ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"];
  readonly gitWorkflow: GitWorkflowService.GitWorkflowService["Service"];
  readonly projectSetupScriptRunner: ProjectSetupScriptRunner.ProjectSetupScriptRunner["Service"];
  readonly startup: ServerRuntimeStartup.ServerRuntimeStartup["Service"];
  readonly terminalManager: TerminalManager.TerminalManager["Service"];
  readonly vcsStatusBroadcaster: VcsStatusBroadcaster.VcsStatusBroadcaster["Service"];
}

function makeDispatcher(
  dependencies: OrchestrationCommandDispatcherDependencies,
): OrchestrationCommandDispatcherShape {
  const {
    crypto,
    orchestrationEngine,
    projectionSnapshotQuery,
    gitWorkflow,
    projectSetupScriptRunner,
    startup,
    terminalManager,
    vcsStatusBroadcaster,
  } = dependencies;

  const refreshGitStatus = (cwd: string) =>
    vcsStatusBroadcaster
      .refreshStatus(cwd)
      .pipe(Effect.ignoreCause({ log: true }), Effect.forkDetach, Effect.asVoid);

  const dispatchBootstrapTurnStart = Effect.fn("OrchestrationCommandDispatcher.bootstrap")(
    function* (
      command: Extract<OrchestrationCommand, { type: "thread.turn.start" }>,
    ): Effect.fn.Return<{ readonly sequence: number }, OrchestrationDispatchCommandError, never> {
      const existingReceipt = yield* orchestrationEngine
        .getCommandReceipt(command.commandId)
        .pipe(
          Effect.mapError((cause) =>
            toDispatchCommandError(cause, "Failed to read orchestration command receipt."),
          ),
        );
      if (Option.isSome(existingReceipt)) {
        if (existingReceipt.value.status === "accepted") {
          return { sequence: existingReceipt.value.resultSequence };
        }
        return yield* toDispatchCommandError(
          new OrchestrationCommandPreviouslyRejectedError({
            commandId: command.commandId,
            detail: existingReceipt.value.error ?? "Previously rejected.",
          }),
          "Orchestration command was previously rejected.",
        );
      }

      const bootstrap = command.bootstrap;
      const { bootstrap: _bootstrap, ...finalTurnStartCommand } = command;
      const invalidBootstrap = (detail: string) =>
        toDispatchCommandError(
          new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail,
          }),
          detail,
        );
      const resolvedBootstrapProject = yield* Effect.gen(function* () {
        if (!bootstrap?.prepareWorktree) {
          return null;
        }
        let projectId = bootstrap.createThread?.projectId;
        if (projectId === undefined) {
          const thread = yield* projectionSnapshotQuery
            .getThreadShellById(command.threadId)
            .pipe(
              Effect.mapError((cause) =>
                toDispatchCommandError(cause, "Failed to resolve bootstrap thread project."),
              ),
            );
          if (Option.isNone(thread)) {
            return yield* invalidBootstrap("Bootstrap thread project could not be resolved.");
          }
          projectId = thread.value.projectId;
        }
        const project = yield* projectionSnapshotQuery
          .getProjectShellById(projectId)
          .pipe(
            Effect.mapError((cause) =>
              toDispatchCommandError(cause, "Failed to resolve bootstrap project."),
            ),
          );
        if (Option.isNone(project)) {
          return yield* invalidBootstrap("Bootstrap project does not exist.");
        }
        if (project.value.workspaceRoot !== bootstrap.prepareWorktree.projectCwd) {
          return yield* invalidBootstrap(
            "Bootstrap project working directory does not match the registered project.",
          );
        }
        return project.value;
      });
      let createdThread = false;
      let finalCommandAccepted = false;
      let setupTerminalId: string | null = null;
      let createdWorktreeBranch: string | null = null;
      let createdWorktreePath: string | null = null;
      let targetProjectId = resolvedBootstrapProject?.id ?? bootstrap?.createThread?.projectId;
      let targetProjectCwd = resolvedBootstrapProject?.workspaceRoot;
      let targetWorktreePath = bootstrap?.createThread?.worktreePath ?? null;

      const randomUUID = crypto.randomUUIDv4.pipe(
        Effect.mapError((cause) =>
          toDispatchCommandError(cause, "Failed to generate orchestration command identifier."),
        ),
      );
      const serverCommandId = (tag: string) =>
        randomUUID.pipe(Effect.map((uuid) => CommandId.make(`server:${tag}:${uuid}`)));
      const serverEventId = randomUUID.pipe(Effect.map(EventId.make));

      const cleanupCreatedResources = () =>
        Effect.gen(function* () {
          if (setupTerminalId) {
            yield* terminalManager
              .close({
                threadId: command.threadId,
                terminalId: setupTerminalId,
                deleteHistory: true,
              })
              .pipe(Effect.ignoreCause({ log: true }));
          }
          if (createdWorktreePath && targetProjectCwd) {
            yield* gitWorkflow
              .removeWorktree({
                cwd: targetProjectCwd,
                path: createdWorktreePath,
                force: true,
              })
              .pipe(Effect.ignoreCause({ log: true }));
            if (createdWorktreeBranch) {
              yield* gitWorkflow
                .deleteBranch({
                  cwd: targetProjectCwd,
                  refName: createdWorktreeBranch,
                  force: true,
                })
                .pipe(Effect.ignoreCause({ log: true }));
            }
          }
          if (createdThread) {
            yield* serverCommandId("bootstrap-thread-delete").pipe(
              Effect.flatMap((commandId) =>
                orchestrationEngine.dispatch({
                  type: "thread.delete",
                  commandId,
                  threadId: command.threadId,
                }),
              ),
              Effect.ignoreCause({ log: true }),
            );
          }
        });

      const appendSetupScriptActivity = (input: {
        readonly tag: "requested" | "started" | "failed";
        readonly threadId: ThreadId;
        readonly kind: "setup-script.requested" | "setup-script.started" | "setup-script.failed";
        readonly summary: string;
        readonly createdAt: string;
        readonly payload: Record<string, unknown>;
        readonly tone: "info" | "error";
      }) =>
        Effect.all({
          commandId: serverCommandId(`setup-script-${input.tag}`),
          activityId: serverEventId,
        }).pipe(
          Effect.flatMap(({ commandId, activityId }) =>
            orchestrationEngine.dispatch({
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

      const recordSetupScriptLaunchFailure = (input: {
        readonly error: ProjectSetupScriptRunner.ProjectSetupScriptRunnerError;
        readonly requestedAt: string;
        readonly worktreePath: string;
      }) => {
        const detail = projectSetupScriptCompatibilityDetail(input.error);
        return appendSetupScriptActivity({
          tag: "failed",
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
              tag: "requested",
              threadId: command.threadId,
              kind: "setup-script.requested",
              summary: "Starting setup script",
              createdAt: input.requestedAt,
              payload,
              tone: "info",
            }),
            appendSetupScriptActivity({
              tag: "started",
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
                onFailure: (error) => {
                  setupTerminalId =
                    error._tag === "ProjectSetupScriptOperationError"
                      ? (error.terminalId ?? null)
                      : null;
                  return recordSetupScriptLaunchFailure({
                    error,
                    requestedAt,
                    worktreePath,
                  });
                },
                onSuccess: (setupResult) => {
                  if (setupResult.status !== "started") {
                    return Effect.void;
                  }
                  setupTerminalId = setupResult.terminalId;
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
          yield* orchestrationEngine.dispatch({
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
          const projectCwd = targetProjectCwd;
          if (projectCwd === undefined) {
            return yield* invalidBootstrap("Bootstrap project working directory is unavailable.");
          }
          let worktreeBaseRef = bootstrap.prepareWorktree.baseBranch;
          if (bootstrap.prepareWorktree.startFromOrigin) {
            yield* gitWorkflow.fetchRemote({
              cwd: projectCwd,
              remoteName: "origin",
            });
            const resolvedRemoteBase = yield* gitWorkflow.resolveRemoteTrackingCommit({
              cwd: projectCwd,
              refName: bootstrap.prepareWorktree.baseBranch,
              fallbackRemoteName: "origin",
            });
            worktreeBaseRef = resolvedRemoteBase.commitSha;
          }
          const worktree = yield* gitWorkflow.createWorktree({
            cwd: projectCwd,
            refName: worktreeBaseRef,
            newRefName: bootstrap.prepareWorktree.branch,
            baseRefName: bootstrap.prepareWorktree.baseBranch,
            path: null,
          });
          targetWorktreePath = worktree.worktree.path;
          createdWorktreeBranch = worktree.worktree.refName;
          createdWorktreePath = targetWorktreePath;
          yield* orchestrationEngine.dispatch({
            type: "thread.meta.update",
            commandId: yield* serverCommandId("bootstrap-thread-meta-update"),
            threadId: command.threadId,
            branch: worktree.worktree.refName,
            worktreePath: targetWorktreePath,
          });
          yield* refreshGitStatus(targetWorktreePath);
        }

        yield* runSetupProgram();
        return yield* orchestrationEngine.dispatch(finalTurnStartCommand).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              finalCommandAccepted = true;
            }),
          ),
          Effect.uninterruptible,
        );
      });

      return yield* bootstrapProgram.pipe(
        Effect.onInterrupt(() =>
          finalCommandAccepted ? Effect.void : Effect.uninterruptible(cleanupCreatedResources()),
        ),
        Effect.catchCause((cause) => {
          const squashed = Cause.squash(cause);
          const dispatchError = toDispatchCommandError(
            squashed,
            "Failed to bootstrap thread turn start.",
          );
          const cleanup = Effect.uninterruptible(cleanupCreatedResources());
          if (Cause.hasInterruptsOnly(cause)) {
            return Effect.interrupt;
          }
          return cleanup.pipe(Effect.flatMap(() => Effect.fail(dispatchError)));
        }),
      );
    },
  );

  const dispatch = Effect.fn("OrchestrationCommandDispatcher.dispatch")(function* (
    command: OrchestrationCommand,
  ): Effect.fn.Return<{ readonly sequence: number }, OrchestrationDispatchCommandError, never> {
    const dispatchEffect =
      command.type === "thread.turn.start" && command.bootstrap
        ? orchestrationEngine.withBootstrapDispatchLock(dispatchBootstrapTurnStart(command))
        : orchestrationEngine
            .dispatch(command)
            .pipe(
              Effect.mapError((cause) =>
                toDispatchCommandError(cause, "Failed to dispatch orchestration command"),
              ),
            );

    const enqueue = startup
      .enqueueCommand(dispatchEffect)
      .pipe(
        Effect.mapError((cause) =>
          toDispatchCommandError(cause, "Failed to dispatch orchestration command"),
        ),
      );
    return yield* command.type === "thread.turn.start"
      ? ServiceUpdateCoordinator.serviceUpdateCoordinator.withTurnAdmission(enqueue)
      : enqueue;
  });

  return { dispatch };
}

export const make = Effect.gen(function* () {
  return makeDispatcher({
    crypto: yield* Crypto.Crypto,
    orchestrationEngine: yield* OrchestrationEngine.OrchestrationEngineService,
    projectionSnapshotQuery: yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery,
    gitWorkflow: yield* GitWorkflowService.GitWorkflowService,
    projectSetupScriptRunner: yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner,
    startup: yield* ServerRuntimeStartup.ServerRuntimeStartup,
    terminalManager: yield* TerminalManager.TerminalManager,
    vcsStatusBroadcaster: yield* VcsStatusBroadcaster.VcsStatusBroadcaster,
  });
});
