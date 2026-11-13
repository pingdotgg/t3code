import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
// @effect-diagnostics anyUnknownInErrorContext:off
import { decodeCheckpointPayload, decodeCheckpointScopePayload, decodeContextHandoffPayload, decodeContextTransferPayload, decodeMessagePayload, decodeNodePayload, decodePlanJson, decodeProviderSessionPayload, decodeProviderThreadPayload, decodeProviderTurnPayload, decodeRows, decodeRunAttemptPayload, decodeRunPayload, decodeRuntimeRequestPayload, decodeSubagentPayload, decodeThreadPayload, decodeTurnItemPayload, isProjectionStoreReadError, isProjectionStoreThreadNotFoundError } from "../ProjectionStorePrelude/BuildVisibleTurnItems.ts";
import { ProjectionStoreReadError, ProjectionStoreSetupError, inheritsForkConversation } from "../ProjectionStorePrelude/ProjectionSettlementCandidate.ts";
import { type PayloadRow, type ProjectionStoreV2Shape } from "../ProjectionStorePrelude/ProjectionStoreV2Shape.ts";
import type { ApplyRecordTailPart } from "./ApplyRecordTail.ts";
import type { ApplyRunTailPart } from "./ApplyRunTail.ts";
import type { RetainedWindowRowsPart } from "./RetainedWindowRows.ts";
import type { ReadCanonicalProjectionPart } from "./ReadCanonicalProjection.ts";
import type { ReadProjectionPart } from "./ReadProjection.ts";

type Deps = Record<never, never> & ApplyRecordTailPart & ApplyRunTailPart & RetainedWindowRowsPart & ReadCanonicalProjectionPart & ReadProjectionPart;

