import type { OrchestrationV2ProjectedTurnItem, OrchestrationV2TurnItem, RunAttemptId } from "@t3tools/contracts";
import { MessageId, ThreadId, TurnItemId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { MCP_APP_OUTPUT_KEY } from "@t3tools/shared/mcpApp";
import { threadHtmlRenderAttachmentIds } from "../../attachmentStore.ts";
export type TimelineIndexItem = Pick<
    OrchestrationV2TurnItem,
    "id" | "threadId" | "runId" | "nodeId" | "parentItemId" | "type" | "status" | "ordinal"
  > & {
    readonly inputIntent?: Extract<
      OrchestrationV2TurnItem,
      { type: "user_message" }
    >["inputIntent"];
    readonly createdBy?: "user" | "agent" | "system";
    readonly messageId?: MessageId;
    readonly runStatus?: string | undefined;
    readonly attemptId?: string | null;
    readonly attemptStatus?: string | null;
    readonly persistentOutput?: boolean;
    readonly deferredWork?: OrchestrationV2TurnItem["deferredWork"];
  };

export type TimelineIndexRow = {
    readonly sourceThreadId: ThreadId;
    readonly sourceItemId: TurnItemId;
    readonly visibility: OrchestrationV2ProjectedTurnItem["visibility"];
    readonly item: TimelineIndexItem;
    readonly synthetic?: OrchestrationV2TurnItem;
  };

import { ORCHESTRATION_V2_PROJECTION_SCHEMA_VERSION, type PayloadRow, type ProjectionStoreV2Shape } from "../ProjectionStorePrelude/ProjectionStoreV2Shape.ts";
import { decodeCheckpointPayload, decodeCheckpointScopePayload, decodeMessagePayload, decodeNodePayload, decodeProviderSessionPayload, decodeProviderThreadPayload, decodeProviderTurnPayload, decodeRows, decodeRunPayload, decodeTurnItemPayload, isProjectionStoreReadError, isProjectionStoreThreadNotFoundError, parseEncodedPayload } from "../ProjectionStorePrelude/BuildVisibleTurnItems.ts";
import { ProjectionStoreReadError, ProjectionStoreThreadNotFoundError, decodeCheckpointContext, decodeRollbackTargetAttempts, type ProjectionCheckpointRollbackContext, type ProjectionRecords } from "../ProjectionStorePrelude/ProjectionSettlementCandidate.ts";
import type { ApplyRecordTailPart } from "./ApplyRecordTail.ts";
import type { ApplyRunTailPart } from "./ApplyRunTail.ts";
import type { RetainedWindowRowsPart } from "./RetainedWindowRows.ts";
import type { ReadCanonicalProjectionPart } from "./ReadCanonicalProjection.ts";
import type { ReadProjectionPart } from "./ReadProjection.ts";
import type { GetUnreadableThreadIdsPart } from "./GetUnreadableThreadIds.ts";
import type { GetRuntimeRecoveryProjectionPart } from "./GetRuntimeRecoveryProjection.ts";

type Deps = Record<never, never> & ApplyRecordTailPart & ApplyRunTailPart & RetainedWindowRowsPart & ReadCanonicalProjectionPart & ReadProjectionPart & GetUnreadableThreadIdsPart & GetRuntimeRecoveryProjectionPart;

export const installGetCheckpointRollbackContext = Effect.fnUntraced(function* (deps: Deps) {
  const { controlReadError, getRuntimeRequest, getThread, getThreadProjection, readCanonicalProjection, requireThread, sql } = deps;

const getThreadProviderContext: ProjectionStoreV2Shape["getThreadProviderContext"] = (
    threadId,
    targetInstanceId,
  ) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const thread = yield* getThread(threadId);
          const sessionRows = yield* sql<PayloadRow>`
        SELECT session.payload_json FROM orchestration_v2_projection_provider_sessions AS session
        JOIN orchestration_v2_projection_provider_session_bindings AS binding
          ON binding.provider_session_id = session.provider_session_id
        WHERE binding.thread_id = ${threadId}
        ORDER BY session.updated_at ASC, session.provider_session_id ASC
      `;
          const threadRows =
            targetInstanceId === undefined
              ? []
              : yield* sql<PayloadRow>`
        SELECT payload_json FROM orchestration_v2_projection_provider_threads
        WHERE provider_thread_id = ${thread.activeProviderThreadId}
           OR provider_thread_id = (
             SELECT provider_thread_id FROM orchestration_v2_projection_provider_threads
             WHERE thread_id = ${threadId} AND owner_node_id IS NULL
               AND provider_instance_id = ${targetInstanceId}
             ORDER BY updated_at DESC, provider_thread_id ASC LIMIT 1
           )
        ORDER BY updated_at ASC, provider_thread_id ASC
      `;
          return {
            thread,
            providerSessions: yield* decodeRows(
              decodeProviderSessionPayload,
              threadId,
            )(sessionRows),
            providerThreads: yield* decodeRows(decodeProviderThreadPayload, threadId)(threadRows),
          };
        }),
      )
      .pipe(Effect.mapError(controlReadError(threadId)));

