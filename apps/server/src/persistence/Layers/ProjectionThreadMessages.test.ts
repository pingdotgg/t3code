import { MessageId, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";

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
      const threadId = ThreadId.makeUnsafe("thread-preserve-attachments");
      const messageId = MessageId.makeUnsafe("message-preserve-attachments");
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
    }),
  );

  it.effect("allows explicit attachment clearing with an empty array", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadMessageRepository;
      const threadId = ThreadId.makeUnsafe("thread-clear-attachments");
      const messageId = MessageId.makeUnsafe("message-clear-attachments");
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

  it.effect("looks up a projected message by id", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadMessageRepository;
      const threadId = ThreadId.makeUnsafe("thread-get-by-message-id");
      const messageId = MessageId.makeUnsafe("message-get-by-message-id");
      const createdAt = "2026-02-28T19:20:00.000Z";
      const updatedAt = "2026-02-28T19:20:01.000Z";

      yield* repository.upsert({
        messageId,
        threadId,
        turnId: null,
        role: "assistant",
        text: "lookup me",
        isStreaming: false,
        createdAt,
        updatedAt,
      });

      const maybeRow = yield* repository.getByMessageId({ messageId });
      assert.isTrue(Option.isSome(maybeRow));
      const row = Option.getOrThrow(maybeRow);
      assert.equal(row.messageId, messageId);
      assert.equal(row.threadId, threadId);
      assert.equal(row.text, "lookup me");
      assert.equal(row.createdAt, createdAt);
      assert.equal(row.updatedAt, updatedAt);
    }),
  );

  it.effect("appends streaming deltas without losing createdAt or attachments", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadMessageRepository;
      const threadId = ThreadId.makeUnsafe("thread-append-delta");
      const messageId = MessageId.makeUnsafe("message-append-delta");
      const createdAt = "2026-02-28T19:30:00.000Z";
      const persistedAttachments = [
        {
          type: "image" as const,
          id: "thread-append-delta-att-1",
          name: "example.png",
          mimeType: "image/png",
          sizeBytes: 5,
        },
      ];

      yield* repository.appendTextDelta({
        messageId,
        threadId,
        turnId: null,
        role: "assistant",
        delta: "Hello",
        attachments: persistedAttachments,
        isStreaming: true,
        createdAt,
        updatedAt: "2026-02-28T19:30:01.000Z",
      });

      yield* repository.appendTextDelta({
        messageId,
        threadId,
        turnId: null,
        role: "assistant",
        delta: " world",
        isStreaming: true,
        createdAt: "2026-02-28T19:30:05.000Z",
        updatedAt: "2026-02-28T19:30:06.000Z",
      });

      const maybeRow = yield* repository.getByMessageId({ messageId });
      assert.isTrue(Option.isSome(maybeRow));
      const row = Option.getOrThrow(maybeRow);
      assert.equal(row.text, "Hello world");
      assert.equal(row.createdAt, createdAt);
      assert.equal(row.updatedAt, "2026-02-28T19:30:06.000Z");
      assert.deepEqual(row.attachments, persistedAttachments);
      assert.isTrue(row.isStreaming);
    }),
  );
});
