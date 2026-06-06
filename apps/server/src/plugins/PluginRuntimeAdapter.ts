import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import type { PluginActivationContext } from "@t3tools/plugin-api/server";
import { PluginRuntimeError } from "@t3tools/plugin-api/server";
import { buildTemporaryWorktreeBranchName } from "@t3tools/shared/git";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { launchThreadBootstrap } from "../orchestration/threadBootstrapLauncher.ts";
import { ProjectSetupScriptRunner } from "../project/Services/ProjectSetupScriptRunner.ts";
import { getAutoBootstrapDefaultModelSelection } from "../serverRuntimeStartup.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { TerminalManager } from "../terminal/Services/Manager.ts";

export const makePluginRuntimeAdapter = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const orchestration = yield* OrchestrationEngineService;
  const snapshot = yield* ProjectionSnapshotQuery;
  const settings = yield* ServerSettingsService;
  const gitWorkflow = yield* GitWorkflowService;
  const setupScripts = yield* ProjectSetupScriptRunner;
  const terminalManager = yield* TerminalManager;

  const uuid = crypto.randomUUIDv4;
  const nextCommandId = (tag: string) =>
    uuid.pipe(
      Effect.mapError(
        (detail) => new PluginRuntimeError("Failed to generate plugin command id.", detail),
      ),
      Effect.map((id) => CommandId.make(`plugin:${tag}:${id}`)),
    );
  const nextThreadId = uuid.pipe(
    Effect.mapError(
      (detail) => new PluginRuntimeError("Failed to generate plugin thread id.", detail),
    ),
    Effect.map(ThreadId.make),
  );
  const nextMessageId = uuid.pipe(
    Effect.mapError(
      (detail) => new PluginRuntimeError("Failed to generate plugin message id.", detail),
    ),
    Effect.map((id) => MessageId.make(`plugin-msg-${id}`)),
  );

  return {
    createAndSendThread: (input) =>
      Effect.gen(function* () {
        const project = yield* snapshot.getProjectShellById(ProjectId.make(input.projectId)).pipe(
          Effect.map(Option.getOrNull),
          Effect.mapError(
            (detail) => new PluginRuntimeError("Failed to read target project.", detail),
          ),
        );
        if (project === null) {
          return yield* Effect.fail(
            new PluginRuntimeError(`Project ${input.projectId} was not found.`),
          );
        }

        const serverSettings = yield* settings.getSettings.pipe(
          Effect.mapError((detail) => new PluginRuntimeError("Failed to read settings.", detail)),
        );
        const createdAt = DateTime.formatIso(yield* DateTime.now);
        const modelSelection =
          project.defaultModelSelection ?? getAutoBootstrapDefaultModelSelection();
        const threadId = yield* nextThreadId;

        const preparePluginWorktree = Effect.gen(function* () {
          const localStatus = yield* gitWorkflow
            .localStatus({ cwd: project.workspaceRoot })
            .pipe(
              Effect.mapError(
                (detail) =>
                  new PluginRuntimeError(
                    "Failed to inspect Git status for plugin worktree.",
                    detail,
                  ),
              ),
            );
          if (!localStatus.isRepo || localStatus.refName === null) {
            return yield* Effect.fail(
              new PluginRuntimeError(
                `Project ${input.projectId} cannot launch a plugin thread in worktree mode because it is not on a Git branch.`,
              ),
            );
          }

          const branchToken = (yield* uuid.pipe(
            Effect.mapError(
              (detail) => new PluginRuntimeError("Failed to generate plugin branch token.", detail),
            ),
          )).replace(/-/g, "");
          return {
            cwd: project.workspaceRoot,
            create: gitWorkflow
              .createWorktree({
                cwd: project.workspaceRoot,
                refName: localStatus.refName,
                newRefName: buildTemporaryWorktreeBranchName(() => branchToken.slice(0, 8)),
                path: null,
              })
              .pipe(
                Effect.map((result) => result.worktree),
                Effect.mapError(
                  (detail) => new PluginRuntimeError("Failed to create plugin worktree.", detail),
                ),
              ),
          } as const;
        });

        const preparedWorktree =
          serverSettings.defaultThreadEnvMode === "worktree" ? yield* preparePluginWorktree : null;

        const turnStartCommand = {
          type: "thread.turn.start" as const,
          commandId: yield* nextCommandId("turn-start"),
          threadId,
          message: {
            messageId: yield* nextMessageId,
            role: "user" as const,
            text: input.prompt,
            attachments: [],
          },
          modelSelection,
          titleSeed: input.title,
          runtimeMode: "full-access" as const,
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          createdAt,
        };

        yield* launchThreadBootstrap({
          threadId,
          orchestration,
          gitWorkflow,
          terminalManager,
          setupScripts,
          nextCommandId,
          createThread: {
            threadId,
            projectId: project.id,
            title: input.title,
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            branch: null,
            worktreePath: null,
            createdAt,
          },
          ...(preparedWorktree ? { prepareWorktree: preparedWorktree } : {}),
          ...(preparedWorktree
            ? {
                setupScript: {
                  input: (worktreePath) => ({
                    threadId,
                    projectId: project.id,
                    projectCwd: project.workspaceRoot,
                    worktreePath,
                  }),
                  onFailure: ({ error }) =>
                    Effect.fail(
                      new PluginRuntimeError("Failed to run plugin thread setup script.", error),
                    ),
                },
              }
            : {}),
          turnStart: turnStartCommand,
        }).pipe(
          Effect.mapError((detail) =>
            detail instanceof PluginRuntimeError
              ? detail
              : new PluginRuntimeError("Failed to launch plugin thread.", detail),
          ),
        );

        return { threadId };
      }),
  } satisfies PluginActivationContext["runtime"];
});
