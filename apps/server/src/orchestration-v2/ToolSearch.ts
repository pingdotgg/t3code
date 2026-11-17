import {
  IsoDateTime,
  OrchestrationV2TurnItemJson,
  ProjectId,
  ThreadId,
  ThreadSearchCursor,
  TurnItemId,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

import {
  backfillToolSearchBatch,
  toolSearchIndexExists,
  toolSearchText,
} from "./toolSearchIndex.ts";

const SNIPPET_LENGTH = 240;
const BACKFILL_WRITER_GAP = "25 millis";

export class ToolSearchError extends Schema.TaggedError<ToolSearchError>()("ToolSearchError", {
  operation: Schema.Literals(["query", "decode", "cursor"]),
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `Tool output search ${this.operation} failed.`;
  }
}

export const ToolSearchMatch = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  title: Schema.String,
  source: Schema.Literal("tool"),
  itemId: TurnItemId,
  toolType: Schema.String,
  archived: Schema.Boolean,
  snippet: Schema.String.check(Schema.isMaxLength(SNIPPET_LENGTH)),
  itemUpdatedAt: IsoDateTime,
});
export type ToolSearchMatch = typeof ToolSearchMatch.Type;

export interface ToolSearchInput {
  readonly query: string;
  readonly projectId?: ProjectId | undefined;
  readonly includeArchived?: boolean | undefined;
  readonly limit?: number | undefined;
  readonly cursor?: typeof ThreadSearchCursor.Type | undefined;
}

export interface ToolSearchResult {
  readonly matches: ReadonlyArray<ToolSearchMatch>;
  readonly nextCursor: typeof ThreadSearchCursor.Type | null;
  readonly complete: boolean;
}

export class ToolSearch extends Context.Service<
  ToolSearch,
  {
    readonly search: (input: ToolSearchInput) => Effect.Effect<ToolSearchResult, ToolSearchError>;
  }
>()("t3/orchestration-v2/ToolSearch") {}

function toolSearchQueries(
  query: string,
): { readonly everyTerm: string; readonly exactPhrase: string } | null {
  const terms = Array.from(query.matchAll(/"([^"]+)"|(\S+)/g), (match) =>
    (match[1] ?? match[2] ?? "").trim(),
  ).filter((term) => /[\p{L}\p{N}]/u.test(term));
  if (terms.length === 0) return null;
  const quote = (term: string) => `"${term.replaceAll('"', '""')}"`;
  return { everyTerm: terms.map(quote).join(" "), exactPhrase: quote(terms.join(" ")) };
}

function toolSnippet(text: string, query: string): string {
  const folded = text.toLowerCase();
  const words = Array.from(query.matchAll(/"([^"]+)"|(\S+)/g), (match) =>
    (match[1] ?? match[2] ?? "").toLowerCase(),
  );
  const starts = [query.replaceAll('"', "").toLowerCase(), ...words]
    .map((term) => folded.indexOf(term))
    .filter((index) => index !== -1);
  const start = Math.max(0, (starts[0] ?? 0) - 60);
  const shown = text
    .slice(start, start + SNIPPET_LENGTH * 2)
    .replace(/\s+/g, " ")
    .trim();
  const body = shown.slice(0, SNIPPET_LENGTH - 2);
  return `${start > 0 ? "…" : ""}${body}${body.length < shown.length ? "…" : ""}`;
}

const HitRow = Schema.Struct({
  itemId: TurnItemId,
  threadId: ThreadId,
  projectId: ProjectId,
  title: Schema.String,
  archived: Schema.Number,
  toolType: Schema.String,
  rank: Schema.Literals([0, 2]),
  threadUpdatedAt: IsoDateTime,
  itemUpdatedAt: IsoDateTime,
  payload: Schema.String,
});

