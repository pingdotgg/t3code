import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import {
  CommandId,
  type ChatAttachment,
  type MessageId,
  type ServerSettingsError,
  type ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import type { OrchestratorV2Error } from "./Orchestrator.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

import { formatThreadTitleContext } from "../textGeneration/ThreadTitleContext.ts";
export { formatThreadTitleContext } from "../textGeneration/ThreadTitleContext.ts";

export class ThreadTitleRegenerationService extends Context.Service<
  ThreadTitleRegenerationService,
  {
    readonly execute: (input: {
      readonly threadId: ThreadId;
      readonly requestId: CommandId;
      readonly kind:
        | { readonly type: "initial"; readonly messageId: MessageId }
        | { readonly type: "regenerate" };
    }) => Effect.Effect<
      void,
      OrchestratorV2Error | ProjectStore.ProjectStoreV2Error | ServerSettingsError
    >;
  }
>()("t3/orchestration-v2/ThreadTitleRegenerationService") {}

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const textGeneration = yield* TextGeneration.TextGeneration;
  const backgroundScope = yield* Scope.make("sequential");
  yield* Effect.addFinalizer(() => Scope.close(backgroundScope, Exit.void));

  // A generic first title ("Fix this") is refined once, after the first run
  // completes, from the whole conversation. Replaying the thread's events from
  // the start also sees a run that already ended. Any title change in the
  // meantime, such as a user rename, cancels the refinement.
  const refineAfterFirstRun = (input: {
    readonly threadId: ThreadId;
    readonly requestId: CommandId;
    readonly title: string;
  }) =>
    threads.streamStoredEventsFrom({ threadId: input.threadId, afterSequence: 0 }).pipe(
      Stream.filter(
        ({ event }) =>
          event.type === "run.updated" &&
          event.payload.ordinal === 1 &&
          ThreadManagementService.isTerminalRunStatus(event.payload.status),
      ),
      Stream.runHead,
      Effect.flatMap((ended) =>
        Option.isNone(ended) ||
        ended.value.event.type !== "run.updated" ||
        ended.value.event.payload.status !== "completed"
          ? Effect.void
          : threads.getThreadShell(input.threadId).pipe(
              Effect.flatMap((thread) =>
                thread === null || thread.title !== input.title || thread.titleRegeneration
                  ? Effect.void
                  : threads.dispatch({
                      type: "thread.metadata.update",
                      commandId: CommandId.make(`${input.requestId}:title-refine`),
                      threadId: input.threadId,
                      // A rename that lands after the read above still wins.
                      expectedTitle: input.title,
                      regenerateTitle: true,
                    }),
              ),
            ),
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning("Thread title refinement failed", {
          threadId: input.threadId,
          cause,
        }),
      ),
    );

  const complete = (input: {
    readonly threadId: ThreadId;
    readonly requestId: CommandId;
    readonly title?: string;
  }) =>
    threads
      .dispatch({
        type: "thread.title.regeneration.complete",
        commandId: CommandId.make(`${input.requestId}:title-complete`),
        threadId: input.threadId,
        requestId: input.requestId,
        ...(input.title === undefined ? {} : { title: input.title }),
      })
      .pipe(Effect.asVoid);

  const execute: ThreadTitleRegenerationService["Service"]["execute"] = Effect.fn(
    "ThreadTitleRegenerationService.execute",
  )(function* (input) {
    const outcome:
      | { readonly type: "stale" }
      | {
          readonly type: "complete";
          readonly title?: string;
          /** Set when a generic initial title should be refined after the first run. */
          readonly refineTitle?: string;
        } = yield* Effect.gen(function* () {
      const projection = yield* threads.getThreadRecords(
        input.threadId,
        ["messages"],
        input.kind.type === "initial"
          ? { messageIds: [input.kind.messageId] }
          : { messageRoles: ["user", "assistant"] },
      );
      if (projection.thread.titleRegeneration?.requestId !== input.requestId) {
        return { type: "stale" as const };
      }

      const project = yield* projects.get(projection.thread.projectId);
      if (Option.isNone(project)) {
        return { type: "complete" as const };
      }

      let context: {
        readonly message: string;
        readonly attachments: ReadonlyArray<ChatAttachment>;
      };
      if (input.kind.type === "initial") {
        const messageId = input.kind.messageId;
        const message = projection.messages.find(
          (candidate) => candidate.id === messageId && !candidate.streaming,
        );
        context =
          message === undefined
            ? { message: "", attachments: [] }
            : { message: message.text, attachments: message.attachments };
      } else {
        context = formatThreadTitleContext(
          projection.messages.filter((message) => !message.streaming),
        );
      }
      if (context.message.length === 0 && context.attachments.length === 0) {
        return { type: "complete" as const };
      }

      const settings = resolveProjectSettings(
        yield* serverSettings.getSettings,
        projection.thread.projectId,
      ).settings;
      const result = yield* textGeneration.generateThreadTitle({
        cwd: projection.thread.worktreePath ?? project.value.workspaceRoot,
        message: context.message,
        attachments: context.attachments,
        ...(input.kind.type === "regenerate" ? { previousTitle: projection.thread.title } : {}),
        modelSelection: settings.textGenerationModelSelection,
      });
      const generatedTitle = result.title.trim();
      const title =
        generatedTitle === "New thread" ||
        (input.kind.type === "regenerate" && generatedTitle === projection.thread.title.trim())
          ? undefined
          : result.title;
      const refine =
        input.kind.type === "initial" &&
        (result.needsRefinement === true || generatedTitle === "New thread");
      return {
        type: "complete" as const,
        ...(title === undefined ? {} : { title }),
        ...(refine ? { refineTitle: title ?? projection.thread.title } : {}),
      };
    }).pipe(
      Effect.retry({
        times: input.kind.type === "initial" ? 2 : 0,
        schedule: Schedule.exponential("2 seconds"),
      }),
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logWarning("Thread title generation failed", {
              threadId: input.threadId,
              requestId: input.requestId,
              cause,
            }).pipe(Effect.as({ type: "complete" as const })),
      ),
    );

    if (outcome.type === "stale") {
      return;
    }
    yield* complete({
      ...input,
      ...(outcome.title === undefined ? {} : { title: outcome.title }),
    });
    if (outcome.refineTitle !== undefined) {
      yield* refineAfterFirstRun({
        threadId: input.threadId,
        requestId: input.requestId,
        title: outcome.refineTitle,
      }).pipe(Effect.forkIn(backgroundScope));
    }
  });

  return ThreadTitleRegenerationService.of({ execute });
});

export const layer = Layer.effect(ThreadTitleRegenerationService, make);
