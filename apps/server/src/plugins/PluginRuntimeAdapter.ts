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
import { ProjectSetupScriptRunner } from "../project/Services/ProjectSetupScriptRunner.ts";
import { getAutoBootstrapDefaultModelSelection } from "../serverRuntimeStartup.ts";
import { ServerSettingsService } from "../serverSettings.ts";

export const makePluginRuntimeAdapter = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const orchestration = yield* OrchestrationEngineService;
  const snapshot = yield* ProjectionSnapshotQuery;
  const settings = yield* ServerSettingsService;
  const gitWorkflow = yield* GitWorkflowService;
  const setupScripts = yield* ProjectSetupScriptRunner;

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
        let branch: string | null = null;
        let worktreePath: string | null = null;

        if (serverSettings.defaultThreadEnvMode === "worktree") {
          const localStatus = yield* gitWorkflow.localStatus({ cwd: project.workspaceRoot }).pipe(
            Effect.catch((detail) =>
              Effect.logWarning("Plugin thread launch could not inspect Git status", {
                projectId: project.id,
                cwd: project.workspaceRoot,
                detail,
              }).pipe(Effect.as(null)),
            ),
          );
          if (localStatus?.isRepo && localStatus.refName !== null) {
            const branchToken = (yield* uuid.pipe(
              Effect.mapError(
                (detail) =>
                  new PluginRuntimeError("Failed to generate plugin branch token.", detail),
              ),
            )).replace(/-/g, "");
            const worktree = yield* gitWorkflow
              .createWorktree({
                cwd: project.workspaceRoot,
                refName: localStatus.refName,
                newRefName: buildTemporaryWorktreeBranchName(() => branchToken.slice(0, 8)),
                path: null,
              })
              .pipe(
                Effect.mapError(
                  (detail) => new PluginRuntimeError("Failed to create plugin worktree.", detail),
                ),
              );
            branch = worktree.worktree.refName;
            worktreePath = worktree.worktree.path;
          }
        }

        let createdThread = false;
        const cleanupCreatedThread = () =>
          Effect.gen(function* () {
            if (!createdThread) {
              return;
            }
            yield* orchestration
              .dispatch({
                type: "thread.delete",
                commandId: yield* nextCommandId("thread-delete"),
                threadId,
              })
              .pipe(Effect.ignoreCause({ log: true }));
          });

        return yield* Effect.gen(function* () {
          yield* orchestration
            .dispatch({
              type: "thread.create",
              commandId: yield* nextCommandId("thread-create"),
              threadId,
              projectId: project.id,
              title: input.title,
              modelSelection,
              runtimeMode: "full-access",
              interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
              branch,
              worktreePath,
              createdAt,
            })
            .pipe(
              Effect.mapError(
                (detail) => new PluginRuntimeError("Failed to create plugin thread.", detail),
              ),
            );
          createdThread = true;

          if (worktreePath !== null) {
            yield* setupScripts
              .runForThread({
                threadId,
                projectId: project.id,
                projectCwd: project.workspaceRoot,
                worktreePath,
              })
              .pipe(
                Effect.catch((detail) =>
                  Effect.logWarning("Plugin thread launch could not start setup script", {
                    threadId,
                    projectId: project.id,
                    worktreePath,
                    detail,
                  }),
                ),
              );
          }

          yield* orchestration
            .dispatch({
              type: "thread.turn.start",
              commandId: yield* nextCommandId("turn-start"),
              threadId,
              message: {
                messageId: yield* nextMessageId,
                role: "user",
                text: input.prompt,
                attachments: [],
              },
              modelSelection,
              titleSeed: input.title,
              runtimeMode: "full-access",
              interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
              createdAt,
            })
            .pipe(
              Effect.mapError(
                (detail) => new PluginRuntimeError("Failed to start plugin turn.", detail),
              ),
            );

          return { threadId };
        }).pipe(
          Effect.catch((detail) =>
            cleanupCreatedThread().pipe(
              Effect.flatMap(() =>
                Effect.fail(
                  detail instanceof PluginRuntimeError
                    ? detail
                    : new PluginRuntimeError("Failed to launch plugin thread.", detail),
                ),
              ),
            ),
          ),
        );
      }),
  } satisfies PluginActivationContext["runtime"];
});
