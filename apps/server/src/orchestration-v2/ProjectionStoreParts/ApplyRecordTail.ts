import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import type * as Statement from "effect/sql/Statement";
import { MCP_APP_OUTPUT_KEY } from "@t3tools/shared/mcpApp";
import { type PayloadRow, type ProjectionStoreV2Shape } from "../ProjectionStorePrelude/ProjectionStoreV2Shape.ts";
import { booleanInt, decodeThreadPayload, encodeCheckpointPayload, encodeCheckpointScopePayload, encodeContextHandoffPayload, encodeContextTransferPayload, encodeMessagePayload, encodePayloadTimestamp, encodePlanPayload, encodeRuntimeRequestPayload, encodeTurnItemPayload, isProjectionStoreThreadNotFoundError, nullableStringField, parseEncodedPayload, stringField } from "../ProjectionStorePrelude/BuildVisibleTurnItems.ts";
import { ProjectionStoreReadError, ProjectionStoreThreadNotFoundError } from "../ProjectionStorePrelude/ProjectionSettlementCandidate.ts";
type Deps = Record<never, never>;

export const installApplyRecordTail = Effect.fnUntraced(function* (deps: Deps) {
const sql = yield* SqlClient.SqlClient;

const inlineWorkOutput = sql`item.type = 'dynamic_tool' AND (
    item.payload_json LIKE '%htmlRender%' OR item.payload_json LIKE ${`%${MCP_APP_OUTPUT_KEY}%`}
    OR item.payload_json LIKE '%"viewedImagePath"%'
    OR item.payload_json LIKE '%"toolName":"%delegate_task"%')`;

const keepRecordedRunField = (payload: Statement.Fragment, path: string) => sql`
    CASE
      WHEN json_type(excluded.payload_json, ${path}) IS NULL
        AND json_type(orchestration_v2_projection_runs.payload_json, ${path}) IS NOT NULL
      THEN json_set(
        ${payload},
        ${path},
        json_extract(orchestration_v2_projection_runs.payload_json, ${path})
      )
      ELSE ${payload}
    END
  `;

const applyRecordTail = Effect.fnUntraced(function* (
    event: Parameters<ProjectionStoreV2Shape["apply"]>[0],
  ) {
    switch (event.type) {
          case "runtime-request.updated": {
            const payloadJson = yield* encodeRuntimeRequestPayload(event.payload);
            const payload = parseEncodedPayload(payloadJson);
            yield* sql`
            INSERT INTO orchestration_v2_projection_runtime_requests (
              runtime_request_id,
              thread_id,
              node_id,
              provider_turn_id,
              kind,
              status,
              created_at,
              resolved_at,
              payload_json
            )
            VALUES (
              ${event.payload.id},
              ${event.threadId},
              ${event.payload.nodeId},
              ${event.payload.providerTurnId},
              ${event.payload.kind},
              ${event.payload.status},
              ${stringField(payload, "createdAt")},
              ${nullableStringField(payload, "resolvedAt")},
              ${payloadJson}
            )
            ON CONFLICT(runtime_request_id)
            DO UPDATE SET
              thread_id = excluded.thread_id,
              node_id = excluded.node_id,
              provider_turn_id = excluded.provider_turn_id,
              kind = excluded.kind,
              status = excluded.status,
              created_at = excluded.created_at,
              resolved_at = excluded.resolved_at,
              payload_json = excluded.payload_json
          `;
            break;
          }
          case "message.updated": {
            const payloadJson = yield* encodeMessagePayload(event.payload);
            const createdAt = yield* encodePayloadTimestamp(event.payload.createdAt);
            const updatedAt = yield* encodePayloadTimestamp(event.payload.updatedAt);
            yield* sql`
            INSERT INTO orchestration_v2_projection_messages (
              message_id,
              thread_id,
              run_id,
              node_id,
              role,
              streaming,
              created_at,
              updated_at,
              payload_json
            )
            VALUES (
              ${event.payload.id},
              ${event.payload.threadId},
              ${event.payload.runId},
              ${event.payload.nodeId},
              ${event.payload.role},
              ${booleanInt(event.payload.streaming)},
              ${createdAt},
              ${updatedAt},
              ${payloadJson}
            )
            ON CONFLICT(message_id)
            DO UPDATE SET
              thread_id = excluded.thread_id,
              run_id = excluded.run_id,
              node_id = excluded.node_id,
              role = excluded.role,
              streaming = excluded.streaming,
              created_at = excluded.created_at,
              updated_at = excluded.updated_at,
              payload_json = excluded.payload_json
          `;
            break;
          }
          case "plan.updated": {
            const payloadJson = yield* encodePlanPayload(event.payload);
            yield* sql`
            INSERT INTO orchestration_v2_projection_plans (
              plan_id,
              thread_id,
              run_id,
              node_id,
              kind,
              status,
              payload_json
            )
            VALUES (
              ${event.payload.id},
              ${event.payload.threadId},
              ${event.payload.runId},
              ${event.payload.nodeId},
              ${event.payload.kind},
              ${event.payload.status},
              ${payloadJson}
            )
            ON CONFLICT(plan_id)
            DO UPDATE SET
              thread_id = excluded.thread_id,
              run_id = excluded.run_id,
              node_id = excluded.node_id,
              kind = excluded.kind,
              status = excluded.status,
              payload_json = excluded.payload_json
          `;
            break;
          }
          case "turn-item.updated": {
            const payloadJson = yield* encodeTurnItemPayload(event.payload);
            const updatedAt = yield* encodePayloadTimestamp(event.payload.updatedAt);
            yield* sql`
            INSERT INTO orchestration_v2_projection_turn_items (
              turn_item_id,
              thread_id,
              run_id,
              node_id,
              provider_thread_id,
              provider_turn_id,
              parent_item_id,
              ordinal,
              type,
              status,
              updated_at,
              payload_json
            )
            VALUES (
              ${event.payload.id},
              ${event.payload.threadId},
              ${event.payload.runId},
              ${event.payload.nodeId},
              ${event.payload.providerThreadId},
              ${event.payload.providerTurnId},
              ${event.payload.parentItemId},
              ${event.payload.ordinal},
              ${event.payload.type},
              ${event.payload.status},
              ${updatedAt},
              ${payloadJson}
            )
            ON CONFLICT(turn_item_id)
            DO UPDATE SET
              thread_id = excluded.thread_id,
              run_id = excluded.run_id,
              node_id = excluded.node_id,
              provider_thread_id = excluded.provider_thread_id,
              provider_turn_id = excluded.provider_turn_id,
              parent_item_id = excluded.parent_item_id,
              ordinal = excluded.ordinal,
              type = excluded.type,
              status = excluded.status,
              updated_at = excluded.updated_at,
              payload_json = excluded.payload_json
          `;
            break;
          }
          case "checkpoint-scope.created": {
            const payloadJson = yield* encodeCheckpointScopePayload(event.payload);
            const payload = parseEncodedPayload(payloadJson);
            yield* sql`
            INSERT INTO orchestration_v2_projection_checkpoint_scopes (
              scope_id,
              thread_id,
              run_id,
              node_id,
              provider_thread_id,
              kind,
              ordinal_within_parent,
              advances_app_run_count,
              created_at,
              payload_json
            )
            VALUES (
              ${event.payload.id},
              ${event.payload.threadId},
              ${event.payload.runId},
              ${event.payload.nodeId},
              ${event.payload.providerThreadId},
              ${event.payload.kind},
              ${event.payload.ordinalWithinParent},
              ${booleanInt(event.payload.advancesAppRunCount)},
              ${stringField(payload, "createdAt")},
              ${payloadJson}
            )
            ON CONFLICT(scope_id)
            DO UPDATE SET
              thread_id = excluded.thread_id,
              run_id = excluded.run_id,
              node_id = excluded.node_id,
              provider_thread_id = excluded.provider_thread_id,
              kind = excluded.kind,
              ordinal_within_parent = excluded.ordinal_within_parent,
              advances_app_run_count = excluded.advances_app_run_count,
              created_at = excluded.created_at,
              payload_json = excluded.payload_json
          `;
            break;
          }
          case "checkpoint.captured": {
            const payloadJson = yield* encodeCheckpointPayload(event.payload);
            const payload = parseEncodedPayload(payloadJson);
            yield* sql`
            INSERT INTO orchestration_v2_projection_checkpoints (
              checkpoint_id,
              thread_id,
              scope_id,
              run_id,
              node_id,
              ordinal_within_scope,
              app_run_ordinal,
              status,
              captured_at,
              payload_json
            )
            VALUES (
              ${event.payload.id},
              ${event.payload.threadId},
              ${event.payload.scopeId},
              ${event.payload.runId},
              ${event.payload.nodeId},
              ${event.payload.ordinalWithinScope},
              ${event.payload.appRunOrdinal},
              ${event.payload.status},
              ${stringField(payload, "capturedAt")},
              ${payloadJson}
            )
            ON CONFLICT(checkpoint_id)
            DO UPDATE SET
              thread_id = excluded.thread_id,
              scope_id = excluded.scope_id,
              run_id = excluded.run_id,
              node_id = excluded.node_id,
              ordinal_within_scope = excluded.ordinal_within_scope,
              app_run_ordinal = excluded.app_run_ordinal,
              status = excluded.status,
              captured_at = excluded.captured_at,
              payload_json = excluded.payload_json
          `;
            break;
          }
          case "checkpoint.rollback-requested":
            break;
          case "context-handoff.updated": {
            const payloadJson = yield* encodeContextHandoffPayload(event.payload);
            const payload = parseEncodedPayload(payloadJson);
            yield* sql`
            INSERT INTO orchestration_v2_projection_context_handoffs (
              context_handoff_id,
              thread_id,
              target_run_id,
              to_provider_thread_id,
              strategy,
              status,
              updated_at,
              payload_json
            )
            VALUES (
              ${event.payload.id},
              ${event.payload.threadId},
              ${event.payload.targetRunId},
              ${event.payload.toProviderThreadId},
              ${event.payload.strategy},
              ${event.payload.status},
              ${stringField(payload, "updatedAt")},
              ${payloadJson}
            )
            ON CONFLICT(context_handoff_id)
            DO UPDATE SET
              thread_id = excluded.thread_id,
              target_run_id = excluded.target_run_id,
              to_provider_thread_id = excluded.to_provider_thread_id,
              strategy = excluded.strategy,
              status = excluded.status,
              updated_at = excluded.updated_at,
              payload_json = excluded.payload_json
          `;
            break;
          }
          case "context-transfer.created":
          case "context-transfer.updated": {
            const payloadJson = yield* encodeContextTransferPayload(event.payload);
            const payload = parseEncodedPayload(payloadJson);
            yield* sql`
            INSERT INTO orchestration_v2_projection_context_transfers (
              context_transfer_id,
              source_thread_id,
              target_thread_id,
              target_run_id,
              type,
              status,
              updated_at,
              payload_json
            )
            VALUES (
              ${event.payload.id},
              ${event.payload.sourceThreadId},
              ${event.payload.targetThreadId},
              ${event.payload.targetRunId},
              ${event.payload.type},
              ${event.payload.status},
              ${stringField(payload, "updatedAt")},
              ${payloadJson}
            )
            ON CONFLICT(context_transfer_id)
            DO UPDATE SET
              source_thread_id = excluded.source_thread_id,
              target_thread_id = excluded.target_thread_id,
              target_run_id = excluded.target_run_id,
              type = excluded.type,
              status = excluded.status,
              updated_at = excluded.updated_at,
              payload_json = excluded.payload_json
          `;
            break;
          }
          default: {
            break;
          }
    }
  });

const getThread: ProjectionStoreV2Shape["getThread"] = Effect.fn("ProjectionStore.getThread")(
    function* (threadId) {
      const rows = yield* sql<PayloadRow>`
        SELECT payload_json FROM orchestration_v2_projection_threads
        WHERE thread_id = ${threadId}
      `;
      if (rows[0] === undefined) {
        return yield* new ProjectionStoreThreadNotFoundError({ threadId });
      }
      return yield* decodeThreadPayload(rows[0].payload_json);
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

  return { sql, inlineWorkOutput, keepRecordedRunField, applyRecordTail, getThread };
});

export type ApplyRecordTailPart = ReturnType<typeof installApplyRecordTail> extends Effect.Effect<infer A, infer _E, infer _R> ? A : ReturnType<typeof installApplyRecordTail>;
