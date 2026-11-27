import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";

export const LEGACY_THREAD_MESSAGES_TABLE = "projection_thread_messages";

export const redactLegacyThreadTitle = Effect.fn("LegacyDeletedThreadContent.redactTitle")(
  function* (sql: SqlClient.SqlClient, threadId: string, title: string) {
    yield* sql`UPDATE projection_threads SET title = ${title} WHERE thread_id = ${threadId}`;
  },
);
