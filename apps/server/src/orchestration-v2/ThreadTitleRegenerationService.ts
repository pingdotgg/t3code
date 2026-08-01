import {
  type ChatAttachment,
  CommandId,
  type MessageId,
  type ServerSettingsError,
  type ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import type { ProjectionRepositoryError } from "../persistence/Errors.ts";
import { ProjectionProjectRepository } from "../persistence/Services/ProjectionProjects.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import type { OrchestratorV2Error } from "./Orchestrator.ts";
import { ThreadManagementService } from "./ThreadManagementService.ts";

const MAX_REGENERATION_ATTACHMENTS = 4;
const MAX_THREAD_TITLE_CONTEXT_CHARS = 8_000;
const THREAD_TITLE_CONTEXT_TRUNCATION_MARKER = "[Earlier content truncated]\n\n";

/**
 * Newest-first conversation digest for the title prompt: walk messages from
 * the end, keep whole sections while they fit the char budget, and mark
 * truncation once older content stops fitting. Ported from the v1 reactor's
 * regeneration flow.
 */
export function formatThreadTitleContext(
  messages: ReadonlyArray<{
    readonly role: "user" | "assistant" | "system";
    readonly text: string;
    readonly attachments?: ReadonlyArray<ChatAttachment> | undefined;
  }>,
): {
  readonly message: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
} {
  let context = "";
  let truncated = false;
  const retainedAttachments: Array<ChatAttachment> = [];

  for (const message of messages.toReversed()) {
    if (message.role === "system") {
      continue;
    }
    const text = message.text.trim();
    const attachmentSummary = (message.attachments ?? [])
      .map((attachment) => attachment.name)
      .join(", ");
    const contents = [
      ...(text.length > 0 ? [text] : []),
      ...(attachmentSummary.length > 0 ? [`[Attachments: ${attachmentSummary}]`] : []),
    ].join("\n");
    if (contents.length === 0) {
      continue;
    }

    const section = `${message.role.toUpperCase()}:\n${contents}`;
    const separator = context.length > 0 ? "\n\n" : "";
    const available = MAX_THREAD_TITLE_CONTEXT_CHARS - context.length - separator.length;
    if (section.length > available) {
      truncated = true;
      break;
    }
    context = `${section}${separator}${context}`;
    for (const attachment of message.attachments ?? []) {
      if (retainedAttachments.length < MAX_REGENERATION_ATTACHMENTS) {
        retainedAttachments.push(attachment);
      }
    }
  }

  return {
    message: truncated ? `${THREAD_TITLE_CONTEXT_TRUNCATION_MARKER}${context}` : context,
    attachments: retainedAttachments,
  };
}

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
      OrchestratorV2Error | ProjectionRepositoryError | ServerSettingsError
    >;
  }
>()("t3/orchestration-v2/ThreadTitleRegenerationService") {}

export const make = Effect.gen(function* () {
  const threads = yield* ThreadManagementService;
  const projects = yield* ProjectionProjectRepository;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const textGeneration = yield* TextGeneration.TextGeneration;

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
      | { readonly type: "complete"; readonly title?: string } = yield* Effect.gen(function* () {
      const projection = yield* threads.getThreadProjection(input.threadId);
      if (projection.thread.titleRegeneration?.requestId !== input.requestId) {
        return { type: "stale" as const };
      }

      const project = yield* projects.getById({ projectId: projection.thread.projectId });
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

      const settings = yield* serverSettings.getSettings;
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
  });

  return ThreadTitleRegenerationService.of({ execute });
});

export const layer = Layer.effect(ThreadTitleRegenerationService, make);
