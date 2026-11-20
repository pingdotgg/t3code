import {
  OrchestrationV2TurnItemJson,
  type OrchestrationV2ProjectedTurnItem,
  OrchestrationV2SearchThreadInput,
  type OrchestrationV2SearchThreadResult,
  type OrchestrationV2TurnItem,
  ThreadId,
} from "@t3tools/contracts";
import { searchableMessageSegments, searchablePlanSegments } from "@t3tools/shared/threadFindText";
import { countThreadSearchOccurrences } from "@t3tools/shared/threadSearch";
import { htmlRenderFromToolItem, mcpAppFromToolItem } from "@t3tools/shared/toolOutput";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as SqlClient from "effect/sql/SqlClient";
import {
  ProjectionStoreReadError,
  ProjectionStoreThreadNotFoundError,
  type ProjectionStoreV2Error,
} from "./ProjectionStore.ts";
import { EVENT_LOG_PRUNED_THROUGH } from "../persistence/OrchestrationEventStore.ts";

type IndexItem = Pick<OrchestrationV2TurnItem, "type" | "runId" | "nodeId" | "ordinal"> & {
  readonly inputIntent?: string | undefined;
};
interface IndexRow {
  readonly visibility: OrchestrationV2ProjectedTurnItem["visibility"];
  readonly sourceThreadId: ThreadId;
  readonly sourceItemId: string;
  readonly item: IndexItem;
}
interface FindDocument {
  readonly position: number;
  readonly entryId: string;
  readonly runId: OrchestrationV2TurnItem["runId"];
  readonly count: number;
}
/** What a search needs from one stored item, without its JSON or a decode. */
interface ItemInfo {
  readonly type: OrchestrationV2TurnItem["type"];
  readonly entryId: string;
  readonly runId: OrchestrationV2TurnItem["runId"];
  readonly emptyText: boolean;
}
interface LoadedItem extends ItemInfo {
  readonly payload: string;
}
interface ItemFacts extends ItemInfo {
  readonly segments: readonly string[];
  /** A question card's answer, which hides the user message with this entry id in the same run. */
  readonly foldsEntryId: string | undefined;
  /** A tool result the timeline embeds in place of its run's empty reply. */
  readonly embedsResult: boolean;
  readonly chars: number;
}
/** Parsed items of one thread at one revision; items keep their facts until an event names them. */
interface Corpus {
  readonly sequence: number;
  readonly sourceThreadIds: readonly ThreadId[];
  readonly index: readonly IndexRow[];
  readonly facts: ReadonlyMap<string, ItemFacts>;
  readonly chars: number;
}
interface CompletedScan {
  readonly sequence: number;
  readonly sourceThreadIds: readonly ThreadId[];
  readonly documents: readonly FindDocument[];
  readonly counts: WeakMap<ItemFacts, number>;
}

const SEARCHED_TYPES: ReadonlySet<OrchestrationV2TurnItem["type"]> = new Set([
  "user_message",
  "assistant_message",
  "proposed_plan",
  "user_input_request",
]);
// These write no turn item, run, attempt or fork field, so the timeline index survives them.
const INDEX_NEUTRAL_EVENTS: ReadonlySet<string> = new Set([
  "node.updated",
  "provider-turn.updated",
  "provider-thread.updated",
  "provider-session.updated",
  "provider-session.attached",
  "provider-session.detached",
  "message.updated",
  "checkpoint.captured",
  "checkpoint-scope.created",
  "plan.updated",
  "runtime-request.updated",
  "subagent.updated",
  "thread.visit-recorded",
  "thread.visited",
  "thread.marked-unread",
]);
// Least recently searched first. Parsed text is about the size of the thread's messages.
const CORPUS_LIMIT = 8;
const CORPUS_CHAR_BUDGET = 32 * 1024 * 1024;
const SCAN_LIMIT = 8;

