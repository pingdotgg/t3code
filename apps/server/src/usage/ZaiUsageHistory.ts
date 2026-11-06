import {
  ZaiUsageHistory,
  ZaiUsageHistoryReadError,
  type ZaiGlmUsageTurn,
} from "@t3tools/provider-acp-registry/server";
import { parseTimestampMs, tokenCount } from "@t3tools/provider-core/server/usage";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";

export { ZaiUsageHistory, ZaiUsageHistoryReadError } from "@t3tools/provider-acp-registry/server";

// `unavailable` turns and payloads without recorded usage fail decoding and are skipped.
// The run row reflects later steering, so the instance and model come from the attempt.
const GlmTurnUsageJson = Schema.Struct({
  usageStatus: Schema.Literals(["complete", "partial"]),
  inputTokens: Schema.optional(Schema.Number),
  cachedInputTokens: Schema.optional(Schema.Number),
  cacheCreationTokens: Schema.optional(Schema.Number),
  outputTokens: Schema.optional(Schema.Number),
  reasoningTokens: Schema.optional(Schema.Number),
});
const decodeGlmTurnUsage = Schema.decodeUnknownOption(Schema.fromJsonString(GlmTurnUsageJson));
const encodeInstanceIds = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const config = yield* ServerConfig.ServerConfig;

  const readGlmTurns = Effect.fn("ZaiUsageHistory.readGlmTurns")(function* (input: {
    readonly instanceIds: ReadonlyArray<string>;
    readonly sinceMs: number;
  }) {
    if (input.instanceIds.length === 0) return [];
    const instanceIdsJson = encodeInstanceIds([...new Set(input.instanceIds)]);
    const rows = yield* sql<{
      readonly provider_turn_id: string;
      readonly provider_thread_id: string;
      readonly completed_at: string | null;
      readonly turn_usage_json: string | null;
      readonly model: string | null;
    }>`
      SELECT turn.provider_turn_id AS provider_turn_id,
        turn.provider_thread_id AS provider_thread_id,
        turn.completed_at AS completed_at,
        json_extract(turn.payload_json, '$.turnTokenUsage') AS turn_usage_json,
        (
          SELECT json_extract(event.payload_json, '$.modelSelection.model')
          FROM orchestration_events AS event
          WHERE event.aggregate_kind = 'thread'
            AND event.application_event_version = 2
            AND event.stream_id = attempt.thread_id
            AND event.event_type = 'run.updated'
            AND json_extract(event.payload_json, '$.id') = attempt.run_id
            AND json_extract(event.payload_json, '$.activeAttemptId') = attempt.attempt_id
            AND json_extract(event.payload_json, '$.status') = 'running'
          ORDER BY event.sequence
          LIMIT 1
        ) AS model
      FROM orchestration_v2_projection_provider_turns AS turn
      JOIN orchestration_v2_projection_run_attempts AS attempt
        ON attempt.attempt_id = turn.run_attempt_id
      WHERE attempt.provider_instance_id IN (SELECT value FROM json_each(${instanceIdsJson}))
        AND json_extract(turn.payload_json, '$.nativeTurnRef.driver') = 'acpRegistry'
        AND turn.completed_at >= ${DateTime.formatIso(DateTime.makeUnsafe(input.sinceMs))}
      ORDER BY turn.completed_at, turn.provider_turn_id
    `.pipe(
      NodeSqliteClient.readOnly,
      Effect.mapError(
        (cause) =>
          new ZaiUsageHistoryReadError({
            requestedInstanceCount: input.instanceIds.length,
            cause,
          }),
      ),
    );
    const turns: ZaiGlmUsageTurn[] = [];
    for (const row of rows) {
      const completedAtMs = parseTimestampMs(row.completed_at);
      if (completedAtMs === null) continue;
      const model = row.model?.trim() ?? "";
      if (model.length === 0) continue;
      const usage = decodeGlmTurnUsage(row.turn_usage_json);
      if (Option.isNone(usage)) continue;
      turns.push({
        providerTurnId: row.provider_turn_id,
        providerThreadId: row.provider_thread_id,
        completedAtMs,
        model,
        inputTokens: tokenCount(usage.value.inputTokens),
        cachedInputTokens: tokenCount(usage.value.cachedInputTokens),
        cacheCreationTokens: tokenCount(usage.value.cacheCreationTokens),
        outputTokens: tokenCount(usage.value.outputTokens),
        reasoningTokens: tokenCount(usage.value.reasoningTokens),
      });
    }
    return turns;
  });

  return ZaiUsageHistory.of({ readGlmTurns, databasePath: config.dbPath });
});

export const layer = Layer.effect(ZaiUsageHistory, make);
