import type { OrchestrationV2Run } from "@t3tools/contracts";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { type PayloadRow, type ProjectionStoreV2Shape } from "../ProjectionStorePrelude/ProjectionStoreV2Shape.ts";
import { ProjectionStoreReadError, ProjectionStoreThreadNotFoundError, type ProjectionRuntimeRecoveryState } from "../ProjectionStorePrelude/ProjectionSettlementCandidate.ts";
import { decodeMessagePayload, decodeNodePayload, decodePlanJson, decodeProviderSessionPayload, decodeProviderThreadPayload, decodeProviderTurnPayload, decodeRows, decodeRunAttemptPayload, decodeRunPayload, decodeRuntimeRequestPayload, decodeSubagentPayload, decodeThreadPayload, decodeTurnItemPayload, encodeNodePayload, isProjectionStoreThreadNotFoundError } from "../ProjectionStorePrelude/BuildVisibleTurnItems.ts";
import type { ApplyRecordTailPart } from "./ApplyRecordTail.ts";
import type { ApplyRunTailPart } from "./ApplyRunTail.ts";
import type { RetainedWindowRowsPart } from "./RetainedWindowRows.ts";
import type { ReadCanonicalProjectionPart } from "./ReadCanonicalProjection.ts";
import type { ReadProjectionPart } from "./ReadProjection.ts";
import type { GetUnreadableThreadIdsPart } from "./GetUnreadableThreadIds.ts";

type Deps = Record<never, never> & ApplyRecordTailPart & ApplyRunTailPart & RetainedWindowRowsPart & ReadCanonicalProjectionPart & ReadProjectionPart & GetUnreadableThreadIdsPart;

