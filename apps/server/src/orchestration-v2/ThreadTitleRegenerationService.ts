import { type ChatAttachment, CommandId, type ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as ProjectService from "../project/ProjectService.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
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

/**
 * Reacts to thread.metadata-updated events that arm the titleRegeneration
 * marker: generates a title from the thread's conversation and lands it via a
 * follow-up metadata update (which clears the marker), or clears the marker
 * explicitly when generation fails. Event-driven so every dispatch surface
 * (ws, MCP, mobile) gets the same behavior.
 */
export const workerLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const threads = yield* ThreadManagementService;
    const projects = yield* ProjectService.ProjectService;
    const textGeneration = yield* TextGeneration.TextGeneration;
    const handledRequestIds = new Set<string>();

    const regenerate = Effect.fn("ThreadTitleRegenerationService.regenerate")(function* (
      threadId: ThreadId,
      requestId: CommandId,
    ) {
      const projection = yield* threads.getThreadProjection(threadId);
      if (projection.thread.titleRegeneration?.requestId !== requestId) {
        return;
      }
      const project = yield* projects.getById(projection.thread.projectId);
      if (Option.isNone(project)) {
        return;
      }
      const context = formatThreadTitleContext(
        projection.messages.filter((message) => !message.streaming),
      );
      if (context.message.length === 0) {
        yield* threads.dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make(`${requestId}:title-clear`),
          threadId,
          regenerateTitle: false,
        });
        return;
      }
      const result = yield* textGeneration.generateThreadTitle({
        cwd: projection.thread.worktreePath ?? Option.getOrThrow(project).workspaceRoot,
        message: context.message,
        attachments: context.attachments,
        modelSelection: projection.thread.modelSelection,
      });
      yield* threads.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make(`${requestId}:title`),
        threadId,
        title: result.title,
      });
    });

    yield* threads.streamDomainEvents.pipe(
      Stream.runForEach((event) => {
        if (event.type !== "thread.metadata-updated") {
          return Effect.void;
        }
        const marker = event.payload.titleRegeneration;
        if (marker === null || marker === undefined || handledRequestIds.has(marker.requestId)) {
          return Effect.void;
        }
        handledRequestIds.add(marker.requestId);
        return regenerate(event.threadId, marker.requestId).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Thread title regeneration failed", {
              threadId: event.threadId,
              requestId: marker.requestId,
              cause,
            }).pipe(
              Effect.andThen(
                threads
                  .dispatch({
                    type: "thread.metadata.update",
                    commandId: CommandId.make(`${marker.requestId}:title-clear`),
                    threadId: event.threadId,
                    regenerateTitle: false,
                  })
                  .pipe(Effect.ignore),
              ),
            ),
          ),
          Effect.forkDetach,
          Effect.asVoid,
        );
      }),
      Effect.forkScoped,
    );
  }),
);
