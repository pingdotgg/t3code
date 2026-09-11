import { MessageId, ThreadId, TurnId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { ProjectionThreadMessageRepository } from "../Services/ProjectionThreadMessages.ts";
import { ProjectionThreadMessageRepositoryLive } from "./ProjectionThreadMessages.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = it.layer(
  ProjectionThreadMessageRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

layer("ProjectionThreadMessageRepository", (it) => {
  it.effect("finds the latest live user-message time within one thread", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadMessageRepository;
      const threadId = ThreadId.make("thread-latest-user-message");
      assert.isNull(yield* repository.getLatestUserMessageAt({ threadId }));

      yield* repository.upsert({
        messageId: MessageId.make("import:codex:latest-user-message:000000"),
        threadId,
        turnId: null,
        role: "user",
        text: "Imported prompt",
        isStreaming: false,
        createdAt: "2026-02-28T19:05:06.000Z",
        updatedAt: "2026-02-28T19:05:06.000Z",
      });
      assert.isNull(yield* repository.getLatestUserMessageAt({ threadId }));

      const messages = [
        { role: "user", createdAt: "2026-02-28T19:05:02.000Z" },
        { role: "user", createdAt: "2026-02-28T19:05:01.000Z" },
        { role: "assistant", createdAt: "2026-02-28T19:05:03.000Z" },
        { role: "system", createdAt: "2026-02-28T19:05:04.000Z" },
      ] as const;
      for (const [index, message] of messages.entries()) {
        yield* repository.upsert({
          messageId: MessageId.make(`latest-user-message-${index}`),
          threadId,
          turnId: null,
          ...message,
          text: "Message body",
          isStreaming: false,
          updatedAt: "2026-02-28T19:06:00.000Z",
        });
      }
      yield* repository.upsert({
        messageId: MessageId.make("latest-user-message-other-thread"),
        threadId: ThreadId.make("thread-latest-user-message-other"),
        turnId: null,
        role: "user",
        text: "Other thread",
        isStreaming: false,
        createdAt: "2026-02-28T19:05:05.000Z",
        updatedAt: "2026-02-28T19:05:05.000Z",
      });

      assert.strictEqual(
        yield* repository.getLatestUserMessageAt({ threadId }),
        "2026-02-28T19:05:02.000Z",
      );
      yield* repository.deleteByThreadId({ threadId });
      assert.isNull(yield* repository.getLatestUserMessageAt({ threadId }));
    }),
  );

  it.effect("appends streaming text and applies attachment updates", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadMessageRepository;
      const threadId = ThreadId.make("thread-streaming-append");
      const messageId = MessageId.make("message-streaming-append");
      const createdAt = "2026-02-28T19:05:00.000Z";
      const attachments = [
        {
          type: "image" as const,
          id: "thread-streaming-append-att-1",
          name: "example.png",
          mimeType: "image/png",
          sizeBytes: 5,
        },
      ];

      yield* repository.appendStreaming({
        messageId,
        threadId,
        turnId: null,
        role: "assistant",
        text: "hello",
        attachments,
        createdAt,
        updatedAt: createdAt,
      });
      yield* repository.appendStreaming({
        messageId,
        threadId,
        turnId: null,
        role: "assistant",
        text: " world",
        createdAt: "2026-02-28T19:05:01.000Z",
        updatedAt: "2026-02-28T19:05:01.000Z",
      });

      const rowWithPreservedAttachments = yield* repository.getByMessageId({ messageId });
      assert.equal(rowWithPreservedAttachments._tag, "Some");
      if (rowWithPreservedAttachments._tag === "Some") {
        assert.deepEqual(rowWithPreservedAttachments.value.attachments, attachments);
      }

      yield* repository.appendStreaming({
        messageId,
        threadId,
        turnId: null,
        role: "assistant",
        text: "",
        attachments: [],
        createdAt: "2026-02-28T19:05:02.000Z",
        updatedAt: "2026-02-28T19:05:02.000Z",
      });

      const row = yield* repository.getByMessageId({ messageId });
      assert.equal(row._tag, "Some");
      if (row._tag === "Some") {
        assert.equal(row.value.text, "hello world");
        assert.deepEqual(row.value.attachments, []);
        assert.equal(row.value.createdAt, createdAt);
        assert.equal(row.value.updatedAt, "2026-02-28T19:05:02.000Z");
        assert.isTrue(row.value.isStreaming);
      }
    }),
  );

  it.effect("persists actual model metadata across later partial upserts", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadMessageRepository;
      const threadId = ThreadId.make("thread-actual-model");
      const messageId = MessageId.make("message-actual-model");
      const createdAt = "2026-08-14T00:00:00.000Z";

      yield* repository.upsert({
        messageId,
        threadId,
        turnId: null,
        role: "assistant",
        text: "complete",
        actualModel: "gpt-5.6-luna",
        isStreaming: false,
        createdAt,
        updatedAt: createdAt,
      });
      yield* repository.upsert({
        messageId,
        threadId,
        turnId: null,
        role: "assistant",
        text: "complete",
        isStreaming: false,
        createdAt,
        updatedAt: "2026-08-14T00:00:01.000Z",
      });

      const row = yield* repository.getByMessageId({ messageId });
      assert.equal(row._tag, "Some");
      if (row._tag === "Some") {
        assert.equal(row.value.actualModel, "gpt-5.6-luna");
      }
    }),
  );

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

  it.effect("checks assistant turn state without hydrating message text", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadMessageRepository;
      const threadId = ThreadId.make("thread-assistant-turn-state");
      const turnId = TurnId.make("turn-assistant-state");
      const createdAt = "2026-03-01T00:00:00.000Z";

      yield* repository.upsert({
        messageId: MessageId.make("message-assistant-turn-state"),
        threadId,
        turnId,
        role: "assistant",
        text: "large text that the existence query must not select",
        isStreaming: false,
        createdAt,
        updatedAt: createdAt,
      });

      assert.equal(
        yield* repository.hasAssistantMessageForTurn({
          threadId,
          turnId,
          streamingOnly: false,
        }),
        true,
      );
      assert.equal(
        yield* repository.hasAssistantMessageForTurn({
          threadId,
          turnId,
          streamingOnly: true,
        }),
        false,
      );
      assert.equal(
        yield* repository.hasAssistantMessageForTurn({
          threadId,
          turnId: TurnId.make("turn-assistant-state-missing"),
          streamingOnly: false,
        }),
        false,
      );
    }),
  );

  it.effect("finds the latest assistant message id for a turn without hydrating message text", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadMessageRepository;
      const threadId = ThreadId.make("thread-latest-assistant-message");
      const turnId = TurnId.make("turn-latest-assistant-message");

      assert.isTrue(
        Option.isNone(yield* repository.getLatestAssistantMessageIdForTurn({ threadId, turnId })),
      );
      for (const [index, createdAt] of [
        "2026-03-01T00:00:00.000Z",
        "2026-03-01T00:00:01.000Z",
      ].entries()) {
        yield* repository.upsert({
          messageId: MessageId.make(`message-latest-assistant-${index}`),
          threadId,
          turnId,
          role: "assistant",
          text: "large text that the id query must not select",
          isStreaming: false,
          createdAt,
          updatedAt: createdAt,
        });
      }

      assert.deepEqual(
        yield* repository.getLatestAssistantMessageIdForTurn({ threadId, turnId }),
        Option.some(MessageId.make("message-latest-assistant-1")),
      );
    }),
  );
});