export const installGetUnreadableThreadIds = Effect.fnUntraced(function* (deps: Deps) {
  const { getThread, readProjection, sql } = deps;

const getUnreadableThreadIds = Effect.fn("ProjectionStore.getUnreadableThreadIds")(
    function* () {
      const actualThreadIds = new Set<ThreadId>();
      const unreadable = new Set<ThreadId>();
      const forkChildren = new Map<ThreadId, Array<ThreadId>>();
      const tables: ReadonlyArray<{
        readonly name: string;
        readonly id: string;
        readonly decode: (payload: string, entityId: string) => Effect.Effect<unknown, unknown>;
      }> = [
        {
          name: "threads",
          id: "thread_id",
          decode: (payload: string, entityId: string) =>
            decodeThreadPayload(payload).pipe(
              Effect.tap((thread) =>
                Effect.sync(() => {
                  if (thread.forkedFrom?.type !== "run") return;
                  const sourceId = thread.forkedFrom.threadId;
                  const children = forkChildren.get(sourceId) ?? [];
                  children.push(ThreadId.make(entityId));
                  forkChildren.set(sourceId, children);
                }),
              ),
            ),
        },
        { name: "runs", id: "run_id", decode: (payload) => decodeRunPayload(payload) },
        {
          name: "run_attempts",
          id: "attempt_id",
          decode: (payload) => decodeRunAttemptPayload(payload),
        },
        { name: "nodes", id: "node_id", decode: (payload) => decodeNodePayload(payload) },
        {
          name: "subagents",
          id: "subagent_id",
          decode: (payload) => decodeSubagentPayload(payload),
        },
        {
          name: "provider_sessions",
          id: "provider_session_id",
          decode: (payload) => decodeProviderSessionPayload(payload),
        },
        {
          name: "provider_threads",
          id: "provider_thread_id",
          decode: (payload) => decodeProviderThreadPayload(payload),
        },
        {
          name: "provider_turns",
          id: "provider_turn_id",
          decode: (payload) => decodeProviderTurnPayload(payload),
        },
        {
          name: "runtime_requests",
          id: "runtime_request_id",
          decode: (payload) => decodeRuntimeRequestPayload(payload),
        },
        {
          name: "messages",
          id: "message_id",
          decode: (payload) => decodeMessagePayload(payload),
        },
        { name: "plans", id: "plan_id", decode: (payload) => decodePlanJson(payload) },
        {
          name: "turn_items",
          id: "turn_item_id",
          decode: (payload) => decodeTurnItemPayload(payload),
        },
        {
          name: "checkpoint_scopes",
          id: "scope_id",
          decode: (payload) => decodeCheckpointScopePayload(payload),
        },
        {
          name: "checkpoints",
          id: "checkpoint_id",
          decode: (payload) => decodeCheckpointPayload(payload),
        },
        {
          name: "context_handoffs",
          id: "context_handoff_id",
          decode: (payload) => decodeContextHandoffPayload(payload),
        },
        {
          name: "context_transfers",
          id: "context_transfer_id",
          decode: (payload) => decodeContextTransferPayload(payload),
        },
      ];
      const pageSize = 500;
      for (const table of tables) {
        let afterRowId = 0;
        while (true) {
          const rows = yield* sql<{
            readonly row_id: number;
            readonly entity_id: string;
            readonly thread_id: string | null;
            readonly target_thread_id: string | null;
            readonly payload_json: string;
          }>`
            SELECT rowid AS row_id, ${sql(table.id)} AS entity_id,
              ${sql(table.name === "context_transfers" ? "source_thread_id" : "thread_id")} AS thread_id,
              ${table.name === "context_transfers" ? sql`target_thread_id` : sql`NULL`} AS target_thread_id,
              payload_json
            FROM ${sql(`orchestration_v2_projection_${table.name}`)}
            WHERE rowid > ${afterRowId}
            ORDER BY rowid ASC LIMIT ${pageSize}
          `;
          for (const row of rows) {
            if (table.name === "threads") actualThreadIds.add(ThreadId.make(row.entity_id));
            const decoded = yield* Effect.exit(
              Effect.suspend(() => table.decode(row.payload_json, row.entity_id)),
            );
            if (decoded._tag === "Success") continue;
            if (table.name === "provider_sessions") {
              const bindings = yield* sql<{ readonly thread_id: string }>`
                SELECT thread_id FROM orchestration_v2_projection_provider_session_bindings
                WHERE provider_session_id = ${row.entity_id}
              `;
              for (const binding of bindings) unreadable.add(ThreadId.make(binding.thread_id));
            } else {
              if (row.thread_id !== null) unreadable.add(ThreadId.make(row.thread_id));
              if (row.target_thread_id !== null)
                unreadable.add(ThreadId.make(row.target_thread_id));
            }
            if (table.name === "provider_threads") {
              const owners = yield* sql<{ readonly thread_id: string }>`
                SELECT thread_id FROM orchestration_v2_projection_nodes
                WHERE node_id = (
                  SELECT owner_node_id FROM orchestration_v2_projection_provider_threads
                  WHERE provider_thread_id = ${row.entity_id}
                )
                UNION
                SELECT thread_id FROM orchestration_v2_projection_subagents
                WHERE provider_thread_id = ${row.entity_id}
              `;
              for (const owner of owners) unreadable.add(ThreadId.make(owner.thread_id));
            }
          }
          if (rows.length < pageSize) break;
          afterRowId = rows[rows.length - 1]!.row_id;
          yield* Effect.yieldNow;
        }
      }
      const pending = [
        ...unreadable,
        ...[...forkChildren.keys()].filter((sourceId) => !actualThreadIds.has(sourceId)),
      ];
      for (let index = 0; index < pending.length; index += 1) {
        for (const childId of forkChildren.get(pending[index]!) ?? []) {
          if (unreadable.has(childId)) continue;
          unreadable.add(childId);
          pending.push(childId);
        }
      }
      return [...unreadable].filter((threadId) => actualThreadIds.has(threadId)).sort();
    },
    Effect.mapError((cause) => new ProjectionStoreSetupError({ cause })),
  );

const javascriptTrimWhitespace =
    " \t\n\r\v\f\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff";

const getTurnStartContext: ProjectionStoreV2Shape["getTurnStartContext"] = (threadId, runId) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const thread = yield* getThread(threadId);
          const runs = yield* sql<PayloadRow>`
            SELECT payload_json FROM orchestration_v2_projection_runs
            WHERE thread_id = ${threadId} ORDER BY ordinal ASC
          `.pipe(Effect.flatMap(decodeRows(decodeRunPayload, threadId)));
          const attempts = yield* sql<PayloadRow>`
            SELECT payload_json FROM orchestration_v2_projection_run_attempts
            WHERE thread_id = ${threadId} ORDER BY run_id ASC, attempt_ordinal ASC
          `.pipe(Effect.flatMap(decodeRows(decodeRunAttemptPayload, threadId)));
          const nodes = yield* sql<PayloadRow>`
            SELECT payload_json FROM orchestration_v2_projection_nodes
            -- Look up the root node by key, not every node in the thread.
            INDEXED BY sqlite_autoindex_orchestration_v2_projection_nodes_1
            WHERE thread_id = ${threadId} AND node_id IN (SELECT json_extract(payload_json, '$.rootNodeId') FROM orchestration_v2_projection_runs WHERE thread_id = ${threadId} AND run_id = ${runId}) ORDER BY node_id ASC
          `.pipe(Effect.flatMap(decodeRows(decodeNodePayload, threadId)));
          const subagents = yield* sql<PayloadRow>`
            SELECT payload_json FROM orchestration_v2_projection_subagents
            WHERE thread_id = ${threadId} AND status NOT IN ('interrupted','failed','cancelled') ORDER BY subagent_id ASC
          `.pipe(Effect.flatMap(decodeRows(decodeSubagentPayload, threadId)));
          const providerThreads = yield* sql<PayloadRow>`
            SELECT payload_json FROM orchestration_v2_projection_provider_threads
            WHERE thread_id = ${threadId} ORDER BY COALESCE(first_run_ordinal, 0), provider_thread_id ASC
          `.pipe(Effect.flatMap(decodeRows(decodeProviderThreadPayload, threadId)));
          const providerTurns = yield* sql<PayloadRow>`
            SELECT payload_json FROM orchestration_v2_projection_provider_turns
            WHERE thread_id = ${threadId} ORDER BY provider_thread_id ASC, ordinal ASC
          `.pipe(Effect.flatMap(decodeRows(decodeProviderTurnPayload, threadId)));
          const checkpointScopes = yield* sql<PayloadRow>`
            SELECT payload_json FROM orchestration_v2_projection_checkpoint_scopes
            WHERE thread_id = ${threadId} AND scope_id IN ${sql.in(nodes.flatMap((node) => (node.checkpointScopeId === null ? [] : [node.checkpointScopeId])))} ORDER BY ordinal_within_parent ASC, scope_id ASC
          `.pipe(Effect.flatMap(decodeRows(decodeCheckpointScopePayload, threadId)));
          const contextHandoffs = yield* sql<PayloadRow>`
            SELECT payload_json FROM orchestration_v2_projection_context_handoffs
            WHERE thread_id = ${threadId} ORDER BY rowid ASC
          `.pipe(Effect.flatMap(decodeRows(decodeContextHandoffPayload, threadId)));
          const contextTransfers = yield* sql<PayloadRow>`
            SELECT payload_json FROM orchestration_v2_projection_context_transfers
            WHERE source_thread_id = ${threadId} OR target_thread_id = ${threadId} ORDER BY rowid ASC
          `.pipe(Effect.flatMap(decodeRows(decodeContextTransferPayload, threadId)));
          const turnItems = yield* sql<PayloadRow>`
            SELECT payload_json FROM orchestration_v2_projection_turn_items
            -- Look up one run's items by key, not by walking the thread's whole history in ordinal order.
            INDEXED BY orchestration_v2_projection_turn_items_run_ordinal_idx
            WHERE thread_id = ${threadId} AND run_id = ${runId} ORDER BY ordinal ASC, turn_item_id ASC
          `.pipe(Effect.flatMap(decodeRows(decodeTurnItemPayload, threadId)));
          const providerSessions = yield* sql<PayloadRow>`
            SELECT sessions.payload_json FROM orchestration_v2_projection_provider_sessions AS sessions
            INNER JOIN orchestration_v2_projection_provider_session_bindings AS bindings
              ON bindings.provider_session_id = sessions.provider_session_id
            WHERE bindings.thread_id = ${threadId}
            ORDER BY sessions.updated_at ASC, sessions.provider_session_id ASC
          `.pipe(Effect.flatMap(decodeRows(decodeProviderSessionPayload, threadId)));
          const messages = yield* sql<PayloadRow>`
            SELECT payload_json FROM orchestration_v2_projection_messages
            WHERE thread_id = ${threadId} AND (
              message_id IN (SELECT json_extract(payload_json, '$.userMessageId') FROM orchestration_v2_projection_runs
                WHERE thread_id = ${threadId} AND run_id = ${runId})
              OR (role = 'user' AND lower(trim(json_extract(payload_json, '$.text'), ${javascriptTrimWhitespace})) = '/compact')
              -- Earlier /goal turns defer context too; parseGoalCommand narrows this prefix match.
              OR (role = 'user' AND trim(json_extract(payload_json, '$.text'), ${javascriptTrimWhitespace}) GLOB '/goal*')
            ) ORDER BY created_at ASC, message_id ASC
          `.pipe(Effect.flatMap(decodeRows(decodeMessagePayload, threadId)));
          const conversation = yield* sql<{ present: number }>`
            SELECT EXISTS(
              SELECT 1 FROM orchestration_v2_projection_messages
              WHERE thread_id = ${threadId} AND role = 'user'
                  AND (lower(trim(json_extract(payload_json, '$.text'), ${javascriptTrimWhitespace})) <> '/compact'
                    OR json_array_length(payload_json, '$.attachments') > 0)
            ) AS present
          `;
          return {
            hasConversation:
              conversation[0]?.present === 1 ||
              inheritsForkConversation({ thread, contextTransfers, contextHandoffs }),
            thread,
            runs,
            attempts,
            nodes,
            subagents,
            providerSessions,
            providerThreads,
            providerTurns,
            messages,
            checkpointScopes,
            contextHandoffs,
            contextTransfers,
            turnItems,
          };
        }),
      )
      .pipe(
        Effect.mapError((cause) =>
          isProjectionStoreThreadNotFoundError(cause)
            ? cause
            : new ProjectionStoreReadError({ threadId, cause }),
        ),
      );

