import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { MigrationsLive } from "../../persistence/Migrations.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { WorkflowEventStore } from "../Services/WorkflowEventStore.ts";
import { WorkflowEventStoreLive } from "./WorkflowEventStore.ts";

const layer = it.layer(MigrationsLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)));

layer("workflow migration", (it) => {
  it.effect("creates workflow_events and projection tables", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const tables = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master WHERE type = 'table'
        AND name IN (
          'workflow_events',
          'projection_board',
          'projection_ticket',
          'projection_pipeline_run',
          'projection_step_run'
        )
      `;
      assert.equal(tables.length, 5);
    }),
  );
});

const storeLayer = it.layer(
  WorkflowEventStoreLive.pipe(
    Layer.provideMerge(MigrationsLive),
    Layer.provideMerge(SqlitePersistenceMemory),
  ),
);

storeLayer("WorkflowEventStore", (it) => {
  it.effect("appends and replays a decoded event with assigned version", () =>
    Effect.gen(function* () {
      const store = yield* WorkflowEventStore;
      const appended = yield* store.append({
        type: "TicketCreated",
        eventId: "evt-a" as never,
        ticketId: "t-1" as never,
        occurredAt: "2026-06-07T00:00:00.000Z" as never,
        payload: { boardId: "b-1" as never, title: "X" as never, laneKey: "backlog" as never },
      });
      assert.equal(appended.streamVersion, 0);

      const events = yield* Stream.runCollect(store.readByTicket("t-1" as never)).pipe(
        Effect.map((chunk) => Array.from(chunk)),
      );
      assert.equal(events.length, 1);
      assert.equal(events[0]?.type, "TicketCreated");
    }),
  );

  it.effect("assigns incrementing stream versions per ticket", () =>
    Effect.gen(function* () {
      const store = yield* WorkflowEventStore;
      yield* store.append({
        type: "TicketCreated",
        eventId: "evt-b" as never,
        ticketId: "t-2" as never,
        occurredAt: "2026-06-07T00:00:00.000Z" as never,
        payload: { boardId: "b-1" as never, title: "Y" as never, laneKey: "backlog" as never },
      });
      const second = yield* store.append({
        type: "TicketBlocked",
        eventId: "evt-c" as never,
        ticketId: "t-2" as never,
        occurredAt: "2026-06-07T00:00:01.000Z" as never,
        payload: { reason: "scope unclear" },
      });
      assert.equal(second.streamVersion, 1);
    }),
  );

  it.effect("deletes events for tickets that belong to a board", () =>
    Effect.gen(function* () {
      const store = yield* WorkflowEventStore;
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-06-07T00:00:00.000Z";

      yield* sql`
        INSERT INTO projection_ticket (
          ticket_id,
          board_id,
          title,
          current_lane_key,
          status,
          created_at,
          updated_at
        )
        VALUES
          ('ticket-events-delete', 'board-events-delete', 'Delete', 'backlog', 'idle', ${now}, ${now}),
          ('ticket-events-keep', 'board-events-keep', 'Keep', 'backlog', 'idle', ${now}, ${now})
      `;
      yield* store.append({
        type: "TicketCreated",
        eventId: "evt-delete" as never,
        ticketId: "ticket-events-delete" as never,
        occurredAt: now as never,
        payload: {
          boardId: "board-events-delete" as never,
          title: "Delete" as never,
          laneKey: "backlog" as never,
        },
      });
      yield* store.append({
        type: "TicketCreated",
        eventId: "evt-keep" as never,
        ticketId: "ticket-events-keep" as never,
        occurredAt: now as never,
        payload: {
          boardId: "board-events-keep" as never,
          title: "Keep" as never,
          laneKey: "backlog" as never,
        },
      });

      yield* store.deleteForBoard("board-events-delete" as never);

      const rows = yield* sql<{ readonly ticketId: string; readonly count: number }>`
        SELECT ticket_id AS "ticketId", COUNT(*) AS count
        FROM workflow_events
        WHERE ticket_id IN ('ticket-events-delete', 'ticket-events-keep')
        GROUP BY ticket_id
        ORDER BY ticket_id ASC
      `;
      assert.deepEqual(rows, [{ ticketId: "ticket-events-keep", count: 1 }]);
    }),
  );

  it.effect("deletes events for exactly one ticket", () =>
    Effect.gen(function* () {
      const store = yield* WorkflowEventStore;
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-06-07T00:00:00.000Z";

      yield* store.append({
        type: "TicketCreated",
        eventId: "evt-ticket-delete" as never,
        ticketId: "ticket-events-delete-one" as never,
        occurredAt: now as never,
        payload: {
          boardId: "board-events-delete-one" as never,
          title: "Delete" as never,
          laneKey: "backlog" as never,
        },
      });
      yield* store.append({
        type: "TicketCreated",
        eventId: "evt-ticket-keep" as never,
        ticketId: "ticket-events-keep-one" as never,
        occurredAt: now as never,
        payload: {
          boardId: "board-events-delete-one" as never,
          title: "Keep" as never,
          laneKey: "backlog" as never,
        },
      });

      yield* store.deleteForTicket("ticket-events-delete-one" as never);

      const rows = yield* sql<{ readonly ticketId: string; readonly count: number }>`
        SELECT ticket_id AS "ticketId", COUNT(*) AS count
        FROM workflow_events
        WHERE ticket_id IN ('ticket-events-delete-one', 'ticket-events-keep-one')
        GROUP BY ticket_id
        ORDER BY ticket_id ASC
      `;
      assert.deepEqual(rows, [{ ticketId: "ticket-events-keep-one", count: 1 }]);
    }),
  );
});