const getRuntimeResponseContext: ProjectionStoreV2Shape["getRuntimeResponseContext"] = (
    threadId,
    requestId,
  ) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          yield* requireThread(threadId);
          const request = yield* getRuntimeRequest(threadId, requestId);
          if (request === undefined)
            return { request, node: undefined, item: undefined, session: undefined };
          const nodeRows =
            yield* sql<PayloadRow>`SELECT payload_json FROM orchestration_v2_projection_nodes
        WHERE thread_id = ${threadId} AND node_id = ${request.nodeId}`;
          const itemRows =
            yield* sql<PayloadRow>`SELECT payload_json FROM orchestration_v2_projection_turn_items
        WHERE thread_id = ${threadId} AND node_id = ${request.nodeId} AND type IN ('approval_request', 'user_input_request')
          AND json_extract(payload_json, '$.requestId') = ${requestId}
        ORDER BY ordinal ASC LIMIT 1`;
          const sessionRows =
            request.responseCapability.type !== "live"
              ? []
              : yield* sql<PayloadRow>`
        SELECT session.payload_json FROM orchestration_v2_projection_provider_sessions AS session
        JOIN orchestration_v2_projection_provider_session_bindings AS binding
          ON binding.provider_session_id = session.provider_session_id
        WHERE binding.thread_id = ${threadId} AND session.provider_session_id = ${request.responseCapability.providerSessionId}`;
          return {
            request,
            node:
              nodeRows[0] === undefined
                ? undefined
                : yield* decodeNodePayload(nodeRows[0].payload_json),
            item:
              itemRows[0] === undefined
                ? undefined
                : yield* decodeTurnItemPayload(itemRows[0].payload_json),
            session:
              sessionRows[0] === undefined
                ? undefined
                : yield* decodeProviderSessionPayload(sessionRows[0].payload_json),
          };
        }),
      )
      .pipe(Effect.mapError(controlReadError(threadId)));

const getCheckpointContext: ProjectionStoreV2Shape["getCheckpointContext"] = (threadId) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const threads = yield* sql<{ readonly thread_id: string }>`
          SELECT thread_id FROM orchestration_v2_projection_threads
          WHERE thread_id = ${threadId} LIMIT 1
        `;
          if (threads.length === 0) {
            return yield* new ProjectionStoreThreadNotFoundError({ threadId });
          }
          // Select checkpoint metadata only; diffs need neither transcripts nor large run/checkpoint JSON.
          const [runs, checkpointScopes, checkpoints] = yield* Effect.all([
            sql`
            SELECT run_id AS id, ordinal, status
            FROM orchestration_v2_projection_runs
            WHERE thread_id = ${threadId}
            ORDER BY ordinal ASC
          `,
            sql`
            SELECT scope_id AS id, run_id AS "runId", kind,
              json_extract(payload_json, '$.cwd') AS cwd
            FROM orchestration_v2_projection_checkpoint_scopes
            WHERE thread_id = ${threadId}
            ORDER BY ordinal_within_parent ASC, scope_id ASC
          `,
            sql`
            SELECT scope_id AS "scopeId", run_id AS "runId",
              ordinal_within_scope AS "ordinalWithinScope",
              app_run_ordinal AS "appRunOrdinal", status,
              json_extract(payload_json, '$.ref') AS ref
            FROM orchestration_v2_projection_checkpoints
            WHERE thread_id = ${threadId}
            ORDER BY scope_id ASC, ordinal_within_scope ASC
          `,
          ]);
          return yield* decodeCheckpointContext({ runs, checkpointScopes, checkpoints });
        }),
      )
      .pipe(
        Effect.mapError((cause) =>
          isProjectionStoreThreadNotFoundError(cause)
            ? cause
            : new ProjectionStoreReadError({ threadId, cause }),
        ),
      );