const getTurnStartHistory: ProjectionStoreV2Shape["getTurnStartHistory"] = Effect.fn(
    "ProjectionStore.getTurnStartHistory",
  )(
    function* (threadId, runIds) {
      const rows = yield* sql<PayloadRow>`
        SELECT payload_json FROM orchestration_v2_projection_turn_items
        WHERE thread_id = ${threadId}
          AND type IN ('user_message','assistant_message','command_execution','error',
            'run_interrupt_result','file_change','proposed_plan')
          AND ${runIds === undefined ? sql`1` : sql`run_id IN ${sql.in(runIds)}`}
        ORDER BY ordinal ASC, turn_item_id ASC
      `;
      return yield* decodeRows(decodeTurnItemPayload, threadId)(rows);
    },
    (effect, threadId, _runIds) =>
      effect.pipe(Effect.mapError((cause) => new ProjectionStoreReadError({ threadId, cause }))),
  );

const getThreadProjection: ProjectionStoreV2Shape["getThreadProjection"] = (threadId) =>
    sql
      .withTransaction(readProjection(threadId, new Set()))
      .pipe(
        Effect.mapError((cause) =>
          isProjectionStoreThreadNotFoundError(cause) || isProjectionStoreReadError(cause)
            ? cause
            : new ProjectionStoreReadError({ threadId, cause }),
        ),
      );

  return { getUnreadableThreadIds, javascriptTrimWhitespace, getTurnStartContext, getTurnStartHistory, getThreadProjection };
});

export type GetUnreadableThreadIdsPart = ReturnType<typeof installGetUnreadableThreadIds> extends Effect.Effect<infer A, infer _E, infer _R> ? A : ReturnType<typeof installGetUnreadableThreadIds>;
