import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceDecodeError, toPersistenceSqlError } from "../Errors.ts";
import {
  DeleteProviderTurnIntentInput,
  ProviderTurnIntent,
  ProviderTurnIntentExactInput,
  ProviderTurnIntentRepository,
  ProviderTurnIntentThreadInput,
  type ProviderTurnIntentRepositoryShape,
} from "../Services/ProviderTurnIntents.ts";

function toPersistenceSqlOrDecodeError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown) =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(decodeOperation)(cause)
      : toPersistenceSqlError(sqlOperation)(cause);
}

const makeProviderTurnIntentRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const PendingCount = Schema.Struct({ count: Schema.Number });

  const insertProviderTurnIntent = SqlSchema.void({
    Request: ProviderTurnIntent,
    execute: (intent) =>
      sql`
        INSERT INTO provider_turn_intents (
          event_sequence,
          thread_id,
          message_id,
          requested_at
        )
        VALUES (
          ${intent.eventSequence},
          ${intent.threadId},
          ${intent.messageId},
          ${intent.requestedAt}
        )
        ON CONFLICT (event_sequence) DO NOTHING
      `,
  });

  const listPendingProviderTurnIntents = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProviderTurnIntent,
    execute: () =>
      sql`
        SELECT
          event_sequence AS "eventSequence",
          thread_id AS "threadId",
          message_id AS "messageId",
          requested_at AS "requestedAt"
        FROM provider_turn_intents
        ORDER BY event_sequence ASC
      `,
  });

  const deleteProviderTurnIntent = SqlSchema.void({
    Request: DeleteProviderTurnIntentInput,
    execute: ({ eventSequence }) =>
      sql`
        DELETE FROM provider_turn_intents
        WHERE event_sequence = ${eventSequence}
      `,
  });

  const countPendingProviderTurnIntentsForThread = SqlSchema.findOne({
    Request: ProviderTurnIntentThreadInput,
    Result: PendingCount,
    execute: ({ threadId }) =>
      sql`
        SELECT COUNT(*) AS "count"
        FROM provider_turn_intents
        WHERE thread_id = ${threadId}
      `,
  });

  const deleteExactProviderTurnIntent = SqlSchema.findOneOption({
    Request: ProviderTurnIntentExactInput,
    Result: ProviderTurnIntent,
    execute: ({ eventSequence, threadId }) =>
      sql`
        DELETE FROM provider_turn_intents
        WHERE event_sequence = ${eventSequence}
          AND thread_id = ${threadId}
        RETURNING
          event_sequence AS "eventSequence",
          thread_id AS "threadId",
          message_id AS "messageId",
          requested_at AS "requestedAt"
      `,
  });

  const getExactProviderTurnIntent = SqlSchema.findOneOption({
    Request: ProviderTurnIntentExactInput,
    Result: ProviderTurnIntent,
    execute: ({ eventSequence, threadId }) =>
      sql`
        SELECT
          event_sequence AS "eventSequence",
          thread_id AS "threadId",
          message_id AS "messageId",
          requested_at AS "requestedAt"
        FROM provider_turn_intents
        WHERE event_sequence = ${eventSequence}
          AND thread_id = ${threadId}
        LIMIT 1
      `,
  });

  const consumeOldestProviderTurnIntentForThread = SqlSchema.findOneOption({
    Request: ProviderTurnIntentThreadInput,
    Result: ProviderTurnIntent,
    execute: ({ threadId }) =>
      sql`
        DELETE FROM provider_turn_intents
        WHERE event_sequence = (
          SELECT event_sequence
          FROM provider_turn_intents
          WHERE thread_id = ${threadId}
          ORDER BY event_sequence ASC
          LIMIT 1
        )
        RETURNING
          event_sequence AS "eventSequence",
          thread_id AS "threadId",
          message_id AS "messageId",
          requested_at AS "requestedAt"
      `,
  });

  const insert: ProviderTurnIntentRepositoryShape["insert"] = (intent) =>
    insertProviderTurnIntent(intent).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProviderTurnIntentRepository.insert:query",
          "ProviderTurnIntentRepository.insert:encodeRequest",
        ),
      ),
    );

  const listPending: ProviderTurnIntentRepositoryShape["listPending"] = () =>
    listPendingProviderTurnIntents().pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProviderTurnIntentRepository.listPending:query",
          "ProviderTurnIntentRepository.listPending:decodeRows",
        ),
      ),
    );

  const hasPendingForThread: ProviderTurnIntentRepositoryShape["hasPendingForThread"] = (input) =>
    countPendingProviderTurnIntentsForThread(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProviderTurnIntentRepository.hasPendingForThread:query",
          "ProviderTurnIntentRepository.hasPendingForThread:encodeRequest",
        ),
      ),
      Effect.map((row) => row.count > 0),
    );

  const deleteByEventSequence: ProviderTurnIntentRepositoryShape["deleteByEventSequence"] = (
    input,
  ) =>
    deleteProviderTurnIntent(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProviderTurnIntentRepository.deleteByEventSequence:query",
          "ProviderTurnIntentRepository.deleteByEventSequence:encodeRequest",
        ),
      ),
    );

  const deleteExact: ProviderTurnIntentRepositoryShape["deleteExact"] = (input) =>
    deleteExactProviderTurnIntent(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProviderTurnIntentRepository.deleteExact:query",
          "ProviderTurnIntentRepository.deleteExact:encodeRequest",
        ),
      ),
      Effect.map(Option.isSome),
    );

  const getExact: ProviderTurnIntentRepositoryShape["getExact"] = (input) =>
    getExactProviderTurnIntent(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProviderTurnIntentRepository.getExact:query",
          "ProviderTurnIntentRepository.getExact:encodeRequest",
        ),
      ),
    );

  const takeExact: ProviderTurnIntentRepositoryShape["takeExact"] = (input) =>
    deleteExactProviderTurnIntent(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProviderTurnIntentRepository.takeExact:query",
          "ProviderTurnIntentRepository.takeExact:encodeRequest",
        ),
      ),
    );

  const takeOldestForThread: ProviderTurnIntentRepositoryShape["takeOldestForThread"] = (input) =>
    consumeOldestProviderTurnIntentForThread(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProviderTurnIntentRepository.takeOldestForThread:query",
          "ProviderTurnIntentRepository.takeOldestForThread:encodeRequest",
        ),
      ),
    );

  const consumeOldestForThread: ProviderTurnIntentRepositoryShape["consumeOldestForThread"] = (
    input,
  ) =>
    consumeOldestProviderTurnIntentForThread(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProviderTurnIntentRepository.consumeOldestForThread:query",
          "ProviderTurnIntentRepository.consumeOldestForThread:encodeRequest",
        ),
      ),
      Effect.map(Option.isSome),
    );

  return {
    insert,
    listPending,
    hasPendingForThread,
    getExact,
    takeExact,
    takeOldestForThread,
    deleteByEventSequence,
    deleteExact,
    consumeOldestForThread,
  } satisfies ProviderTurnIntentRepositoryShape;
});

export const ProviderTurnIntentRepositoryLive = Layer.effect(
  ProviderTurnIntentRepository,
  makeProviderTurnIntentRepository,
);