const getCheckpointCaptureContext: ProjectionStoreV2Shape["getCheckpointCaptureContext"] = (
    threadId,
    target,
  ) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const threadRows = yield* sql<{ readonly side_chat: number | null }>`
        SELECT json_extract(payload_json, '$.lineage.sideChat') AS side_chat
        FROM orchestration_v2_projection_threads WHERE thread_id = ${threadId} LIMIT 1`;
          if (threadRows[0] === undefined) {
            return yield* new ProjectionStoreThreadNotFoundError({ threadId });
          }
          const runRows = yield* sql<PayloadRow>`
        SELECT payload_json FROM orchestration_v2_projection_runs
        WHERE thread_id = ${threadId} AND run_id = ${target.runId}`;
          const run =
            runRows[0] === undefined
              ? undefined
              : yield* decodeRunPayload(runRows[0].payload_json);
          const [nodeRows, scopeRows, providerRows, readyRows] = yield* Effect.all([
            sql<PayloadRow>`SELECT payload_json FROM orchestration_v2_projection_nodes
          WHERE thread_id = ${threadId} AND node_id = ${run?.rootNodeId ?? null}`,
            sql<PayloadRow>`SELECT payload_json FROM orchestration_v2_projection_checkpoint_scopes
          WHERE thread_id = ${threadId} AND scope_id = ${target.scopeId}`,
            sql<PayloadRow>`SELECT payload_json FROM orchestration_v2_projection_provider_threads
          WHERE provider_thread_id = ${run?.providerThreadId ?? null}
            AND (thread_id = ${threadId}
              OR owner_node_id IN (SELECT node_id FROM orchestration_v2_projection_nodes WHERE thread_id = ${threadId})
              OR provider_thread_id IN (SELECT provider_thread_id FROM orchestration_v2_projection_subagents WHERE thread_id = ${threadId}))`,
            sql<{ readonly ordinal: number }>`SELECT ordinal_within_scope AS ordinal
          FROM orchestration_v2_projection_checkpoints
          WHERE thread_id = ${threadId} AND scope_id = ${target.scopeId} AND status = 'ready'`,
          ]);
          return {
            run,
            rootNode:
              nodeRows[0] === undefined
                ? undefined
                : yield* decodeNodePayload(nodeRows[0].payload_json),
            scope:
              scopeRows[0] === undefined
                ? undefined
                : yield* decodeCheckpointScopePayload(scopeRows[0].payload_json),
            providerThread:
              providerRows[0] === undefined
                ? undefined
                : yield* decodeProviderThreadPayload(providerRows[0].payload_json),
            readyCheckpointOrdinals: readyRows.map(({ ordinal }) => ordinal),
            sideChat: threadRows[0].side_chat === 1,
          };
        }),
      )
      .pipe(Effect.mapError(controlReadError(threadId)));

