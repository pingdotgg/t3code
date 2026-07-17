import { MessageId, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ProjectionThreadMessageRepositoryLive } from "../../persistence/Layers/ProjectionThreadMessages.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ProjectionThreadMessageRepository } from "../../persistence/Services/ProjectionThreadMessages.ts";
import { makeProjectionsReadCapability } from "./ProjectionsReadCapability.ts";

const layer = it.layer(
  ProjectionThreadMessageRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

layer("ProjectionsReadCapability", (it) => {
  it.effect("getMessageById returns the projected message or null", () =>
    Effect.gen(function* () {
      const messages = yield* ProjectionThreadMessageRepository;
      const projections = makeProjectionsReadCapability({
        snapshots: {} as any,
        turns: {} as any,
        messages,
        activities: {} as any,
      });
      const threadId = ThreadId.make("thread-message-by-id");
      const messageId = MessageId.make("message-by-id");
      const createdAt = "2026-03-01T00:00:00.000Z";

      yield* messages.upsert({
        messageId,
        threadId,
        turnId: null,
        role: "assistant",
        text: "projected text",
        isStreaming: false,
        createdAt,
        updatedAt: createdAt,
      });

      const found = yield* projections.getMessageById(messageId);
      const missing = yield* projections.getMessageById(MessageId.make("message-missing"));

      assert.deepEqual(found, {
        id: messageId,
        role: "assistant",
        text: "projected text",
        turnId: null,
        streaming: false,
        createdAt,
        updatedAt: createdAt,
      });
      assert.equal(missing, null);
    }),
  );

  it.effect("listMessagesByThreadId bounds the query with a SQL LIMIT", () =>
    Effect.gen(function* () {
      const messages = yield* ProjectionThreadMessageRepository;
      const projections = makeProjectionsReadCapability({
        snapshots: {} as any,
        turns: {} as any,
        messages,
        activities: {} as any,
      });
      const threadId = ThreadId.make("thread-limit");

      // Seed more rows than we will request. Because the cap pushes the bound
      // into the repo query (LIMIT) rather than slicing after materializing all
      // rows, only `limit` rows come back — in ascending creation order.
      for (let index = 0; index < 5; index += 1) {
        const stamp = `2026-03-01T00:00:0${index}.000Z`;
        yield* messages.upsert({
          messageId: MessageId.make(`message-limit-${index}`),
          threadId,
          turnId: null,
          role: "assistant",
          text: `message ${index}`,
          isStreaming: false,
          createdAt: stamp,
          updatedAt: stamp,
        });
      }

      const limited = yield* projections.listMessagesByThreadId({ threadId, limit: 2 });
      assert.equal(limited.length, 2);
      assert.deepEqual(
        limited.map((message) => message.id),
        [MessageId.make("message-limit-0"), MessageId.make("message-limit-1")],
      );
    }),
  );
});
