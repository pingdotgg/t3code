import {
  ChatAttachment,
  MessageId,
  OrchestrationProposedPlan,
  ThreadId,
  TurnId,
  type OrchestrationSearchThreadInput,
  type OrchestrationSearchThreadResult,
} from "@t3tools/contracts";
import { searchableMessageSegments, searchablePlanSegments } from "@t3tools/shared/threadFindText";
import { countThreadSearchOccurrences } from "@t3tools/shared/threadSearch";
import * as Cache from "effect/Cache";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import {
  PersistenceSqlError,
  isPersistenceError,
  toPersistenceSqlError,
  type ProjectionRepositoryError,
} from "../../persistence/Errors.ts";

const SourceRow = Schema.Struct({
  id: Schema.String,
  turnId: Schema.NullOr(TurnId),
  text: Schema.String,
  role: Schema.Literals(["user", "assistant", "system"]),
  streaming: Schema.Number,
  createdAt: Schema.String,
});
const Cursor = Schema.Struct({ threadId: ThreadId, createdAt: Schema.String, id: Schema.String });
class SearchKey extends Data.Class<{ threadId: ThreadId; query: string; sequence: number }> {}
interface MatchingDocument {
  source: "message" | "plan";
  sourceId: string;
  turnId: TurnId | null;
  createdAt: string;
  count: number;
}

