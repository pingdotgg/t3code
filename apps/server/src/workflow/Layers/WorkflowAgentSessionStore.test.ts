import { BoardId, LaneKey, TicketId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { MigrationsLive } from "../../persistence/Migrations.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { WorkflowAgentSessionStore } from "../Services/WorkflowAgentSessionStore.ts";
import { WorkflowAgentSessionStoreLive } from "./WorkflowAgentSessionStore.ts";

const storeLayer = it.layer(
  WorkflowAgentSessionStoreLive.pipe(
    Layer.provideMerge(MigrationsLive),
    Layer.provideMerge(SqlitePersistenceMemory),
  ),
);

const seedTicket = (ticketId: TicketId, boardId: BoardId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const now = DateTime.formatIso(yield* DateTime.now);
    yield* sql`
      INSERT INTO projection_ticket
        (ticket_id, board_id, title, current_lane_key, status, created_at, updated_at)
      VALUES
        (${String(ticketId)}, ${String(boardId)}, ${"t"}, ${"backlog"}, ${"open"}, ${now}, ${now})
    `;
  });

storeLayer("WorkflowAgentSessionStore", (it) => {
  it.effect("upsert then getThreadId returns the stored thread id", () =>
    Effect.gen(function* () {
      const store = yield* WorkflowAgentSessionStore;
      const ticketId = TicketId.make("ticket-1");
      const laneKey = LaneKey.make("implement");

      yield* store.upsert(ticketId, laneKey, "agent-a", "thread-1");
      const threadId = yield* store.getThreadId(ticketId, laneKey, "agent-a");
      assert.equal(threadId, "thread-1");
    }),
  );

  it.effect("missing key returns null", () =>
    Effect.gen(function* () {
      const store = yield* WorkflowAgentSessionStore;
      const threadId = yield* store.getThreadId(
        TicketId.make("ticket-missing"),
        LaneKey.make("implement"),
        "agent-a",
      );
      assert.isNull(threadId);
    }),
  );

  it.effect("re-upsert updates last_used_at and keeps the original thread id", () =>
    Effect.gen(function* () {
      const store = yield* WorkflowAgentSessionStore;
      const ticketId = TicketId.make("ticket-2");
      const laneKey = LaneKey.make("implement");

      yield* store.upsert(ticketId, laneKey, "agent-a", "thread-1");
      const before = yield* store.listByTicket(ticketId);
      assert.equal(before.length, 1);
      const firstUsedAt = before[0]!.lastUsedAt;

      // A second upsert with a different thread id must NOT overwrite thread_id
      // (resume must keep reusing the same stable thread); it bumps last_used_at.
      yield* store.upsert(ticketId, laneKey, "agent-a", "thread-IGNORED");

      const threadId = yield* store.getThreadId(ticketId, laneKey, "agent-a");
      assert.equal(threadId, "thread-1");

      const after = yield* store.listByTicket(ticketId);
      assert.equal(after.length, 1);
      assert.isTrue(after[0]!.lastUsedAt >= firstUsedAt);
    }),
  );

  it.effect("two agent keys in one (ticket, lane) coexist", () =>
    Effect.gen(function* () {
      const store = yield* WorkflowAgentSessionStore;
      const ticketId = TicketId.make("ticket-3");
      const laneKey = LaneKey.make("implement");

      yield* store.upsert(ticketId, laneKey, "agent-a", "thread-a");
      yield* store.upsert(ticketId, laneKey, "agent-b", "thread-b");

      assert.equal(yield* store.getThreadId(ticketId, laneKey, "agent-a"), "thread-a");
      assert.equal(yield* store.getThreadId(ticketId, laneKey, "agent-b"), "thread-b");

      const rows = yield* store.listByTicket(ticketId);
      assert.equal(rows.length, 2);
    }),
  );

  it.effect("listByTicket and deleteByTicket scope to the ticket", () =>
    Effect.gen(function* () {
      const store = yield* WorkflowAgentSessionStore;
      const ticketId = TicketId.make("ticket-4");
      const otherTicketId = TicketId.make("ticket-5");
      const laneKey = LaneKey.make("implement");

      yield* store.upsert(ticketId, laneKey, "agent-a", "thread-a");
      yield* store.upsert(ticketId, LaneKey.make("review"), "agent-b", "thread-b");
      yield* store.upsert(otherTicketId, laneKey, "agent-c", "thread-c");

      const listed = yield* store.listByTicket(ticketId);
      assert.deepEqual(listed.map((r) => r.threadId).sort(), ["thread-a", "thread-b"]);

      yield* store.deleteByTicket(ticketId);
      assert.deepEqual(yield* store.listByTicket(ticketId), []);
      // The other ticket's rows are untouched.
      assert.equal((yield* store.listByTicket(otherTicketId)).length, 1);
    }),
  );

  it.effect("listByBoard and deleteByBoard join through projection_ticket", () =>
    Effect.gen(function* () {
      const store = yield* WorkflowAgentSessionStore;
      const boardId = BoardId.make("board-1");
      const otherBoardId = BoardId.make("board-2");
      const ticketA = TicketId.make("ticket-board-a");
      const ticketB = TicketId.make("ticket-board-b");
      const ticketOther = TicketId.make("ticket-board-other");

      yield* seedTicket(ticketA, boardId);
      yield* seedTicket(ticketB, boardId);
      yield* seedTicket(ticketOther, otherBoardId);

      yield* store.upsert(ticketA, LaneKey.make("implement"), "agent-a", "thread-a");
      yield* store.upsert(ticketB, LaneKey.make("implement"), "agent-b", "thread-b");
      yield* store.upsert(ticketOther, LaneKey.make("implement"), "agent-c", "thread-c");

      const listed = yield* store.listByBoard(boardId);
      assert.deepEqual(listed.map((r) => r.threadId).sort(), ["thread-a", "thread-b"]);

      yield* store.deleteByBoard(boardId);
      assert.deepEqual(yield* store.listByBoard(boardId), []);
      // Rows reachable only from the other board are untouched.
      assert.equal((yield* store.listByBoard(otherBoardId)).length, 1);
    }),
  );
});