const getCheckpointRollbackContext: ProjectionStoreV2Shape["getCheckpointRollbackContext"] = (
    threadId,
    target,
  ) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const thread = yield* getThread(threadId);
          const [providerRows, checkpointRows, scopeRows] = yield* Effect.all([
            sql<PayloadRow>`SELECT payload_json FROM orchestration_v2_projection_provider_threads
          WHERE provider_thread_id = ${target.providerThreadId}
            AND (thread_id = ${threadId}
              OR owner_node_id IN (SELECT node_id FROM orchestration_v2_projection_nodes WHERE thread_id = ${threadId})
              OR provider_thread_id IN (SELECT provider_thread_id FROM orchestration_v2_projection_subagents WHERE thread_id = ${threadId}))`,
            sql<PayloadRow>`SELECT payload_json FROM orchestration_v2_projection_checkpoints
          WHERE thread_id = ${threadId} AND checkpoint_id = ${target.checkpointId}`,
            sql<PayloadRow>`SELECT payload_json FROM orchestration_v2_projection_checkpoint_scopes
          WHERE thread_id = ${threadId} AND scope_id = ${target.scopeId}`,
          ]);
          const providerThread =
            providerRows[0] === undefined
              ? undefined
              : yield* decodeProviderThreadPayload(providerRows[0].payload_json);
          const checkpoint =
            checkpointRows[0] === undefined
              ? undefined
              : yield* decodeCheckpointPayload(checkpointRows[0].payload_json);
          const scope =
            scopeRows[0] === undefined
              ? undefined
              : yield* decodeCheckpointScopePayload(scopeRows[0].payload_json);
          const context: ProjectionCheckpointRollbackContext = {
            thread,
            providerThread,
            checkpoint,
            scope,
            providerSession: undefined,
            targetAttempt: undefined,
            providerTurns: [],
            rolledBackAttemptIds: [],
            runsToRollback: [],
            rootNodes: [],
            staleCheckpoints: [],
          };
          if (
            providerThread === undefined ||
            providerThread.providerSessionId === null ||
            checkpoint === undefined ||
            scope === undefined ||
            checkpoint.scopeId !== scope.id ||
            checkpoint.status !== "ready" ||
            providerThread.id !== thread.activeProviderThreadId ||
            providerThread.providerInstanceId !== thread.modelSelection.instanceId
          )
            return context;

          const targetOrdinal = checkpoint.appRunOrdinal ?? 0;
          const [attemptRows, runRows, sessionRows, rolledBackAttempts, staleRows] =
            yield* Effect.all([
              sql`SELECT attempt.attempt_id AS id, attempt.provider_turn_id AS "providerTurnId"
          FROM orchestration_v2_projection_run_attempts AS attempt
          JOIN orchestration_v2_projection_runs AS run
            ON attempt.attempt_id = json_extract(run.payload_json, '$.activeAttemptId')
          WHERE run.thread_id = ${threadId} AND run.ordinal = ${targetOrdinal}
            AND attempt.thread_id = ${threadId}`,
              sql<PayloadRow>`SELECT payload_json FROM orchestration_v2_projection_runs
          WHERE thread_id = ${threadId} AND ordinal > ${targetOrdinal}
            AND status IN ('completed', 'interrupted', 'failed', 'cancelled')
          ORDER BY ordinal ASC`,
              sql<PayloadRow>`SELECT session.payload_json
          FROM orchestration_v2_projection_provider_sessions AS session
          JOIN orchestration_v2_projection_provider_session_bindings AS binding
            ON binding.provider_session_id = session.provider_session_id
          WHERE binding.thread_id = ${threadId}
            AND session.provider_session_id = ${providerThread.providerSessionId}`,
              sql<{ readonly id: RunAttemptId }>`SELECT attempt.attempt_id AS id
          FROM orchestration_v2_projection_run_attempts AS attempt
          JOIN orchestration_v2_projection_runs AS run ON run.run_id = attempt.run_id
          WHERE run.thread_id = ${threadId} AND run.status = 'rolled_back'
            AND attempt.thread_id = ${threadId}`,
              sql<PayloadRow>`SELECT payload_json FROM orchestration_v2_projection_checkpoints
          WHERE thread_id = ${threadId} AND scope_id = ${scope.id} AND status = 'ready'
            AND app_run_ordinal > ${targetOrdinal}
          ORDER BY ordinal_within_scope ASC`,
            ]);
          const targetAttempt = (yield* decodeRollbackTargetAttempts(attemptRows))[0];
          const runsToRollback = yield* decodeRows(decodeRunPayload, threadId)(runRows);
          const [nodeRows, turnRows] = yield* Effect.all([
            sql<PayloadRow>`SELECT payload_json FROM orchestration_v2_projection_nodes
          WHERE thread_id = ${threadId} AND ${sql.in(
            "node_id",
            runsToRollback.map((run) => run.rootNodeId),
          )}
          ORDER BY node_id ASC`,
            sql<PayloadRow>`SELECT payload_json FROM orchestration_v2_projection_provider_turns
          WHERE thread_id = ${threadId} AND (
            provider_thread_id = ${providerThread.id}
            OR provider_turn_id = ${targetAttempt?.providerTurnId ?? null}
            OR run_attempt_id = ${targetAttempt?.id ?? null})
          ORDER BY provider_thread_id ASC, ordinal ASC`,
          ]);
          return {
            ...context,
            targetAttempt,
            runsToRollback,
            providerSession:
              sessionRows[0] === undefined
                ? undefined
                : yield* decodeProviderSessionPayload(sessionRows[0].payload_json),
            rolledBackAttemptIds: rolledBackAttempts.map(({ id }) => id),
            rootNodes: yield* decodeRows(decodeNodePayload, threadId)(nodeRows),
            providerTurns: yield* decodeRows(decodeProviderTurnPayload, threadId)(turnRows),
            staleCheckpoints: yield* decodeRows(decodeCheckpointPayload, threadId)(staleRows),
          };
        }),
      )
      .pipe(Effect.mapError(controlReadError(threadId)));