export const installGetRuntimeRecoveryProjection = Effect.fnUntraced(function* (deps: Deps) {
  const { sql } = deps;

const getRuntimeRecoveryProjection: ProjectionStoreV2Shape["getRuntimeRecoveryProjection"] =
    Effect.fn("ProjectionStore.getRuntimeRecoveryProjection")(
      function* (threadId) {
        const threadRows = yield* sql<PayloadRow>`
          SELECT payload_json FROM orchestration_v2_projection_threads
          WHERE thread_id = ${threadId}
        `;
        if (threadRows[0] === undefined) {
          return yield* new ProjectionStoreThreadNotFoundError({ threadId });
        }
        const [
          thread,
          runRows,
          attemptRows,
          nodeRows,
          subagentRows,
          providerSessionRows,
          providerThreadRows,
          providerTurnRows,
          runtimeRequestRows,
          messageRows,
          turnItemRows,
        ] = yield* Effect.all([
          decodeThreadPayload(threadRows[0].payload_json),
          sql<PayloadRow>`
            SELECT payload_json FROM orchestration_v2_projection_runs AS run
            WHERE run.thread_id = ${threadId}
              AND (
                run.status IN ('queued', 'preparing', 'starting', 'running', 'waiting')
                OR run.run_id = (
                  SELECT latest.run_id FROM orchestration_v2_projection_runs AS latest
                  WHERE latest.thread_id = ${threadId}
                  ORDER BY latest.ordinal DESC LIMIT 1
                )
                -- Retain the latest run for each provider thread with lost
                -- background work, including owners used before a handoff.
                OR run.run_id IN (
                  SELECT (
                    SELECT ended.run_id FROM orchestration_v2_projection_runs AS ended
                    WHERE ended.thread_id = ${threadId}
                      AND ended.provider_thread_id = roster.provider_thread_id
                      AND ended.status NOT IN ('queued', 'rolled_back')
                      -- A run that never started (see neverStarted) owns no work.
                      AND NOT (
                        json_type(ended.payload_json, '$.startedAt') = 'null'
                        AND json_type(ended.payload_json, '$.restartContinuationOfRunId') IS NULL
                      )
                    ORDER BY ended.completed_at IS NULL DESC, ended.completed_at DESC,
                      ended.ordinal DESC
                    LIMIT 1
                  )
                  FROM orchestration_v2_projection_provider_threads AS roster
                  WHERE roster.thread_id = ${threadId}
                    AND CASE WHEN json_valid(roster.payload_json)
                      THEN json_array_length(roster.payload_json, '$.pendingBackgroundTasks') > 0
                      ELSE 0 END
                )
                OR run.run_id IN (
                  SELECT item.run_id FROM orchestration_v2_projection_turn_items AS item
                  WHERE item.thread_id = ${threadId}
                    AND item.type IN ('command_execution', 'dynamic_tool', 'subagent')
                    AND item.status IN ('pending', 'running', 'waiting')
                    AND item.run_id IS NOT NULL
                )
              )
            ORDER BY run.ordinal ASC
          `,
          sql<PayloadRow>`
            SELECT attempt.payload_json
            FROM orchestration_v2_projection_run_attempts AS attempt
            WHERE attempt.thread_id = ${threadId}
              AND attempt.run_id IN (
                SELECT run_id FROM orchestration_v2_projection_runs
                WHERE thread_id = ${threadId}
                  AND status IN ('queued', 'preparing', 'starting', 'running', 'waiting')
              )
            ORDER BY attempt.run_id ASC, attempt.attempt_ordinal ASC
          `,
          sql<PayloadRow>`
            SELECT node.payload_json FROM orchestration_v2_projection_nodes AS node
            WHERE node.thread_id = ${threadId}
              AND node.status IN ('pending', 'starting', 'running', 'waiting')
              AND (
                (node.run_id IS NULL AND node.kind = 'root_turn')
                OR node.node_id IN (
                  SELECT node_id FROM orchestration_v2_projection_runtime_requests
                  WHERE thread_id = ${threadId} AND status = 'pending' AND kind = 'user_input'
                )
                OR node.run_id IN (
                  SELECT run_id FROM orchestration_v2_projection_runs
                  WHERE thread_id = ${threadId}
                    AND status IN ('queued', 'preparing', 'starting', 'running', 'waiting')
                )
                OR node.node_id IN (
                  SELECT item.node_id FROM orchestration_v2_projection_turn_items AS item
                  WHERE item.thread_id = ${threadId}
                    AND item.type IN ('command_execution', 'dynamic_tool', 'subagent')
                    AND item.status IN ('pending', 'running', 'waiting')
                )
                OR node.node_id IN (
                  SELECT json_extract(item.payload_json, '$.subagentId')
                  FROM orchestration_v2_projection_turn_items AS item
                  WHERE item.thread_id = ${threadId} AND item.type = 'subagent'
                    AND item.status IN ('pending', 'running', 'waiting')
                )
                OR node.node_id IN (
                  SELECT subagent_id FROM orchestration_v2_projection_subagents
                  WHERE thread_id = ${threadId} AND origin = 'provider_native'
                    AND status IN ('pending', 'running', 'waiting')
                )
              )
            ORDER BY COALESCE(node.started_at, ''), node.node_id ASC
          `,
          sql<PayloadRow>`
            SELECT subagent.payload_json FROM orchestration_v2_projection_subagents AS subagent
            WHERE subagent.thread_id = ${threadId}
              AND subagent.status IN ('pending', 'starting', 'running', 'waiting')
              AND (
                subagent.origin = 'provider_native'
                OR subagent.run_id IN (
                  SELECT run_id FROM orchestration_v2_projection_runs
                  WHERE thread_id = ${threadId}
                    AND status IN ('queued', 'preparing', 'starting', 'running', 'waiting')
                )
                OR subagent.subagent_id IN (
                  SELECT json_extract(item.payload_json, '$.subagentId')
                  FROM orchestration_v2_projection_turn_items AS item
                  WHERE item.thread_id = ${threadId} AND item.type = 'subagent'
                    AND item.status IN ('pending', 'running', 'waiting')
                )
              )
            ORDER BY COALESCE(subagent.started_at, ''), subagent.subagent_id ASC
          `,
          sql<PayloadRow>`
            SELECT session.payload_json
            FROM orchestration_v2_projection_provider_sessions AS session
            WHERE (
                session.provider_session_id IN (
                  SELECT binding.provider_session_id
                  FROM orchestration_v2_projection_provider_session_bindings AS binding
                  WHERE binding.thread_id = ${threadId}
                )
                AND (
                  session.status NOT IN ('stopped', 'error')
                  OR session.provider_session_id IN (
                    SELECT provider_thread.provider_session_id
                    FROM orchestration_v2_projection_provider_threads AS provider_thread
                    WHERE provider_thread.provider_thread_id IN (
                      SELECT run.provider_thread_id
                      FROM orchestration_v2_projection_runs AS run
                      WHERE run.thread_id = ${threadId}
                        AND run.status IN ('queued', 'preparing', 'starting', 'running', 'waiting')
                    )
                  )
                )
              )
              -- This thread detached it, which keeps its status. Its process
              -- did not outlive the server either, so recovery stops it.
              OR (
                session.thread_id = ${threadId}
                AND session.status NOT IN ('stopped', 'error')
                AND NOT EXISTS (
                  SELECT 1 FROM orchestration_v2_projection_provider_session_bindings AS binding
                  WHERE binding.provider_session_id = session.provider_session_id
                )
              )
            ORDER BY session.updated_at ASC, session.provider_session_id ASC
          `,
          sql<PayloadRow>`
            SELECT provider_thread.payload_json
            FROM orchestration_v2_projection_provider_threads AS provider_thread
            WHERE provider_thread.provider_thread_id IN (
                SELECT provider_thread_id FROM orchestration_v2_projection_provider_threads
                WHERE thread_id = ${threadId}
                UNION
                -- Start with non-null owners; a thread can have a large settled node history.
                SELECT owned.provider_thread_id
                FROM orchestration_v2_projection_provider_threads AS owned
                  INDEXED BY orchestration_v2_projection_provider_threads_owner_idx
                CROSS JOIN orchestration_v2_projection_nodes AS owner
                  ON owner.node_id = owned.owner_node_id
                WHERE owned.owner_node_id IS NOT NULL AND owner.thread_id = ${threadId}
                UNION
                SELECT provider_thread_id FROM orchestration_v2_projection_subagents
                WHERE thread_id = ${threadId} AND provider_thread_id IS NOT NULL
              )
              AND (
                provider_thread.status = 'active'
                OR CASE WHEN json_valid(provider_thread.payload_json)
                  THEN json_array_length(provider_thread.payload_json, '$.pendingBackgroundTasks') > 0
                  ELSE 0 END
                OR provider_thread.provider_thread_id IN (
                  SELECT run.provider_thread_id FROM orchestration_v2_projection_runs AS run
                  WHERE run.thread_id = ${threadId}
                    AND run.status IN ('queued', 'preparing', 'starting', 'running', 'waiting')
                )
                OR provider_thread.provider_thread_id IN (
                  SELECT item.provider_thread_id
                  FROM orchestration_v2_projection_turn_items AS item
                  WHERE item.thread_id = ${threadId}
                    AND item.status IN ('pending', 'running', 'waiting')
                )
                -- A native subagent's item names its own provider thread; the
                -- run that waits on it (see awaitingProviderThreadId) is woken.
                OR provider_thread.provider_thread_id IN (
                  SELECT run.provider_thread_id
                  FROM orchestration_v2_projection_turn_items AS item
                  JOIN orchestration_v2_projection_runs AS run ON run.run_id = item.run_id
                  WHERE item.thread_id = ${threadId}
                    AND item.status IN ('pending', 'running', 'waiting')
                )
              )
            ORDER BY COALESCE(provider_thread.first_run_ordinal, 0), provider_thread.provider_thread_id ASC
          `,
          sql<PayloadRow>`
            SELECT provider_turn.payload_json
            FROM orchestration_v2_projection_provider_turns AS provider_turn
            WHERE provider_turn.thread_id = ${threadId}
              AND provider_turn.status IN ('pending', 'starting', 'running', 'waiting')
              AND (
                provider_turn.run_attempt_id IN (
                  SELECT attempt_id FROM orchestration_v2_projection_run_attempts
                  WHERE thread_id = ${threadId}
                    AND run_id IN (
                      SELECT run_id FROM orchestration_v2_projection_runs
                      WHERE thread_id = ${threadId}
                        AND status IN ('queued', 'preparing', 'starting', 'running', 'waiting')
                    )
                )
                OR (
                  provider_turn.run_attempt_id IS NULL
                  AND provider_turn.node_id IN (
                    SELECT node_id FROM orchestration_v2_projection_nodes
                    WHERE thread_id = ${threadId}
                      AND run_id IS NULL
                      AND kind = 'root_turn'
                      AND status IN ('pending', 'running', 'waiting')
                  )
                )
              )
            ORDER BY provider_turn.provider_thread_id ASC, provider_turn.ordinal ASC
          `,
          sql<PayloadRow>`
            SELECT payload_json FROM orchestration_v2_projection_runtime_requests
            WHERE thread_id = ${threadId} AND status = 'pending'
            ORDER BY created_at ASC, runtime_request_id ASC
          `,
          // CROSS JOIN keeps empty run cohorts out of message history; the run index bounds each lookup.
          sql<PayloadRow>`
            SELECT message.payload_json FROM orchestration_v2_projection_runs AS run
            CROSS JOIN orchestration_v2_projection_messages AS message
              INDEXED BY orchestration_v2_projection_messages_run_idx ON message.run_id = run.run_id
            WHERE run.thread_id = ${threadId}
              AND run.status IN ('queued', 'preparing', 'starting', 'running', 'waiting')
              AND message.thread_id = ${threadId} AND message.streaming = 1
            ORDER BY message.created_at ASC, message.message_id ASC
          `,
          sql<PayloadRow>`
            SELECT item.payload_json FROM orchestration_v2_projection_turn_items AS item
            WHERE item.thread_id = ${threadId}
              AND item.status IN ('pending', 'running', 'waiting')
              AND (
                item.run_id IN (
                  SELECT run_id FROM orchestration_v2_projection_runs
                  WHERE thread_id = ${threadId}
                    AND status IN ('queued', 'preparing', 'starting', 'running', 'waiting')
                )
                OR item.type IN ('command_execution', 'dynamic_tool', 'subagent')
                OR (
                  item.type = 'user_input_request'
                  AND json_extract(item.payload_json, '$.requestId') IN (
                    SELECT runtime_request_id FROM orchestration_v2_projection_runtime_requests
                    WHERE thread_id = ${threadId} AND status = 'pending' AND kind = 'user_input'
                  )
                )
                OR (
                  item.run_id IS NULL
                  AND item.node_id IN (
                    SELECT node_id FROM orchestration_v2_projection_nodes
                    WHERE thread_id = ${threadId}
                      AND run_id IS NULL
                      AND kind = 'root_turn'
                      AND status IN ('pending', 'running', 'waiting')
                  )
                )
              )
            ORDER BY item.ordinal ASC, item.turn_item_id ASC
          `,
        ]);
        const [
          runs,
          attempts,
          nodes,
          subagents,
          providerSessions,
          providerThreads,
          providerTurns,
          runtimeRequests,
          messages,
          turnItems,
        ] = yield* Effect.all([
          decodeRows(decodeRunPayload, threadId)(runRows),
          decodeRows(decodeRunAttemptPayload, threadId)(attemptRows),
          decodeRows(decodeNodePayload, threadId)(nodeRows),
          decodeRows(decodeSubagentPayload, threadId)(subagentRows),
          decodeRows(decodeProviderSessionPayload, threadId)(providerSessionRows),
          decodeRows(decodeProviderThreadPayload, threadId)(providerThreadRows),
          decodeRows(decodeProviderTurnPayload, threadId)(providerTurnRows),
          decodeRows(decodeRuntimeRequestPayload, threadId)(runtimeRequestRows),
          decodeRows(decodeMessagePayload, threadId)(messageRows),
          decodeRows(decodeTurnItemPayload, threadId)(turnItemRows),
        ]);
        return {
          thread,
          runs,
          attempts,
          nodes,
          subagents,
          providerSessions,
          providerThreads,
          providerTurns,
          runtimeRequests,
          messages,
          turnItems,
        } satisfies ProjectionRuntimeRecoveryState;
      },
      (effect, threadId) =>
        effect.pipe(
          Effect.mapError((cause) =>
            isProjectionStoreThreadNotFoundError(cause)
              ? cause
              : new ProjectionStoreReadError({ threadId, cause }),
          ),
        ),
    );

const requireThread = Effect.fn("ProjectionStore.requireThread")(function* (
    threadId: ThreadId,
  ) {
    const rows = yield* sql<{ readonly thread_id: string }>`
      SELECT thread_id FROM orchestration_v2_projection_threads WHERE thread_id = ${threadId} LIMIT 1
    `;
    if (rows.length === 0) return yield* new ProjectionStoreThreadNotFoundError({ threadId });
  });

const controlReadError = (threadId: ThreadId) => (cause: unknown) =>
    isProjectionStoreThreadNotFoundError(cause)
      ? cause
      : new ProjectionStoreReadError({ threadId, cause });

const getPendingNativeUserInputs: ProjectionStoreV2Shape["getPendingNativeUserInputs"] = (
    threadId,
    providerTurnId,
  ) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const rows = yield* sql<PayloadRow>`
        SELECT payload_json FROM orchestration_v2_projection_runtime_requests
        WHERE thread_id = ${threadId} AND provider_turn_id = ${providerTurnId}
          AND kind = 'user_input' AND status = 'pending'
      `;
          const runtimeRequests = (yield* decodeRows(
            decodeRuntimeRequestPayload,
            threadId,
          )(rows)).filter((request) => request.responseCapability.type !== "message");
          if (runtimeRequests.length === 0) return { runtimeRequests, nodes: [], turnItems: [] };
          const nodeRows = yield* sql<PayloadRow>`
        SELECT payload_json FROM orchestration_v2_projection_nodes
        WHERE thread_id = ${threadId} AND ${sql.in(
          "node_id",
          runtimeRequests.map((request) => request.nodeId),
        )}
      `;
          const itemRows = yield* sql<PayloadRow>`
        SELECT payload_json FROM orchestration_v2_projection_turn_items
        WHERE thread_id = ${threadId} AND provider_turn_id = ${providerTurnId}
          AND type = 'user_input_request'
      `;
          const requestIds = new Set(runtimeRequests.map((request) => request.id));
          return {
            runtimeRequests,
            nodes: yield* decodeRows(decodeNodePayload, threadId)(nodeRows),
            turnItems: (yield* decodeRows(decodeTurnItemPayload, threadId)(itemRows)).filter(
              (item) => item.type === "user_input_request" && requestIds.has(item.requestId),
            ),
          };
        }),
      )
      .pipe(Effect.mapError(controlReadError(threadId)));

