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
  type ConversationSummaryRangeRef,
  type ConversationSummaryRead,
  type ConversationSummaryStatement,
  type ConversationSummarySourceRef,
  type ConversationSummarySourceResult,
  type KnowledgeSourceUnavailableReason,
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
import { readPeerSpeakers } from "../../orchestration-v2/readPeerSpeakers.ts";
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
  type SummarySource,
} from "./conversationSummarySources.ts";
import {
  buildSummaryTree,
  childIds,
  condensedPosition,
  handoffCover,
  isRangeRef,
  leafPosition,
  planCondensation,
  type StoredSummary,
  type SummaryNode,
  type SummaryTree,
} from "./conversationSummaryTree.ts";

// The newest messages stay out of summaries: handoffs replay them verbatim.
const FRESH_TAIL_MESSAGES = 6;
// Bounds the cost of opting in on a long thread; later passes continue where this one stopped.
// Leaves and roll-ups share it.
const MAX_SUMMARIES_PER_PASS = 3;
// Measured as delivery measures it, so a few roll-ups fit beside the verbatim tail of a 16 KB
// handoff in any script. The prompt asks for fewer characters, so this cut is a backstop.
const CONDENSED_MAX_BYTES = 1_536;
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
    readonly hasPendingPass: ConversationSummaryRuntimeShape["hasPendingPass"];
    readonly forHandoff: ConversationSummaryRuntimeShape["forHandoff"];
  }
>()("t3/project/conversationSummaries/ConversationSummaries") {}

const decodeSummary = Schema.decodeUnknownEffect(Schema.fromJsonString(ConversationSummary));
const decodeSources = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ConversationSummary.fields.sources),
);
const encodeSummary = Schema.encodeSync(Schema.fromJsonString(ConversationSummary));
const encodeStatements = Schema.encodeSync(
  Schema.fromJsonString(ConversationSummary.fields.statements),
);
const encodeIds = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));
const decodePass = Schema.decodeUnknownEffect(Schema.fromJsonString(ConversationSummaryPass));
const encodePass = Schema.encodeSync(Schema.fromJsonString(ConversationSummaryPass));
const isConversationSummaryError = Schema.is(ConversationSummaryError);
const isConversationSummaryPassError = Schema.is(ConversationSummaryPassError);

type FinalizedMessage = OrchestrationV2ConversationMessage & {
  readonly role: "user" | "assistant";
};
interface SummaryCursor {
  readonly position: string;
  readonly summary_id: string;
}
type StaleReason = KnowledgeSourceUnavailableReason;

const jsonBytes = (text: string) => Buffer.byteLength(JSON.stringify(text));
const isScrubbed = (summary: ConversationSummary) =>
  summary.scrubbed === true || summary.statements[0]?.text === SCRUBBED_TEXT;

/** Each statement with the 1-based positions of the sources it cites. */
const renderStatements = (summary: Pick<ConversationSummary, "sources" | "statements">) => {
  const position = new Map(
    summary.sources.map((source, index) => [conversationSummarySourceKey(source), index + 1]),
  );
  return summary.statements.map(
    (statement) =>
      `- ${statement.text} [${statement.citations.map((id) => `#${position.get(id)}`).join(", ")}]`,
  );
};

