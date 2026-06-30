import { assert, describe, it } from "@effect/vitest";
import type { EnvironmentId } from "@t3tools/contracts";
import type { RelayBoardTicketState } from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ServerEnvironment } from "../../environment/ServerEnvironment.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { WorkflowEventStoreError } from "../Services/Errors.ts";
import { WorkflowBoardNotificationDispatcher } from "../Services/WorkflowBoardNotificationDispatcher.ts";
import { WorkflowBoardNotificationRelay } from "../Services/WorkflowBoardNotificationRelay.ts";
import {
  WorkflowReadModel,
  type TicketDetail,
  type TicketRow,
} from "../Services/WorkflowReadModel.ts";
import { makeWorkflowBoardNotificationDispatcherLive } from "./WorkflowBoardNotificationDispatcher.ts";

const ENV_ID = "env-1" as EnvironmentId;

interface PublishCall {
  readonly environmentId: EnvironmentId;
  readonly boardId: string;
  readonly ticketId: string;
  readonly state: RelayBoardTicketState;
}

// Mutable per-test recorder for the stub relay. Reset in each test setup.
interface RelayRecorder {
  calls: Array<PublishCall>;
  failQueue: Array<"ok" | "fail">;
}

const makeRecorder = (failQueue: ReadonlyArray<"ok" | "fail"> = []): RelayRecorder => ({
  calls: [],
  failQueue: [...failQueue],
});

const stubRelayLayer = (recorder: RelayRecorder) =>
  Layer.succeed(WorkflowBoardNotificationRelay, {
    publishTicket: (input) =>
      Effect.suspend(() => {
        recorder.calls.push(input);
        const outcome = recorder.failQueue.length === 0 ? "ok" : recorder.failQueue.shift()!;
        return outcome === "fail"
          ? Effect.fail(new WorkflowEventStoreError({ message: "stub relay failure" }))
          : Effect.void;
      }),
  } satisfies WorkflowBoardNotificationRelay["Service"]);

const makeTicketRow = (over: Partial<TicketRow> = {}): TicketRow => ({
  ticketId: "ticket-1",
  boardId: "board-1",
  title: "Fix the thing",
  description: null,
  currentLaneKey: "review",
  currentLaneEntryToken: null,
  status: "waiting_on_user",
  queuedAt: null,
  totalTokens: null,
  totalDurationMs: null,
  attentionKind: "waiting_for_input",
  attentionReason: "please review",
  ...over,
});

const detail = (ticket: TicketRow): TicketDetail => ({ ticket, steps: [], messages: [] });

// Stub read model: only getTicketDetail is exercised by the dispatcher.
const stubReadModelLayer = (byTicket: Record<string, TicketDetail | null>) =>
  Layer.succeed(WorkflowReadModel, {
    getTicketDetail: (ticketId: string) => Effect.succeed(byTicket[ticketId] ?? null),
  } as unknown as WorkflowReadModel["Service"]) as Layer.Layer<WorkflowReadModel>;

const serverEnvironmentLayer = Layer.succeed(ServerEnvironment, {
  getEnvironmentId: Effect.succeed(ENV_ID),
  getDescriptor: Effect.die("unsupported descriptor read"),
} as unknown as ServerEnvironment["Service"]) as Layer.Layer<ServerEnvironment>;

