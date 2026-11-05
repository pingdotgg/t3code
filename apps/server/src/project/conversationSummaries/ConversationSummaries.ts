import {
  ConversationSummary,
  ConversationSummaryError,
  ConversationSummaryPass,
  CONVERSATION_SUMMARY_MAX_EXPANSION_CHARS,
  CONVERSATION_SUMMARY_MAX_SOURCES,
  conversationSummarySourceIdentity,
  conversationSummarySourceKey,
  type ConversationSummaryDescribeInput,
  type ConversationSummaryExpandInput,
  type ConversationSummaryExpansion,
  type ConversationSummaryList,
  type ConversationSummaryListInput,
  type ConversationSummaryRead,
  type ConversationSummaryStatement,
  type ConversationSummarySourceRef,
  type ConversationSummarySourceResult,
  type MessageId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2RunStatus,
  type OrchestrationV2UserMessageInputIntent,
  type ProjectId,
  type RunId,
  type ThreadId,
  type TurnItemId,
} from "@t3tools/contracts";
import {
  finalizedToolStatuses,
  summaryToolText,
  summaryToolTypes,
} from "@t3tools/provider-core/server/conversationEvidence";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { createOrchestrationV2TurnItemVisibility } from "@t3tools/shared/orchestrationV2Timeline";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as TextGeneration from "../../textGeneration/TextGeneration.ts";
import * as ProjectKnowledge from "../knowledge/ProjectKnowledge.ts";
import { deliveredKnowledgeForHistory } from "../knowledge/composer.ts";
import {
  ConversationSummaryPassError,
  ConversationSummaryRuntime,
  type ConversationSummaryRuntimeShape,
  type HandoffSummary,
} from "./conversationSummarySchedule.ts";
import {
  boundedTextEnd,
  isTextBoundary,
  MAX_SOURCE_CHARS,
  planLeafChunks,
  sourceRanges,
  sourcesCoverWholeItems,
  type SummarySource,
} from "./conversationSummarySources.ts";

// The newest messages stay out of summaries: handoffs replay them verbatim.
const FRESH_TAIL_MESSAGES = 6;
// Bounds the cost of opting in on a long thread; later passes continue where this one stopped.
const MAX_LEAVES_PER_PASS = 3;
const MAX_STATEMENTS = 8;
const MAX_STATEMENT_CHARS = 600;
const MAX_CITATIONS = 8;
// Bound each read, not the thread's total coverage. Long threads must keep making progress.
const THREAD_SUMMARY_PAGE_SIZE = 500;
const HANDOFF_CANDIDATE_LIMIT = 40;
const CLEANUP_LIMIT = 100;
const SCRUBBED_TEXT = "[Source unavailable: removed or changed.]";

export class ConversationSummaries extends Context.Service<
  ConversationSummaries,
  {
    readonly list: (
      input: ConversationSummaryListInput,
    ) => Effect.Effect<ConversationSummaryList, ConversationSummaryError>;
    readonly describe: (
      input: ConversationSummaryDescribeInput,
    ) => Effect.Effect<ConversationSummaryRead, ConversationSummaryError>;
    readonly expand: (
      input: ConversationSummaryExpandInput,
    ) => Effect.Effect<ConversationSummaryExpansion, ConversationSummaryError>;
    readonly summarizeThread: ConversationSummaryRuntimeShape["summarizeThread"];
    readonly forHandoff: ConversationSummaryRuntimeShape["forHandoff"];
  }
>()("t3/project/conversationSummaries/ConversationSummaries") {}

const decodeSummary = Schema.decodeUnknownEffect(Schema.fromJsonString(ConversationSummary));
const decodeSources = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ConversationSummary.fields.sources),
);
const encodeSummary = Schema.encodeSync(Schema.fromJsonString(ConversationSummary));
const encodeIds = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));
const decodePass = Schema.decodeUnknownEffect(Schema.fromJsonString(ConversationSummaryPass));
const encodePass = Schema.encodeSync(Schema.fromJsonString(ConversationSummaryPass));
const isConversationSummaryError = Schema.is(ConversationSummaryError);
const isConversationSummaryPassError = Schema.is(ConversationSummaryPassError);

type FinalizedMessage = OrchestrationV2ConversationMessage & {
  readonly role: "user" | "assistant";
};
type SummarySources = Pick<ConversationSummary, "id" | "sources" | "scrubbed">;
interface SummaryCursor {
  readonly first_source_at: string;
  readonly first_source_id: string;
  readonly first_source_offset: number;
  readonly summary_id: string;
}

