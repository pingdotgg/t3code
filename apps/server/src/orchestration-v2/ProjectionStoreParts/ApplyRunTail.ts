import * as Effect from "effect/Effect";
import { isQueuedProviderThreadPlaceholder, type PayloadRow, type ProjectionStoreV2Shape, upsertProviderTurn } from "../ProjectionStorePrelude/ProjectionStoreV2Shape.ts";
import { decodeProviderTurnPayload, decodeThreadPayload, encodeNodePayload, encodeProviderSessionPayload, encodeProviderThreadPayload, encodeProviderTurnPayload, encodeRestartCancelledBackgroundWork, encodeRunAttemptPayload, encodeRunPayload, encodeSubagentPayload, encodeThreadPayload, nullableStringField, parseEncodedPayload, stringField } from "../ProjectionStorePrelude/BuildVisibleTurnItems.ts";
import type { ApplyRecordTailPart } from "./ApplyRecordTail.ts";

type Deps = Record<never, never> & ApplyRecordTailPart;

export const installApplyRunTail = Effect.fnUntraced(function* (deps: Deps) {
  const { applyRecordTail, keepRecordedRunField, sql } = deps;

const applyRunTail = Effect.fnUntraced(function* (
    event: Parameters<ProjectionStoreV2Shape["apply"]>[0],
  ) {
    switch (event.type) {
          case "run.created":
          case "run.updated": {
            const payloadJson = yield* encodeRunPayload(event.payload);
            const payload = parseEncodedPayload(payloadJson);
            yield* sql`
            INSERT INTO orchestration_v2_projection_runs (
              run_id,
              thread_id,
              ordinal,
              provider,
              provider_instance_id,
              provider_thread_id,
              status,
              requested_at,
              completed_at,
              payload_json
            )
            VALUES (
              ${event.payload.id},
              ${event.payload.threadId},
              ${event.payload.ordinal},
              ${event.payload.providerInstanceId},
              ${event.payload.providerInstanceId},
              ${event.payload.providerThreadId},
              ${event.payload.status},
              ${stringField(payload, "requestedAt")},
              ${nullableStringField(payload, "completedAt")},
              ${payloadJson}
            )
            ON CONFLICT(run_id)
            DO UPDATE SET
              thread_id = excluded.thread_id,
              ordinal = excluded.ordinal,
              provider = excluded.provider,
              provider_instance_id = excluded.provider_instance_id,
              provider_thread_id = excluded.provider_thread_id,
              status = excluded.status,
              requested_at = excluded.requested_at,
              completed_at = excluded.completed_at,
              payload_json = ${keepRecordedRunField(
                keepRecordedRunField(sql`excluded.payload_json`, "$.delegatedCompletion"),
                "$.restartCancelledBackgroundWork",
              )}
          `;
            break;
          }
          case "run.background-work-cancelled": {
            // Only this field changes, so a concurrent lifecycle write is never regressed.
            const workJson = yield* encodeRestartCancelledBackgroundWork(
              event.payload.restartCancelledBackgroundWork,
            );
            yield* sql`
            UPDATE orchestration_v2_projection_runs
            SET payload_json = json_set(
              payload_json,
              '$.restartCancelledBackgroundWork',
              json(${workJson})
            )
            WHERE run_id = ${event.payload.runId} AND thread_id = ${event.threadId}
          `;
            break;
          }
          case "run-attempt.created":
          case "run-attempt.updated": {
            const payloadJson = yield* encodeRunAttemptPayload(event.payload);
            yield* sql`
            INSERT INTO orchestration_v2_projection_run_attempts (
              attempt_id,
              thread_id,
              run_id,
              attempt_ordinal,
              root_node_id,
              provider,
              provider_instance_id,
              provider_thread_id,
              provider_turn_id,
              status,
              payload_json
            )
            VALUES (
              ${event.payload.id},
              ${event.threadId},
              ${event.payload.runId},
              ${event.payload.attemptOrdinal},
              ${event.payload.rootNodeId},
              ${event.payload.providerInstanceId},
              ${event.payload.providerInstanceId},
              ${event.payload.providerThreadId},
              ${event.payload.providerTurnId},
              ${event.payload.status},
              ${payloadJson}
            )
            ON CONFLICT(attempt_id)
            DO UPDATE SET
              thread_id = excluded.thread_id,
              run_id = excluded.run_id,
              attempt_ordinal = excluded.attempt_ordinal,
              root_node_id = excluded.root_node_id,
              provider = excluded.provider,
              provider_instance_id = excluded.provider_instance_id,
              provider_thread_id = excluded.provider_thread_id,
              provider_turn_id = excluded.provider_turn_id,
              status = excluded.status,
              payload_json = excluded.payload_json
          `;
            break;
          }
          case "node.updated": {
            const payloadJson = yield* encodeNodePayload(event.payload);
            const payload = parseEncodedPayload(payloadJson);
            yield* sql`
            INSERT INTO orchestration_v2_projection_nodes (
              node_id,
              thread_id,
              run_id,
              parent_node_id,
              root_node_id,
              kind,
              status,
              provider_thread_id,
              provider_turn_id,
              started_at,
              completed_at,
              payload_json
            )
            VALUES (
              ${event.payload.id},
              ${event.payload.threadId},
              ${event.payload.runId},
              ${event.payload.parentNodeId},
              ${event.payload.rootNodeId},
              ${event.payload.kind},
              ${event.payload.status},
              ${event.payload.providerThreadId},
              ${event.payload.providerTurnId},
              ${nullableStringField(payload, "startedAt")},
              ${nullableStringField(payload, "completedAt")},
              ${payloadJson}
            )
            ON CONFLICT(node_id)
            DO UPDATE SET
              thread_id = excluded.thread_id,
              run_id = excluded.run_id,
              parent_node_id = excluded.parent_node_id,
              root_node_id = excluded.root_node_id,
              kind = excluded.kind,
              status = excluded.status,
              provider_thread_id = excluded.provider_thread_id,
              provider_turn_id = excluded.provider_turn_id,
              started_at = excluded.started_at,
              completed_at = excluded.completed_at,
              payload_json = excluded.payload_json
          `;
            break;
          }
          case "subagent.updated": {
            const payloadJson = yield* encodeSubagentPayload(event.payload);
            const payload = parseEncodedPayload(payloadJson);
            yield* sql`
            INSERT INTO orchestration_v2_projection_subagents (
              subagent_id,
              thread_id,
              run_id,
              parent_node_id,
              provider,
              driver,
              provider_instance_id,
              provider_thread_id,
              child_thread_id,
              origin,
              status,
              started_at,
              completed_at,
              updated_at,
              completion_delivery_state,
              payload_json
            )
            VALUES (
              ${event.payload.id},
              ${event.payload.threadId},
              ${event.payload.runId},
              ${event.payload.parentNodeId},
              ${event.payload.providerInstanceId},
              ${event.payload.driver},
              ${event.payload.providerInstanceId},
              ${event.payload.providerThreadId},
              ${event.payload.childThreadId},
              ${event.payload.origin},
              ${event.payload.status},
              ${nullableStringField(payload, "startedAt")},
              ${nullableStringField(payload, "completedAt")},
              ${stringField(payload, "updatedAt")},
              ${event.payload.completionDelivery?.state ?? null},
              ${payloadJson}
            )
            ON CONFLICT(subagent_id)
            DO UPDATE SET
              thread_id = excluded.thread_id,
              run_id = excluded.run_id,
              parent_node_id = excluded.parent_node_id,
              provider = excluded.provider,
              driver = excluded.driver,
              provider_instance_id = excluded.provider_instance_id,
              provider_thread_id = excluded.provider_thread_id,
              child_thread_id = excluded.child_thread_id,
              origin = excluded.origin,
              status = excluded.status,
              started_at = excluded.started_at,
              completed_at = excluded.completed_at,
              updated_at = excluded.updated_at,
              completion_delivery_state = COALESCE(
                excluded.completion_delivery_state,
                orchestration_v2_projection_subagents.completion_delivery_state
              ),
              payload_json = CASE
                WHEN json_type(excluded.payload_json, '$.completionDelivery') IS NULL
                  AND json_type(orchestration_v2_projection_subagents.payload_json, '$.completionDelivery') IS NOT NULL
                THEN json_set(
                  excluded.payload_json,
                  '$.completionDelivery',
                  json_extract(
                    orchestration_v2_projection_subagents.payload_json,
                    '$.completionDelivery'
                  )
                )
                ELSE excluded.payload_json
              END
          `;
            break;
          }
          case "provider-session.attached":
          case "provider-session.updated": {
            const payloadJson = yield* encodeProviderSessionPayload(event.payload);
            const payload = parseEncodedPayload(payloadJson);
            yield* sql`
            INSERT INTO orchestration_v2_projection_provider_sessions (
              provider_session_id,
              thread_id,
              provider,
              driver,
              provider_instance_id,
              status,
              updated_at,
              payload_json
            )
            VALUES (
              ${event.payload.id},
              ${event.threadId},
              ${event.payload.providerInstanceId},
              ${event.payload.driver},
              ${event.payload.providerInstanceId},
              ${event.payload.status},
              ${stringField(payload, "updatedAt")},
              ${payloadJson}
            )
            ON CONFLICT(provider_session_id)
            DO UPDATE SET
              thread_id = excluded.thread_id,
              provider = excluded.provider,
              driver = excluded.driver,
              provider_instance_id = excluded.provider_instance_id,
              status = excluded.status,
              updated_at = excluded.updated_at,
              payload_json = excluded.payload_json
          `;
            if (event.type === "provider-session.attached") {
              yield* sql`
              INSERT OR IGNORE INTO orchestration_v2_projection_provider_session_bindings (
                provider_session_id,
                thread_id
              )
              VALUES (${event.payload.id}, ${event.threadId})
            `;
            }
            break;
          }
          case "provider-session.detached": {
            yield* sql`
            DELETE FROM orchestration_v2_projection_provider_session_bindings
            WHERE provider_session_id = ${event.payload.providerSessionId}
              AND thread_id = ${event.threadId}
          `;
            break;
          }
          case "provider-thread.updated": {
            const payloadJson = yield* encodeProviderThreadPayload(event.payload);
            const payload = parseEncodedPayload(payloadJson);
            yield* sql`
            INSERT INTO orchestration_v2_projection_provider_threads (
              provider_thread_id,
              thread_id,
              owner_node_id,
              provider,
              driver,
              provider_instance_id,
              provider_session_id,
              status,
              first_run_ordinal,
              last_run_ordinal,
              updated_at,
              payload_json
            )
            VALUES (
              ${event.payload.id},
              ${event.payload.appThreadId},
              ${event.payload.ownerNodeId},
              ${event.payload.providerInstanceId},
              ${event.payload.driver},
              ${event.payload.providerInstanceId},
              ${event.payload.providerSessionId},
              ${event.payload.status},
              ${event.payload.firstRunOrdinal},
              ${event.payload.lastRunOrdinal},
              ${stringField(payload, "updatedAt")},
              ${payloadJson}
            )
            ON CONFLICT(provider_thread_id)
            DO UPDATE SET
              thread_id = excluded.thread_id,
              owner_node_id = excluded.owner_node_id,
              provider = excluded.provider,
              driver = excluded.driver,
              provider_instance_id = excluded.provider_instance_id,
              provider_session_id = excluded.provider_session_id,
              status = excluded.status,
              first_run_ordinal = excluded.first_run_ordinal,
              last_run_ordinal = excluded.last_run_ordinal,
              updated_at = excluded.updated_at,
              payload_json = excluded.payload_json
          `;
            if (
              event.payload.appThreadId !== null &&
              !isQueuedProviderThreadPlaceholder(event.payload)
            ) {
              const threadRows = yield* sql<PayloadRow>`
              SELECT payload_json
              FROM orchestration_v2_projection_threads
              WHERE thread_id = ${event.payload.appThreadId}
              LIMIT 1
            `;
              const threadRow = threadRows[0];
              if (threadRow !== undefined) {
                const thread = yield* decodeThreadPayload(threadRow.payload_json);
                const updatedThread = {
                  ...thread,
                  activeProviderThreadId: event.payload.id,
                  updatedAt: event.payload.updatedAt,
                };
                const updatedThreadPayloadJson = yield* encodeThreadPayload(updatedThread);
                yield* sql`
                UPDATE orchestration_v2_projection_threads
                SET
                  active_provider_thread_id = ${event.payload.id},
                  updated_at = ${stringField(parseEncodedPayload(updatedThreadPayloadJson), "updatedAt")},
                  payload_json = ${updatedThreadPayloadJson}
                WHERE thread_id = ${event.payload.appThreadId}
              `;
              }
            }
            break;
          }
          case "provider-turn.updated": {
            const existingRows =
              event.payload.tokenUsage === undefined
                ? yield* sql<PayloadRow>`
                  SELECT payload_json
                  FROM orchestration_v2_projection_provider_turns
                  WHERE provider_turn_id = ${event.payload.id}
                  LIMIT 1
                `
                : [];
            const existing = existingRows[0];
            const providerTurn =
              existing === undefined
                ? event.payload
                : upsertProviderTurn(
                    [yield* decodeProviderTurnPayload(existing.payload_json)],
                    event.payload,
                  )[0]!;
            const payloadJson = yield* encodeProviderTurnPayload(providerTurn);
            const payload = parseEncodedPayload(payloadJson);
            yield* sql`
            INSERT INTO orchestration_v2_projection_provider_turns (
              provider_turn_id,
              thread_id,
              provider_thread_id,
              node_id,
              run_attempt_id,
              ordinal,
              status,
              started_at,
              completed_at,
              payload_json
            )
            VALUES (
              ${event.payload.id},
              ${event.threadId},
              ${providerTurn.providerThreadId},
              ${providerTurn.nodeId},
              ${providerTurn.runAttemptId},
              ${providerTurn.ordinal},
              ${providerTurn.status},
              ${nullableStringField(payload, "startedAt")},
              ${nullableStringField(payload, "completedAt")},
              ${payloadJson}
            )
            ON CONFLICT(provider_turn_id)
            DO UPDATE SET
              thread_id = excluded.thread_id,
              provider_thread_id = excluded.provider_thread_id,
              node_id = excluded.node_id,
              run_attempt_id = excluded.run_attempt_id,
              ordinal = excluded.ordinal,
              status = excluded.status,
              started_at = excluded.started_at,
              completed_at = excluded.completed_at,
              payload_json = excluded.payload_json
          `;
            break;
          }
          default: {
            yield* applyRecordTail(event);
            break;
          }
    }
  });

  return { applyRunTail };
});

export type ApplyRunTailPart = ReturnType<typeof installApplyRunTail> extends Effect.Effect<infer A, infer _E, infer _R> ? A : ReturnType<typeof installApplyRunTail>;