function parseItem(
  item: OrchestrationV2TurnItem,
  cwd: string | undefined,
  skills: NonNullable<OrchestrationV2SearchThreadInput["skills"]>,
  theme: OrchestrationV2SearchThreadInput["theme"],
): readonly string[] {
  if (item.type === "proposed_plan") return searchablePlanSegments(item.markdown, cwd, theme);
  if (item.type !== "user_message" && item.type !== "assistant_message") return [];
  return (
    searchableMessageSegments(
      {
        role: item.type === "user_message" ? "user" : "assistant",
        text: item.text,
        streaming: item.type === "assistant_message" && item.streaming,
        context:
          item.type === "user_message" && item.context !== undefined
            ? { version: 1, records: [] }
            : undefined,
      },
      cwd,
      skills,
      theme,
    ) ?? []
  );
}

function sameIndexItem(
  cached: IndexRow,
  row: {
    readonly thread_id: string;
    readonly type: string;
    readonly run_id: string | null;
    readonly node_id: string | null;
    readonly ordinal: number;
    readonly input_intent: string | null;
  },
) {
  return (
    cached.visibility !== "synthetic" &&
    cached.sourceThreadId === row.thread_id &&
    cached.item.type === row.type &&
    cached.item.runId === row.run_id &&
    cached.item.nodeId === row.node_id &&
    cached.item.ordinal === row.ordinal &&
    (cached.item.inputIntent ?? null) === row.input_intent
  );
}

function countSegments(segments: readonly string[], query: string) {
  return segments.reduce((sum, text) => sum + countThreadSearchOccurrences(text, query), 0);
}

function selectMatch(
  documents: readonly FindDocument[],
  input: Pick<OrchestrationV2SearchThreadInput, "index" | "start" | "offset">,
) {
  const totalMatches = documents.reduce((sum, doc) => sum + doc.count, 0);
  let requestedIndex = input.index ?? 0;
  if (input.index === undefined && input.start) {
    const startIndex = documents.findIndex((doc) => doc.entryId === input.start?.entryId);
    if (startIndex >= 0) {
      requestedIndex =
        documents.slice(0, startIndex).reduce((sum, doc) => sum + doc.count, 0) +
        Math.min(input.start.occurrence, documents[startIndex]!.count);
      if (requestedIndex >= totalMatches) requestedIndex = 0;
    }
  }
  const activeIndex =
    input.index === undefined && totalMatches > 0
      ? (((requestedIndex + (input.offset ?? 0)) % totalMatches) + totalMatches) % totalMatches
      : Math.min(requestedIndex, Math.max(0, totalMatches - 1));
  let occurrence = activeIndex;
  for (const document of documents) {
    if (occurrence < document.count) return { totalMatches, activeIndex, document, occurrence };
    occurrence -= document.count;
  }
  return { totalMatches, activeIndex, document: null, occurrence: 0 };
}

function resultForSelection(
  selected: ReturnType<typeof selectMatch>,
  documents: readonly FindDocument[],
  snapshotSequence: number,
): OrchestrationV2SearchThreadResult {
  let startIndex = 0;
  const entries = documents.flatMap(({ entryId, runId, count }) => {
    const entry = { entryId, runId, count, startIndex };
    startIndex += count;
    return count > 0 ? [entry] : [];
  });
  const selectedEntry = entries.findIndex((entry) => entry.entryId === selected.document?.entryId);
  const navigation =
    entries.length <= 17
      ? entries
      : Array.from(
          { length: 17 },
          (_, i) => entries[(selectedEntry + i - 8 + entries.length) % entries.length]!,
        );
  return {
    snapshotSequence,
    totalMatches: selected.totalMatches,
    activeIndex: selected.activeIndex,
    navigation,
    match:
      selected.document === null
        ? null
        : {
            entryId: selected.document.entryId,
            runId: selected.document.runId,
            occurrence: selected.occurrence,
          },
  };
}