const byConversationOrder = (left: FinalizedMessage, right: FinalizedMessage) =>
  DateTime.toEpochMillis(left.createdAt) - DateTime.toEpochMillis(right.createdAt) ||
  left.id.localeCompare(right.id);

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Digest.Digest;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const knowledge = yield* ProjectKnowledge.ProjectKnowledge;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const textGeneration = yield* TextGeneration.TextGeneration;
  const digest = (text: string) =>
    crypto.digest(Digest.sha256, new TextEncoder().encode(text)).pipe(Effect.map(Hex.encode));
  // Several leaves of a long source share a timestamp. Its identity and range offset keep
  // those leaves in source order, independently of their content-addressed summary ids.
  const firstSourceId = sql`CASE json_extract(payload_json, '$.sources[0].kind')
    WHEN 'message' THEN 'message:' || json_extract(payload_json, '$.sources[0].messageId')
    ELSE 'turn_item:' || json_extract(payload_json, '$.sources[0].itemId') END`;
  const firstSourceOffset = sql`coalesce(json_extract(payload_json, '$.sources[0].range.start'), 0)`;
  const summaryOrder = sql`first_source_at, ${firstSourceId}, ${firstSourceOffset}, summary_id`;
  const afterSummary = (after: SummaryCursor | undefined) =>
    after === undefined
      ? sql``
      : sql`
    AND (first_source_at, ${firstSourceId}, ${firstSourceOffset}, summary_id) >
      (${after.first_source_at}, ${after.first_source_id}, ${after.first_source_offset}, ${after.summary_id})
  `;

  const storageError = (projectId: ProjectId) => (cause: unknown) =>
    isConversationSummaryError(cause)
      ? cause
      : new ConversationSummaryError({ reason: "storage", projectId, cause });

  const requireProject = Effect.fn("ConversationSummaries.requireProject")(function* (
    projectId: ProjectId,
  ) {
    const project = yield* projects.get(projectId).pipe(Effect.mapError(storageError(projectId)));
    if (Option.isNone(project) || project.value.deletedAt !== null)
      return yield* new ConversationSummaryError({ reason: "missing_project", projectId });
    return project.value;
  });

  const scanThreadSummarySources = Effect.fn("ConversationSummaries.scanThreadSummarySources")(
    function* <E, R>(
      projectId: ProjectId,
      threadId: ThreadId,
      // Return false when the caller has enough results; true continues through every page.
      visit: (page: ReadonlyArray<SummarySources>) => Effect.Effect<boolean, E, R>,
      sourceIds?: ReadonlyArray<string>,
    ) {
      const selectedSources = sourceIds === undefined ? undefined : encodeIds(sourceIds);
      let after: SummaryCursor | undefined;
      while (true) {
        const rows = yield* sql<{
          readonly first_source_at: string;
          readonly summary_id: string;
          readonly first_source_id: string;
          readonly first_source_offset: number;
          readonly sources_json: string;
          readonly scrubbed: number;
        }>`
          SELECT first_source_at, summary_id,
            ${firstSourceId} AS first_source_id, ${firstSourceOffset} AS first_source_offset,
            json_extract(payload_json, '$.sources') AS sources_json,
            (coalesce(json_extract(payload_json, '$.scrubbed'), 0) = 1
              OR json_extract(payload_json, '$.statements[0].text') = ${SCRUBBED_TEXT}) AS scrubbed
          FROM conversation_summaries
          WHERE project_id = ${projectId} AND thread_id = ${threadId}
          ${afterSummary(after)}
          ${
            selectedSources === undefined
              ? sql``
              : sql`AND NOT EXISTS (
                  SELECT 1 FROM json_each(payload_json, '$.sources') AS source
                  WHERE CASE json_extract(source.value, '$.kind')
                    WHEN 'message' THEN 'message:' || json_extract(source.value, '$.messageId')
                    ELSE 'turn_item:' || json_extract(source.value, '$.itemId') END NOT IN (
                    SELECT value FROM json_each(${selectedSources})
                  )
                )`
          }
          ORDER BY ${summaryOrder}
          LIMIT ${THREAD_SUMMARY_PAGE_SIZE}
        `;
        if (rows.length === 0) return;
        const page = yield* Effect.forEach(rows, (row) =>
          decodeSources(row.sources_json).pipe(
            Effect.map((sources) => ({
              id: row.summary_id,
              sources,
              scrubbed: row.scrubbed === 1,
            })),
          ),
        );
        if (!(yield* visit(page)) || rows.length < THREAD_SUMMARY_PAGE_SIZE) return;
        after = rows.at(-1)!;
      }
    },
  );

  const findSummary = Effect.fn("ConversationSummaries.findSummary")(function* (
    input: ConversationSummaryDescribeInput,
  ) {
    const rows = yield* sql<{ readonly payload_json: string }>`
      SELECT payload_json FROM conversation_summaries
      WHERE project_id = ${input.projectId} AND thread_id = ${input.threadId}
        AND summary_id = ${input.summaryId}
    `.pipe(Effect.mapError(storageError(input.projectId)));
    if (rows[0] === undefined)
      return yield* new ConversationSummaryError({
        reason: "missing_summary",
        projectId: input.projectId,
      });
    return yield* decodeSummary(rows[0].payload_json).pipe(
      Effect.mapError(storageError(input.projectId)),
    );
  });

  const invisibleMessageIds = Effect.fn("ConversationSummaries.invisibleMessageIds")(function* (
    threadId: ThreadId,
    messageIds?: ReadonlyArray<MessageId>,
  ) {
    // Read identity/visibility metadata only. The canonical message reader still owns body
    // retrieval, and the timeline's shared rule decides whether queued input was ever sent.
    const rows = yield* sql<{
      readonly message_id: MessageId;
      readonly run_id: RunId | null;
      readonly status: OrchestrationV2RunStatus | null;
      readonly input_intent: OrchestrationV2UserMessageInputIntent | null;
    }>`
        SELECT json_extract(item.payload_json, '$.messageId') AS message_id, item.run_id, run.status,
          json_extract(item.payload_json, '$.inputIntent') AS input_intent
        FROM orchestration_v2_projection_turn_items AS item
        LEFT JOIN orchestration_v2_projection_runs AS run ON run.run_id = item.run_id
        WHERE item.thread_id = ${threadId} AND item.type = 'user_message'
          ${messageIds === undefined ? sql`` : sql`AND json_extract(item.payload_json, '$.messageId') IN (SELECT value FROM json_each(${encodeIds(messageIds)}))`}
      `;
    const visible = createOrchestrationV2TurnItemVisibility({
      runs: rows.flatMap((row) =>
        row.run_id === null || row.status === null ? [] : [{ id: row.run_id, status: row.status }],
      ),
      // These are message identities; the superseded-interrupt rule does not apply.
      attempts: [],
      items: [],
    });
    return new Set(
      rows
        .filter(
          (row) =>
            !visible({
              type: "user_message",
              runId: row.run_id,
              nodeId: null,
              ...(row.input_intent === null ? {} : { inputIntent: row.input_intent }),
            }),
        )
        .map((row) => row.message_id),
    );
  });

  const readSources = Effect.fn("ConversationSummaries.readSources")(function* (input: {
    readonly projectId: ProjectId;
    readonly threadId: ThreadId;
    readonly sources: ReadonlyArray<ConversationSummarySourceRef>;
  }) {
    // Read/hash each canonical body once, even if a leaf cites several ranges of it.
    const unique = [
      ...new Map(
        input.sources.map((source) => [conversationSummarySourceIdentity(source), source]),
      ).values(),
    ];
    const messages = unique.filter(
      (source): source is Extract<ConversationSummarySourceRef, { kind: "message" }> =>
        source.kind === "message",
    );
    const messageResults = yield* knowledge.readSources({ ...input, sources: messages });
    const invisible =
      messages.length === 0
        ? new Set<MessageId>()
        : yield* invisibleMessageIds(
            input.threadId,
            messages.map((source) => source.messageId),
          );
    const current = new Map<string, ConversationSummarySourceResult>();
    messages.forEach((source, index) =>
      current.set(
        conversationSummarySourceIdentity(source),
        invisible.has(source.messageId)
          ? { state: "unavailable", reason: "missing" }
          : messageResults[index]!,
      ),
    );
    const tools = unique.filter(
      (source): source is Extract<ConversationSummarySourceRef, { kind: "turn_item" }> =>
        source.kind === "turn_item",
    );
    if (tools.length > 0) {
      const records = yield* projections
        .getThreadRecords(input.threadId, ["turnItems"], {
          turnItemIds: tools.map((source) => source.itemId),
        })
        .pipe(Effect.catchTags({ ProjectionStoreThreadNotFoundError: () => Effect.succeed(null) }));
      const rolledBack = yield* sql<{ readonly item_id: string }>`
        SELECT item.turn_item_id AS item_id FROM orchestration_v2_projection_turn_items AS item
        JOIN orchestration_v2_projection_runs AS run ON run.run_id = item.run_id
        WHERE item.thread_id = ${input.threadId} AND run.status = 'rolled_back'
          AND item.turn_item_id IN (SELECT value FROM json_each(${encodeIds(tools.map((source) => source.itemId))}))
      `;
      const excluded = new Set(rolledBack.map((row) => row.item_id));
      const items = new Map(records?.turnItems.map((item) => [item.id, item]));
      for (const source of tools) {
        const item = items.get(source.itemId);
        const text = item === undefined ? null : summaryToolText(item);
        const reason =
          records === null
            ? "missing"
            : records.thread.projectId !== input.projectId
              ? "wrong_project"
              : records.thread.deletedAt !== null
                ? "deleted"
                : records.thread.archivedAt !== null
                  ? "archived"
                  : item === undefined || excluded.has(item.id)
                    ? "missing"
                    : text === null
                      ? "streaming"
                      : source.digest !== (yield* digest(text))
                        ? "changed"
                        : null;
        current.set(
          conversationSummarySourceIdentity(source),
          reason === null && item !== undefined && text !== null
            ? {
                state: "available",
                source,
                text,
                role: "tool",
                title: records!.thread.title,
                createdAt: DateTime.formatIso(item.completedAt ?? item.updatedAt),
                archived: false,
              }
            : { state: "unavailable", reason: reason ?? "missing" },
        );
      }
    }
    return input.sources.map((source): ConversationSummarySourceResult => {
      const result = current.get(conversationSummarySourceIdentity(source));
      if (source.threadId !== input.threadId) return { state: "unavailable", reason: "missing" };
      if (result === undefined) return { state: "unavailable", reason: "missing" };
      if (result.state !== "available") return result;
      if (result.source.digest !== source.digest)
        return { state: "unavailable", reason: "changed" };
      const range = source.range;
      if (
        range !== undefined &&
        (range.total !== result.text.length ||
          range.start >= range.end ||
          range.end > range.total ||
          !isTextBoundary(result.text, range.start) ||
          !isTextBoundary(result.text, range.end))
      )
        return { state: "unavailable", reason: "changed" };
      return {
        ...result,
        source,
        text: range === undefined ? result.text : result.text.slice(range.start, range.end),
      };
    });
  });

  // Validate canonical scope, deletion, archive, final status, full digest and exact range.
  const read = Effect.fn("ConversationSummaries.read")(function* (summary: ConversationSummary) {
    const current = yield* readSources({
      projectId: summary.projectId,
      threadId: summary.threadId,
      sources: summary.sources,
    });
    const unavailable = current.find((source) => source.state === "unavailable");
    const scrubbed = summary.scrubbed === true || summary.statements[0]?.text === SCRUBBED_TEXT;
    // Old leaves claimed a complete source while their model only saw the first 6,000 units.
    const legacyTruncated = current.some(
      (result, index) =>
        result.state === "available" &&
        summary.sources[index]!.range === undefined &&
        result.text.length > MAX_SOURCE_CHARS,
    );
    const reason =
      unavailable?.state === "unavailable"
        ? unavailable.reason
        : scrubbed || legacyTruncated
          ? "changed"
          : null;
    if (reason !== null && reason !== "archived" && !summary.scrubbed) {
      // Handoff references keep the summary skeleton, not text derived from a removed source.
      yield* sql`UPDATE conversation_summaries SET payload_json = ${encodeSummary({
        ...summary,
        scrubbed: true,
        statements: [
          {
            text: SCRUBBED_TEXT,
            citations: [conversationSummarySourceKey(summary.sources[0]!)],
          },
        ],
      })} WHERE summary_id = ${summary.id}`;
    }
    return reason !== null
      ? ({
          state: "stale",
          id: summary.id,
          sourceCount: summary.sources.length,
          createdAt: summary.createdAt,
          reason,
        } satisfies ConversationSummaryRead)
      : ({ state: "available", summary } satisfies ConversationSummaryRead);
  });

  const list: ConversationSummaries["Service"]["list"] = Effect.fn("ConversationSummaries.list")(
    function* (input) {
      yield* requireProject(input.projectId);
      const settings = yield* serverSettings.getSettings;
      const passRows = yield* sql<{ readonly payload_json: string }>`
        SELECT payload_json FROM conversation_summary_passes
        WHERE thread_id = ${input.threadId} AND project_id = ${input.projectId}
      `;
      const lastPass =
        passRows[0] === undefined ? null : yield* decodePass(passRows[0].payload_json);
      let after: SummaryCursor | undefined;
      if (input.cursor !== undefined) {
        const cursorRows = yield* sql<SummaryCursor>`
          SELECT first_source_at, summary_id,
            ${firstSourceId} AS first_source_id, ${firstSourceOffset} AS first_source_offset
          FROM conversation_summaries
          WHERE project_id = ${input.projectId} AND thread_id = ${input.threadId}
            AND summary_id = ${input.cursor}
        `;
        if (cursorRows[0] === undefined)
          return yield* new ConversationSummaryError({
            reason: "invalid_cursor",
            projectId: input.projectId,
          });
        after = cursorRows[0];
      }
      const limit = input.limit ?? 20;
      const query = input.query?.trim().toLowerCase() ?? "";
      const matching: Array<ConversationSummary> = [];
      const scanLimit = query === "" ? limit + 1 : THREAD_SUMMARY_PAGE_SIZE;
      // Fold Unicode in application code; SQLite lower() only folds ASCII. Each read is
      // bounded, and the cursor remains the last returned summary, even across sparse matches.
      while (matching.length <= limit) {
        const rows = yield* sql<{
          readonly payload_json: string;
          readonly summary_id: string;
          readonly first_source_at: string;
          readonly first_source_id: string;
          readonly first_source_offset: number;
        }>`
          SELECT payload_json, summary_id, first_source_at,
            ${firstSourceId} AS first_source_id, ${firstSourceOffset} AS first_source_offset
          FROM conversation_summaries
          WHERE project_id = ${input.projectId} AND thread_id = ${input.threadId}
          ${afterSummary(after)}
          ORDER BY ${summaryOrder} LIMIT ${scanLimit}
        `;
        for (const row of rows) {
          const summary = yield* decodeSummary(row.payload_json);
          if (
            query === "" ||
            summary.statements.some((statement) => statement.text.toLowerCase().includes(query))
          )
            matching.push(summary);
          if (matching.length > limit) break;
        }
        if (rows.length < scanLimit) break;
        const last = rows.at(-1)!;
        after = last;
      }
      const page = matching.slice(0, limit);
      return {
        enabled: resolveProjectSettings(settings, input.projectId).settings
          .enableConversationSummaries,
        lastPass,
        summaries: yield* Effect.forEach(page, read),
        nextCursor: matching.length > limit ? (page.at(-1)?.id ?? null) : null,
      };
    },
    (effect, input) => effect.pipe(Effect.mapError(storageError(input.projectId))),
  );

  const describe: ConversationSummaries["Service"]["describe"] = Effect.fn(
    "ConversationSummaries.describe",
  )(
    function* (input) {
      yield* requireProject(input.projectId);
      return yield* read(yield* findSummary(input));
    },
    (effect, input) => effect.pipe(Effect.mapError(storageError(input.projectId))),
  );

  const expand: ConversationSummaries["Service"]["expand"] = Effect.fn(
    "ConversationSummaries.expand",
  )(
    function* (input) {
      yield* requireProject(input.projectId);
      const summary = yield* findSummary(input);
      const offset = input.offset ?? 0;
      const textOffset = input.textOffset ?? 0;
      if (
        offset > summary.sources.length ||
        (offset === summary.sources.length && textOffset !== 0)
      )
        return yield* new ConversationSummaryError({
          reason: "invalid_cursor",
          projectId: input.projectId,
        });
      const limit = input.limit ?? CONVERSATION_SUMMARY_MAX_SOURCES;
      const page = summary.sources.slice(offset, offset + limit);
      // Each source is re-read with its recorded digest, so a changed message comes back as
      // unavailable instead of as text the summary was not made from.
      const results = yield* readSources({
        projectId: input.projectId,
        threadId: input.threadId,
        sources: page,
      });
      let remaining = input.maxChars ?? 12_000;
      // Contracts enforce this for RPC/MCP; service callers get the same hard upper bound.
      remaining = Math.max(2, Math.min(remaining, CONVERSATION_SUMMARY_MAX_EXPANSION_CHARS));
      const sources: Array<ConversationSummaryExpansion["sources"][number]> = [];
      let nextOffset: number | null = null;
      let nextTextOffset: number | null = null;
      for (let index = 0; index < page.length; index++) {
        const ref = page[index]!;
        const result = results[index]!;
        const start = index === 0 ? textOffset : 0;
        if (result.state === "available") {
          if (start > result.text.length || !isTextBoundary(result.text, start))
            return yield* new ConversationSummaryError({
              reason: "invalid_cursor",
              projectId: input.projectId,
            });
          const end = boundedTextEnd(result.text, start, remaining);
          if (end === start && start < result.text.length) {
            nextOffset = offset + index;
            nextTextOffset = start;
            break;
          }
          sources.push({
            ref,
            result: {
              ...result,
              text: result.text.slice(start, end),
              textOffset: start,
              totalChars: result.text.length,
            },
          });
          remaining -= end - start;
          if (end < result.text.length) {
            nextOffset = offset + index;
            nextTextOffset = end;
            break;
          }
        } else sources.push({ ref, result });
        if (offset + index + 1 < summary.sources.length) {
          nextOffset = offset + index + 1;
          nextTextOffset = 0;
        } else {
          nextOffset = null;
          nextTextOffset = null;
        }
      }
      return {
        summary: yield* read(summary),
        sources,
        nextOffset,
        nextTextOffset,
      };
    },
    (effect, input) => effect.pipe(Effect.mapError(storageError(input.projectId))),
  );

  const recordPass = Effect.fn("ConversationSummaries.recordPass")(function* (
    projectId: ProjectId,
    threadId: ThreadId,
    pass: ConversationSummaryPass,
  ) {
    yield* sql`
      INSERT INTO conversation_summary_passes (thread_id, project_id, payload_json)
      VALUES (${threadId}, ${projectId}, ${encodePass(pass)})
      ON CONFLICT (thread_id) DO UPDATE SET
        project_id = excluded.project_id,
        payload_json = excluded.payload_json
    `;
  });

  // Delivered handoffs keep retrieval ids, including handoffs on forked threads. Check all
  // deliveries at deletion time, not only the thread currently being summarized.
  const unreferenced = sql`NOT EXISTS (
    SELECT 1 FROM orchestration_v2_projection_context_handoffs AS handoff,
      json_each(handoff.payload_json, '$.delivery.summaryIds') AS reference
    WHERE reference.value = conversation_summaries.summary_id
  )`;

  const cleanupDeleted = Effect.fn("ConversationSummaries.cleanupDeleted")(function* () {
    yield* sql`
      DELETE FROM conversation_summaries WHERE summary_id IN (
        SELECT summary_id FROM conversation_summaries
        WHERE NOT EXISTS (
          SELECT 1 FROM orchestration_v2_projection_threads AS thread
          WHERE thread.thread_id = conversation_summaries.thread_id
            AND thread.deleted_at IS NULL
        ) AND ${unreferenced}
        ORDER BY summary_id LIMIT ${CLEANUP_LIMIT}
      ) AND ${unreferenced}
    `;
  });

  const cleanupSuperseded = Effect.fn("ConversationSummaries.cleanupSuperseded")(function* (
    projectId: ProjectId,
    threadId: ThreadId,
    digests: ReadonlyMap<string, string>,
    covered: ReadonlySet<string>,
    validSourceKeys: ReadonlySet<string>,
  ) {
    // Reuse the pass's validated coverage. Re-reading every source here would hash the whole
    // history again on every completed turn, even when no summary needs replacing.
    if (covered.size === 0) return;
    let deleted = 0;
    yield* scanThreadSummarySources(
      projectId,
      threadId,
      Effect.fnUntraced(function* (summaries) {
        const replaced = summaries.filter(
          (summary) =>
            summary.sources.every((source) =>
              covered.has(conversationSummarySourceIdentity(source)),
            ) &&
            (summary.scrubbed ||
              summary.sources.some(
                (source) =>
                  digests.get(conversationSummarySourceIdentity(source)) !== source.digest ||
                  !validSourceKeys.has(conversationSummarySourceKey(source)),
              )),
        );
        if (replaced.length > 0) {
          const removed = yield* sql<{ readonly summary_id: string }>`
            DELETE FROM conversation_summaries
            WHERE summary_id IN (
              SELECT summary_id FROM conversation_summaries
              WHERE ${sql.in(
                "summary_id",
                replaced.map((summary) => summary.id),
              )}
                AND ${unreferenced}
              ORDER BY summary_id LIMIT ${CLEANUP_LIMIT - deleted}
            ) AND ${unreferenced}
            RETURNING summary_id
          `;
          deleted += removed.length;
        }
        return deleted < CLEANUP_LIMIT;
      }),
    );
  });

  const summarizeThread: ConversationSummaries["Service"]["summarizeThread"] = Effect.fn(
    "ConversationSummaries.summarizeThread",
  )(
    function* ({ threadId, runId }) {
      yield* cleanupDeleted();
      const records = yield* projections
        .getThreadRecords(threadId, ["messages", "turnItems"], {
          messageRoles: ["user", "assistant"],
          turnItemTypes: summaryToolTypes,
          turnItemStatuses: finalizedToolStatuses,
        })
        .pipe(Effect.catchTags({ ProjectionStoreThreadNotFoundError: () => Effect.succeed(null) }));
      if (records === null) return { hasMore: false };
      const projectId = records.thread.projectId;
      const digests = new Map<string, string>();
      const covered = new Set<string>();
      const validSources = new Map<string, SummarySource>();
      let hasStaleSummaries = false;
      const coveredOrigins = () => {
        const all = new Map<string, Array<string>>();
        for (const [key, source] of validSources) {
          const identity = conversationSummarySourceIdentity(source.ref);
          const keys = all.get(identity) ?? [];
          keys.push(key);
          all.set(identity, keys);
        }
        return new Set(
          [...all].filter(([, keys]) => keys.every((key) => covered.has(key))).map(([id]) => id),
        );
      };
      const finish = (
        result: ConversationSummaryPass["result"],
        reason: string | null,
        generated: number,
        waitingMessages: number,
        hasMore = false,
      ) =>
        (hasStaleSummaries
          ? cleanupSuperseded(
              projectId,
              threadId,
              digests,
              coveredOrigins(),
              new Set(validSources.keys()),
            )
          : Effect.void
        ).pipe(
          Effect.andThen(DateTime.now),
          Effect.flatMap((now) =>
            recordPass(projectId, threadId, {
              runId,
              result,
              reason,
              generated,
              waitingMessages,
              at: DateTime.formatIso(now),
            }),
          ),
          Effect.as({ hasMore }),
        );
      if (records.thread.deletedAt !== null)
        return yield* finish("skipped", "The thread was deleted.", 0, 0);
      if (records.thread.archivedAt !== null)
        return yield* finish("skipped", "The thread is archived.", 0, 0);
      const settings = resolveProjectSettings(
        yield* serverSettings.getSettings,
        projectId,
      ).settings;
      if (!settings.enableConversationSummaries)
        return yield* finish("skipped", "Conversation summaries are off for this project.", 0, 0);
      const project = yield* projects.get(projectId);
      if (Option.isNone(project) || project.value.deletedAt !== null) return { hasMore: false };
      const cwd = records.thread.worktreePath ?? project.value.workspaceRoot;

      const rolledBack = yield* sql<{ readonly run_id: string }>`
        SELECT run_id FROM orchestration_v2_projection_runs
        WHERE thread_id = ${threadId} AND status = 'rolled_back'
      `;
      const excluded = new Set(rolledBack.map((row) => row.run_id));
      const invisible = yield* invisibleMessageIds(threadId);
      const finalized = records.messages
        .filter(
          (message): message is FinalizedMessage =>
            (message.role === "user" || message.role === "assistant") &&
            (message.runId === null || !excluded.has(message.runId)) &&
            !invisible.has(message.id) &&
            !message.streaming &&
            message.text.trim() !== "",
        )
        .toSorted(byConversationOrder);
      const freshIndex = Math.max(0, finalized.length - FRESH_TAIL_MESSAGES);
      const freshAt = finalized[freshIndex]?.createdAt;
      const settledMessageIds = new Set(
        finalized.slice(0, freshIndex).map((message) => message.id),
      );
      const all: Array<SummarySource> = [];
      for (const message of finalized) {
        all.push({
          ref: {
            kind: "message",
            threadId,
            messageId: message.id,
            digest: yield* digest(message.text),
          },
          role: message.role,
          text: message.text,
          createdAt: message.createdAt,
        });
      }
      for (const item of records.turnItems) {
        if (item.runId !== null && excluded.has(item.runId)) continue;
        const text = summaryToolText(item);
        if (text === null) continue;
        all.push({
          ref: { kind: "turn_item", threadId, itemId: item.id, digest: yield* digest(text) },
          role: "tool",
          text,
          createdAt: item.completedAt ?? item.updatedAt,
        });
      }
      all.sort(
        (a, b) =>
          DateTime.toEpochMillis(a.createdAt) - DateTime.toEpochMillis(b.createdAt) ||
          conversationSummarySourceIdentity(a.ref).localeCompare(
            conversationSummarySourceIdentity(b.ref),
          ),
      );
      const settled: Array<SummarySource> = [];
      for (const source of all) {
        digests.set(conversationSummarySourceIdentity(source.ref), source.ref.digest);
        const ranges = sourceRanges(source);
        for (const range of ranges)
          validSources.set(conversationSummarySourceKey(range.ref), range);
        if (
          source.ref.kind === "message"
            ? settledMessageIds.has(source.ref.messageId)
            : freshAt === undefined ||
              DateTime.toEpochMillis(source.createdAt) < DateTime.toEpochMillis(freshAt)
        ) {
          settled.push(...ranges);
        }
      }
      yield* scanThreadSummarySources(projectId, threadId, (summaries) =>
        Effect.sync(() => {
          for (const summary of summaries) {
            if (
              !summary.scrubbed &&
              summary.sources.every(
                (source) =>
                  source.threadId === threadId &&
                  digests.get(conversationSummarySourceIdentity(source)) === source.digest &&
                  validSources.has(conversationSummarySourceKey(source)),
              )
            ) {
              for (const source of summary.sources)
                covered.add(conversationSummarySourceKey(source));
            } else hasStaleSummaries = true;
          }
          return true;
        }),
      );
      const waiting = () =>
        new Set(
          settled
            .filter((source) => !covered.has(conversationSummarySourceKey(source.ref)))
            .map((source) => conversationSummarySourceIdentity(source.ref)),
        ).size;
      let generated = 0;
      const failPass = (reason: string) =>
        finish("failed", reason.slice(0, 300), generated, waiting()).pipe(
          Effect.andThen(Effect.fail(new ConversationSummaryPassError({ runId, cause: reason }))),
        );
      for (const chunk of planLeafChunks({ settled, covered }).slice(0, MAX_LEAVES_PER_PASS)) {
        const refs = new Map<string, string>();
        const messages = chunk.map((source, index) => {
          const ref = `M${index + 1}`;
          refs.set(ref, conversationSummarySourceKey(source.ref));
          return {
            ref,
            role: source.role,
            text: source.text,
            ...(source.ref.range === undefined ? {} : { range: source.ref.range }),
          };
        });
        const reply = yield* textGeneration
          .generateConversationSummary({
            cwd,
            messages,
            modelSelection: settings.textGenerationModelSelection,
          })
          .pipe(
            Effect.map((result) => ({ ok: true as const, statements: result.statements })),
            Effect.catchTags({
              TextGenerationError: (error) =>
                Effect.succeed({ ok: false as const, detail: error.detail }),
            }),
          );
        if (!reply.ok) return yield* failPass(reply.detail);
        const statements: Array<ConversationSummaryStatement> = [];
        for (const statement of reply.statements.slice(0, MAX_STATEMENTS)) {
          const text = statement.text.trim().slice(0, MAX_STATEMENT_CHARS).trim();
          const citations = [
            ...new Set(statement.citations.flatMap((ref) => refs.get(ref.trim()) ?? [])),
          ].slice(0, MAX_CITATIONS);
          if (text !== "" && citations.length > 0) statements.push({ text, citations });
        }
        if (statements.length === 0)
          return yield* failPass("The model returned no statements citing the summarized sources.");
        const sources = chunk.map((source) => source.ref);
        const current = yield* readSources({ projectId, threadId, sources });
        if (current.some((source) => source.state !== "available"))
          return yield* failPass("A source changed while it was being summarized.");
        const id = `summary:${yield* digest(
          [
            "v2",
            threadId,
            ...sources.map((source) => `${conversationSummarySourceKey(source)}:${source.digest}`),
          ].join("\n"),
        )}`;
        const summary: ConversationSummary = {
          id,
          projectId,
          threadId,
          sources,
          statements,
          modelSelection: settings.textGenerationModelSelection,
          createdAt: DateTime.formatIso(yield* DateTime.now),
        };
        yield* sql`
          INSERT INTO conversation_summaries (
            summary_id, project_id, thread_id, first_source_at, created_at, payload_json
          ) VALUES (
            ${id}, ${projectId}, ${threadId}, ${DateTime.formatIso(chunk[0]!.createdAt)},
            ${summary.createdAt}, ${encodeSummary(summary)}
          )
          ON CONFLICT (summary_id) DO UPDATE SET
            created_at = excluded.created_at, payload_json = excluded.payload_json
          WHERE coalesce(json_extract(conversation_summaries.payload_json, '$.scrubbed'), 0) = 1
            OR json_extract(conversation_summaries.payload_json, '$.statements[0].text') = ${SCRUBBED_TEXT}
        `;
        for (const source of sources) covered.add(conversationSummarySourceKey(source));
        generated += 1;
      }
      return yield* finish(
        generated > 0 ? "ran" : "skipped",
        generated > 0 ? null : "No settled stretch is long enough to summarize yet.",
        generated,
        waiting(),
        planLeafChunks({ settled, covered }).length > 0,
      );
    },
    (effect, { runId }) =>
      effect.pipe(
        Effect.mapError((cause) =>
          isConversationSummaryPassError(cause)
            ? cause
            : new ConversationSummaryPassError({ runId, cause }),
        ),
      ),
  );

  const renderForHandoff = (summary: ConversationSummary) => {
    const position = new Map(
      summary.sources.map((source, index) => [conversationSummarySourceKey(source), index + 1]),
    );
    return [
      `[Conversation summary ${summary.id}: written by a model from ${summary.sources.length} earlier source ranges of thread ${summary.threadId}. It is a summary, not the original evidence.]`,
      `Read the exact source ranges with t3_conversation_summary_expand({projectId:"${summary.projectId}",threadId:"${summary.threadId}",summaryId:"${summary.id}"}); #n is the nth source. Follow nextOffset and nextTextOffset together to retrieve all text.`,
      ...summary.statements.map(
        (statement) =>
          `- ${statement.text} [${statement.citations.map((id) => `#${position.get(id)}`).join(", ")}]`,
      ),
    ].join("\n");
  };

  const forHandoff: ConversationSummaries["Service"]["forHandoff"] = Effect.fn(
    "ConversationSummaries.forHandoff",
  )(
    function* ({ projectId, handoffs, itemIds }) {
      yield* requireProject(projectId);
      if (
        !resolveProjectSettings(yield* serverSettings.getSettings, projectId).settings
          .enableConversationSummaries
      )
        return [];
      const threadIds = new Set<ThreadId>();
      for (const handoff of handoffs) {
        threadIds.add(handoff.threadId);
        for (const message of handoff.history?.messages ?? []) threadIds.add(message.threadId);
      }
      const offered: Array<HandoffSummary> = [];
      const requestedItems = encodeIds([...itemIds]);
      for (const threadId of threadIds) {
        if (offered.length >= HANDOFF_CANDIDATE_LIMIT) break;
        // Resolve exact requested canonical item identities without loading their bodies.
        const items = yield* sql<{
          readonly itemId: TurnItemId;
          readonly messageId: MessageId | null;
          readonly runId: RunId | null;
          readonly kind: string;
        }>`
          SELECT item.turn_item_id AS "itemId", item.run_id AS "runId", item.type AS kind,
            json_extract(item.payload_json, '$.messageId') AS "messageId"
          FROM json_each(${requestedItems}) AS requested
          JOIN orchestration_v2_projection_turn_items AS item ON item.turn_item_id = requested.value
          WHERE item.thread_id = ${threadId}
        `;
        const itemBySource = new Map(
          items.map((item) => [
            (item.kind === "user_message" || item.kind === "assistant_message") &&
            item.messageId !== null
              ? `message:${item.messageId}`
              : `turn_item:${item.itemId}`,
            item,
          ]),
        );
        const itemByMessage = new Map(
          items.flatMap((item) =>
            item.messageId === null ? [] : [[item.messageId, item] as const],
          ),
        );
        if (itemBySource.size === 0) continue;
        const candidates: Array<ConversationSummary> = [];
        yield* scanThreadSummarySources(
          projectId,
          threadId,
          Effect.fnUntraced(function* (summaries) {
            for (const metadata of summaries) {
              if (
                metadata.scrubbed ||
                !metadata.sources.every((source) =>
                  itemBySource.has(conversationSummarySourceIdentity(source)),
                )
              )
                continue;
              const summary = yield* findSummary({ projectId, threadId, summaryId: metadata.id });
              if ((yield* read(summary)).state !== "available") continue;
              candidates.push(summary);
              if (candidates.length >= HANDOFF_CANDIDATE_LIMIT) return false;
            }
            return true;
          }),
          [...itemBySource.keys()],
        );
        // Leaves sharing a split source form one atomic offer. Omitting the item after only
        // one of its ranges was summarized would silently discard the remaining evidence.
        const groups: Array<{ summaries: Array<ConversationSummary>; identities: Set<string> }> =
          [];
        for (const summary of candidates) {
          const group = {
            summaries: [summary],
            identities: new Set(summary.sources.map(conversationSummarySourceIdentity)),
          };
          for (let index = groups.length - 1; index >= 0; index--) {
            const previous = groups[index]!;
            if (![...previous.identities].some((id) => group.identities.has(id))) continue;
            group.summaries.unshift(...previous.summaries);
            for (const id of previous.identities) group.identities.add(id);
            groups.splice(index, 1);
          }
          groups.push(group);
        }
        for (const group of groups) {
          if (!sourcesCoverWholeItems(group.summaries.flatMap((summary) => summary.sources)))
            continue;
          const sourceItems = [...group.identities].map((id) => itemBySource.get(id)!);
          const evidence = yield* deliveredKnowledgeForHistory({
            projectId,
            messages: sourceItems.flatMap((item) =>
              item.kind === "user_message" || item.kind === "assistant_message"
                ? [{ ...item, kind: item.kind, threadId }]
                : [],
            ),
            userItemId: (messageId) => itemByMessage.get(messageId)?.itemId,
          }).pipe(Effect.provideService(ProjectKnowledge.ProjectKnowledge, knowledge));
          offered.push({
            id: group.summaries[0]!.id,
            ...(group.summaries.length > 1
              ? { summaryIds: group.summaries.map((summary) => summary.id) }
              : {}),
            text: [
              ...group.summaries.map(renderForHandoff),
              ...sourceItems.flatMap((item) => {
                const attached = evidence.get(item.itemId);
                return attached === undefined
                  ? []
                  : [`[Summary source item=${item.itemId}]\n${attached}`];
              }),
            ].join("\n\n"),
            coveredItemIds: sourceItems.map((item) => item.itemId),
          });
          if (offered.length >= HANDOFF_CANDIDATE_LIMIT) break;
        }
      }
      return offered;
    },
    (effect) =>
      effect.pipe(
        // Summaries only improve a handoff; failing to read them must not block the turn.
        Effect.catchCause((cause) =>
          Effect.logWarning("Conversation summaries unavailable for handoff", { cause }).pipe(
            Effect.as([]),
          ),
        ),
      ),
  );

  return ConversationSummaries.of({ list, describe, expand, summarizeThread, forHandoff });
});

export const layer = Layer.effect(ConversationSummaries, make);

/** What orchestration reads: the background pass and handoff lookup. */
export const layerRuntime = Layer.effect(
  ConversationSummaryRuntime,
  Effect.gen(function* () {
    const service = yield* ConversationSummaries;
    return { summarizeThread: service.summarizeThread, forHandoff: service.forHandoff };
  }),
);
