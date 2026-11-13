import type { OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import { RunId, ThreadId, TurnItemId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { encodeThreadHistoryCursor } from "../threadHistoryPaging.ts";
import { type PayloadRow, type ProjectionWindow } from "../ProjectionStorePrelude/ProjectionStoreV2Shape.ts";
import { ProjectionStoreReadError, ProjectionStoreThreadNotFoundError, type ProjectionRecordField, type ProjectionRecordFilter } from "../ProjectionStorePrelude/ProjectionSettlementCandidate.ts";
import { decodeCheckpointPayload, decodeCheckpointScopePayload, decodeContextHandoffPayload, decodeContextTransferPayload, decodeMessagePayload, decodeNodePayload, decodePlanJson, decodeProviderSessionPayload, decodeProviderThreadPayload, decodeProviderTurnPayload, decodeRows, decodeRunAttemptPayload, decodeRunPayload, decodeRuntimeRequestPayload, decodeSubagentPayload, decodeThreadPayload, decodeTurnItemPayload, encodeIdList, isProjectionStoreThreadNotFoundError, matchesNothing, nullableStringField, sortMessagesByTurnItemOrder } from "../ProjectionStorePrelude/BuildVisibleTurnItems.ts";
import type { ApplyRecordTailPart } from "./ApplyRecordTail.ts";
import type { ApplyRunTailPart } from "./ApplyRunTail.ts";
import type { RetainedWindowRowsPart } from "./RetainedWindowRows.ts";

type Deps = Record<never, never> & ApplyRecordTailPart & ApplyRunTailPart & RetainedWindowRowsPart;

export const installReadCanonicalProjection = Effect.fnUntraced(function* (deps: Deps) {
  const { retainedWindowRows, sql } = deps;

const readCanonicalProjection = Effect.fn("ProjectionStore.readCanonicalProjection")(
    function* (
      threadId: ThreadId,
      window?: ProjectionWindow,
      fields?: ReadonlyArray<ProjectionRecordField>,
      filter?: ProjectionRecordFilter,
    ) {
      const threadRows = yield* sql<PayloadRow>`
        SELECT payload_json
        FROM orchestration_v2_projection_threads
        WHERE thread_id = ${threadId}
        LIMIT 1
      `;
      const threadRow = threadRows[0];
      if (!threadRow) {
        return yield* new ProjectionStoreThreadNotFoundError({ threadId });
      }

      type WindowPayloadRow = PayloadRow & {
        readonly work_last_id?: string | null;
        readonly work_last_ordinal?: number | null;
        readonly work_item_count?: number | null;
      };
      const boundedTurnItemRows: ReadonlyArray<WindowPayloadRow> =
        (fields !== undefined && !fields.includes("turnItems")) ||
        (window === undefined &&
          matchesNothing(
            filter?.turnItemTypes,
            filter?.turnItemStatuses,
            filter?.turnItemRunIds,
            filter?.turnItemNodeIds,
          ))
          ? []
          : window === undefined
            ? yield* sql<PayloadRow>`
              SELECT payload_json
              FROM orchestration_v2_projection_turn_items
              WHERE thread_id = ${threadId}
                ${filter?.turnItemTypes === undefined ? sql`` : sql`AND type IN (SELECT value FROM json_each(${encodeIdList(filter.turnItemTypes)}))`}
                ${filter?.turnItemStatuses === undefined ? sql`` : sql`AND status IN (SELECT value FROM json_each(${encodeIdList(filter.turnItemStatuses)}))`}
                ${filter?.turnItemRunId === undefined ? sql`` : sql`AND run_id = ${filter.turnItemRunId}`}
                ${filter?.turnItemNodeIds === undefined ? sql`` : sql`AND node_id IN (SELECT value FROM json_each(${encodeIdList(filter.turnItemNodeIds)}))`}
                ${filter?.turnItemRunIds === undefined ? sql`` : sql`AND (run_id IN (SELECT value FROM json_each(${encodeIdList(filter.turnItemRunIds.filter((id): id is RunId => id !== null))})) OR (${filter.turnItemRunIds.includes(null) ? 1 : 0} = 1 AND run_id IS NULL))`}
              ORDER BY ordinal ASC, turn_item_id ASC
            `
            : yield* sql<PayloadRow>`
              ${yield* retainedWindowRows(threadId, window)}
              -- CROSS JOIN keeps the sorted IDs as the outer loop, so SQLite
              -- skips sorting again once the payloads are attached. Carry the
              -- rowid through selection to avoid a second string-key index lookup.
              SELECT item.payload_json, tail.turn_item_id AS work_last_id,
                deferred.last_ordinal AS work_last_ordinal, deferred.item_count AS work_item_count
              FROM retained
              CROSS JOIN orchestration_v2_projection_turn_items AS item
                ON item.rowid = retained.item_rowid
              LEFT JOIN deferred_work deferred ON deferred.run_id = item.run_id
                AND deferred.first_ordinal = item.ordinal
              LEFT JOIN orchestration_v2_projection_turn_items tail
                ON tail.turn_item_id = (
                  SELECT turn_item_id FROM orchestration_v2_projection_turn_items
                  WHERE thread_id = item.thread_id AND ordinal = deferred.last_ordinal
                  ORDER BY turn_item_id DESC LIMIT 1
                )
              ORDER BY retained.ordinal ASC, retained.turn_item_id ASC
            `;
      // Decode items once for cohort ids and projection; repeated parsing duplicates retained tool output.
      const decodedTurnItems = yield* decodeRows(
        decodeTurnItemPayload,
        threadId,
      )(boundedTurnItemRows);
      const turnItems = decodedTurnItems.map((item, index) => {
        const row = boundedTurnItemRows[index]!;
        return row.work_last_id == null ||
          row.work_item_count == null ||
          row.work_last_ordinal == null
          ? item
          : {
              ...item,
              deferredWork: {
                cursor: encodeThreadHistoryCursor({
                  snapshotSequence: 0,
                  sourceThreadId: threadId,
                  sourceItemId: TurnItemId.make(row.work_last_id),
                  position: row.work_last_ordinal,
                  inclusive: true,
                }),
                itemCount: row.work_item_count,
                lastOrdinal: row.work_last_ordinal,
              },
            };
      });
      const cohortJson = (field: string) =>
        JSON.stringify(
          turnItems.flatMap((payload) => {
            const value = nullableStringField(payload, field);
            return value === null ? [] : [value];
          }),
        );
      const cohortRunIds = cohortJson("runId");
      const cohortNodeIds =
        window === undefined ||
        (fields !== undefined &&
          fields.every(
            (field) => field === "runs" || field === "attempts" || field === "turnItems",
          ))
          ? cohortJson("nodeId")
          : encodeIdList(
              (yield* sql<{ readonly node_id: string }>`
          WITH RECURSIVE retained(node_id) AS (
            SELECT value FROM json_each(${cohortJson("nodeId")})
            UNION
            SELECT node_id FROM orchestration_v2_projection_nodes
            WHERE thread_id = ${threadId} AND status IN ('pending','starting','running','waiting')
            UNION
            SELECT root_node_id FROM orchestration_v2_projection_run_attempts
            WHERE thread_id = ${threadId} AND (
              status IN ('pending','starting','running','waiting')
              OR run_id IN (SELECT value FROM json_each(${cohortRunIds}))
              OR run_id = ${window.requiredRunId ?? null})
            UNION
            SELECT json_extract(payload_json, '$.rootNodeId') FROM orchestration_v2_projection_runs
            WHERE thread_id = ${threadId} AND (
              status IN ('queued','preparing','starting','running','waiting')
              OR run_id IN (SELECT value FROM json_each(${cohortRunIds}))
              OR run_id = ${window.requiredRunId ?? null})
            UNION
            SELECT node_id FROM orchestration_v2_projection_runtime_requests
            WHERE thread_id = ${threadId} AND status IN ('pending','waiting')
            UNION
            SELECT parent_node_id FROM orchestration_v2_projection_subagents
            WHERE thread_id = ${threadId} AND status IN ('pending','starting','running','waiting')
            UNION
            SELECT node_id FROM orchestration_v2_projection_provider_turns
            WHERE thread_id = ${threadId} AND status IN ('starting','running','waiting')
            UNION
            SELECT parent.parent_node_id FROM orchestration_v2_projection_nodes AS parent
            INNER JOIN retained ON parent.node_id = retained.node_id
            WHERE parent.thread_id = ${threadId} AND parent.parent_node_id IS NOT NULL
          )
          -- Sort IDs before fetching bodies, so large payloads never enter
          -- SQLite's temporary sort. The node read restores this order by key.
          SELECT retained.node_id
          FROM retained
          LEFT JOIN orchestration_v2_projection_nodes AS node
            ON node.node_id = retained.node_id AND node.thread_id = ${threadId}
          WHERE retained.node_id IS NOT NULL
          ORDER BY COALESCE(node.started_at, ''), retained.node_id ASC
        `).map((row) => row.node_id),
            );
      const cohortProviderThreadIds = cohortJson("providerThreadId");
      const cohortProviderTurnIds = cohortJson("providerTurnId");
      const cohortMessageIds = cohortJson("messageId");
      const cohortPlanIds = cohortJson("planId");
      const cohortCheckpointIds = cohortJson("checkpointId");
      const cohortHandoffIds = cohortJson("contextHandoffId");
      // A newer completion must keep an older active list from resurfacing after paging.
      const [latestTodoList] =
        window === undefined ||
        (fields !== undefined &&
          !fields.some(
            (field) => field === "plans" || field === "runs" || field === "providerThreads",
          ))
          ? []
          : yield* sql<{
              readonly plan_id: string;
              readonly run_id: string;
              readonly provider_thread_id: string | null;
              readonly last_plan_id: string;
            }>`
              WITH latest_owner AS MATERIALIZED (
                SELECT plan.plan_id, owner.run_id, owner.provider_thread_id
                FROM orchestration_v2_projection_plans AS plan
                INNER JOIN orchestration_v2_projection_runs AS owner
                  ON owner.thread_id = plan.thread_id AND owner.run_id = plan.run_id
                WHERE plan.thread_id = ${threadId}
                  AND plan.kind = 'todo_list' AND plan.status <> 'superseded'
                ORDER BY owner.ordinal DESC, plan.plan_id DESC
                LIMIT 1
              )
              SELECT COALESCE(CASE WHEN EXISTS (
                SELECT 1 FROM orchestration_v2_projection_plans
                WHERE thread_id = ${threadId} AND run_id = owner.run_id
                  AND kind = 'todo_list' AND status <> 'superseded'
                  AND plan_id <> owner.plan_id
              ) THEN (
                -- Plan UUIDs cannot order replacements within a run.
                SELECT plan.plan_id
                FROM orchestration_v2_projection_turn_items AS item
                CROSS JOIN orchestration_v2_projection_plans AS plan
                  ON plan.plan_id = json_extract(item.payload_json, '$.planId')
                WHERE item.run_id = owner.run_id AND item.thread_id = ${threadId}
                  AND item.type = 'todo_list'
                  AND plan.run_id = owner.run_id AND plan.thread_id = ${threadId}
                  AND plan.kind = 'todo_list' AND plan.status <> 'superseded'
                ORDER BY item.ordinal DESC
                LIMIT 1
              ) END, owner.plan_id) AS plan_id, owner.run_id, owner.provider_thread_id,
              (
                SELECT MAX(plan_id) FROM orchestration_v2_projection_plans
                WHERE thread_id = ${threadId} AND run_id = owner.run_id
              ) AS last_plan_id
              FROM latest_owner AS owner
            `;

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
        planRows,
        checkpointScopeRows,
        checkpointRows,
        contextHandoffRows,
        contextTransferRows,
      ] = yield* Effect.all([
        decodeThreadPayload(threadRow.payload_json),
        (fields !== undefined && !fields.includes("runs")) ||
        (window === undefined &&
          (matchesNothing(filter?.runIds) ||
            (matchesNothing(filter?.runStatuses) && filter?.includeLatestRun !== true)))
          ? Effect.succeed([])
          : window === undefined
            ? sql<PayloadRow>`
          SELECT payload_json
          FROM orchestration_v2_projection_runs
          WHERE thread_id = ${threadId}
            ${filter?.runIds === undefined ? sql`` : sql`AND run_id IN (SELECT value FROM json_each(${encodeIdList(filter.runIds)}))`}
            ${
              filter?.runStatuses === undefined
                ? sql``
                : sql`AND (status IN (SELECT value FROM json_each(${encodeIdList(filter.runStatuses)}))
                  OR (${filter.includeLatestRun === true ? 1 : 0} = 1 AND run_id = (
                    SELECT run_id FROM orchestration_v2_projection_runs
                    WHERE thread_id = ${threadId}
                      AND (status <> 'cancelled' OR json_extract(payload_json, '$.startedAt') IS NOT NULL)
                    ORDER BY ordinal DESC
                    LIMIT 1
                  )))`
            }
          ORDER BY ordinal ASC
        `
            : sql<PayloadRow>`
          SELECT payload_json FROM orchestration_v2_projection_runs
          WHERE thread_id = ${threadId}
            AND (status IN ('queued','preparing','starting','running','waiting')
              OR run_id IN (SELECT value FROM json_each(${cohortRunIds}))
              OR run_id = ${window.requiredRunId ?? null}
              -- Queued or cancelled turns must not hide the latest actual session.
              OR run_id = ${latestTodoList?.run_id ?? null}
              OR run_id = (
                SELECT run_id FROM orchestration_v2_projection_runs
                WHERE thread_id = ${threadId}
                  AND provider_thread_id IS NOT NULL
                  AND json_extract(payload_json, '$.startedAt') IS NOT NULL
                  AND ${latestTodoList?.plan_id ?? null} IS NOT NULL
                ORDER BY ordinal DESC
                LIMIT 1
              ))
          ORDER BY ordinal ASC
        `,
        fields !== undefined && !fields.includes("attempts")
          ? Effect.succeed([])
          : window === undefined
            ? sql<PayloadRow>`
          SELECT payload_json
          FROM orchestration_v2_projection_run_attempts
          WHERE thread_id = ${threadId}
          ORDER BY run_id ASC, attempt_ordinal ASC
        `
            : sql<PayloadRow>`
          SELECT payload_json FROM orchestration_v2_projection_run_attempts
          WHERE thread_id = ${threadId}
            AND (status IN ('pending','starting','running','waiting')
              OR run_id IN (SELECT value FROM json_each(${cohortRunIds})))
          ORDER BY run_id ASC, attempt_ordinal ASC
        `,
        (fields !== undefined && !fields.includes("nodes")) ||
        (window === undefined && matchesNothing(filter?.nodeIds))
          ? Effect.succeed([])
          : window === undefined
            ? sql<PayloadRow>`
          SELECT payload_json
          FROM orchestration_v2_projection_nodes AS node
          WHERE node.thread_id = ${threadId}
            ${filter?.nodeIds === undefined ? sql`` : sql`AND node.node_id IN (SELECT value FROM json_each(${encodeIdList(filter.nodeIds)}))`}
            ${
              filter?.omitSettledLeafNodes === true
                ? sql`AND NOT (
                    node.kind IN ('tool_call', 'assistant_message', 'reasoning')
                    AND node.status IN ('completed', 'interrupted', 'failed', 'cancelled', 'rolled_back')
                    AND node.run_id IS NOT NULL
                    AND NOT EXISTS (
                      SELECT 1 FROM orchestration_v2_projection_runs AS run
                      WHERE run.run_id = node.run_id
                        AND run.status IN ('preparing', 'queued', 'starting', 'running', 'waiting')
                    )
                  )`
                : sql``
            }
          ORDER BY COALESCE(node.started_at, ''), node.node_id ASC
            `
            : sql<PayloadRow & { readonly position: number }>`
          -- Keep retained IDs outermost so SQLite looks up each node by its
          -- primary key instead of scanning every historical node in the thread.
          SELECT node.payload_json, retained.key AS position
          FROM json_each(${cohortNodeIds}) AS retained
          CROSS JOIN orchestration_v2_projection_nodes AS node
            ON node.node_id = retained.value
          WHERE node.thread_id = ${threadId}
        `.pipe(
                Effect.map((rows) =>
                  rows.toSorted((left, right) => left.position - right.position),
                ),
              ),
        (fields !== undefined && !fields.includes("subagents")) ||
        (window === undefined &&
          (matchesNothing(filter?.subagentIds) || matchesNothing(filter?.subagentRunIds)))
          ? Effect.succeed([])
          : window === undefined
            ? sql<PayloadRow>`
          SELECT payload_json
          FROM orchestration_v2_projection_subagents AS subagent
          WHERE thread_id = ${threadId}
            ${filter?.subagentIds === undefined ? sql`` : sql`AND subagent_id IN (SELECT value FROM json_each(${encodeIdList(filter.subagentIds)}))`}
            ${filter?.subagentRunIds === undefined ? sql`` : sql`AND run_id IN (SELECT value FROM json_each(${encodeIdList(filter.subagentRunIds)}))`}
            ${
              filter?.omitSettledSubagents !== undefined
                ? sql`AND (${
                    filter.omitSettledSubagents === true
                      ? sql`0`
                      : sql`subagent_id IN (SELECT value FROM json_each(${encodeIdList(filter.omitSettledSubagents.except)}))`
                  } OR NOT (
                    subagent.status IN ('completed', 'failed', 'cancelled', 'interrupted')
                    AND COALESCE(subagent.completion_delivery_state, '')
                      IN ('acknowledged', 'delivered', 'disposed')
                    AND NOT EXISTS (
                      SELECT 1 FROM orchestration_v2_projection_runs AS run
                      WHERE run.run_id = subagent.run_id
                        AND run.status IN ('preparing', 'queued', 'starting', 'running', 'waiting')
                    )
                  ))`
                : sql``
            }
          ORDER BY COALESCE(started_at, ''), subagent_id ASC
        `
            : sql<PayloadRow>`
          SELECT payload_json FROM orchestration_v2_projection_subagents
          WHERE thread_id = ${threadId}
            AND (status IN ('pending','starting','running','waiting')
              OR run_id IN (SELECT value FROM json_each(${cohortRunIds}))
              OR parent_node_id IN (SELECT value FROM json_each(${cohortNodeIds})))
          ORDER BY COALESCE(started_at, ''), subagent_id ASC
        `,
        fields !== undefined && !fields.includes("providerSessions")
          ? Effect.succeed([])
          : window === undefined
            ? sql<PayloadRow>`
          SELECT sessions.payload_json
          FROM orchestration_v2_projection_provider_sessions AS sessions
          INNER JOIN orchestration_v2_projection_provider_session_bindings AS bindings
            ON bindings.provider_session_id = sessions.provider_session_id
          WHERE bindings.thread_id = ${threadId}
          ORDER BY sessions.updated_at ASC, sessions.provider_session_id ASC
        `
            : sql<PayloadRow>`
          SELECT DISTINCT sessions.payload_json
          FROM orchestration_v2_projection_provider_sessions AS sessions
          INNER JOIN orchestration_v2_projection_provider_session_bindings AS bindings
            ON bindings.provider_session_id = sessions.provider_session_id
          LEFT JOIN orchestration_v2_projection_provider_threads AS threads
            ON threads.provider_session_id = sessions.provider_session_id
          WHERE bindings.thread_id = ${threadId}
            AND (sessions.status IN ('starting','running','waiting')
              OR threads.provider_thread_id IN (SELECT value FROM json_each(${cohortProviderThreadIds})))
          ORDER BY sessions.updated_at ASC, sessions.provider_session_id ASC
        `,
        (fields !== undefined && !fields.includes("providerThreads")) ||
        (window === undefined && matchesNothing(filter?.providerThreadIds))
          ? Effect.succeed([])
          : window === undefined
            ? sql<PayloadRow>`
          SELECT payload_json
          FROM orchestration_v2_projection_provider_threads
          WHERE (thread_id = ${threadId}
             OR owner_node_id IN (
               SELECT node_id
               FROM orchestration_v2_projection_nodes
               WHERE thread_id = ${threadId}
             )
             OR provider_thread_id IN (
               SELECT provider_thread_id
               FROM orchestration_v2_projection_subagents
               WHERE thread_id = ${threadId}
                 AND provider_thread_id IS NOT NULL
             ))
            ${filter?.providerThreadIds === undefined ? sql`` : sql`AND provider_thread_id IN (SELECT value FROM json_each(${encodeIdList(filter.providerThreadIds)}))`}
          ORDER BY COALESCE(first_run_ordinal, 0), provider_thread_id ASC
        `
            : sql<PayloadRow>`
          SELECT payload_json FROM orchestration_v2_projection_provider_threads
          WHERE (thread_id = ${threadId} AND status = 'active')
            OR provider_thread_id IN (SELECT value FROM json_each(${cohortProviderThreadIds}))
            OR owner_node_id IN (SELECT value FROM json_each(${cohortNodeIds}))
            OR (thread_id = ${threadId}
              AND provider_thread_id = ${latestTodoList?.provider_thread_id ?? null})
          ORDER BY COALESCE(first_run_ordinal, 0), provider_thread_id ASC
        `,
        (fields !== undefined && !fields.includes("providerTurns")) ||
        (window === undefined &&
          matchesNothing(filter?.providerTurnAttemptIds, filter?.providerTurnThreadIds))
          ? Effect.succeed([])
          : window === undefined
            ? sql<PayloadRow>`
          SELECT payload_json
          FROM orchestration_v2_projection_provider_turns
          WHERE thread_id = ${threadId}
            ${filter?.providerTurnAttemptIds === undefined ? sql`` : sql`AND run_attempt_id IN (SELECT value FROM json_each(${encodeIdList(filter.providerTurnAttemptIds)}))`}
            ${filter?.providerTurnThreadIds === undefined ? sql`` : sql`AND provider_thread_id IN (SELECT value FROM json_each(${encodeIdList(filter.providerTurnThreadIds)}))`}
            ${
              filter?.latestProviderTurnUsageOnly === true
                ? sql`AND json_extract(payload_json, '$.tokenUsage') IS NOT NULL
          ORDER BY julianday(json_extract(payload_json, '$.tokenUsage.updatedAt')) DESC,
            provider_thread_id ASC, ordinal ASC
          LIMIT 1`
                : sql`ORDER BY provider_thread_id ASC, ordinal ASC`
            }
        `
            : sql<PayloadRow>`
          SELECT payload_json FROM orchestration_v2_projection_provider_turns
          WHERE thread_id = ${threadId}
            AND (status IN ('starting','running','waiting')
              OR provider_turn_id IN (SELECT value FROM json_each(${cohortProviderTurnIds}))
              OR node_id IN (SELECT value FROM json_each(${cohortNodeIds})))
          ORDER BY provider_thread_id ASC, ordinal ASC
        `,
        (fields !== undefined && !fields.includes("runtimeRequests")) ||
        (window === undefined && matchesNothing(filter?.runtimeRequestStatuses))
          ? Effect.succeed([])
          : window === undefined
            ? sql<PayloadRow>`
          SELECT payload_json
          FROM orchestration_v2_projection_runtime_requests
          WHERE thread_id = ${threadId}
            ${filter?.runtimeRequestStatuses === undefined ? sql`` : sql`AND status IN (SELECT value FROM json_each(${encodeIdList(filter.runtimeRequestStatuses)}))`}
          ORDER BY created_at ASC, runtime_request_id ASC
        `
            : sql<PayloadRow>`
          SELECT payload_json FROM orchestration_v2_projection_runtime_requests
          WHERE thread_id = ${threadId}
            AND (status IN ('pending','waiting')
              OR node_id IN (SELECT value FROM json_each(${cohortNodeIds}))
              OR provider_turn_id IN (SELECT value FROM json_each(${cohortProviderTurnIds})))
          ORDER BY created_at ASC, runtime_request_id ASC
        `,
        (fields !== undefined && !fields.includes("messages")) ||
        (window === undefined &&
          matchesNothing(filter?.messageIds, filter?.messageRoles, filter?.messageRunIds))
          ? Effect.succeed([])
          : window === undefined
            ? sql<PayloadRow>`
              SELECT payload_json FROM orchestration_v2_projection_messages
              WHERE thread_id = ${threadId}
                ${filter?.messageIds === undefined ? sql`` : sql`AND message_id IN (SELECT value FROM json_each(${encodeIdList(filter.messageIds)}))`}
                ${filter?.messageRoles === undefined ? sql`` : sql`AND role IN (SELECT value FROM json_each(${encodeIdList(filter.messageRoles)}))`}
                ${filter?.monitorNotificationsOnly === true ? sql`AND json_extract(payload_json, '$.notification.source.kind') = 'monitor'` : sql``}
                ${filter?.messageRunIds === undefined ? sql`` : sql`AND run_id IN (SELECT value FROM json_each(${encodeIdList(filter.messageRunIds)}))`}
              ORDER BY created_at ASC, message_id ASC
            `
            : sql<PayloadRow>`
              SELECT payload_json FROM orchestration_v2_projection_messages AS message
              WHERE message.thread_id = ${threadId}
                AND (
                  message.message_id IN (
                    SELECT value FROM json_each(${cohortMessageIds})
                  )
                  OR message.run_id IN (
                    SELECT run_id FROM orchestration_v2_projection_runs
                    WHERE thread_id = ${threadId}
                      AND status IN ('queued', 'preparing', 'starting', 'running', 'waiting')
                  )
                )
              ORDER BY created_at ASC, message_id ASC
            `,
        fields !== undefined && !fields.includes("plans")
          ? Effect.succeed([])
          : window === undefined
            ? sql<PayloadRow>`
              SELECT payload_json FROM orchestration_v2_projection_plans
              WHERE thread_id = ${threadId} ORDER BY plan_id ASC
            `
            : sql<PayloadRow>`
              SELECT payload_json FROM orchestration_v2_projection_plans AS plan
              WHERE plan.thread_id = ${threadId}
                AND (
                  plan.status = 'active'
                  OR plan.plan_id = ${latestTodoList?.plan_id ?? null}
                  OR plan.plan_id IN (
                    SELECT value FROM json_each(${cohortPlanIds})
                  )
                )
              -- Keep the selected artifact last within its run for equal-run consumers.
              ORDER BY CASE WHEN plan_id = ${latestTodoList?.plan_id ?? null}
                THEN ${latestTodoList?.last_plan_id ?? null} ELSE plan_id END ASC,
                plan_id = ${latestTodoList?.plan_id ?? null} ASC
            `,
        fields !== undefined && !fields.includes("checkpointScopes")
          ? Effect.succeed([])
          : window === undefined
            ? sql<PayloadRow>`
          SELECT payload_json
          FROM orchestration_v2_projection_checkpoint_scopes
          WHERE thread_id = ${threadId}
          ORDER BY ordinal_within_parent ASC, scope_id ASC
        `
            : sql<PayloadRow>`
          SELECT payload_json FROM orchestration_v2_projection_checkpoint_scopes
          WHERE thread_id = ${threadId}
            AND (run_id IN (SELECT value FROM json_each(${cohortRunIds}))
              OR node_id IN (SELECT value FROM json_each(${cohortNodeIds})))
          ORDER BY ordinal_within_parent ASC, scope_id ASC
        `,
        fields !== undefined && !fields.includes("checkpoints")
          ? Effect.succeed([])
          : window === undefined
            ? sql<PayloadRow>`
          SELECT payload_json
          FROM orchestration_v2_projection_checkpoints
          WHERE thread_id = ${threadId}
          ORDER BY scope_id ASC, ordinal_within_scope ASC
        `
            : sql<PayloadRow>`
          SELECT payload_json FROM orchestration_v2_projection_checkpoints
          WHERE thread_id = ${threadId}
            AND (status IN ('pending','capturing')
              OR (run_id IS NULL AND ordinal_within_scope = 0 AND status = 'ready')
              OR checkpoint_id IN (SELECT value FROM json_each(${cohortCheckpointIds}))
              OR run_id IN (SELECT value FROM json_each(${cohortRunIds}))
              OR node_id IN (SELECT value FROM json_each(${cohortNodeIds})))
          ORDER BY scope_id ASC, ordinal_within_scope ASC
        `,
        fields !== undefined && !fields.includes("contextHandoffs")
          ? Effect.succeed([])
          : window === undefined
            ? sql<PayloadRow>`
              SELECT payload_json FROM orchestration_v2_projection_context_handoffs
              WHERE thread_id = ${threadId} ORDER BY rowid ASC
            `
            : sql<PayloadRow>`
              SELECT payload_json FROM orchestration_v2_projection_context_handoffs AS handoff
              WHERE handoff.thread_id = ${threadId}
                AND (
                  handoff.status IN ('pending', 'ready')
                  OR handoff.context_handoff_id IN (
                    SELECT value FROM json_each(${cohortHandoffIds})
                  )
                )
              ORDER BY rowid ASC
            `,
        (fields !== undefined && !fields.includes("contextTransfers")) ||
        (window === undefined && matchesNothing(filter?.contextTransferStatuses))
          ? Effect.succeed([])
          : window === undefined
            ? sql<PayloadRow>`
          SELECT payload_json
          FROM orchestration_v2_projection_context_transfers
          WHERE (source_thread_id = ${threadId} OR target_thread_id = ${threadId})
            ${filter?.contextTransferStatuses === undefined ? sql`` : sql`AND status IN (SELECT value FROM json_each(${encodeIdList(filter.contextTransferStatuses)}))`}
          ORDER BY rowid ASC
        `
            : sql<PayloadRow>`
          SELECT payload_json FROM orchestration_v2_projection_context_transfers
          WHERE (source_thread_id = ${threadId} OR target_thread_id = ${threadId})
            AND (status IN ('pending','running','waiting')
              OR target_run_id IN (SELECT value FROM json_each(${cohortRunIds}))
              OR json_extract(payload_json, '$.contextHandoffId') IN
                (SELECT value FROM json_each(${cohortHandoffIds})))
          ORDER BY rowid ASC
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
        plans,
        checkpointScopes,
        checkpoints,
        contextHandoffs,
        contextTransfers,
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
        decodeRows(decodePlanJson, threadId)(planRows),
        decodeRows(decodeCheckpointScopePayload, threadId)(checkpointScopeRows),
        decodeRows(decodeCheckpointPayload, threadId)(checkpointRows),
        decodeRows(decodeContextHandoffPayload, threadId)(contextHandoffRows),
        decodeRows(decodeContextTransferPayload, threadId)(contextTransferRows),
      ]);
      const messageOrdinals = new Map<string, number>();
      if (fields !== undefined && fields.includes("messages") && messages.length > 1) {
        // Broad role reads keep the original query to avoid per-ID lookup overhead.
        const loadedMessageIds =
          filter?.messageIds === undefined &&
          filter?.messageRunIds === undefined &&
          (filter?.messageRoles === undefined ||
            (filter.messageRoles.includes("user") && filter.messageRoles.includes("assistant")))
            ? undefined
            : messages.map((message) => message.id);
        const rows = yield* sql<{ message_id: string; ordinal: number }>`
          SELECT json_extract(payload_json, '$.messageId') AS message_id, MIN(ordinal) AS ordinal
          FROM orchestration_v2_projection_turn_items
          WHERE thread_id = ${threadId} AND type IN ('user_message', 'assistant_message')
            ${loadedMessageIds === undefined ? sql`` : sql`AND json_extract(payload_json, '$.messageId') IN (SELECT value FROM json_each(${encodeIdList(loadedMessageIds)}))`}
          GROUP BY json_extract(payload_json, '$.messageId')
        `;
        for (const row of rows) messageOrdinals.set(row.message_id, row.ordinal);
      }
      const orderedMessages = sortMessagesByTurnItemOrder(messages, turnItems, messageOrdinals);
      const projection = {
        thread,
        runs,
        attempts,
        nodes,
        subagents,
        providerSessions,
        providerThreads,
        providerTurns,
        runtimeRequests,
        messages: orderedMessages,
        plans,
        turnItems,
        checkpointScopes,
        checkpoints,
        contextHandoffs,
        contextTransfers,
        visibleTurnItems: [],
        updatedAt: thread.updatedAt,
      } satisfies OrchestrationV2ThreadProjection;
      return projection;
    },
    (effect, threadId, _window?, _fields?, _filter?) =>
      effect.pipe(
        Effect.mapError((cause) =>
          isProjectionStoreThreadNotFoundError(cause)
            ? cause
            : new ProjectionStoreReadError({
                threadId,
                cause,
              }),
        ),
      ),
  );

  return { readCanonicalProjection };
});

export type ReadCanonicalProjectionPart = ReturnType<typeof installReadCanonicalProjection> extends Effect.Effect<infer A, infer _E, infer _R> ? A : ReturnType<typeof installReadCanonicalProjection>;