const getPlan: ProjectionStoreV2Shape["getPlan"] = (threadId, planId) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          yield* requireThread(threadId);
          const rows =
            yield* sql<PayloadRow>`SELECT payload_json FROM orchestration_v2_projection_plans
        WHERE thread_id = ${threadId} AND plan_id = ${planId}`;
          return rows[0] === undefined ? undefined : yield* decodePlanJson(rows[0].payload_json);
        }),
      )
      .pipe(Effect.mapError(controlReadError(threadId)));

const hasUnpairedRunInterruptRequest: ProjectionStoreV2Shape["hasUnpairedRunInterruptRequest"] =
    Effect.fn("ProjectionStore.hasUnpairedRunInterruptRequest")(
      function* (threadId, requestId, resultId) {
        const rows = yield* sql<{ pending: number }>`
      SELECT EXISTS (
        SELECT 1 FROM orchestration_v2_projection_turn_items
        WHERE thread_id = ${threadId} AND turn_item_id = ${requestId}
      ) AND NOT EXISTS (
        SELECT 1 FROM orchestration_v2_projection_turn_items
        WHERE thread_id = ${threadId} AND turn_item_id = ${resultId}
      ) AS pending
    `;
        return rows[0]?.pending === 1;
      },
      (effect, threadId, _requestId, _resultId) =>
        effect.pipe(Effect.mapError(controlReadError(threadId))),
    );

