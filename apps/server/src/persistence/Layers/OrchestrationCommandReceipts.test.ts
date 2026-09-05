import { assert, it } from "@effect/vitest";
import { CommandId, EventId, ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as OrchestrationCommandReceipts from "../Services/OrchestrationCommandReceipts.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "./OrchestrationCommandReceipts.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const TestLayer = OrchestrationCommandReceiptRepositoryLive.pipe(
  Layer.provideMerge(SqlitePersistenceMemory),
);
const layer = it.layer(TestLayer);

layer("OrchestrationCommandReceiptRepository", (it) => {
  it.effect("recovers accepted legacy project command types from their result events", () =>
    Effect.gen(function* () {
      const receipts = yield* OrchestrationCommandReceipts.OrchestrationCommandReceiptRepository;
      const sql = yield* SqlClient.SqlClient;
      const mappings = [
        ["project.created", "project.create"],
        ["project.meta-updated", "project.meta.update"],
        ["project.deleted", "project.delete"],
      ] as const;

      for (const [index, [eventType, expectedCommandType]] of mappings.entries()) {
        const commandId = CommandId.make(`command:legacy-receipt:${index}`);
        const projectId = ProjectId.make(`project:legacy-receipt:${index}`);
        const events = yield* sql<{ readonly sequence: number }>`
          INSERT INTO orchestration_events (
            event_id, aggregate_kind, stream_id, stream_version, event_type,
            occurred_at, command_id, causation_event_id, correlation_id,
            actor_kind, payload_json, metadata_json, application_event_version
          ) VALUES (
            ${EventId.make(`event:legacy-receipt:${index}`)}, 'project', ${projectId}, 0,
            ${eventType}, '2026-09-05T00:00:00.000Z', ${commandId}, NULL, ${commandId},
            'server', '{}', '{}', 1
          )
          RETURNING sequence
        `;
        const resultSequence = events[0]?.sequence ?? assert.fail("Event was not inserted");
        yield* sql`
          INSERT INTO orchestration_command_receipts (
            command_id, aggregate_kind, aggregate_id, command_type, accepted_at,
            result_sequence, status, error
          ) VALUES (
            ${commandId}, 'project', ${projectId}, 'legacy',
            '2026-09-05T00:00:00.000Z', ${resultSequence}, 'accepted', NULL
          )
        `;

        const receipt = yield* receipts.getByCommandId({ commandId });
        assert.isTrue(Option.isSome(receipt));
        if (Option.isNone(receipt)) return assert.fail("Receipt was not found");
        assert.equal(receipt.value.commandType, expectedCommandType);
      }
    }),
  );

  it.effect("leaves a legacy receipt untyped when its result event has another owner", () =>
    Effect.gen(function* () {
      const receipts = yield* OrchestrationCommandReceipts.OrchestrationCommandReceiptRepository;
      const sql = yield* SqlClient.SqlClient;
      const commandId = CommandId.make("command:legacy-receipt:mismatched-owner");
      const receiptProjectId = ProjectId.make("project:legacy-receipt:owner");
      const eventProjectId = ProjectId.make("project:legacy-receipt:other-owner");
      const events = yield* sql<{ readonly sequence: number }>`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type,
          occurred_at, command_id, causation_event_id, correlation_id,
          actor_kind, payload_json, metadata_json, application_event_version
        ) VALUES (
          ${EventId.make("event:legacy-receipt:mismatched-owner")}, 'project', ${eventProjectId}, 0,
          'project.deleted', '2026-09-05T00:00:00.000Z', ${commandId}, NULL, ${commandId},
          'server', '{}', '{}', 1
        )
        RETURNING sequence
      `;
      const resultSequence = events[0]?.sequence ?? assert.fail("Event was not inserted");
      yield* sql`
        INSERT INTO orchestration_command_receipts (
          command_id, aggregate_kind, aggregate_id, command_type, accepted_at,
          result_sequence, status, error
        ) VALUES (
          ${commandId}, 'project', ${receiptProjectId}, 'legacy',
          '2026-09-05T00:00:00.000Z', ${resultSequence}, 'accepted', NULL
        )
      `;

      const receipt = yield* receipts.getByCommandId({ commandId });
      assert.isTrue(Option.isSome(receipt));
      if (Option.isNone(receipt)) return assert.fail("Receipt was not found");
      assert.equal(receipt.value.commandType, "legacy");
    }),
  );
});
