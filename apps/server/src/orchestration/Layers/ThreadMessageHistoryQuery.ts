import { Effect, Layer } from "effect";

import { ProjectionThreadMessageRepository } from "../../persistence/Services/ProjectionThreadMessages.ts";
import {
  ThreadMessageHistoryQuery,
  type ThreadMessageHistoryQueryShape,
} from "../Services/ThreadMessageHistoryQuery.ts";

const make = Effect.gen(function* () {
  const repository = yield* ProjectionThreadMessageRepository;

  const getThreadMessagesPage: ThreadMessageHistoryQueryShape["getThreadMessagesPage"] = (input) =>
    repository.listPageNewestFirst(input).pipe(
      Effect.map(({ messages, total }) => ({
        messages: messages.map((message) => ({
          id: message.messageId,
          role: message.role,
          text: message.text,
          ...(message.attachments ? { attachments: message.attachments } : {}),
          turnId: message.turnId,
          streaming: message.isStreaming,
          createdAt: message.createdAt,
          updatedAt: message.updatedAt,
        })),
        total,
        hasMore: input.offset + messages.length < total,
      })),
    );

  return {
    getThreadMessagesPage,
  } satisfies ThreadMessageHistoryQueryShape;
});

export const ThreadMessageHistoryQueryLive = Layer.effect(ThreadMessageHistoryQuery, make);
