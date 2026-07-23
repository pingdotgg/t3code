/**
 * Boots the auto-review poller against live server services.
 * Feature stays default-off via ServerSettings.autoReview.enabled.
 *
 * Mounted from `makeServerLayer`'s application layer so RuntimeServicesLive
 * already provides JobStore, Runner, settings, and orchestration.
 */
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  MessageId,
  ThreadId,
} from "@t3tools/contracts";

import * as ServerSettings from "../serverSettings.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as AutoReviewJobStore from "./AutoReviewJobStore.ts";
import * as AutoReviewPoller from "./AutoReviewPoller.ts";
import * as AutoReviewRunner from "./AutoReviewRunner.ts";
import * as GitHubCli from "../sourceControl/GitHubCli.ts";

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const settings = yield* ServerSettings.ServerSettingsService;
    const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
    const sourceControl = yield* SourceControlProviderRegistry.SourceControlProviderRegistry;
    const orchestration = yield* OrchestrationEngine.OrchestrationEngineService;
    const crypto = yield* Crypto.Crypto;
    yield* AutoReviewJobStore.AutoReviewJobStore;
    yield* AutoReviewRunner.AutoReviewRunner;
    yield* GitHubCli.GitHubCli;

    const deps: AutoReviewPoller.AutoReviewPollerDeps = {
      getSettings: settings.getSettings,
      listProjects: snapshots.getShellSnapshot().pipe(
        Effect.map((shell) =>
          shell.projects.map((project) => ({
            id: String(project.id),
            workspaceRoot: project.workspaceRoot,
            deletedAt: null,
          })),
        ),
        Effect.orElseSucceed(() => []),
      ),
      isGitHubProject: (cwd: string) =>
        sourceControl.resolveHandle({ cwd }).pipe(
          Effect.map((handle) => handle.provider.kind === "github"),
          Effect.orElseSucceed(() => false),
        ),
      contextForJob: (job) =>
        Effect.gen(function* () {
          const shell = yield* snapshots.getShellSnapshot().pipe(
            Effect.orElseSucceed(() => null),
          );
          if (!shell) {
            return { cwd: "", candidates: [] };
          }
          const project = shell.projects.find((p) => String(p.id) === job.projectId);
          return {
            cwd: project?.workspaceRoot ?? "",
            candidates: shell.threads
              .filter(
                (thread) =>
                  String(thread.projectId) === job.projectId && thread.archivedAt == null,
              )
              .map((thread) => ({
                threadId: String(thread.id),
                projectId: String(thread.projectId),
                deletedAt: thread.archivedAt,
                updatedAt: thread.updatedAt,
                status: thread.session?.status ?? "idle",
                prNumber: null as number | null,
                prState: null as "open" | "closed" | "merged" | null,
                branch: thread.branch,
              })),
            dispatchFixPrompt: (input: { readonly threadId: string; readonly prompt: string }) =>
              Effect.gen(function* () {
                const commandUuid = yield* crypto.randomUUIDv4;
                const messageUuid = yield* crypto.randomUUIDv4;
                const createdAt = DateTime.formatIso(yield* DateTime.now);
                yield* orchestration
                  .dispatch({
                    type: "thread.turn.start",
                    commandId: CommandId.make(`auto-review-fix:${commandUuid}`),
                    threadId: ThreadId.make(input.threadId),
                    message: {
                      messageId: MessageId.make(`auto-review-fix-msg:${messageUuid}`),
                      role: "user",
                      text: input.prompt,
                      attachments: [],
                    },
                    runtimeMode: DEFAULT_RUNTIME_MODE,
                    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
                    createdAt,
                  })
                  .pipe(Effect.asVoid);
              }).pipe(
                Effect.provideService(Crypto.Crypto, crypto),
                Effect.orElseSucceed(() => undefined),
                Effect.asVoid,
              ),
          } satisfies AutoReviewRunner.AutoReviewOriginContext;
        }),
    };

    const poller = yield* AutoReviewPoller.make(deps);
    yield* Effect.forkScoped(
      poller.start.pipe(
        Effect.delay(Duration.seconds(5)),
        Effect.andThen(Effect.logInfo("Auto-review poller started")),
        Effect.orElseSucceed(() => undefined),
      ),
    );
  }),
);
