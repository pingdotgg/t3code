import { Cause, Effect, Schema } from "effect";
import {
  CommandId,
  EventId,
  OrchestrationDispatchCommandError,
  type OrchestrationCommand,
  ThreadId,
} from "@t3tools/contracts";

import type { GitCoreShape } from "../git/Services/GitCore.ts";
import type { GitStatusBroadcasterShape } from "../git/Services/GitStatusBroadcaster.ts";
import type { ProjectSetupScriptRunnerShape } from "../project/Services/ProjectSetupScriptRunner.ts";
import type { ServerRuntimeStartupShape } from "../serverRuntimeStartup.ts";
import {
  dispatchThroughStartupGate,
  toOrchestrationDispatchCommandError,
} from "./gatedDispatch.ts";
import type { OrchestrationEngineShape } from "./Services/OrchestrationEngine.ts";

const serverCommandId = (tag: string) => CommandId.make(`server:${tag}:${crypto.randomUUID()}`);

const toBootstrapDispatchCommandCauseError = (cause: Cause.Cause<unknown>) => {
  const error = Cause.squash(cause);
  return Schema.is(OrchestrationDispatchCommandError)(error)
    ? error
    : new OrchestrationDispatchCommandError({
        message: error instanceof Error ? error.message : "Failed to bootstrap thread turn start.",
        cause,
      });
};

interface ClientCommandDispatcherDeps {
  readonly orchestrationEngine: OrchestrationEngineShape;
  readonly startup: ServerRuntimeStartupShape;
  readonly git: GitCoreShape;
  readonly gitStatusBroadcaster: GitStatusBroadcasterShape;
  readonly projectSetupScriptRunner: ProjectSetupScriptRunnerShape;
}

export const makeClientCommandDispatcher = ({
  orchestrationEngine,
  startup,
  git,
  gitStatusBroadcaster,
  projectSetupScriptRunner,
}: ClientCommandDispatcherDeps) => {
  const refreshGitStatus = (cwd: string) =>
    gitStatusBroadcaster
      .refreshStatus(cwd)
      .pipe(Effect.ignoreCause({ log: true }), Effect.forkDetach, Effect.asVoid);

  const appendSetupScriptActivity = (input: {
    readonly threadId: ThreadId;
    readonly kind: "setup-script.requested" | "setup-script.started" | "setup-script.failed";
    readonly summary: string;
    readonly createdAt: string;
    readonly payload: Record<string, unknown>;
    readonly tone: "info" | "error";
  }) =>
    orchestrationEngine.dispatch({
      type: "thread.activity.append",
      commandId: serverCommandId("setup-script-activity"),
      threadId: input.threadId,
      activity: {
        id: EventId.make(crypto.randomUUID()),
        tone: input.tone,
        kind: input.kind,
        summary: input.summary,
        payload: input.payload,
        turnId: null,
        createdAt: input.createdAt,
      },
      createdAt: input.createdAt,
    });

  const dispatchBootstrapTurnStart = (
    command: Extract<OrchestrationCommand, { type: "thread.turn.start" }>,
  ): Effect.Effect<{ readonly sequence: number }, OrchestrationDispatchCommandError> =>
    Effect.gen(function* () {
      const bootstrap = command.bootstrap;
      const { bootstrap: _bootstrap, ...finalTurnStartCommand } = command;
      let createdThread = false;
      let targetProjectId = bootstrap?.createThread?.projectId;
      let targetProjectCwd = bootstrap?.prepareWorktree?.projectCwd;
      let targetWorktreePath = bootstrap?.createThread?.worktreePath ?? null;

      const cleanupCreatedThread = () =>
        createdThread
          ? orchestrationEngine
              .dispatch({
                type: "thread.delete",
                commandId: serverCommandId("bootstrap-thread-delete"),
                threadId: command.threadId,
              })
              .pipe(Effect.ignoreCause({ log: true }))
          : Effect.void;

      const recordSetupScriptLaunchFailure = (input: {
        readonly error: unknown;
        readonly requestedAt: string;
        readonly worktreePath: string;
      }) => {
        const detail =
          input.error instanceof Error ? input.error.message : "Unknown setup failure.";
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
      }) => {
        const payload = {
          scriptId: input.scriptId,
          scriptName: input.scriptName,
          terminalId: input.terminalId,
          worktreePath: input.worktreePath,
        };
        return Effect.all([
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
            createdAt: new Date().toISOString(),
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
      };

      const runSetupProgram = () =>
        bootstrap?.runSetupScript && targetWorktreePath
          ? (() => {
              const worktreePath = targetWorktreePath;
              const requestedAt = new Date().toISOString();
              return projectSetupScriptRunner
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
            })()
          : Effect.void;

      const bootstrapProgram = Effect.gen(function* () {
        if (bootstrap?.createThread) {
          yield* orchestrationEngine.dispatch({
            type: "thread.create",
            commandId: serverCommandId("bootstrap-thread-create"),
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
          const worktree = yield* git.createWorktree({
            cwd: bootstrap.prepareWorktree.projectCwd,
            branch: bootstrap.prepareWorktree.baseBranch,
            newBranch: bootstrap.prepareWorktree.branch,
            path: null,
          });
          targetWorktreePath = worktree.worktree.path;
          yield* orchestrationEngine.dispatch({
            type: "thread.meta.update",
            commandId: serverCommandId("bootstrap-thread-meta-update"),
            threadId: command.threadId,
            branch: worktree.worktree.branch,
            worktreePath: targetWorktreePath,
          });
          yield* refreshGitStatus(targetWorktreePath);
        }

        yield* runSetupProgram();

        return yield* orchestrationEngine.dispatch(finalTurnStartCommand);
      });

      return yield* bootstrapProgram.pipe(
        Effect.catchCause((cause) => {
          const dispatchError = toBootstrapDispatchCommandCauseError(cause);
          if (Cause.hasInterruptsOnly(cause)) {
            return Effect.fail(dispatchError);
          }
          return cleanupCreatedThread().pipe(Effect.flatMap(() => Effect.fail(dispatchError)));
        }),
      );
    });

  return (
    normalizedCommand: OrchestrationCommand,
  ): Effect.Effect<{ readonly sequence: number }, OrchestrationDispatchCommandError> => {
    const dispatchEffect =
      normalizedCommand.type === "thread.turn.start" && normalizedCommand.bootstrap
        ? dispatchBootstrapTurnStart(normalizedCommand)
        : dispatchThroughStartupGate(normalizedCommand, orchestrationEngine, startup);

    return normalizedCommand.type === "thread.turn.start" && normalizedCommand.bootstrap
      ? startup
          .enqueueCommand(dispatchEffect)
          .pipe(
            Effect.mapError((cause) =>
              toOrchestrationDispatchCommandError(
                cause,
                "Failed to dispatch orchestration command",
              ),
            ),
          )
      : dispatchEffect;
  };
};