/** Search projected visible text without sending or retaining a full transcript in the client. */
export const makeThreadFindQuery = Effect.fn("makeThreadFindQuery")(function* (
  getSequence: (threadId: ThreadId) => Effect.Effect<number, ProjectionRepositoryError>,
) {
  const sql = yield* SqlClient.SqlClient;
  const messageBatch = SqlSchema.findAll({
    Request: Cursor,
    Result: SourceRow,
    execute: ({ threadId, createdAt, id }) => sql`
      SELECT message_id AS id, turn_id AS "turnId", text, role,
        is_streaming AS streaming, created_at AS "createdAt"
      FROM projection_thread_messages
      WHERE thread_id = ${threadId} AND (created_at, message_id) > (${createdAt}, ${id})
      ORDER BY created_at, message_id LIMIT 128`,
  });
  const planBatch = SqlSchema.findAll({
    Request: Cursor,
    Result: SourceRow,
    execute: ({ threadId, createdAt, id }) => sql`
      SELECT plan_id AS id, turn_id AS "turnId", plan_markdown AS text,
        'assistant' AS role, 0 AS streaming, created_at AS "createdAt"
      FROM projection_thread_proposed_plans
      WHERE thread_id = ${threadId} AND (created_at, plan_id) > (${createdAt}, ${id})
      ORDER BY created_at, plan_id LIMIT 128`,
  });
  const isActive = SqlSchema.findAll({
    Request: ThreadId,
    Result: Schema.Struct({ id: ThreadId }),
    execute: (threadId) => sql`
      SELECT thread_id AS id FROM projection_threads
      WHERE thread_id = ${threadId} AND deleted_at IS NULL`,
  });
  const changed = () =>
    new PersistenceSqlError({
      operation: "searchThread",
      detail: "Thread changed during search. Please retry.",
    });
  const scan = Effect.fn("ThreadFindQuery.scan")(function* (key: SearchKey) {
    const documents: MatchingDocument[] = [];
    let totalMatches = 0;
    for (const source of ["message", "plan"] as const) {
      let cursor = { threadId: key.threadId, createdAt: "", id: "" };
      while (true) {
        const rows = yield* source === "message" ? messageBatch(cursor) : planBatch(cursor);
        for (const row of rows) {
          const segments =
            source === "plan"
              ? searchablePlanSegments(row.text)
              : searchableMessageSegments({ ...row, streaming: row.streaming === 1 });
          const count =
            segments?.reduce(
              (sum, text) => sum + countThreadSearchOccurrences(text, key.query),
              0,
            ) ?? 0;
          if (count > 0) {
            documents.push({
              source,
              sourceId: row.id,
              turnId: row.turnId,
              createdAt: row.createdAt,
              count,
            });
            totalMatches += count;
          }
        }
        const last = rows.at(-1);
        if (rows.length < 128 || !last) break;
        cursor = { threadId: key.threadId, createdAt: last.createdAt, id: last.id };
        yield* Effect.yieldNow;
      }
    }
    // Scans are already ID-ordered; stable sort keeps messages before plans on ties.
    documents.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
    if ((yield* getSequence(key.threadId)) !== key.sequence) return yield* changed();
    return { documents, totalMatches };
  });
  // Cache counts/positions, not message bodies or one object per occurrence.
  const cache = yield* Cache.makeWith(scan, {
    capacity: 16,
    timeToLive: (exit) =>
      Exit.isSuccess(exit) && exit.value.documents.length <= 10_000 ? "1 minute" : 0,
  });
  const messages = SqlSchema.findAll({
    Request: Schema.Struct({ threadId: ThreadId, createdAt: Schema.String, id: Schema.String }),
    Result: Schema.Struct({
      id: MessageId,
      turnId: Schema.NullOr(TurnId),
      role: SourceRow.fields.role,
      text: Schema.String,
      streaming: Schema.Number,
      attachments: Schema.NullOr(Schema.fromJsonString(Schema.Array(ChatAttachment))),
      createdAt: Schema.String,
      updatedAt: Schema.String,
    }),
    execute: ({ threadId, createdAt, id }) => sql`
      SELECT message_id AS id, turn_id AS "turnId", role, text,
        is_streaming AS streaming, attachments_json AS attachments,
        created_at AS "createdAt", updated_at AS "updatedAt"
      FROM (
        SELECT * FROM (SELECT * FROM projection_thread_messages
          WHERE thread_id = ${threadId} AND (created_at, message_id) <= (${createdAt}, ${id})
          ORDER BY created_at DESC, message_id DESC LIMIT 3)
        UNION ALL
        SELECT * FROM (SELECT * FROM projection_thread_messages
          WHERE thread_id = ${threadId} AND (created_at, message_id) > (${createdAt}, ${id})
          ORDER BY created_at, message_id LIMIT 3)
      ) ORDER BY created_at, message_id`,
  });
  const plans = SqlSchema.findAll({
    Request: Schema.Struct({ threadId: ThreadId, id: Schema.String }),
    Result: OrchestrationProposedPlan,
    execute: ({ threadId, id }) => sql`
      SELECT plan_id AS id, turn_id AS "turnId", plan_markdown AS "planMarkdown",
        implemented_at AS "implementedAt", implementation_thread_id AS "implementationThreadId",
        created_at AS "createdAt", updated_at AS "updatedAt"
      FROM projection_thread_proposed_plans WHERE thread_id = ${threadId} AND plan_id = ${id}`,
  });
  return Effect.fn("ThreadFindQuery.searchThread")(
    function* (input: OrchestrationSearchThreadInput) {
      const threadSequence = yield* getSequence(input.threadId);
      const empty: OrchestrationSearchThreadResult = {
        threadSequence,
        totalMatches: 0,
        activeIndex: 0,
        match: null,
        messages: [],
        proposedPlans: [],
      };
      if ((yield* isActive(input.threadId)).length === 0) return empty;
      const { documents, totalMatches } = yield* Cache.get(
        cache,
        new SearchKey({ threadId: input.threadId, query: input.query, sequence: threadSequence }),
      );
      const activeIndex = Math.min(input.index ?? 0, Math.max(0, totalMatches - 1));
      let occurrence = activeIndex;
      const selected = documents.find((document) => {
        if (occurrence < document.count) return true;
        occurrence -= document.count;
        return false;
      });
      if (!selected) return empty;
      const contextMessages = yield* messages({
        threadId: input.threadId,
        createdAt: selected.createdAt,
        id: selected.source === "message" ? selected.sourceId : "",
      });
      const proposedPlans =
        selected.source === "plan"
          ? yield* plans({ threadId: input.threadId, id: selected.sourceId })
          : [];
      if (
        (yield* getSequence(input.threadId)) !== threadSequence ||
        (yield* isActive(input.threadId)).length === 0
      )
        return yield* changed();
      return {
        threadSequence,
        totalMatches,
        activeIndex,
        match: {
          source: selected.source,
          sourceId: selected.sourceId,
          turnId: selected.turnId,
          occurrence,
        },
        messages: contextMessages.map(({ streaming, attachments, ...message }) => ({
          ...message,
          streaming: streaming === 1,
          ...(attachments === null ? {} : { attachments }),
        })),
        proposedPlans,
      };
    },
    Effect.mapError((error) =>
      isPersistenceError(error) ? error : toPersistenceSqlError("searchThread")(error),
    ),
  );
});
