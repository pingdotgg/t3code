import type { ThreadId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { ProjectionStoreReadError } from "../../orchestration-v2/ProjectionStore.ts";

export class LastUserInput extends Context.Service<
  LastUserInput,
  {
    /**
     * When the thread's last message from a user or a bot was sent, queued ones included, or its
     * last question or approval was answered, whichever is later, in epoch milliseconds.
     */
    readonly atMs: (threadId: ThreadId) => Effect.Effect<number | null, ProjectionStoreReadError>;
  }
>()("t3/fork/idleCompaction/lastUserInput") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return LastUserInput.of({
    atMs: Effect.fn("LastUserInput.atMs")(
      function* (threadId: ThreadId) {
        const rows = yield* sql<{ at: string | null }>`SELECT MAX(at) AS at FROM (
          SELECT created_at AS at
          FROM orchestration_v2_projection_messages
          WHERE thread_id = ${threadId}
            AND role = 'user'
            AND (
              json_extract(payload_json, '$.createdBy') = 'user'
              OR json_extract(payload_json, '$.creationSource') = 'mcp'
            )
            AND json_extract(payload_json, '$.fyi') IS NULL
          UNION ALL
          SELECT resolved_at AS at
          FROM orchestration_v2_projection_runtime_requests
          WHERE thread_id = ${threadId} AND status = 'resolved'
        )`;
        const at = rows[0]?.at ?? null;
        return at === null ? null : DateTime.toEpochMillis(DateTime.makeUnsafe(at));
      },
      (effect, threadId) =>
        effect.pipe(
          Effect.mapError((cause) => new ProjectionStoreReadError({ threadId, cause })),
          NodeSqliteClient.readOnly,
        ),
    ),
  });
});

export const layer = Layer.effect(LastUserInput, make);
