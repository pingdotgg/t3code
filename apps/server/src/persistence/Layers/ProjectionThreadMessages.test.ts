import { MessageId, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ProjectionThreadMessageRepository } from "../Services/ProjectionThreadMessages.ts";
import { ProjectionThreadMessageRepositoryLive } from "./ProjectionThreadMessages.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = it.layer(
  ProjectionThreadMessageRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

layer("ProjectionThreadMessageRepository", (it) => {
  it.effect("preserves existing attachments when upsert omits attachments", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadMessageRepository;
      const threadId = ThreadId.make("thread-preserve-attachments");
      const messageId = MessageId.make("message-preserve-attachments");
      const createdAt = "2026-02-28T19:00:00.000Z";
      const updatedAt = "2026-02-28T19:00:01.000Z";
      const persistedAttachments = [
        {
          type: "image" as const,
          id: "thread-preserve-attachments-att-1",
          name: "example.png",
          mimeType: "image/png",
          sizeBytes: 5,
        },
      ];

      yield* repository.upsert({
        messageId,
        threadId,
        turnId: null,
        role: "user",
        text: "initial",
        attachments: persistedAttachments,
        isStreaming: false,
        createdAt,
        updatedAt,
      });

      yield* repository.upsert({
        messageId,
        threadId,
        turnId: null,
        role: "user",
        text: "updated",
        isStreaming: false,
        createdAt,
        updatedAt: "2026-02-28T19:00:02.000Z",
      });

      const rows = yield* repository.listByThreadId({ threadId });
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.text, "updated");
      assert.deepEqual(rows[0]?.attachments, persistedAttachments);

      const rowById = yield* repository.getByMessageId({ messageId });
      assert.equal(rowById._tag, "Some");
      if (rowById._tag === "Some") {
        assert.equal(rowById.value.text, "updated");
        assert.deepEqual(rowById.value.attachments, persistedAttachments);
      }
    }),
  );

  it.effect("allows explicit attachment clearing with an empty array", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadMessageRepository;
      const threadId = ThreadId.make("thread-clear-attachments");
      const messageId = MessageId.make("message-clear-attachments");
      const createdAt = "2026-02-28T19:10:00.000Z";

      yield* repository.upsert({
        messageId,
        threadId,
        turnId: null,
        role: "assistant",
        text: "with attachment",
        attachments: [
          {
            type: "image",
            id: "thread-clear-attachments-att-1",
            name: "example.png",
            mimeType: "image/png",
            sizeBytes: 5,
          },
        ],
        isStreaming: false,
        createdAt,
        updatedAt: "2026-02-28T19:10:01.000Z",
      });

      yield* repository.upsert({
        messageId,
        threadId,
        turnId: null,
        role: "assistant",
        text: "cleared",
        attachments: [],
        isStreaming: false,
        createdAt,
        updatedAt: "2026-02-28T19:10:02.000Z",
      });

      const rows = yield* repository.listByThreadId({ threadId });
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.text, "cleared");
      assert.deepEqual(rows[0]?.attachments, []);
    }),
  );

  it.effect("reads only the message context needed to start a provider turn", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadMessageRepository;
      const threadId = ThreadId.make("thread-turn-start-context");
      const otherThreadId = ThreadId.make("thread-turn-start-context-other");
      const firstMessageId = MessageId.make("message-turn-start-context-first");
      const secondMessageId = MessageId.make("message-turn-start-context-second");
      const createdAt = "2026-02-28T19:20:00.000Z";

      yield* Effect.forEach(
        [
          {
            messageId: firstMessageId,
            threadId,
            role: "user" as const,
            text: "first user message",
          },
          {
            messageId: MessageId.make("message-turn-start-context-assistant"),
            threadId,
            role: "assistant" as const,
            text: "assistant message",
          },
          {
            messageId: secondMessageId,
            threadId,
            role: "user" as const,
            text: "second user message",
          },
        ],
        (message) =>
          repository.upsert({
            ...message,
            turnId: null,
            isStreaming: false,
            createdAt,
            updatedAt: createdAt,
          }),
        { discard: true },
      );

      const context = yield* repository.getTurnStartContext({
        threadId,
        messageId: secondMessageId,
      });
      assert.equal(context._tag, "Some");
      if (context._tag === "Some") {
        assert.equal(context.value.message.text, "second user message");
        assert.equal(context.value.userMessageCount, 2);
      }

      const wrongThread = yield* repository.getTurnStartContext({
        threadId: otherThreadId,
        messageId: secondMessageId,
      });
      assert.equal(wrongThread._tag, "None");
    }),
  );
});
