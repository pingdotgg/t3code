import * as Context from "effect/Context";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

import { MessageId, ThreadId } from "@t3tools/contracts";

import {
  PersistenceDecodeError,
  PersistenceSqlError,
  type ThreadRecapRepositoryError,
} from "./Errors.ts";

export const PersistedThreadRecap = Schema.Struct({
  threadId: ThreadId,
  text: Schema.String,
  coveredMessageId: Schema.NullOr(MessageId),
  sourceSignature: Schema.String,
  updatedAt: Schema.String,
});
export type PersistedThreadRecap = typeof PersistedThreadRecap.Type;

export class ThreadRecapRepository extends Context.Service<
  ThreadRecapRepository,
  {
    readonly get: (
      threadId: ThreadId,
    ) => Effect.Effect<Option.Option<PersistedThreadRecap>, ThreadRecapRepositoryError>;
    readonly put: (recap: PersistedThreadRecap) => Effect.Effect<void, ThreadRecapRepositoryError>;
    readonly delete: (threadId: ThreadId) => Effect.Effect<void, ThreadRecapRepositoryError>;
  }
>()("t3/persistence/ThreadRecaps/ThreadRecapRepository") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const findRecap = SqlSchema.findOneOption({
    Request: ThreadId,
    Result: PersistedThreadRecap,
    execute: (threadId) =>
      sql`
        SELECT
          thread_id AS "threadId",
          text AS "text",
          covered_message_id AS "coveredMessageId",
          source_signature AS "sourceSignature",
          updated_at AS "updatedAt"
        FROM thread_recaps
        WHERE thread_id = ${threadId}
      `,
  });

  return ThreadRecapRepository.of({
    get: Effect.fn("ThreadRecapRepository.get")(function (threadId) {
      return findRecap(threadId).pipe(
        NodeSqliteClient.readOnly,
        Effect.mapError((cause) =>
          Schema.isSchemaError(cause)
            ? PersistenceDecodeError.fromSchemaError("ThreadRecap", cause, { threadId })
            : new PersistenceSqlError({
                operation: "getThreadRecap",
                correlation: { threadId },
                cause,
              }),
        ),
      );
    }),
    put: Effect.fn("ThreadRecapRepository.put")(function (recap) {
      return sql`
        INSERT INTO thread_recaps (
          thread_id,
          text,
          covered_message_id,
          source_signature,
          updated_at
        )
        VALUES (
          ${recap.threadId},
          ${recap.text},
          ${recap.coveredMessageId},
          ${recap.sourceSignature},
          ${recap.updatedAt}
        )
        ON CONFLICT (thread_id) DO UPDATE SET
          text = excluded.text,
          covered_message_id = excluded.covered_message_id,
          source_signature = excluded.source_signature,
          updated_at = excluded.updated_at
      `.pipe(
        Effect.asVoid,
        Effect.mapError(
          (cause) =>
            new PersistenceSqlError({
              operation: "putThreadRecap",
              correlation: { threadId: recap.threadId },
              cause,
            }),
        ),
      );
    }),
    delete: Effect.fn("ThreadRecapRepository.delete")(function (threadId) {
      return sql`
        DELETE FROM thread_recaps
        WHERE thread_id = ${threadId}
      `.pipe(
        Effect.asVoid,
        Effect.mapError(
          (cause) =>
            new PersistenceSqlError({
              operation: "deleteThreadRecap",
              correlation: { threadId },
              cause,
            }),
        ),
      );
    }),
  });
});

export const layer = Layer.effect(ThreadRecapRepository, make);
