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

/** Carries no query text: search input is user content. */
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

const SearchRequest = Schema.Struct({
  pattern: Schema.String,
  limit: Schema.Int,
  archived: Schema.Boolean,
});
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

/** At most 240 characters, centred near the first match. */
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

/**
 * Searches the finished user and assistant messages of active V2 threads in
 * active projects. Legacy V1 transcripts that have not been imported yet are
 * not searched.
 */
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

  // One best match per active (or archived, when requested) thread: user messages
  // outrank assistant ones, then the newest message wins. Threads order by match kind, then recency.
  const searchRows = SqlSchema.findAll({
    Request: SearchRequest,
    Result: SearchRow,
    execute: ({ pattern, limit, archived }) => sql`
      WITH candidate AS (
        SELECT
          threads.thread_id,
          threads.project_id,
          messages.role,
          json_extract(messages.payload_json, '$.text') AS match_text,
          messages.created_at AS message_created_at,
          messages.message_id,
          threads.updated_at AS thread_updated_at
        FROM orchestration_v2_projection_messages AS messages
        INNER JOIN orchestration_v2_projection_threads AS threads
          ON threads.thread_id = messages.thread_id
        INNER JOIN projection_projects AS projects
          ON projects.project_id = threads.project_id
        WHERE threads.deleted_at IS NULL
          AND ${archived ? sql`threads.archived_at IS NOT NULL` : sql`threads.archived_at IS NULL`}
          AND projects.deleted_at IS NULL
          AND messages.streaming = 0
          AND messages.role IN ('user', 'assistant')
          AND json_extract(messages.payload_json, '$.text') LIKE ${pattern} ESCAPE '!'
      ),
      ranked AS (
        SELECT
          thread_id,
          project_id,
          role AS source,
          match_text,
          message_created_at,
          CASE role WHEN 'user' THEN 0 ELSE 1 END AS match_rank,
          thread_updated_at,
          ROW_NUMBER() OVER (
            PARTITION BY thread_id
            ORDER BY
              CASE role WHEN 'user' THEN 0 ELSE 1 END ASC,
              message_created_at DESC,
              message_id ASC
          ) AS thread_match_rank
        FROM candidate
      )
      SELECT
        thread_id AS "threadId",
        project_id AS "projectId",
        source,
        match_text AS "matchText",
        message_created_at AS "messageCreatedAt"
      FROM ranked
      WHERE thread_match_rank = 1
      ORDER BY match_rank ASC, thread_updated_at DESC, thread_id ASC
      LIMIT ${limit}
    `,
  });

  const search: ThreadSearch["Service"]["search"] = Effect.fn("ThreadSearch.search")(
    function* (input) {
      const rows = yield* searchRows({
        pattern: `%${escapeLikePattern(input.query)}%`,
        limit: input.limit ?? 50,
        archived: input.archived === true,
      }).pipe(
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
