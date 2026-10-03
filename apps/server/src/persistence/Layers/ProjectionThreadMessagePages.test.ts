import { EnvironmentId, MessageId, ThreadContextId, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { ProjectionThreadMessageRepository } from "../Services/ProjectionThreadMessages.ts";
import { ProjectionThreadMessageRepositoryLive } from "./ProjectionThreadMessages.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = it.layer(
  ProjectionThreadMessageRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

const threadId = ThreadId.make("thread-paged-history");

function seedMessage(index: number, text = `message ${index}`) {
  const padded = String(index).padStart(2, "0");
  return {
    messageId: MessageId.make(`message-paged-${padded}`),
    threadId,
    turnId: null,
    role: "user" as const,
    text,
    isStreaming: false,
    createdAt: `2026-04-01T00:00:${padded}.000Z`,
    updatedAt: `2026-04-01T00:00:${padded}.000Z`,
  };
}

layer("ProjectionThreadMessageRepository.listMessagesPage", (it) => {
  it.effect("pages in stable creation order without loading the whole history", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadMessageRepository;
      for (let index = 0; index < 5; index += 1) {
        yield* repository.upsert(seedMessage(index));
      }

      const first = yield* repository.listMessagesPage({ threadId, limit: 2 });
      assert.equal(first.map((row) => row.messageId).length, 2);
      assert.deepEqual(
        first.map((row) => row.messageId),
        ["message-paged-00", "message-paged-01"],
      );

      const last = first.at(-1);
      assert.ok(last);
      const second = yield* repository.listMessagesPage({
        threadId,
        afterCreatedAt: last.createdAt,
        afterMessageId: last.messageId,
        limit: 2,
      });
      assert.deepEqual(
        second.map((row) => row.messageId),
        ["message-paged-02", "message-paged-03"],
      );

      const tail = second.at(-1);
      assert.ok(tail);
      const rest = yield* repository.listMessagesPage({
        threadId,
        afterCreatedAt: tail.createdAt,
        afterMessageId: tail.messageId,
        limit: 2,
      });
      // Only one row remains: a bounded page, never the whole history.
      assert.deepEqual(
        rest.map((row) => row.messageId),
        ["message-paged-04"],
      );
    }),
  );

  it.effect("round-trips message context through storage", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadMessageRepository;
      const context = {
        version: 1 as const,
        records: [
          {
            version: 1 as const,
            kind: "thread" as const,
            contextId: ThreadContextId.make("ctx_1"),
            label: "Auth refactor",
            environmentId: EnvironmentId.make("env-1"),
            threadId: ThreadId.make("thread-attached"),
            title: "Auth refactor thread",
          },
        ],
      };
      yield* repository.upsert({ ...seedMessage(9, "with context"), context });

      const rows = yield* repository.listMessagesPage({ threadId, limit: 10 });
      const stored = rows.find((row) => row.messageId === "message-paged-09");
      assert.deepEqual(stored?.context, context);
    }),
  );

  it.effect("preserves context when an upsert omits it", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadMessageRepository;
      const context = {
        version: 1 as const,
        records: [],
      };
      yield* repository.upsert({ ...seedMessage(8, "context then omitted"), context });
      yield* repository.upsert({ ...seedMessage(8, "updated text") });

      const row = yield* repository.getByMessageId({
        messageId: MessageId.make("message-paged-08"),
      });
      assert.equal(row._tag, "Some");
      if (row._tag === "Some") {
        assert.equal(row.value.text, "updated text");
        assert.deepEqual(row.value.context, context);
      }
    }),
  );
});
