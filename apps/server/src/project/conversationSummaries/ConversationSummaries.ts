import {
  ConversationSummary,
  ConversationSummaryError,
  ConversationSummaryPass,
  CONVERSATION_SUMMARY_MAX_SOURCES,
  type ConversationSummaryDescribeInput,
  type ConversationSummaryExpandInput,
  type ConversationSummaryExpansion,
  type ConversationSummaryList,
  type ConversationSummaryListInput,
  type ConversationSummaryRead,
  type ConversationSummaryStatement,
  type KnowledgeMessageRef,
  type MessageId,
  type OrchestrationV2ConversationMessage,
  type ProjectId,
  type RunId,
  type ThreadId,
  type TurnItemId,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
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

// The newest messages stay out of summaries: handoffs replay them verbatim.
const FRESH_TAIL_MESSAGES = 6;
// A pass waits until an open stretch is worth a model call.
const MIN_LEAF_MESSAGES = 8;
const MAX_MESSAGE_CHARS = 6_000;
const MAX_PROMPT_CHARS = 32_000;
// Bounds the cost of opting in on a long thread; later passes continue where this one stopped.
const MAX_LEAVES_PER_PASS = 3;
const MAX_STATEMENTS = 8;
const MAX_STATEMENT_CHARS = 600;
const MAX_CITATIONS = 8;
// Bound each read, not the thread's total coverage. Long threads must keep making progress.
const THREAD_SUMMARY_PAGE_SIZE = 500;
const HANDOFF_CANDIDATE_LIMIT = 40;
const CLEANUP_LIMIT = 100;

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

type FinalizedMessage = OrchestrationV2ConversationMessage & {
  readonly role: "user" | "assistant";
};
type SummarySources = Pick<ConversationSummary, "id" | "sources">;

const byConversationOrder = (left: FinalizedMessage, right: FinalizedMessage) =>
  DateTime.toEpochMillis(left.createdAt) - DateTime.toEpochMillis(right.createdAt) ||
  left.id.localeCompare(right.id);

/**
 * Consecutive open stretches of settled messages, cut into chunks a single model call can
 * summarize. A chunk that is cut short ends on a reply so an exchange stays together.
 */
function planLeafChunks(input: {
  readonly settled: ReadonlyArray<FinalizedMessage>;
  readonly covered: ReadonlySet<string>;
}): ReadonlyArray<ReadonlyArray<FinalizedMessage>> {
  const chunks: Array<ReadonlyArray<FinalizedMessage>> = [];
  let index = 0;
  while (index < input.settled.length) {
    if (input.covered.has(input.settled[index]!.id)) {
      index += 1;
      continue;
    }
    let end = index;
    while (end < input.settled.length && !input.covered.has(input.settled[end]!.id)) end += 1;
    // A stretch with covered messages after it is closed: it can never grow, so any size counts.
    const closed = end < input.settled.length;
    let start = index;
    while (start < end) {
      const chunk: Array<FinalizedMessage> = [];
      let chars = 0;
      for (let cursor = start; cursor < end; cursor++) {
        const message = input.settled[cursor]!;
        const cost = Math.min(message.text.length, MAX_MESSAGE_CHARS);
        if (
          chunk.length >= CONVERSATION_SUMMARY_MAX_SOURCES ||
          (chunk.length > 0 && chars + cost > MAX_PROMPT_CHARS)
        )
          break;
        chunk.push(message);
        chars += cost;
      }
      const cut = start + chunk.length < end;
      const lastReply = chunk.findLastIndex((message) => message.role === "assistant");
      const kept = cut && lastReply > 0 ? chunk.slice(0, lastReply + 1) : chunk;
      if (kept.length < MIN_LEAF_MESSAGES && !cut && !closed) break;
      chunks.push(kept);
      start += kept.length;
    }
    index = end;
  }
  return chunks;
}

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
      messageIds?: ReadonlyArray<string>,
    ) {
      const selectedMessages = messageIds === undefined ? undefined : encodeIds(messageIds);
      let after: { readonly first_source_at: string; readonly summary_id: string } | undefined;
      while (true) {
        const rows = yield* sql<{
          readonly first_source_at: string;
          readonly summary_id: string;
          readonly sources_json: string;
        }>`
          SELECT first_source_at, summary_id,
            json_extract(payload_json, '$.sources') AS sources_json
          FROM conversation_summaries
          WHERE project_id = ${projectId} AND thread_id = ${threadId}
          ${
            after === undefined
              ? sql``
              : sql`AND (first_source_at > ${after.first_source_at}
                  OR (first_source_at = ${after.first_source_at} AND summary_id > ${after.summary_id}))`
          }
          ${
            selectedMessages === undefined
              ? sql``
              : sql`AND NOT EXISTS (
                  SELECT 1 FROM json_each(payload_json, '$.sources') AS source
                  WHERE json_extract(source.value, '$.messageId') NOT IN (
                    SELECT value FROM json_each(${selectedMessages})
                  )
                )`
          }
          ORDER BY first_source_at, summary_id
          LIMIT ${THREAD_SUMMARY_PAGE_SIZE}
        `;
        if (rows.length === 0) return;
        const page = yield* Effect.forEach(rows, (row) =>
          decodeSources(row.sources_json).pipe(
            Effect.map((sources) => ({ id: row.summary_id, sources })),
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

  // The same canonical check citations use: thread scope, deletion, archive, streaming, digest.
  const read = Effect.fn("ConversationSummaries.read")(function* (summary: ConversationSummary) {
    const current = yield* knowledge.readSources({
      projectId: summary.projectId,
      threadId: summary.threadId,
      sources: summary.sources,
    });
    const unavailable = current.find((source) => source.state === "unavailable");
    if (unavailable?.state === "unavailable" && unavailable.reason !== "archived") {
      // Handoff references keep the summary skeleton, not text derived from a removed source.
      yield* sql`UPDATE conversation_summaries SET payload_json = ${encodeSummary({
        ...summary,
        statements: [
          {
            text: "[Source unavailable: removed or changed.]",
            citations: [summary.sources[0]!.messageId],
          },
        ],
      })} WHERE summary_id = ${summary.id}`;
    }
    return unavailable?.state === "unavailable"
      ? ({
          state: "stale",
          id: summary.id,
          sourceCount: summary.sources.length,
          createdAt: summary.createdAt,
          reason: unavailable.reason,
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
      let after: { readonly firstSourceAt: string; readonly id: string } | null = null;
      if (input.cursor !== undefined) {
        const cursorRows = yield* sql<{ readonly first_source_at: string }>`
          SELECT first_source_at FROM conversation_summaries
          WHERE project_id = ${input.projectId} AND thread_id = ${input.threadId}
            AND summary_id = ${input.cursor}
        `;
        if (cursorRows[0] === undefined)
          return yield* new ConversationSummaryError({
            reason: "invalid_cursor",
            projectId: input.projectId,
          });
        after = { firstSourceAt: cursorRows[0].first_source_at, id: input.cursor };
      }
      const limit = input.limit ?? 20;
      const rows = yield* sql<{ readonly payload_json: string }>`
        SELECT payload_json FROM conversation_summaries
        WHERE project_id = ${input.projectId} AND thread_id = ${input.threadId}
        ${
          after === null
            ? sql``
            : sql`AND (first_source_at > ${after.firstSourceAt}
                OR (first_source_at = ${after.firstSourceAt} AND summary_id > ${after.id}))`
        }
        ORDER BY first_source_at, summary_id
        LIMIT ${limit + 1}
      `;
      const page = yield* Effect.forEach(rows.slice(0, limit), (row) =>
        decodeSummary(row.payload_json),
      );
      return {
        enabled: resolveProjectSettings(settings, input.projectId).settings
          .enableConversationSummaries,
        lastPass,
        summaries: yield* Effect.forEach(page, read),
        nextCursor: rows.length > limit ? (page.at(-1)?.id ?? null) : null,
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
      if (offset > summary.sources.length)
        return yield* new ConversationSummaryError({
          reason: "invalid_cursor",
          projectId: input.projectId,
        });
      const limit = input.limit ?? CONVERSATION_SUMMARY_MAX_SOURCES;
      const page = summary.sources.slice(offset, offset + limit);
      // Each source is re-read with its recorded digest, so a changed message comes back as
      // unavailable instead of as text the summary was not made from.
      const results = yield* knowledge.readSources({
        projectId: input.projectId,
        threadId: input.threadId,
        sources: page,
      });
      return {
        summary: yield* read(summary),
        sources: page.map((ref, index) => ({ ref, result: results[index]! })),
        nextOffset: offset + page.length < summary.sources.length ? offset + page.length : null,
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
            summary.sources.every((source) => covered.has(source.messageId)) &&
            summary.sources.some((source) => digests.get(source.messageId) !== source.digest),
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
        .getThreadRecords(threadId, ["messages"], { messageRoles: ["user", "assistant"] })
        .pipe(Effect.catchTags({ ProjectionStoreThreadNotFoundError: () => Effect.succeed(null) }));
      if (records === null) return;
      const projectId = records.thread.projectId;
      const digests = new Map<string, string>();
      const covered = new Set<string>();
      let hasStaleSummaries = false;
      const finish = (
        result: ConversationSummaryPass["result"],
        reason: string | null,
        generated: number,
        waitingMessages: number,
      ) =>
        (hasStaleSummaries
          ? cleanupSuperseded(projectId, threadId, digests, covered)
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
        );
      if (records.thread.deletedAt !== null)
        return yield* finish("skipped", "The thread was deleted.", 0, 0);
      if (records.thread.archivedAt !== null)
        return yield* finish("skipped", "The thread is archived.", 0, 0);
      const settings = resolveProjectSettings(
        yield* serverSettings.getSettings,
        projectId,
      ).settings;
      // The setting can change between scheduling and running; the latest choice wins.
      if (!settings.enableConversationSummaries)
        return yield* finish("skipped", "Conversation summaries are off for this project.", 0, 0);
      const project = yield* projects.get(projectId);
      if (Option.isNone(project) || project.value.deletedAt !== null) return;
      const cwd = records.thread.worktreePath ?? project.value.workspaceRoot;

      // Match canonical source eligibility without reloading and rehashing each summary's
      // sources. Deleted/archived threads and non-final messages are excluded above/below.
      const rolledBack = yield* sql<{ readonly message_id: string }>`
        SELECT message.message_id
        FROM orchestration_v2_projection_messages AS message
        JOIN orchestration_v2_projection_runs AS run ON run.run_id = message.run_id
        WHERE message.thread_id = ${threadId} AND run.status = 'rolled_back'
      `;
      const excluded = new Set(rolledBack.map((row) => row.message_id));
      const finalized = records.messages
        .filter(
          (message): message is FinalizedMessage =>
            (message.role === "user" || message.role === "assistant") &&
            !excluded.has(message.id) &&
            !message.streaming &&
            message.text.trim() !== "",
        )
        .toSorted(byConversationOrder);
      for (const message of finalized) digests.set(message.id, yield* digest(message.text));
      // Only summaries whose every source is unchanged count as coverage; a stale range is
      // summarized again from the messages as they are now.
      yield* scanThreadSummarySources(projectId, threadId, (summaries) =>
        Effect.sync(() => {
          for (const summary of summaries) {
            if (
              summary.sources.every((source) => digests.get(source.messageId) === source.digest)
            ) {
              for (const source of summary.sources) covered.add(source.messageId);
            } else {
              hasStaleSummaries = true;
            }
          }
          return true;
        }),
      );
      const settled = finalized.slice(0, Math.max(0, finalized.length - FRESH_TAIL_MESSAGES));
      const waiting = () => settled.filter((message) => !covered.has(message.id)).length;

      let generated = 0;
      for (const chunk of planLeafChunks({ settled, covered }).slice(0, MAX_LEAVES_PER_PASS)) {
        const refs = new Map<string, MessageId>();
        const messages = chunk.map((message, index) => {
          const ref = `M${index + 1}`;
          refs.set(ref, message.id);
          return {
            ref,
            role: message.role,
            text:
              message.text.length > MAX_MESSAGE_CHARS
                ? `${message.text.slice(0, MAX_MESSAGE_CHARS)}\n[truncated]`
                : message.text,
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
        if (!reply.ok)
          return yield* finish("failed", reply.detail.slice(0, 300), generated, waiting());
        // The model only names refs; citations become the message ids read above.
        const statements: Array<ConversationSummaryStatement> = [];
        for (const statement of reply.statements.slice(0, MAX_STATEMENTS)) {
          const text = statement.text.trim().slice(0, MAX_STATEMENT_CHARS).trim();
          const citations = [
            ...new Set(statement.citations.flatMap((ref) => refs.get(ref.trim()) ?? [])),
          ].slice(0, MAX_CITATIONS);
          if (text !== "" && citations.length > 0) statements.push({ text, citations });
        }
        if (statements.length === 0)
          return yield* finish(
            "failed",
            "The model returned no statements citing the summarized messages.",
            generated,
            waiting(),
          );
        const sources: ReadonlyArray<KnowledgeMessageRef> = chunk.map((message) => ({
          kind: "message",
          threadId,
          messageId: message.id,
          digest: digests.get(message.id)!,
        }));
        // A source edited or removed during generation must not be published as covered.
        const current = yield* knowledge.readSources({ projectId, threadId, sources });
        if (current.some((source) => source.state !== "available"))
          return yield* finish(
            "skipped",
            "A message changed while it was being summarized.",
            generated,
            waiting(),
          );
        const id = `summary:${yield* digest(
          [threadId, ...sources.map((source) => `${source.messageId}:${source.digest}`)].join("\n"),
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
            ${id}, ${projectId}, ${threadId},
            ${DateTime.formatIso(chunk[0]!.createdAt)}, ${summary.createdAt},
            ${encodeSummary(summary)}
          )
          ON CONFLICT (summary_id) DO NOTHING
        `;
        for (const message of chunk) covered.add(message.id);
        generated += 1;
      }
      yield* finish(
        generated > 0 ? "ran" : "skipped",
        generated > 0 ? null : "No settled stretch is long enough to summarize yet.",
        generated,
        waiting(),
      );
    },
    (effect, { runId }) =>
      effect.pipe(Effect.mapError((cause) => new ConversationSummaryPassError({ runId, cause }))),
  );

  const renderForHandoff = (summary: ConversationSummary) => {
    const position = new Map(summary.sources.map((source, index) => [source.messageId, index + 1]));
    return [
      `[Conversation summary ${summary.id}: written by a model from ${summary.sources.length} earlier messages of thread ${summary.threadId}. It is a summary, not the original messages.]`,
      `Read the exact messages with t3_conversation_summary_expand({projectId:"${summary.projectId}",threadId:"${summary.threadId}",summaryId:"${summary.id}"}); #n is the nth source it returns.`,
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
        // Look up only the requested item identities, not every command and message body in
        // the thread. json_each avoids SQLite's bind limit for a long omitted-history range.
        const items = yield* sql<{
          readonly itemId: TurnItemId;
          readonly messageId: MessageId;
          readonly runId: RunId | null;
          readonly kind: "user_message" | "assistant_message";
        }>`
          SELECT item.turn_item_id AS "itemId", item.run_id AS "runId", item.type AS kind,
            json_extract(item.payload_json, '$.messageId') AS "messageId"
          FROM json_each(${requestedItems}) AS requested
          JOIN orchestration_v2_projection_turn_items AS item ON item.turn_item_id = requested.value
          WHERE item.thread_id = ${threadId} AND item.type IN ('user_message', 'assistant_message')
        `;
        const itemByMessage = new Map(items.map((item) => [item.messageId, item]));
        if (itemByMessage.size === 0) continue;
        yield* scanThreadSummarySources(
          projectId,
          threadId,
          Effect.fnUntraced(function* (summaries) {
            for (const metadata of summaries) {
              const sourceItems = metadata.sources.flatMap(
                (source) => itemByMessage.get(source.messageId) ?? [],
              );
              if (sourceItems.length !== metadata.sources.length) continue;
              // Decode statement bodies only for summaries covering the handoff's requested
              // messages; source validation still runs immediately before offering any text.
              const summary = yield* findSummary({ projectId, threadId, summaryId: metadata.id });
              // Stale rows must not consume the offer limit and hide later usable summaries.
              if ((yield* read(summary)).state !== "available") continue;
              // Summary input excludes attached knowledge; replay its receipts even when the
              // source messages were omitted before this handoff was prepared.
              const evidence = yield* deliveredKnowledgeForHistory({
                projectId,
                messages: sourceItems.map((item) => ({ ...item, threadId })),
                userItemId: (messageId) => itemByMessage.get(messageId)?.itemId,
              }).pipe(Effect.provideService(ProjectKnowledge.ProjectKnowledge, knowledge));
              offered.push({
                id: summary.id,
                text: [
                  renderForHandoff(summary),
                  ...sourceItems.flatMap((item, index) => {
                    const attached = evidence.get(item.itemId);
                    return attached === undefined
                      ? []
                      : [`[Summary source #${index + 1}; item=${item.itemId}]\n${attached}`];
                  }),
                ].join("\n\n"),
                coveredItemIds: sourceItems.map((item) => item.itemId),
              });
              if (offered.length >= HANDOFF_CANDIDATE_LIMIT) return false;
            }
            return true;
          }),
          [...itemByMessage.keys()],
        );
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