export const makeThreadFind = Effect.fn("makeThreadFind")(function* (
  readIndex: (threadId: ThreadId) => Effect.Effect<readonly IndexRow[], ProjectionStoreV2Error>,
  corpusCharBudget = CORPUS_CHAR_BUDGET,
) {
  const sql = yield* SqlClient.SqlClient;
  const encodeCorpusKey = Schema.encodeEffect(
    Schema.fromJsonString(
      Schema.Struct({
        threadId: ThreadId,
        cwd: Schema.optional(Schema.String),
        skills: OrchestrationV2SearchThreadInput.fields.skills,
        theme: OrchestrationV2SearchThreadInput.fields.theme,
      }),
    ),
  );
  const encodeStrings = Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)));
  const decodeItem = Schema.decodeUnknownEffect(Schema.fromJsonString(OrchestrationV2TurnItemJson));
  const isSnapshotError = Schema.is(
    Schema.Union([ProjectionStoreReadError, ProjectionStoreThreadNotFoundError]),
  );
  const corpora = new Map<string, Corpus>();
  const scans = new Map<string, CompletedScan>();

  const sourceThreads = (sources: string) => sql`
    WITH RECURSIVE source_threads(thread_id) AS (
      SELECT value FROM json_each(${sources})
      UNION
      SELECT json_extract(t.payload_json, '$.forkedFrom.threadId')
      FROM orchestration_v2_projection_threads t
      JOIN source_threads s ON s.thread_id = t.thread_id
      WHERE json_extract(t.payload_json, '$.forkedFrom.type') = 'run'
    )`;
  const readRevision = Effect.fn("ThreadFind.readRevision")(function* (
    threadIds: readonly ThreadId[],
  ) {
    const revision = yield* sql<{ sequence: number }>`
      ${sourceThreads(yield* encodeStrings(threadIds))}
      SELECT COALESCE(MAX(sequence), 0) AS sequence FROM orchestration_events
      -- The planner otherwise walks every V2 event backwards from the newest,
      -- which takes seconds for a thread that has been idle a long time.
      INDEXED BY idx_orch_events_stream_sequence
      WHERE application_event_version = 2 AND aggregate_kind = 'thread'
        AND stream_id IN (SELECT thread_id FROM source_threads)
    `;
    return revision[0]?.sequence ?? 0;
  });
  /** The events committed after a corpus was read: turn items they name, and whether any can move the index. */
  const readChanges = Effect.fn("ThreadFind.readChanges")(function* (
    corpus: Corpus,
    through: number,
  ) {
    const events = yield* sql<{ event_type: string; item_id: string | null }>`
      ${sourceThreads(yield* encodeStrings(corpus.sourceThreadIds))}
      SELECT event_type,
        CASE WHEN event_type = 'turn-item.updated' THEN json_extract(payload_json, '$.id') END AS item_id
      FROM orchestration_events
      INDEXED BY idx_orch_events_stream_sequence
      WHERE application_event_version = 2 AND aggregate_kind = 'thread'
        AND stream_id IN (SELECT thread_id FROM source_threads)
        AND sequence > ${corpus.sequence} AND sequence <= ${through}
    `;
    const itemIds = new Set<string>();
    let moved = false;
    for (const event of events) {
      if (event.event_type !== "turn-item.updated") {
        moved ||= !INDEX_NEUTRAL_EVENTS.has(event.event_type);
      } else if (event.item_id === null) {
        return null;
      } else {
        itemIds.add(event.item_id);
      }
    }
    if (moved || itemIds.size === 0) return { itemIds, moved };
    // A changed item keeps its index row only when every field the index orders or filters by is unchanged.
    const indexed = new Map(corpus.index.map((row) => [row.sourceItemId, row]));
    const rows = yield* sql<{
      turn_item_id: string;
      thread_id: string;
      type: string;
      run_id: string | null;
      node_id: string | null;
      ordinal: number;
      input_intent: string | null;
    }>`
      SELECT turn_item_id, thread_id, type, run_id, node_id, ordinal,
        CASE WHEN type = 'user_message' THEN json_extract(payload_json, '$.inputIntent') END AS input_intent
      FROM orchestration_v2_projection_turn_items
      WHERE turn_item_id IN (SELECT value FROM json_each(${yield* encodeStrings([...itemIds])}))
    `;
    moved =
      rows.length !== itemIds.size ||
      rows.some((row) => {
        const cached = indexed.get(row.turn_item_id);
        return cached === undefined || !sameIndexItem(cached, row);
      });
    return { itemIds, moved };
  });
  const load = Effect.fn("ThreadFind.load")(function* (threadId: ThreadId, ids: readonly string[]) {
    const loaded = new Map<string, LoadedItem>();
    for (let start = 0; start < ids.length; start += 512) {
      const batch = ids.slice(start, start + 512);
      const rows = yield* sql<{
        turn_item_id: string;
        payload_json: string;
        entry_id: string;
        run_id: OrchestrationV2TurnItem["runId"];
        item_type: OrchestrationV2TurnItem["type"];
        empty_text: number | null;
      }>`
        SELECT turn_item_id, payload_json,
          COALESCE(json_extract(payload_json, '$.messageId'), turn_item_id) AS entry_id,
          json_extract(payload_json, '$.runId') AS run_id,
          json_extract(payload_json, '$.type') AS item_type,
          json_extract(payload_json, '$.text') = '' AS empty_text
        FROM orchestration_v2_projection_turn_items
        WHERE turn_item_id IN (SELECT value FROM json_each(${yield* encodeStrings(batch)}))
      `;
      for (const row of rows) {
        loaded.set(row.turn_item_id, {
          payload: row.payload_json,
          entryId: row.entry_id,
          runId: row.run_id,
          type: row.item_type,
          emptyText: row.empty_text === 1,
        });
      }
      if (rows.length !== batch.length) return yield* new ProjectionStoreReadError({ threadId });
    }
    return loaded;
  });

  const snapshot = Effect.fn("ThreadFind.snapshot")(
    function* (input: OrchestrationV2SearchThreadInput) {
      const { threadId, theme } = input;
      const active = yield* sql<{ cwd: string | null }>`
      SELECT COALESCE(json_extract(t.payload_json, '$.worktreePath'), p.workspace_root) AS cwd
      FROM orchestration_v2_projection_threads t JOIN projection_projects p ON p.project_id = t.project_id
      WHERE t.thread_id = ${threadId} AND t.deleted_at IS NULL AND p.deleted_at IS NULL
    `;
      if (!active[0]) return yield* new ProjectionStoreThreadNotFoundError({ threadId });
      const cwd = active[0].cwd ?? undefined;
      const skills = input.skills ?? [];
      const corpusKey = yield* encodeCorpusKey({
        threadId,
        cwd,
        skills,
        ...(theme === undefined ? {} : { theme }),
      });
      const scanKey = `${corpusKey}\u0000${input.query}`;
      const scan = scans.get(scanKey);
      if (scan && scan.sequence === (yield* readRevision(scan.sourceThreadIds))) {
        scans.delete(scanKey);
        scans.set(scanKey, scan);
        const selected = selectMatch(scan.documents, input);
        return { result: resultForSelection(selected, scan.documents, scan.sequence) };
      }

      const cached = corpora.get(corpusKey);
      // A corpus older than the prune boundary cannot see the edits pruning removed.
      const prunedThrough =
        cached === undefined
          ? 0
          : ((yield* sql<{ last_sequence: number }>`
              SELECT last_sequence FROM orchestration_v2_projection_metadata
              WHERE projection_name = ${EVENT_LOG_PRUNED_THROUGH}
            `)[0]?.last_sequence ?? 0);
      const previous =
        cached !== undefined && cached.sequence >= prunedThrough ? cached : undefined;
      let sequence = previous === undefined ? 0 : yield* readRevision(previous.sourceThreadIds);
      const changes =
        previous === undefined
          ? null
          : sequence === previous.sequence
            ? { itemIds: new Set<string>(), moved: false }
            : yield* readChanges(previous, sequence);
      let index: readonly IndexRow[];
      let sourceThreadIds: readonly ThreadId[];
      if (previous !== undefined && changes !== null && !changes.moved) {
        ({ index, sourceThreadIds } = previous);
      } else {
        index = yield* readIndex(threadId);
        sourceThreadIds = [...new Set([threadId, ...index.map((row) => row.sourceThreadId)])];
        sequence = yield* readRevision(sourceThreadIds);
      }
      const facts = new Map<string, ItemFacts>();
      if (previous !== undefined && changes !== null) {
        for (const row of index) {
          const cached = previous.facts.get(row.sourceItemId);
          if (cached !== undefined && !changes.itemIds.has(row.sourceItemId))
            facts.set(row.sourceItemId, cached);
        }
      }
      const searched = index.flatMap((row, position) =>
        SEARCHED_TYPES.has(row.item.type) ? [{ ...row, position }] : [],
      );
      const loaded = yield* load(
        threadId,
        searched.flatMap((row) => (facts.has(row.sourceItemId) ? [] : [row.sourceItemId])),
      );
      const info = (id: string): ItemInfo => loaded.get(id) ?? facts.get(id)!;
      // Only runs with an empty reply can hide its fallback, so other tool payloads stay unread.
      const emptyReplyRunIds = new Set(
        searched.flatMap(({ sourceItemId }) => {
          const row = info(sourceItemId);
          return row.type === "assistant_message" && row.emptyText && row.runId !== null
            ? [row.runId]
            : [];
        }),
      );
      const tools = index.filter(
        (row) =>
          row.item.type === "dynamic_tool" &&
          row.item.runId !== null &&
          emptyReplyRunIds.has(row.item.runId),
      );
      const loadedTools = yield* load(
        threadId,
        tools.flatMap((row) => (facts.has(row.sourceItemId) ? [] : [row.sourceItemId])),
      );
      for (const [id, row] of loadedTools) loaded.set(id, row);
      return { searched, tools, facts, loaded, cwd, sequence, sourceThreadIds, index, corpusKey };
    },
    (effect) => sql.withTransaction(effect).pipe(NodeSqliteClient.readOnly),
    (effect, input) =>
      effect.pipe(
        Effect.mapError((cause) =>
          isSnapshotError(cause)
            ? cause
            : new ProjectionStoreReadError({ threadId: input.threadId, cause }),
        ),
      ),
  );

  const remember = (corpusKey: string, corpus: Corpus) => {
    const current = corpora.get(corpusKey);
    if (current !== undefined && current.sequence > corpus.sequence) return;
    corpora.delete(corpusKey);
    if (corpus.chars > corpusCharBudget) return;
    corpora.set(corpusKey, corpus);
    let chars = 0;
    for (const entry of corpora.values()) chars += entry.chars;
    for (const [key, entry] of corpora) {
      if (key === corpusKey || (corpora.size <= CORPUS_LIMIT && chars <= corpusCharBudget)) break;
      corpora.delete(key);
      chars -= entry.chars;
    }
  };

  const searchThreadStream = (input: OrchestrationV2SearchThreadInput) =>
    Stream.unwrap(
      Effect.gen(function* () {
        // Release SQLite before decoding and parsing. Both frames describe one snapshot.
        const data = yield* snapshot(input);
        if (data.result) return Stream.succeed(data.result);
        const { searched, tools, facts, loaded, cwd, sequence, sourceThreadIds, index } = data;
        const skills = input.skills ?? [];
        const info = (id: string): ItemInfo => loaded.get(id) ?? facts.get(id)!;
        const factsFor = Effect.fnUntraced(function* (id: string) {
          const cached = facts.get(id);
          if (cached !== undefined) return cached;
          const row = loaded.get(id)!;
          const item = yield* decodeItem(row.payload).pipe(
            Effect.mapError(
              (cause) => new ProjectionStoreReadError({ threadId: input.threadId, cause }),
            ),
          );
          const segments = parseItem(item, cwd, skills, input.theme);
          const next: ItemFacts = {
            type: row.type,
            entryId: row.entryId,
            runId: row.runId,
            emptyText: row.emptyText,
            segments,
            foldsEntryId:
              item.type === "user_input_request" && item.questionAnswer
                ? `async-answer:${item.questionAnswer.requestId}`
                : undefined,
            embedsResult:
              item.type === "dynamic_tool" &&
              Boolean(
                (item.status === "completed" && htmlRenderFromToolItem(item)) ||
                mcpAppFromToolItem(item),
              ),
            chars: segments.reduce((sum, text) => sum + text.length, 0),
          };
          facts.set(id, next);
          return next;
        });
        // Answers rendered inside question cards must not appear as separate matches.
        const foldedAnswerRunIds = new Map<string, OrchestrationV2TurnItem["runId"]>();
        for (const row of searched) {
          if (row.item.type !== "user_input_request") continue;
          const item = yield* factsFor(row.sourceItemId);
          if (item.foldsEntryId !== undefined)
            foldedAnswerRunIds.set(item.foldsEntryId, item.runId);
        }
        // The timeline hides an empty reply's fallback when its run shows an HTML render or MCP app.
        const embeddedResultRunIds = new Set<OrchestrationV2TurnItem["runId"]>();
        for (const row of tools) {
          const item = yield* factsFor(row.sourceItemId);
          if (item.embedsResult) embeddedResultRunIds.add(item.runId);
        }
        const rows = searched.filter(({ sourceItemId }) => {
          const row = info(sourceItemId);
          return (
            row.type !== "user_input_request" &&
            !(row.type === "user_message" && foldedAnswerRunIds.get(row.entryId) === row.runId)
          );
        });
        const scanKey = `${data.corpusKey}\u0000${input.query}`;
        const counts = scans.get(scanKey)?.counts ?? new WeakMap<ItemFacts, number>();
        const documents = new Map<number, FindDocument>();
        const count = Effect.fnUntraced(function* (row: (typeof rows)[number]) {
          const cached = documents.get(row.position);
          if (cached) return cached;
          const fresh = !facts.has(row.sourceItemId);
          const item = yield* factsFor(row.sourceItemId);
          let occurrences = counts.get(item);
          if (occurrences === undefined) {
            occurrences = countSegments(item.segments, input.query);
            counts.set(item, occurrences);
          }
          const document: FindDocument = {
            position: row.position,
            entryId: item.entryId,
            runId: item.runId,
            count:
              item.type === "assistant_message" &&
              item.emptyText &&
              embeddedResultRunIds.has(item.runId)
                ? 0
                : occurrences,
          };
          documents.set(row.position, document);
          if (fresh) yield* Effect.yieldNow;
          return document;
        });
        const finish = Effect.gen(function* () {
          for (const row of rows) yield* count(row);
          for (const id of loaded.keys()) yield* factsFor(id);
          let chars = 0;
          for (const item of facts.values()) chars += item.chars;
          remember(data.corpusKey, { sequence, sourceThreadIds, index, facts, chars });
          const ordered = rows.map((row) => documents.get(row.position)!);
          scans.delete(scanKey);
          scans.set(scanKey, { sequence, documents: ordered, sourceThreadIds, counts });
          if (scans.size > SCAN_LIMIT) {
            const oldest = scans.keys().next().value;
            if (oldest !== undefined) scans.delete(oldest);
          }
          return resultForSelection(selectMatch(ordered, input), ordered, sequence);
        });
        if (input.index !== undefined || (input.offset ?? 0) !== 0)
          return Stream.fromEffect(finish);
        const anchor = Math.max(
          0,
          rows.findIndex((row) => info(row.sourceItemId).entryId === input.start?.entryId),
        );
        for (let step = 0; step <= rows.length; step++) {
          const index = (anchor + step) % rows.length;
          const row = rows[index];
          if (!row) break;
          const document = yield* count(row);
          const occurrence =
            step === 0 && document.entryId === input.start?.entryId
              ? Math.min(input.start.occurrence, document.count)
              : 0;
          if (occurrence >= document.count) continue;
          const first: OrchestrationV2SearchThreadResult = {
            complete: false,
            snapshotSequence: sequence,
            totalMatches: 1,
            activeIndex: 0,
            match: { entryId: document.entryId, runId: document.runId, occurrence },
          };
          return Stream.concat(Stream.succeed(first), Stream.fromEffect(finish));
        }
        return Stream.fromEffect(finish);
      }),
    );
  return {
    searchThreadStream,
    searchThread: (input: OrchestrationV2SearchThreadInput) =>
      searchThreadStream(input).pipe(
        Stream.runCollect,
        Effect.map((results) => results[results.length - 1]!),
      ),
  };
});
