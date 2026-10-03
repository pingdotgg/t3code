import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import {
  CommandId,
  type ChatAttachment,
  type MessageId,
  type ServerSettingsError,
  TextGenerationError,
  type ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";

import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import type { OrchestratorV2Error } from "./Orchestrator.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

import { formatThreadTitleContext } from "../textGeneration/ThreadTitleContext.ts";
export { formatThreadTitleContext } from "../textGeneration/ThreadTitleContext.ts";

const TITLE_GENERATION_FAILED_MESSAGE = "The thread title could not be generated.";
// The reason is persisted on the thread and sent with its shell, so CLI output is capped.
const TITLE_GENERATION_FAILURE_MAX_LENGTH = 500;
const isTextGenerationError = Schema.is(TextGenerationError);

/** The provider's reason when text generation failed, or a fixed message for anything else. */
const titleGenerationFailureMessage = (cause: Cause.Cause<unknown>): string => {
  const error = Cause.squash(cause);
  const detail = isTextGenerationError(error) ? error.detail.trim() : "";
  if (detail.length === 0) return TITLE_GENERATION_FAILED_MESSAGE;
  return detail.length > TITLE_GENERATION_FAILURE_MAX_LENGTH
    ? `${detail.slice(0, TITLE_GENERATION_FAILURE_MAX_LENGTH - 1).trimEnd()}…`
    : detail;
};

type TitleOutcome =
  | { readonly type: "stale" }
  | { readonly type: "complete"; readonly title?: string; readonly failure?: string };

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

  const complete = (input: {
    readonly threadId: ThreadId;
    readonly requestId: CommandId;
    readonly title?: string;
    readonly failure?: string;
  }) =>
    threads
      .dispatch({
        type: "thread.title.regeneration.complete",
        commandId: CommandId.make(`${input.requestId}:title-complete`),
        threadId: input.threadId,
        requestId: input.requestId,
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.failure === undefined ? {} : { failure: input.failure }),
      })
      .pipe(Effect.asVoid);

  const execute: ThreadTitleRegenerationService["Service"]["execute"] = Effect.fn(
    "ThreadTitleRegenerationService.execute",
  )(function* (input) {
    const outcome: TitleOutcome = yield* Effect.gen(function* () {
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
      return generatedTitle === "New thread" ||
        (input.kind.type === "regenerate" && generatedTitle === projection.thread.title.trim())
        ? { type: "complete" as const }
        : { type: "complete" as const, title: result.title };
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
            }).pipe(
              Effect.as({
                type: "complete" as const,
                failure: titleGenerationFailureMessage(cause),
              }),
            ),
      ),
    );

    if (outcome.type === "stale") {
      return;
    }
    yield* complete({
      ...input,
      ...(outcome.title === undefined ? {} : { title: outcome.title }),
      ...(outcome.failure === undefined ? {} : { failure: outcome.failure }),
    });
  });

  return ThreadTitleRegenerationService.of({ execute });
});

export const layer = Layer.effect(ThreadTitleRegenerationService, make);