const decodeItem = Schema.decodeUnknownEffect(Schema.fromJsonString(OrchestrationV2TurnItemJson));

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const hitRows = SqlSchema.findAll({
    Request: Schema.Struct({
      everyTerm: Schema.String,
      exactPhrase: Schema.String,
      projectId: Schema.NullOr(ProjectId),
      includeArchived: Schema.Boolean,
      limit: Schema.Int,
      cursor: Schema.NullOr(ThreadSearchCursor),
    }),
    Result: HitRow,
    execute: ({ everyTerm, exactPhrase, projectId, includeArchived, limit, cursor }) => sql`
      WITH hit AS MATERIALIZED (
        SELECT rowid FROM orchestration_v2_tool_search
        WHERE orchestration_v2_tool_search MATCH ${everyTerm}
      ),
      phrase_hit AS MATERIALIZED (
        SELECT rowid FROM orchestration_v2_tool_search
        WHERE orchestration_v2_tool_search MATCH ${exactPhrase}
      ),
      candidate AS (
        SELECT
          items.turn_item_id,
          items.thread_id,
          threads.project_id,
          json_extract(threads.payload_json, '$.title') AS title,
          threads.archived_at,
          items.type,
          items.updated_at AS item_updated_at,
          threads.updated_at AS thread_updated_at,
          CASE WHEN items.rowid IN (SELECT rowid FROM phrase_hit) THEN 0 ELSE 2 END AS match_rank
        FROM hit
        INNER JOIN orchestration_v2_projection_turn_items AS items ON items.rowid = hit.rowid
        INNER JOIN orchestration_v2_projection_threads AS threads
          ON threads.thread_id = items.thread_id
        INNER JOIN projection_projects AS projects ON projects.project_id = threads.project_id
        WHERE threads.deleted_at IS NULL
          AND projects.deleted_at IS NULL
          AND (${includeArchived ? 1 : 0} = 1 OR threads.archived_at IS NULL)
          AND (${projectId} IS NULL OR threads.project_id = ${projectId})
          AND NOT EXISTS (SELECT 1 FROM orchestration_v2_projection_runs AS run
            WHERE run.run_id = items.run_id AND run.status = 'rolled_back')
      ),
      ranked AS (
        SELECT *, ROW_NUMBER() OVER (
          PARTITION BY thread_id
          ORDER BY match_rank ASC, item_updated_at DESC, turn_item_id ASC
        ) AS thread_hit_rank
        FROM candidate
      )
      SELECT
        turn_item_id AS "itemId",
        thread_id AS "threadId",
        project_id AS "projectId",
        coalesce(title, '') AS title,
        archived_at IS NOT NULL AS archived,
        type AS "toolType",
        match_rank AS rank,
        thread_updated_at AS "threadUpdatedAt",
        item_updated_at AS "itemUpdatedAt",
        (SELECT payload_json FROM orchestration_v2_projection_turn_items AS source_item
          WHERE source_item.turn_item_id = ranked.turn_item_id) AS payload
      FROM ranked
      WHERE thread_hit_rank = 1
        AND (${cursor === null ? 1 : 0} = 1
          OR match_rank > ${cursor?.rank ?? 0}
          OR (match_rank = ${cursor?.rank ?? 0} AND thread_updated_at < ${cursor?.updatedAt ?? ""})
          OR (match_rank = ${cursor?.rank ?? 0} AND thread_updated_at = ${cursor?.updatedAt ?? ""}
            AND thread_id > ${cursor?.threadId ?? ""}))
      ORDER BY match_rank ASC, thread_updated_at DESC, thread_id ASC
      LIMIT ${limit}
    `,
  });

  const fail = (cause: unknown) =>
    new ToolSearchError({
      operation: Schema.isSchemaError(cause) ? "decode" : "query",
      cause,
    });

  const search = Effect.fn("ToolSearch.search")(function* (input: ToolSearchInput) {
    const projectId = input.projectId ?? null;
    const includeArchived = input.includeArchived ?? false;
    if (
      input.cursor !== undefined &&
      (input.cursor.source !== "tools" ||
        input.cursor.query !== input.query ||
        input.cursor.projectId !== projectId ||
        input.cursor.includeArchived !== includeArchived)
    ) {
      return yield* new ToolSearchError({ operation: "cursor", cause: "Search scope changed" });
    }
    const match = toolSearchQueries(input.query);
    const exists = yield* toolSearchIndexExists(sql).pipe(Effect.mapError(fail));
    if (match === null || !exists) return { matches: [], nextCursor: null, complete: exists };
    const limit = input.limit ?? 50;
    const { rows, state } = yield* Effect.all({
      rows: hitRows({
        ...match,
        projectId,
        includeArchived,
        limit: limit + 1,
        cursor: input.cursor ?? null,
      }),
      state: sql<{ readonly pending: number }>`
        SELECT cursor < backfill_end AS pending FROM orchestration_v2_tool_search_state WHERE id = 1
      `,
    }).pipe(sql.withTransaction, NodeSqliteClient.readOnly, Effect.mapError(fail));
    const page = rows.slice(0, limit);
    const matches = yield* Effect.forEach(page, (row) =>
      decodeItem(row.payload).pipe(
        Effect.mapError(fail),
        Effect.map((item) => ({
          threadId: row.threadId,
          projectId: row.projectId,
          title: row.title,
          source: "tool" as const,
          itemId: row.itemId,
          toolType: row.toolType,
          archived: row.archived === 1,
          snippet: toolSnippet(toolSearchText(item) ?? "", input.query),
          itemUpdatedAt: row.itemUpdatedAt,
        })),
      ),
    );
    const last = page.at(-1);
    return {
      matches,
      nextCursor:
        rows.length > limit && last !== undefined
          ? {
              query: input.query,
              source: "tools" as const,
              projectId,
              includeArchived,
              rank: last.rank,
              updatedAt: last.threadUpdatedAt,
              threadId: last.threadId,
            }
          : null,
      complete: state[0]?.pending !== 1,
    };
  });

  return ToolSearch.of({ search });
});

const backfill = Effect.fn("ToolSearch.backfill")(function* () {
  const sql = yield* SqlClient.SqlClient;
  if (!(yield* toolSearchIndexExists(sql))) return;
  while (!(yield* backfillToolSearchBatch(sql))) {
    yield* Effect.sleep(BACKFILL_WRITER_GAP);
  }
});

export const layer = Layer.effect(
  ToolSearch,
  Effect.gen(function* () {
    const service = yield* make;
    yield* backfill().pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Tool output search backfill stopped; it resumes on restart.", cause),
      ),
      Effect.forkScoped,
    );
    return service;
  }),
);