const isNodeStored: ProjectionStoreV2Shape["isNodeStored"] = Effect.fn(
    "ProjectionStore.isNodeStored",
  )(
    function* (node) {
      const payloadJson = yield* encodeNodePayload(node);
      const rows = yield* sql<PayloadRow>`
        SELECT payload_json FROM orchestration_v2_projection_nodes WHERE node_id = ${node.id}
      `;
      return rows[0]?.payload_json === payloadJson;
    },
    (effect, node) => effect.pipe(Effect.mapError(controlReadError(node.threadId))),
  );

const getRuntimeRequest: ProjectionStoreV2Shape["getRuntimeRequest"] = (threadId, requestId) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          yield* requireThread(threadId);
          const rows = yield* sql<PayloadRow>`
        SELECT payload_json FROM orchestration_v2_projection_runtime_requests
        WHERE thread_id = ${threadId} AND runtime_request_id = ${requestId}
      `;
          return rows[0] === undefined
            ? undefined
            : yield* decodeRuntimeRequestPayload(rows[0].payload_json);
        }),
      )
      .pipe(Effect.mapError(controlReadError(threadId)));

const getProviderControlContext: ProjectionStoreV2Shape["getProviderControlContext"] = (
    threadId,
    target,
  ) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          yield* requireThread(threadId);
          const [threadRows, turnRows, attemptRows, messageRows] = yield* Effect.all([
            sql<PayloadRow>`SELECT payload_json FROM orchestration_v2_projection_provider_threads
          WHERE provider_thread_id = ${target.providerThreadId} AND (
            thread_id = ${threadId}
            OR owner_node_id IN (SELECT node_id FROM orchestration_v2_projection_nodes WHERE thread_id = ${threadId})
            OR provider_thread_id IN (SELECT provider_thread_id FROM orchestration_v2_projection_subagents WHERE thread_id = ${threadId})
          )`,
            sql<PayloadRow>`SELECT payload_json FROM orchestration_v2_projection_provider_turns
          WHERE thread_id = ${threadId} AND provider_turn_id = ${target.providerTurnId}`,
            target.attemptId === undefined
              ? Effect.succeed([] as ReadonlyArray<PayloadRow>)
              : sql<PayloadRow>`SELECT payload_json FROM orchestration_v2_projection_run_attempts
            WHERE thread_id = ${threadId} AND attempt_id = ${target.attemptId}`,
            target.messageId === undefined
              ? Effect.succeed([] as ReadonlyArray<PayloadRow>)
              : sql<PayloadRow>`SELECT payload_json FROM orchestration_v2_projection_messages
            WHERE thread_id = ${threadId} AND message_id = ${target.messageId}`,
          ]);
          const providerThread =
            threadRows[0] === undefined
              ? undefined
              : yield* decodeProviderThreadPayload(threadRows[0].payload_json);
          const providerTurn =
            turnRows[0] === undefined
              ? undefined
              : yield* decodeProviderTurnPayload(turnRows[0].payload_json);
          const attempt =
            attemptRows[0] === undefined
              ? undefined
              : yield* decodeRunAttemptPayload(attemptRows[0].payload_json);
          const message =
            messageRows[0] === undefined
              ? undefined
              : yield* decodeMessagePayload(messageRows[0].payload_json);
          let run: OrchestrationV2Run | undefined;
          if (target.messageId !== undefined && providerTurn !== undefined) {
            const rows =
              yield* sql<PayloadRow>`SELECT payload_json FROM orchestration_v2_projection_runs
          WHERE thread_id = ${threadId} AND json_extract(payload_json, '$.activeAttemptId') IS ${providerTurn.runAttemptId}
          ORDER BY ordinal ASC LIMIT 1`;
            if (rows[0] !== undefined) run = yield* decodeRunPayload(rows[0].payload_json);
          }
          return { providerThread, providerTurn, attempt, message, run };
        }),
      )
      .pipe(Effect.mapError(controlReadError(threadId)));