const insertOutboxRow = (over: {
  readonly outboxId: string;
  readonly ticketId: string;
  readonly boardId: string;
  readonly sequence: number;
  readonly status: string;
  readonly attentionKind?: string | null;
  readonly attentionReason?: string | null;
  readonly deliveryState?: string;
  readonly attemptCount?: number;
  readonly createdAt?: string;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO workflow_notification_outbox (
        outbox_id, ticket_id, board_id, sequence, status,
        attention_kind, attention_reason, delivery_state, attempt_count, created_at
      ) VALUES (
        ${over.outboxId}, ${over.ticketId}, ${over.boardId}, ${over.sequence}, ${over.status},
        ${over.attentionKind ?? null}, ${over.attentionReason ?? null},
        ${over.deliveryState ?? "pending"}, ${over.attemptCount ?? 0},
        ${over.createdAt ?? "2026-06-12T00:00:00.000Z"}
      )
    `;
  });

const readOutbox = (outboxId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{
      readonly delivery_state: string;
      readonly attempt_count: number;
    }>`
      SELECT delivery_state AS "delivery_state", attempt_count AS "attempt_count"
      FROM workflow_notification_outbox WHERE outbox_id = ${outboxId}
    `;
    return rows[0]!;
  });

const buildLayer = (recorder: RelayRecorder, byTicket: Record<string, TicketDetail | null>) =>
  makeWorkflowBoardNotificationDispatcherLive({ sweepIntervalMs: 60_000 }).pipe(
    Layer.provideMerge(stubRelayLayer(recorder)),
    Layer.provideMerge(stubReadModelLayer(byTicket)),
    Layer.provideMerge(serverEnvironmentLayer),
    Layer.provideMerge(SqlitePersistenceMemory),
  );

describe.sequential("WorkflowBoardNotificationDispatcher", () => {
  it.effect("publishes a pending needs-you row and marks it sent", () => {
    const recorder = makeRecorder();
    return Effect.gen(function* () {
      yield* insertOutboxRow({
        outboxId: "ob-1",
        ticketId: "ticket-1",
        boardId: "board-1",
        sequence: 7,
        status: "waiting_on_user",
        attentionKind: "waiting_for_input",
        attentionReason: "please review",
      });
      const dispatcher = yield* WorkflowBoardNotificationDispatcher;
      const result = yield* dispatcher.sweep();

      assert.strictEqual(result.claimed, 1);
      assert.strictEqual(result.sent, 1);
      assert.strictEqual(result.superseded, 0);
      assert.strictEqual(result.failed, 0);
      assert.strictEqual(recorder.calls.length, 1);
      const call = recorder.calls[0]!;
      assert.strictEqual(call.boardId, "board-1");
      assert.strictEqual(call.ticketId, "ticket-1");
      assert.strictEqual(call.state.attentionKind, "waiting_for_input");
      assert.strictEqual(call.state.title, "Fix the thing");
      assert.strictEqual(call.state.body, "please review");
      assert.strictEqual(call.state.deepLink, "/tickets/env-1/board-1/ticket-1");
      assert.strictEqual(call.state.transitionId, "7");

      const row = yield* readOutbox("ob-1");
      assert.strictEqual(row.delivery_state, "sent");
    }).pipe(
      Effect.provide(
        buildLayer(recorder, {
          "ticket-1": detail(makeTicketRow({ status: "waiting_on_user" })),
        }),
      ),
    );
  });

  it.effect("supersedes a row whose ticket has left needs-you", () => {
    const recorder = makeRecorder();
    return Effect.gen(function* () {
      yield* insertOutboxRow({
        outboxId: "ob-2",
        ticketId: "ticket-2",
        boardId: "board-1",
        sequence: 8,
        status: "waiting_on_user",
        attentionKind: "waiting_for_input",
        attentionReason: "stale",
      });
      yield* insertOutboxRow({
        outboxId: "ob-3",
        ticketId: "ticket-3",
        boardId: "board-1",
        sequence: 9,
        status: "waiting_on_user",
        attentionKind: "waiting_for_input",
        attentionReason: "gone",
      });
      const dispatcher = yield* WorkflowBoardNotificationDispatcher;
      const result = yield* dispatcher.sweep();

      assert.strictEqual(result.superseded, 2);
      assert.strictEqual(result.sent, 0);
      assert.strictEqual(recorder.calls.length, 0);
      assert.strictEqual((yield* readOutbox("ob-2")).delivery_state, "superseded");
      assert.strictEqual((yield* readOutbox("ob-3")).delivery_state, "superseded");
    }).pipe(
      Effect.provide(
        buildLayer(recorder, {
          // ticket-2 left needs-you (now running); ticket-3 detail missing (null).
          "ticket-2": detail(makeTicketRow({ ticketId: "ticket-2", status: "running" })),
          "ticket-3": null,
        }),
      ),
    );
  });

  it.effect("retries on relay failure then gives up at the attempt ceiling", () => {
    // Five consecutive failures across five sweeps → row ends 'failed'.
    const recorder = makeRecorder(["fail", "fail", "fail", "fail", "fail"]);
    return Effect.gen(function* () {
      yield* insertOutboxRow({
        outboxId: "ob-4",
        ticketId: "ticket-4",
        boardId: "board-1",
        sequence: 10,
        status: "blocked",
        attentionKind: "blocked",
        attentionReason: "needs help",
      });
      const dispatcher = yield* WorkflowBoardNotificationDispatcher;

      // Sweeps 1-4: stays pending, attempt_count climbs.
      for (let i = 1; i <= 4; i++) {
        const r = yield* dispatcher.sweep();
        assert.strictEqual(r.failed, 1, `sweep ${i} failed count`);
        const row = yield* readOutbox("ob-4");
        assert.strictEqual(row.delivery_state, "pending", `sweep ${i} state`);
        assert.strictEqual(row.attempt_count, i, `sweep ${i} attempts`);
      }

      // Sweep 5: 5th attempt hits the ceiling → 'failed'.
      const r5 = yield* dispatcher.sweep();
      assert.strictEqual(r5.failed, 1);
      const after = yield* readOutbox("ob-4");
      assert.strictEqual(after.delivery_state, "failed");
      assert.strictEqual(after.attempt_count, 5);
      assert.strictEqual(recorder.calls.length, 5);

      // Sweep 6: failed rows are not re-selected → no new publish.
      const r6 = yield* dispatcher.sweep();
      assert.strictEqual(r6.claimed, 0);
      assert.strictEqual(recorder.calls.length, 5);
    }).pipe(
      Effect.provide(
        buildLayer(recorder, {
          "ticket-4": detail(
            makeTicketRow({
              ticketId: "ticket-4",
              status: "blocked",
              attentionKind: "blocked",
              attentionReason: "needs help",
            }),
          ),
        }),
      ),
    );
  });

  it.effect("drains a pre-existing pending row (startup drain)", () => {
    const recorder = makeRecorder();
    return Effect.gen(function* () {
      yield* insertOutboxRow({
        outboxId: "ob-5",
        ticketId: "ticket-5",
        boardId: "board-1",
        sequence: 11,
        status: "waiting_on_user",
        attentionKind: "waiting_for_approval",
        attentionReason: "approve me",
      });
      const dispatcher = yield* WorkflowBoardNotificationDispatcher;
      const result = yield* dispatcher.sweep();
      assert.strictEqual(result.sent, 1);
      assert.strictEqual(recorder.calls[0]!.state.attentionKind, "waiting_for_approval");
      assert.strictEqual((yield* readOutbox("ob-5")).delivery_state, "sent");
    }).pipe(
      Effect.provide(
        buildLayer(recorder, {
          "ticket-5": detail(
            makeTicketRow({
              ticketId: "ticket-5",
              status: "waiting_on_user",
              attentionKind: "waiting_for_approval",
              attentionReason: "approve me",
            }),
          ),
        }),
      ),
    );
  });

  it.effect("falls back to a non-empty title when the ticket title is blank", () => {
    const recorder = makeRecorder();
    return Effect.gen(function* () {
      yield* insertOutboxRow({
        outboxId: "ob-8",
        ticketId: "ticket-8",
        boardId: "board-1",
        sequence: 14,
        status: "waiting_on_user",
        attentionKind: "waiting_for_input",
        attentionReason: "please review",
      });
      const dispatcher = yield* WorkflowBoardNotificationDispatcher;
      const result = yield* dispatcher.sweep();

      assert.strictEqual(result.sent, 1);
      assert.strictEqual(recorder.calls.length, 1);
      const title = recorder.calls[0]!.state.title;
      // The relay decodes title as TrimmedNonEmptyString; a whitespace title
      // must be replaced with the non-empty fallback before publish.
      assert.isTrue(title.trim().length > 0, "blank title falls back to non-empty title");
      assert.strictEqual(title, "Ticket needs your attention");
    }).pipe(
      Effect.provide(
        buildLayer(recorder, {
          "ticket-8": detail(makeTicketRow({ ticketId: "ticket-8", title: "   " })),
        }),
      ),
    );
  });

  it.effect("redacts and caps the body, and falls back when reason is empty", () => {
    const recorder = makeRecorder();
    const secret = "ghp_" + "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    const longReason = `token leak ${secret} ` + "x".repeat(400);
    return Effect.gen(function* () {
      yield* insertOutboxRow({
        outboxId: "ob-6",
        ticketId: "ticket-6",
        boardId: "board-1",
        sequence: 12,
        status: "waiting_on_user",
        attentionKind: "waiting_for_input",
        attentionReason: longReason,
      });
      yield* insertOutboxRow({
        outboxId: "ob-7",
        ticketId: "ticket-7",
        boardId: "board-1",
        sequence: 13,
        status: "waiting_on_user",
        attentionKind: "waiting_for_input",
        attentionReason: "",
      });
      const dispatcher = yield* WorkflowBoardNotificationDispatcher;
      yield* dispatcher.sweep();

      const byTicket = Object.fromEntries(recorder.calls.map((c) => [c.ticketId, c]));
      const redactedBody = byTicket["ticket-6"]!.state.body;
      assert.isFalse(redactedBody.includes(secret), "raw secret must not appear");
      assert.isAtMost(redactedBody.length, 240, "body capped to MAX_NOTIFICATION_BODY");

      const fallbackBody = byTicket["ticket-7"]!.state.body;
      assert.isTrue(fallbackBody.trim().length > 0, "empty reason falls back to non-empty body");
    }).pipe(
      Effect.provide(
        buildLayer(recorder, {
          "ticket-6": detail(makeTicketRow({ ticketId: "ticket-6", attentionReason: longReason })),
          "ticket-7": detail(makeTicketRow({ ticketId: "ticket-7", attentionReason: "" })),
        }),
      ),
    );
  });

  it.effect(
    "does not resurrect a row the committer superseded during a failed publish (M11)",
    () => {
      // Regression: the dispatcher SELECTs a pending row, the relay publish fails,
      // and concurrently the committer supersedes the row (a newer needs-you
      // transition committed for the same ticket). The retry re-mark must be a
      // no-op once the row has left 'pending', or the superseded transition gets
      // resurrected and re-delivered as a stale push. The relay stub below
      // supersedes the row mid-publish (standing in for the committer's UPDATE
      // landing during the publish round-trip), then fails — exercising the retry
      // path against an already-superseded row.
      const supersedingRelayLayer = Layer.effect(
        WorkflowBoardNotificationRelay,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          return {
            publishTicket: () =>
              Effect.gen(function* () {
                // SqlError here would be an infra failure, not part of the relay
                // contract (WorkflowEventStoreError only) — orDie keeps the failure
                // channel aligned with the publishTicket signature.
                yield* sql`UPDATE workflow_notification_outbox SET delivery_state = 'superseded' WHERE outbox_id = ${"ob-m11"}`.pipe(
                  Effect.orDie,
                );
                return yield* new WorkflowEventStoreError({ message: "stub relay failure" });
              }),
          } satisfies WorkflowBoardNotificationRelay["Service"];
        }),
      );

      return Effect.gen(function* () {
        yield* insertOutboxRow({
          outboxId: "ob-m11",
          ticketId: "ticket-m11",
          boardId: "board-1",
          sequence: 5,
          status: "waiting_on_user",
          attentionKind: "waiting_for_input",
          attentionReason: "please review",
        });
        const dispatcher = yield* WorkflowBoardNotificationDispatcher;
        const result = yield* dispatcher.sweep();
        assert.strictEqual(result.failed, 1);

        // The row must stay 'superseded' — the guarded retry re-mark must NOT
        // flip it back to 'pending' (which would re-deliver the stale transition).
        const row = yield* readOutbox("ob-m11");
        assert.strictEqual(row.delivery_state, "superseded");
      }).pipe(
        Effect.provide(
          makeWorkflowBoardNotificationDispatcherLive({ sweepIntervalMs: 60_000 }).pipe(
            Layer.provideMerge(supersedingRelayLayer),
            Layer.provideMerge(
              stubReadModelLayer({
                "ticket-m11": detail(makeTicketRow({ ticketId: "ticket-m11" })),
              }),
            ),
            Layer.provideMerge(serverEnvironmentLayer),
            Layer.provideMerge(SqlitePersistenceMemory),
          ),
        ),
      );
    },
  );
});
