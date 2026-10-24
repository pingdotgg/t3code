import {
  IsoDateTime,
  OrchestrationThreadSearchSource,
  type OrchestrationSearchThreadsInput,
  type OrchestrationSearchThreadsResult,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

export class ThreadSearchError extends Schema.TaggedError<ThreadSearchError>()(
  "ThreadSearchError",
  {
    operation: Schema.Literals(["query", "decode"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Thread search ${this.operation} failed.`;
  }
}

const SearchRequest = Schema.Struct({ pattern: Schema.String, limit: Schema.Int });
const SearchRow = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  source: OrchestrationThreadSearchSource,
  matchText: Schema.String,
  messageCreatedAt: Schema.NullOr(IsoDateTime),
});

function escapeLikePattern(value: string): string {
  return value.replaceAll("!", "!!").replaceAll("%", "!%").replaceAll("_", "!_");
}

function foldAsciiCase(value: string): string {
  return value.replace(/[A-Z]/g, (character) => character.toLowerCase());
}

function buildSearchSnippet(text: string, query: string): string {
  const normalizedText = text.replace(/\s+/g, " ").trim();
  if (normalizedText.length <= 240) {
    return normalizedText;
  }
  const normalizedQuery = foldAsciiCase(query.replace(/\s+/g, " ").trim());
  const matchIndex = foldAsciiCase(normalizedText).indexOf(normalizedQuery);
  const bodyLength = 236;
  const idealStart = Math.max(0, matchIndex - 72);
  const start = Math.min(idealStart, normalizedText.length - bodyLength);
  const end = Math.min(normalizedText.length, start + bodyLength);
  return `${start > 0 ? "…" : ""}${normalizedText.slice(start, end)}${
    end < normalizedText.length ? "…" : ""
  }`;
}

export class ThreadSearch extends Context.Service<
  ThreadSearch,
  {
    readonly search: (
      input: OrchestrationSearchThreadsInput,
    ) => Effect.Effect<OrchestrationSearchThreadsResult, ThreadSearchError>;
  }
>()("t3/orchestration-v2/ThreadSearch") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Carrying message bodies through ranking can spill large histories to temporary files.
  const searchRows = SqlSchema.findAll({
    Request: SearchRequest,
    Result: SearchRow,
    execute: ({ pattern, limit }) => sql`
      WITH ranked AS (
        SELECT
          threads.thread_id,
          threads.project_id,
          messages.role AS source,
          messages.message_id,
          messages.created_at AS message_created_at,
          CASE messages.role WHEN 'user' THEN 0 ELSE 1 END AS match_rank,
          threads.updated_at AS thread_updated_at,
          ROW_NUMBER() OVER (
            PARTITION BY threads.thread_id
            ORDER BY
              CASE messages.role WHEN 'user' THEN 0 ELSE 1 END ASC,
              messages.created_at DESC,
              messages.message_id ASC
          ) AS thread_match_rank
        FROM orchestration_v2_projection_messages AS messages
        INNER JOIN orchestration_v2_projection_threads AS threads
          ON threads.thread_id = messages.thread_id
        INNER JOIN projection_projects AS projects
          ON projects.project_id = threads.project_id
        WHERE threads.deleted_at IS NULL
          AND threads.archived_at IS NULL
          AND projects.deleted_at IS NULL
          AND messages.streaming = 0
          AND messages.role IN ('user', 'assistant')
          AND json_extract(messages.payload_json, '$.text') LIKE ${pattern} ESCAPE '!'
      ),
      matches AS (
        SELECT *
        FROM ranked
        WHERE thread_match_rank = 1
        ORDER BY match_rank ASC, thread_updated_at DESC, thread_id ASC
        LIMIT ${limit}
      )
      SELECT
        matches.thread_id AS "threadId",
        matches.project_id AS "projectId",
        matches.source,
        json_extract(messages.payload_json, '$.text') AS "matchText",
        matches.message_created_at AS "messageCreatedAt"
      FROM matches
      INNER JOIN orchestration_v2_projection_messages AS messages
        ON messages.message_id = matches.message_id
      ORDER BY matches.match_rank ASC, matches.thread_updated_at DESC, matches.thread_id ASC
    `,
  });

  const search: ThreadSearch["Service"]["search"] = Effect.fn("ThreadSearch.search")(
    function* (input) {
      // The scan reads every message, so run it on the reader worker rather
      // than the event loop.
      const rows = yield* sql
        .withTransaction(
          searchRows({
            pattern: `%${escapeLikePattern(input.query)}%`,
            limit: input.limit ?? 50,
          }),
        )
        .pipe(
          NodeSqliteClient.readOnly,
          Effect.mapError(
            (cause) =>
              new ThreadSearchError({
                operation: Schema.isSchemaError(cause) ? "decode" : "query",
                cause,
              }),
          ),
        );
      return {
        matches: rows.map((row) => ({
          threadId: row.threadId,
          projectId: row.projectId,
          source: row.source,
          snippet: buildSearchSnippet(row.matchText, input.query),
          messageCreatedAt: row.messageCreatedAt,
        })),
      };
    },
  );

  return ThreadSearch.of({ search });
});

export const layer = Layer.effect(ThreadSearch, make);