/** Keep statements in order while the rendered roll-up fits its byte budget. */
const fitCondensed = (
  sources: ReadonlyArray<ConversationSummarySourceRef>,
  statements: ReadonlyArray<ConversationSummaryStatement>,
) => {
  const bytes = (kept: ReadonlyArray<ConversationSummaryStatement>) =>
    jsonBytes(renderStatements({ sources, statements: kept }).join("\n"));
  const kept: Array<ConversationSummaryStatement> = [];
  for (const statement of statements) {
    if (bytes([...kept, statement]) > CONDENSED_MAX_BYTES) break;
    kept.push(statement);
  }
  const first = statements[0];
  if (kept.length > 0 || first === undefined) return kept;
  let text = first.text;
  while (text !== "" && bytes([{ ...first, text }]) > CONDENSED_MAX_BYTES)
    text = text.slice(0, boundedTextEnd(text, 0, Math.floor(text.length * 0.9))).trim();
  return text === "" ? [] : [{ ...first, text }];
};

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
  const afterSummary = (after: SummaryCursor | undefined) =>
    after === undefined
      ? sql``
      : sql`AND (position, summary_id) > (${after.position}, ${after.summary_id})`;

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

  /** Every summary of a thread, without statements. Each read is bounded by a page. */
  const loadThreadSummaries = Effect.fn("ConversationSummaries.loadThreadSummaries")(function* (
    projectId: ProjectId,
    threadId: ThreadId,
  ) {
    const summaries: Array<StoredSummary> = [];
    let after: SummaryCursor | undefined;
    while (true) {
      const rows = yield* sql<{
        readonly position: string;
        readonly summary_id: string;
        readonly sources_json: string;
        readonly scrubbed: number;
      }>`
        SELECT position, summary_id,
          json_extract(payload_json, '$.sources') AS sources_json,
          (coalesce(json_extract(payload_json, '$.scrubbed'), 0) = 1
            OR json_extract(payload_json, '$.statements[0].text') = ${SCRUBBED_TEXT}) AS scrubbed
        FROM conversation_summaries
        WHERE project_id = ${projectId} AND thread_id = ${threadId}
        ${afterSummary(after)}
        ORDER BY position, summary_id
        LIMIT ${THREAD_SUMMARY_PAGE_SIZE}
      `;
      for (const row of rows)
        summaries.push({
          id: row.summary_id,
          sources: yield* decodeSources(row.sources_json),
          scrubbed: row.scrubbed === 1,
          position: row.position,
        });
      if (rows.length < THREAD_SUMMARY_PAGE_SIZE) return summaries;
      after = rows.at(-1)!;
    }
  });

  const loadSummaries = Effect.fn("ConversationSummaries.loadSummaries")(function* (
    projectId: ProjectId,
    threadId: ThreadId,
    ids: ReadonlyArray<string>,
  ) {
    if (ids.length === 0) return new Map<string, ConversationSummary>();
    const rows = yield* sql<{ readonly payload_json: string }>`
      SELECT payload_json FROM conversation_summaries
      WHERE project_id = ${projectId} AND thread_id = ${threadId}
        AND summary_id IN (SELECT value FROM json_each(${encodeIds(ids)}))
    `;
    const summaries = yield* Effect.forEach(rows, (row) => decodeSummary(row.payload_json));
    return new Map(summaries.map((summary) => [summary.id, summary]));
  });

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

  const readRanges = Effect.fn("ConversationSummaries.readRanges")(function* (input: {
    readonly projectId: ProjectId;
    readonly threadId: ThreadId;
    readonly sources: ReadonlyArray<ConversationSummaryRangeRef>;
  }) {
    // Read/hash each canonical body once, even if a leaf cites several ranges of it.
    const unique = [
      ...new Map(
        input.sources.map((source) => [conversationSummarySourceIdentity(source), source]),
      ).values(),
    ];
    const messages = unique.filter(
      (source): source is Extract<ConversationSummaryRangeRef, { kind: "message" }> =>
        source.kind === "message",
    );
    const messageResults = yield* knowledge.readSources({ ...input, sources: messages });
    const speakers = yield* readPeerSpeakers(
      sql,
      input.threadId,
      messages.map((source) => source.messageId),
    );
    const invisible =
      messages.length === 0
        ? new Set<MessageId>()
        : yield* invisibleMessageIds(
            input.threadId,
            messages.map((source) => source.messageId),
          );
    const current = new Map<string, ConversationSummarySourceResult>();
    messages.forEach((source, index) => {
      const result = invisible.has(source.messageId)
        ? { state: "unavailable" as const, reason: "missing" as const }
        : messageResults[index]!;
      const speaker = result.state === "available" ? speakers.get(source.messageId) : undefined;
      current.set(
        conversationSummarySourceIdentity(source),
        speaker === undefined || result.state !== "available" ? result : { ...result, speaker },
      );
    });
    const tools = unique.filter(
      (source): source is Extract<ConversationSummaryRangeRef, { kind: "turn_item" }> =>
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
      if (result.source.kind === "summary" || result.source.digest !== source.digest)
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

  /**
   * Why each summary, and every summary beneath it, is stale, or null when it is current. Every
   * range beneath them is re-read once. A leaf checks canonical scope, deletion, archive, final
   * status, full digest and exact range; a condensed summary is current when every child is.
   */
  const verify = Effect.fn("ConversationSummaries.verify")(function* (
    projectId: ProjectId,
    threadId: ThreadId,
    rows: ReadonlyMap<string, StoredSummary>,
    ids: ReadonlyArray<string>,
  ) {
    const leaves: Array<StoredSummary> = [];
    const visited = new Set<string>();
    const collect = (id: string) => {
      const row = rows.get(id);
      if (visited.has(id) || row === undefined) return;
      visited.add(id);
      const children = childIds(row);
      if (children.length === 0) leaves.push(row);
      else children.forEach(collect);
    };
    ids.forEach(collect);
    const ranges = leaves.flatMap((row) => row.sources.filter(isRangeRef));
    const read =
      ranges.length === 0 ? [] : yield* readRanges({ projectId, threadId, sources: ranges });
    const results = new Map(ranges.map((source, index) => [source, read[index]!]));
    const reasons = new Map<string, StaleReason | null>();
    const reasonOf = (id: string, path: ReadonlySet<string>): StaleReason | null => {
      const known = reasons.get(id);
      if (known !== undefined) return known;
      const row = rows.get(id);
      if (row === undefined || path.has(id)) return "missing";
      const children = childIds(row);
      let reason: StaleReason | null;
      if (children.length === 0) {
        const current = row.sources.flatMap((source) => {
          const result = isRangeRef(source) ? results.get(source) : undefined;
          return result === undefined ? [] : [{ source, result }];
        });
        const unavailable = current.find(({ result }) => result.state === "unavailable")?.result;
        // Old leaves claimed a complete source while their model only saw the first 6,000 units.
        const legacyTruncated = current.some(
          ({ source, result }) =>
            result.state === "available" &&
            isRangeRef(source) &&
            source.range === undefined &&
            result.text.length > MAX_SOURCE_CHARS,
        );
        reason =
          unavailable?.state === "unavailable"
            ? unavailable.reason
            : row.scrubbed || legacyTruncated
              ? "changed"
              : null;
      } else {
        const inner = new Set([...path, id]);
        reason =
          children.map((child) => reasonOf(child, inner)).find((found) => found !== null) ??
          (row.scrubbed ? "changed" : null);
      }
      reasons.set(id, reason);
      return reason;
    };
    for (const id of visited) reasonOf(id, new Set());
    for (const [id, reason] of reasons) {
      const row = rows.get(id);
      if (row === undefined || reason === null || reason === "archived" || row.scrubbed) continue;
      // Handoff references keep the summary skeleton, not text derived from a removed source.
      yield* sql`UPDATE conversation_summaries SET payload_json = json_set(payload_json,
        '$.scrubbed', json('true'),
        '$.statements', json(${encodeStatements([
          { text: SCRUBBED_TEXT, citations: [conversationSummarySourceKey(row.sources[0]!)] },
        ])})) WHERE summary_id = ${id}`;
    }
    return reasons;
  });

  const storedOf = (summary: ConversationSummary): StoredSummary => ({
    id: summary.id,
    sources: summary.sources,
    scrubbed: isScrubbed(summary),
    position: "",
  });

  /** Rows a verification of these summaries needs: themselves, or the thread for a roll-up. */
  const rowsFor = Effect.fn("ConversationSummaries.rowsFor")(function* (
    projectId: ProjectId,
    threadId: ThreadId,
    summaries: ReadonlyArray<ConversationSummary>,
  ) {
    return summaries.some((summary) => childIds(storedOf(summary)).length > 0)
      ? new Map((yield* loadThreadSummaries(projectId, threadId)).map((row) => [row.id, row]))
      : new Map(summaries.map((summary) => [summary.id, storedOf(summary)]));
  });

  const readAll = Effect.fn("ConversationSummaries.readAll")(function* (
    projectId: ProjectId,
    threadId: ThreadId,
    summaries: ReadonlyArray<ConversationSummary>,
  ) {
    if (summaries.length === 0) return [];
    const reasons = yield* verify(
      projectId,
      threadId,
      yield* rowsFor(projectId, threadId, summaries),
      summaries.map((summary) => summary.id),
    );
    return summaries.map((summary): ConversationSummaryRead => {
      const reason = reasons.get(summary.id);
      return reason === null
        ? { state: "available", summary }
        : {
            state: "stale",
            id: summary.id,
            sourceCount: summary.sources.length,
            createdAt: summary.createdAt,
            reason: reason ?? "missing",
          };
    });
  });

  const read = (summary: ConversationSummary) =>
    readAll(summary.projectId, summary.threadId, [summary]).pipe(Effect.map((reads) => reads[0]!));

  /** A child summary reads as its statements, or as unavailable with the reason it is stale. */
  const readChildSummaries = Effect.fn("ConversationSummaries.readChildSummaries")(function* (
    projectId: ProjectId,
    threadId: ThreadId,
    refs: ReadonlyArray<Extract<ConversationSummarySourceRef, { kind: "summary" }>>,
  ) {
    const ids = refs.map((ref) => ref.summaryId);
    const rows = new Map(
      (yield* loadThreadSummaries(projectId, threadId)).map((row) => [row.id, row]),
    );
    const reasons = yield* verify(projectId, threadId, rows, ids);
    const children = yield* loadSummaries(projectId, threadId, ids);
    const threads = yield* sql<{ readonly title: string }>`
      SELECT title FROM orchestration_v2_projection_threads WHERE thread_id = ${threadId}
    `;
    return refs.map((ref): ConversationSummarySourceResult => {
      const child = children.get(ref.summaryId);
      const reason = reasons.get(ref.summaryId);
      if (
        ref.threadId !== threadId ||
        child === undefined ||
        reason === undefined ||
        threads[0] === undefined
      )
        return { state: "unavailable", reason: "missing" };
      if (reason !== null) return { state: "unavailable", reason };
      return {
        state: "available",
        source: ref,
        text: renderStatements(child).join("\n"),
        title: threads[0].title,
        role: "summary",
        createdAt: child.createdAt,
        archived: false,
      };
    });
  });

  const readSources = (input: {
    readonly projectId: ProjectId;
    readonly threadId: ThreadId;
    readonly sources: ReadonlyArray<ConversationSummarySourceRef>;
  }) => {
    const ranges = input.sources.filter(isRangeRef);
    const refs = input.sources.filter(
      (source): source is Extract<ConversationSummarySourceRef, { kind: "summary" }> =>
        source.kind === "summary",
    );
    // A summary's sources are all ranges or all summaries.
    return refs.length > 0
      ? readChildSummaries(input.projectId, input.threadId, refs)
      : readRanges({ ...input, sources: ranges });
  };

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
          SELECT position, summary_id FROM conversation_summaries
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
          readonly position: string;
        }>`
          SELECT payload_json, summary_id, position FROM conversation_summaries
          WHERE project_id = ${input.projectId} AND thread_id = ${input.threadId}
          ${afterSummary(after)}
          ORDER BY position, summary_id LIMIT ${scanLimit}
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
        summaries: yield* readAll(input.projectId, input.threadId, page),
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
    ids: ReadonlyArray<string>,
  ) {
    if (ids.length === 0) return;
    yield* sql`
      DELETE FROM conversation_summaries
      WHERE summary_id IN (
        SELECT summary_id FROM conversation_summaries
        WHERE ${sql.in("summary_id", ids)} AND ${unreferenced}
        ORDER BY summary_id LIMIT ${CLEANUP_LIMIT}
      ) AND ${unreferenced}
    `;
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
      let tree: SummaryTree = { roots: [], dead: [] };
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
      // A dead roll-up loses nothing: its current children are roots again. A dead leaf goes only
      // once current summaries cover all of its sources, so a stale stretch stays visible until
      // it is replaced. Reusing the pass's validated coverage avoids hashing the history again.
      const superseded = () => {
        if (tree.dead.length === 0) return [];
        const origins = coveredOrigins();
        return tree.dead
          .filter(
            (row) =>
              childIds(row).length > 0 ||
              row.sources.every((source) => origins.has(conversationSummarySourceIdentity(source))),
          )
          .map((row) => row.id);
      };
      const finish = (
        result: ConversationSummaryPass["result"],
        reason: string | null,
        generated: number,
        waitingMessages: number,
        hasMore = false,
      ) =>
        cleanupSuperseded(superseded()).pipe(
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
      const speakers = yield* readPeerSpeakers(sql, threadId);
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
      const rows = new Map(
        (yield* loadThreadSummaries(projectId, threadId)).map((row) => [row.id, row]),
      );
      const isCurrentLeaf = (row: StoredSummary) =>
        row.sources.every(
          (source) =>
            isRangeRef(source) &&
            source.threadId === threadId &&
            digests.get(conversationSummarySourceIdentity(source)) === source.digest &&
            validSources.has(conversationSummarySourceKey(source)),
        );
      const rebuild = () => {
        tree = buildSummaryTree([...rows.values()], isCurrentLeaf);
        covered.clear();
        for (const root of tree.roots)
          for (const source of root.leafSources) covered.add(conversationSummarySourceKey(source));
      };
      rebuild();
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

      const publish = Effect.fnUntraced(function* (input: {
        readonly messages: ReadonlyArray<
          {
            readonly text: string;
            readonly range?: ConversationSummaryRangeRef["range"];
          } & (
            | { readonly role: "user" | "assistant" | "tool" | "summary" }
            | {
                readonly role: "peer";
                readonly speaker: { readonly label: string; readonly model: string };
              }
          )
        >;
        readonly sources: ReadonlyArray<ConversationSummarySourceRef>;
        readonly ranges: ReadonlyArray<ConversationSummaryRangeRef>;
        readonly position: string;
      }) {
        const refs = new Map<string, string>();
        const messages = input.messages.map((message, index) => {
          const ref = `M${index + 1}`;
          refs.set(ref, conversationSummarySourceKey(input.sources[index]!));
          const range = message.range === undefined ? {} : { range: message.range };
          return message.role === "peer"
            ? { ref, role: message.role, speaker: message.speaker, text: message.text, ...range }
            : { ref, role: message.role, text: message.text, ...range };
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
        if (!reply.ok) return { ok: false as const, reason: reply.detail };
        const cited: Array<ConversationSummaryStatement> = [];
        for (const statement of reply.statements.slice(0, MAX_STATEMENTS)) {
          const text = statement.text.trim().slice(0, MAX_STATEMENT_CHARS).trim();
          const citations = [
            ...new Set(statement.citations.flatMap((ref) => refs.get(ref.trim()) ?? [])),
          ].slice(0, MAX_CITATIONS);
          if (text !== "" && citations.length > 0) cited.push({ text, citations });
        }
        const statements = input.sources.some((source) => source.kind === "summary")
          ? fitCondensed(input.sources, cited)
          : cited;
        if (statements.length === 0)
          return {
            ok: false as const,
            reason: "The model returned no statements citing the summarized sources.",
          };
        const current = yield* readRanges({ projectId, threadId, sources: input.ranges });
        if (current.some((source) => source.state !== "available"))
          return { ok: false as const, reason: "A source changed while it was being summarized." };
        // A child id already digests the child's exact ranges, so it stands in for a digest.
        const id = `summary:${yield* digest(
          [
            "v2",
            threadId,
            ...input.sources.map((source) =>
              source.kind === "summary"
                ? source.summaryId
                : `${conversationSummarySourceKey(source)}:${source.digest}`,
            ),
          ].join("\n"),
        )}`;
        const summary: ConversationSummary = {
          id,
          projectId,
          threadId,
          sources: input.sources,
          statements,
          modelSelection: settings.textGenerationModelSelection,
          createdAt: DateTime.formatIso(yield* DateTime.now),
        };
        yield* sql`
          INSERT INTO conversation_summaries (
            summary_id, project_id, thread_id, position, created_at, payload_json
          ) VALUES (
            ${id}, ${projectId}, ${threadId}, ${input.position},
            ${summary.createdAt}, ${encodeSummary(summary)}
          )
          ON CONFLICT (summary_id) DO UPDATE SET
            created_at = excluded.created_at, payload_json = excluded.payload_json
          WHERE coalesce(json_extract(conversation_summaries.payload_json, '$.scrubbed'), 0) = 1
            OR json_extract(conversation_summaries.payload_json, '$.statements[0].text') = ${SCRUBBED_TEXT}
        `;
        return {
          ok: true as const,
          row: { id, sources: input.sources, scrubbed: false, position: input.position },
        };
      });

      const summarizeLeaf = (chunk: ReadonlyArray<SummarySource>) =>
        publish({
          messages: chunk.map((source) => {
            const speaker =
              source.ref.kind === "message" ? speakers.get(source.ref.messageId) : undefined;
            const range = source.ref.range === undefined ? {} : { range: source.ref.range };
            return speaker === undefined
              ? { role: source.role, text: source.text, ...range }
              : { role: "peer" as const, speaker, text: source.text, ...range };
          }),
          sources: chunk.map((source) => source.ref),
          ranges: chunk.map((source) => source.ref),
          position: leafPosition(DateTime.formatIso(chunk[0]!.createdAt), chunk[0]!.ref),
        });

      const condense = Effect.fnUntraced(function* (group: ReadonlyArray<SummaryNode>) {
        const children = yield* loadSummaries(
          projectId,
          threadId,
          group.map((node) => node.row.id),
        );
        return yield* publish({
          messages: group.map((node) => ({
            role: "summary" as const,
            text: (children.get(node.row.id)?.statements ?? [])
              .map((statement) => `- ${statement.text}`)
              .join("\n"),
          })),
          sources: group.map((node) => ({
            kind: "summary" as const,
            threadId,
            summaryId: node.row.id,
          })),
          ranges: group.flatMap((node) => node.leafSources),
          position: condensedPosition(
            group[0]!.row.position,
            Math.max(...group.map((node) => node.depth)) + 1,
          ),
        });
      });

      // Leaves first: a replacement leaf must exist before its stretch rolls up, or its old
      // neighbours would roll up without it and the broken path could never be rebuilt alone.
      const nextWork = () => {
        const chunk = planLeafChunks({ settled, covered })[0];
        if (chunk !== undefined) return { kind: "leaf" as const, chunk };
        const group = planCondensation(tree.roots);
        return group === null ? null : { kind: "condense" as const, group };
      };
      while (generated < MAX_SUMMARIES_PER_PASS) {
        const work = nextWork();
        if (work === null) break;
        const published =
          work.kind === "leaf" ? yield* summarizeLeaf(work.chunk) : yield* condense(work.group);
        if (!published.ok) return yield* failPass(published.reason);
        rows.set(published.row.id, published.row);
        rebuild();
        generated += 1;
      }
      return yield* finish(
        generated > 0 ? "ran" : "skipped",
        generated > 0 ? null : "No settled stretch is long enough to summarize yet.",
        generated,
        waiting(),
        nextWork() !== null,
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
    const condensed = summary.sources.some((source) => source.kind === "summary");
    return [
      `[Conversation summary ${summary.id}: written by a model from ${summary.sources.length} earlier ${condensed ? "summaries" : "source ranges"} of thread ${summary.threadId}. It is a summary, not the original evidence.]`,
      `Read the exact source ranges with t3_conversation_summary_expand({projectId:"${summary.projectId}",threadId:"${summary.threadId}",summaryId:"${summary.id}"}); #n is the nth source.${condensed ? " A source that is a summary expands the same way, down to the original text." : ""} Follow nextOffset and nextTextOffset together to retrieve all text.`,
      ...renderStatements(summary),
    ].join("\n");
  };

  const coveredUncarriedSources = Effect.fn("ConversationSummaries.coveredUncarriedSources")(
    function* (
      threadId: ThreadId,
      sources: ReadonlyArray<ConversationSummarySourceRef>,
      runs: ReadonlyArray<{ readonly from: number; readonly to: number }>,
    ) {
      if (sources.length === 0 || runs.length === 0) return new Set<string>();
      const rows = yield* sql<{ readonly identity: string; readonly ordinal: number }>`
        SELECT CASE WHEN item.type IN ('user_message', 'assistant_message')
            THEN 'message:' || json_extract(item.payload_json, '$.messageId')
            ELSE 'turn_item:' || item.turn_item_id END AS identity,
          run.ordinal AS ordinal
        FROM orchestration_v2_projection_turn_items AS item
        JOIN orchestration_v2_projection_runs AS run ON run.run_id = item.run_id
        WHERE item.thread_id = ${threadId}
          AND (
            item.turn_item_id IN (SELECT value FROM json_each(${encodeIds(
              sources.flatMap((source) => (source.kind === "turn_item" ? [source.itemId] : [])),
            )}))
            OR (
              item.type IN ('user_message', 'assistant_message')
              AND json_extract(item.payload_json, '$.messageId') IN (
                SELECT value FROM json_each(${encodeIds(
                  sources.flatMap((source) =>
                    source.kind === "message" ? [source.messageId] : [],
                  ),
                )})
              )
            )
          )
      `;
      return new Set(
        rows
          .filter((row) => runs.some((run) => row.ordinal >= run.from && row.ordinal <= run.to))
          .map((row) => row.identity),
      );
    },
  );

  const forHandoff: ConversationSummaries["Service"]["forHandoff"] = Effect.fn(
    "ConversationSummaries.forHandoff",
  )(
    function* ({ projectId, handoffs, itemIds, replayed }) {
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
        const rows = yield* loadThreadSummaries(projectId, threadId);
        const uncarried = yield* coveredUncarriedSources(
          threadId,
          rows.flatMap((row) =>
            row.sources.filter(
              (source) =>
                isRangeRef(source) && !itemBySource.has(conversationSummarySourceIdentity(source)),
            ),
          ),
          replayed?.threadId === threadId ? [replayed] : [],
        );
        const eligible = (identity: string) =>
          itemBySource.has(identity) || uncarried.has(identity);
        // Re-read every leaf the handoff could use. A roll-up is current only when all of its
        // leaves are, and a stale one gives way to its current children.
        const reasons = yield* verify(
          projectId,
          threadId,
          new Map(rows.map((row) => [row.id, row])),
          rows
            .filter(
              (row) =>
                childIds(row).length === 0 &&
                row.sources.every((source) => eligible(conversationSummarySourceIdentity(source))),
            )
            .map((row) => row.id),
        );
        const groups = handoffCover({
          roots: buildSummaryTree(rows, (row) => reasons.get(row.id) === null).roots,
          eligible,
          requested: (identity) => itemBySource.has(identity),
        });
        const summaries = yield* loadSummaries(
          projectId,
          threadId,
          groups.flatMap((group) => group.nodes.map((node) => node.row.id)),
        );
        // The stretch next to the verbatim tail matters most, so it wins the candidate limit.
        for (const group of groups.toReversed()) {
          const sourceItems = [...group.identities].flatMap((id) => itemBySource.get(id) ?? []);
          // A roll-up's evidence would be that of hundreds of items and never fit beside it.
          const evidence = group.nodes.every((node) => node.depth === 0)
            ? yield* deliveredKnowledgeForHistory({
                projectId,
                messages: sourceItems.flatMap((item) =>
                  item.kind === "user_message" || item.kind === "assistant_message"
                    ? [{ ...item, kind: item.kind, threadId }]
                    : [],
                ),
                userItemId: (messageId) => itemByMessage.get(messageId)?.itemId,
              }).pipe(Effect.provideService(ProjectKnowledge.ProjectKnowledge, knowledge))
            : undefined;
          const nodes = group.nodes.flatMap((node) => summaries.get(node.row.id) ?? []);
          if (nodes.length !== group.nodes.length) continue;
          offered.push({
            id: nodes[0]!.id,
            ...(nodes.length > 1 ? { summaryIds: nodes.map((summary) => summary.id) } : {}),
            text: [
              ...nodes.map(renderForHandoff),
              ...sourceItems.flatMap((item) => {
                const attached = evidence?.textByItem.get(item.itemId);
                return attached === undefined
                  ? []
                  : [`[Summary source item=${item.itemId}]\n${attached}`];
              }),
            ].join("\n\n"),
            coveredItemIds: sourceItems.map((item) => item.itemId),
            ...(evidence === undefined
              ? {}
              : {
                  knowledgeFactIds: [
                    ...new Set(
                      sourceItems.flatMap((item) => evidence.factIdsByItem.get(item.itemId) ?? []),
                    ),
                  ],
                }),
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

  const hasPendingPass: ConversationSummaries["Service"]["hasPendingPass"] = Effect.fn(
    "ConversationSummaries.hasPendingPass",
  )(
    function* ({ threadId }) {
      const rows = yield* sql<{ readonly pending: number }>`
        SELECT 1 AS pending FROM orchestration_v2_effect_outbox
        WHERE thread_id = ${threadId}
          AND effect_type = 'conversation-summary.generate'
          AND status IN ('pending', 'running')
        LIMIT 1
      `;
      return rows.length > 0;
    },
    (effect) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Conversation summary queue unreadable", { cause }).pipe(
            Effect.as(true),
          ),
        ),
      ),
  );

  return ConversationSummaries.of({
    list,
    describe,
    expand,
    summarizeThread,
    hasPendingPass,
    forHandoff,
  });
});

export const layer = Layer.effect(ConversationSummaries, make);

/** What orchestration reads: the background pass and handoff lookup. */
export const layerRuntime = Layer.effect(
  ConversationSummaryRuntime,
  Effect.gen(function* () {
    const service = yield* ConversationSummaries;
    return {
      summarizeThread: service.summarizeThread,
      hasPendingPass: service.hasPendingPass,
      forHandoff: service.forHandoff,
    };
  }),
);