const getRunningTurnContext: ProjectionStoreV2Shape["getRunningTurnContext"] = (threadId) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          yield* requireThread(threadId);
          const rows =
            yield* sql<PayloadRow>`SELECT payload_json FROM orchestration_v2_projection_runs
        WHERE thread_id = ${threadId} AND status = 'running' ORDER BY ordinal ASC LIMIT 1`;
          const run =
            rows[0] === undefined ? undefined : yield* decodeRunPayload(rows[0].payload_json);
          if (run === undefined)
            return { run, providerThread: undefined, providerTurn: undefined };
          const threadRows =
            yield* sql<PayloadRow>`SELECT payload_json FROM orchestration_v2_projection_provider_threads WHERE provider_thread_id = ${run.providerThreadId}`;
          const turnRows =
            yield* sql<PayloadRow>`SELECT payload_json FROM orchestration_v2_projection_provider_turns
        WHERE provider_thread_id = ${run.providerThreadId}
          AND run_attempt_id = ${run.activeAttemptId}
          AND node_id = ${run.rootNodeId}
          AND status = 'running'`;
          return {
            run,
            providerThread:
              threadRows[0] === undefined
                ? undefined
                : yield* decodeProviderThreadPayload(threadRows[0].payload_json),
            providerTurn:
              turnRows[0] === undefined
                ? undefined
                : yield* decodeProviderTurnPayload(turnRows[0].payload_json),
          };
        }),
      )
      .pipe(Effect.mapError(controlReadError(threadId)));

  return { getRuntimeRecoveryProjection, requireThread, controlReadError, getPendingNativeUserInputs, getPlan, hasUnpairedRunInterruptRequest, isNodeStored, getRuntimeRequest, getProviderControlContext, getRunningTurnContext };
});

export type GetRuntimeRecoveryProjectionPart = ReturnType<typeof installGetRuntimeRecoveryProjection> extends Effect.Effect<infer A, infer _E, infer _R> ? A : ReturnType<typeof installGetRuntimeRecoveryProjection>;