const getRunMessage: ProjectionStoreV2Shape["getRunMessage"] = (threadId, runId) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          yield* requireThread(threadId);
          const rows = yield* sql<PayloadRow>`
        SELECT message.payload_json FROM orchestration_v2_projection_messages AS message
        JOIN orchestration_v2_projection_runs AS run
          ON message.message_id = json_extract(run.payload_json, '$.userMessageId')
        WHERE run.thread_id = ${threadId} AND run.run_id = ${runId}
          AND message.thread_id = ${threadId}`;
          return rows[0] === undefined
            ? undefined
            : yield* decodeMessagePayload(rows[0].payload_json);
        }),
      )
      .pipe(Effect.mapError(controlReadError(threadId)));

const canStartQueuedRun: ProjectionStoreV2Shape["canStartQueuedRun"] = (threadId) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          yield* requireThread(threadId);
          const rows = yield* sql<{ readonly ready: number }>`
        SELECT 1 AS ready FROM orchestration_v2_projection_threads AS thread
        WHERE thread.thread_id = ${threadId} AND thread.archived_at IS NULL AND thread.deleted_at IS NULL
          AND EXISTS (SELECT 1 FROM orchestration_v2_projection_runs
            WHERE thread_id = ${threadId} AND status = 'queued'
              AND json_extract(payload_json, '$.queueHeld') IS NOT 1)
          AND NOT EXISTS (SELECT 1 FROM orchestration_v2_projection_runs
            WHERE thread_id = ${threadId}
              AND status IN ('preparing', 'starting', 'running', 'waiting'))`;
          return rows.length > 0;
        }),
      )
      .pipe(Effect.mapError(controlReadError(threadId)));

const getHeldQueuedRuns: ProjectionStoreV2Shape["getHeldQueuedRuns"] = (threadId) =>
    sql<PayloadRow>`
      SELECT payload_json FROM orchestration_v2_projection_runs
      WHERE thread_id = ${threadId} AND status = 'queued'
        AND json_extract(payload_json, '$.queueHeld') IS 1
      ORDER BY ordinal ASC
    `.pipe(
      Effect.flatMap(decodeRows(decodeRunPayload, threadId)),
      Effect.mapError(controlReadError(threadId)),
    );

const getMessageCount: ProjectionStoreV2Shape["getMessageCount"] = (threadId) =>
    sql<{
      count: number;
    }>`SELECT COUNT(*) AS count FROM orchestration_v2_projection_messages WHERE thread_id = ${threadId}`.pipe(
      Effect.map((rows) => rows[0]?.count ?? 0),
      Effect.mapError(controlReadError(threadId)),
    );

const getSubagentCount: ProjectionStoreV2Shape["getSubagentCount"] = (threadId) =>
    sql<{
      count: number;
    }>`SELECT COUNT(*) AS count FROM orchestration_v2_projection_subagents WHERE thread_id = ${threadId}`.pipe(
      Effect.map((rows) => rows[0]?.count ?? 0),
      Effect.mapError(controlReadError(threadId)),
    );

const listAppOwnedChildThreadIds: ProjectionStoreV2Shape["listAppOwnedChildThreadIds"] = (
    threadId,
  ) =>
    sql<{ readonly child_thread_id: string }>`SELECT child_thread_id
      FROM orchestration_v2_projection_subagents
      WHERE thread_id = ${threadId} AND origin = 'app_owned' AND child_thread_id IS NOT NULL
      ORDER BY COALESCE(started_at, ''), subagent_id ASC`.pipe(
      Effect.map((rows) => [...new Set(rows.map((row) => ThreadId.make(row.child_thread_id)))]),
      Effect.mapError(controlReadError(threadId)),
    );

const getNextTurnItemOrdinal: ProjectionStoreV2Shape["getNextTurnItemOrdinal"] = (threadId) =>
    sql<{ ordinal: number | null }>`SELECT MAX(ordinal) AS ordinal
      FROM orchestration_v2_projection_turn_items WHERE thread_id = ${threadId}`.pipe(
      Effect.map((rows) => (rows[0]?.ordinal ?? 0) + 1),
      Effect.mapError(controlReadError(threadId)),
    );

const getTurnItem: ProjectionStoreV2Shape["getTurnItem"] = ({ threadId, itemId }) =>
    sql<{ payload_json: string }>`SELECT payload_json
      FROM orchestration_v2_projection_turn_items
      WHERE turn_item_id = ${itemId} AND thread_id = ${threadId}`.pipe(
      Effect.flatMap((rows) =>
        rows[0] === undefined
          ? Effect.succeed(null)
          : decodeTurnItemPayload(rows[0].payload_json),
      ),
      Effect.mapError(controlReadError(threadId)),
    );

