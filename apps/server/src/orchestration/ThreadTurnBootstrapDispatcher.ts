import {
  CommandId,
  EventId,
  type OrchestrationCommand,
  OrchestrationDispatchCommandError,
  STANDALONE_CHAT_PROJECT_ID,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as OrchestrationEngine from "./Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "./Services/ProjectionSnapshotQuery.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
const isOrchestrationDispatchCommandError = Schema.is(OrchestrationDispatchCommandError);

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
  }
}

export class ThreadTurnBootstrapDispatcher extends Context.Service<
  ThreadTurnBootstrapDispatcher,
  {
    readonly dispatch: (
      command: Extract<OrchestrationCommand, { type: "thread.turn.start" }>,
    ) => Effect.Effect<{ readonly sequence: number }, OrchestrationDispatchCommandError>;
  }
>()("t3/orchestration/ThreadTurnBootstrapDispatcher") {}

export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const crypto = yield* Crypto.Crypto;
  const orchestrationEngine = yield* OrchestrationEngine.OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const gitWorkflow = yield* GitWorkflowService.GitWorkflowService;
  const projectSetupScriptRunner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
  const vcsStatusBroadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;

  const randomUUID = crypto.randomUUIDv4.pipe(
    Effect.mapError(
      (cause) =>
        new OrchestrationDispatchCommandError({
          message: "Failed to generate orchestration command identifier.",
          cause,
        }),
    ),
  );
  const serverEventId = randomUUID.pipe(Effect.map(EventId.make));
  const serverCommandId = (tag: string) =>
    randomUUID.pipe(Effect.map((uuid) => CommandId.make(`server:${tag}:${uuid}`)));

  const refreshGitStatus = (cwd: string) =>
    vcsStatusBroadcaster
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
    Effect.all({
      commandId: serverCommandId("setup-script-activity"),
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

  const toBootstrapDispatchCommandCauseError = (cause: Cause.Cause<unknown>) => {
    const error = Cause.squash(cause);
    return isOrchestrationDispatchCommandError(error)
      ? error
      : new OrchestrationDispatchCommandError({
          message:
            error instanceof Error ? error.message : "Failed to bootstrap thread turn start.",
          cause,
        });
  };

  const dispatch: ThreadTurnBootstrapDispatcher["Service"]["dispatch"] = Effect.fn(
    "ThreadTurnBootstrapDispatcher.dispatch",
  )(function* (command) {
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
              orchestrationEngine.dispatch({
                type: "thread.delete",
                commandId,
                threadId: command.threadId,
              }),
            ),
            Effect.ignoreCause({ log: true }),
          )
        : Effect.void;

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

    const ensureStandaloneProject = Effect.fnUntraced(function* () {
      const existing = yield* projectionSnapshotQuery.getProjectShellById(
        STANDALONE_CHAT_PROJECT_ID,
      );
      if (Option.isSome(existing)) {
        if (existing.value.kind !== "standalone") {
          return yield* new OrchestrationDispatchCommandError({
            message: "Reserved chat project id is already used by a workspace project.",
          });
        }
        return;
      }

      const createdAt = yield* nowIso;
      yield* orchestrationEngine.dispatch({
        type: "project.create",
        commandId: yield* serverCommandId("bootstrap-standalone-project-create"),
        projectId: STANDALONE_CHAT_PROJECT_ID,
        kind: "standalone",
        title: "Chat",
        workspaceRoot: config.chatWorkspaceDir,
        createWorkspaceRootIfMissing: true,
        defaultModelSelection: bootstrap?.createThread?.modelSelection ?? null,
        createdAt,
      });
    });

    const bootstrapProgram = Effect.gen(function* () {
      if (bootstrap?.ensureStandaloneProject) {
        if (
          bootstrap.createThread &&
          bootstrap.createThread.projectId !== STANDALONE_CHAT_PROJECT_ID
        ) {
          return yield* new OrchestrationDispatchCommandError({
            message: "Standalone chat bootstrap must target the reserved chat project.",
          });
        }
        yield* ensureStandaloneProject();
      }

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
          ...(bootstrap.createThread.origin ? { origin: bootstrap.createThread.origin } : {}),
          createdAt: bootstrap.createThread.createdAt,
        });
        createdThread = true;
      }

      if (bootstrap?.prepareWorktree) {
        let worktreeBaseRef = bootstrap.prepareWorktree.baseBranch;
        if (bootstrap.prepareWorktree.startFromOrigin) {
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

  return ThreadTurnBootstrapDispatcher.of({ dispatch });
});

export const layer = Layer.effect(ThreadTurnBootstrapDispatcher, make);