const getThreadAttachmentIds: ProjectionStoreV2Shape["getThreadAttachmentIds"] = (threadId) =>
    Effect.all([
      sql<{ id: string }>`
    SELECT DISTINCT json_extract(attachment.value, '$.id') AS id
    FROM orchestration_v2_projection_messages AS message,
      json_each(message.payload_json, '$.attachments') AS attachment
    WHERE message.thread_id = ${threadId}
  `,
      sql<{ payload_json: string }>`
    SELECT payload_json
    FROM orchestration_v2_projection_turn_items
    WHERE thread_id = ${threadId}
      AND type = 'dynamic_tool'
      AND (payload_json LIKE '%htmlRender%' OR payload_json LIKE ${`%${MCP_APP_OUTPUT_KEY}%`}
        OR payload_json LIKE '%preview_recording_stop%')
  `,
      sql<{ id: string }>`
    SELECT DISTINCT json_extract(attachment.value, '$.id') AS id
    FROM orchestration_v2_projection_turn_items AS item,
      json_each(item.payload_json, '$.questionAnswer.attachmentsByQuestionId') AS question,
      json_each(question.value) AS attachment
    WHERE item.thread_id = ${threadId}
      AND item.type = 'user_input_request'
  `,
      // A guest's waiting files are pending uploads that no message row holds yet.
      sql<{ id: string }>`
    SELECT DISTINCT json_extract(attachment.value, '$.id') AS id
    FROM orchestration_v2_projection_threads AS thread,
      json_each(thread.payload_json, '$.guestShare.messages') AS message,
      json_each(message.value, '$.attachments') AS attachment
    WHERE thread.thread_id = ${threadId}
      AND json_extract(message.value, '$.status') = 'pending'
  `,
    ]).pipe(
      Effect.map(([messages, renders, answerFiles, guestFiles]) => [
        ...new Set([
          ...messages.map((row) => row.id),
          ...guestFiles.map((row) => row.id),
          ...answerFiles.map((row) => row.id),
          ...threadHtmlRenderAttachmentIds(
            threadId,
            renders.map((row) => {
              const item = parseEncodedPayload(row.payload_json);
              return {
                toolName: typeof item.toolName === "string" ? item.toolName : null,
                output: item.output,
              };
            }),
          ),
        ]),
      ]),
      Effect.mapError((cause) => new ProjectionStoreReadError({ threadId, cause })),
    );

const getThreadRecords: ProjectionStoreV2Shape["getThreadRecords"] = (
    threadId,
    fields,
    filter,
  ) =>
    sql.withTransaction(readCanonicalProjection(threadId, undefined, fields, filter)).pipe(
      Effect.map(
        (projection) =>
          Object.fromEntries([
            ["thread", projection.thread],
            ...fields.map((field) => [field, projection[field]]),
          ]) as ProjectionRecords<(typeof fields)[number]>,
      ),
      Effect.mapError(controlReadError(threadId)),
    );

const getThreadSnapshot: ProjectionStoreV2Shape["getThreadSnapshot"] = (threadId) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const projection = yield* getThreadProjection(threadId);
          const rows = yield* sql<{ readonly snapshot_sequence: number | null }>`
          SELECT MAX(sequence) AS snapshot_sequence
          FROM orchestration_events
          WHERE application_event_version = 2
            AND aggregate_kind = 'thread'
            AND stream_id = ${threadId}
        `;
          return {
            schemaVersion: ORCHESTRATION_V2_PROJECTION_SCHEMA_VERSION,
            snapshotSequence: rows[0]?.snapshot_sequence ?? 0,
            projection,
          };
        }),
      )
      .pipe(
        Effect.mapError((cause) =>
          isProjectionStoreThreadNotFoundError(cause) || isProjectionStoreReadError(cause)
            ? cause
            : new ProjectionStoreReadError({ threadId, cause }),
        ),
      );

  return { getThreadProviderContext, getRuntimeResponseContext, getCheckpointContext, getCheckpointCaptureContext, getCheckpointRollbackContext, getRunMessage, canStartQueuedRun, getHeldQueuedRuns, getMessageCount, getSubagentCount, listAppOwnedChildThreadIds, getNextTurnItemOrdinal, getTurnItem, getThreadAttachmentIds, getThreadRecords, getThreadSnapshot };
});

export type GetCheckpointRollbackContextPart = ReturnType<typeof installGetCheckpointRollbackContext> extends Effect.Effect<infer A, infer _E, infer _R> ? A : ReturnType<typeof installGetCheckpointRollbackContext>;
