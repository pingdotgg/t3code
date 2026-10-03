import { ModelSelection } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { getCodexServiceTierOptionValue } from "../codexModelOptions.ts";
import type { UsageRecord, UsageSpeed } from "./usageTranscripts.ts";

export class CodexUsageHistoryReadError extends Schema.TaggedError<CodexUsageHistoryReadError>()(
  "CodexUsageHistoryReadError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not read historical Codex usage tiers.";
  }
}

const decodeSelection = Schema.decodeUnknownOption(Schema.fromJsonString(ModelSelection));
const encodeTurnIds = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));

export class CodexUsageHistory extends Context.Service<
  CodexUsageHistory,
  {
    readonly resolve: (
      records: readonly UsageRecord[],
    ) => Effect.Effect<ReadonlyMap<UsageRecord, UsageSpeed>, CodexUsageHistoryReadError>;
  }
>()("t3/usage/CodexUsageHistory") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const resolve = Effect.fn("CodexUsageHistory.resolve")(function* (
    records: readonly UsageRecord[],
  ) {
    const resolved = new Map<UsageRecord, UsageSpeed>();
    if (records.length === 0) return resolved;
    const turnIds = [...new Set(records.flatMap((record) => record.unresolvedCodexTurnId ?? []))];
    if (turnIds.length === 0) return resolved;
    const turnIdsJson = encodeTurnIds(turnIds);

    // The attempt retains its native destination even if the provider thread is
    // rebound. Its first running event retains the selection before later steers
    // or retries mutate the run projection. Read only these indexed streams.
    const rows = yield* sql<{
      native_thread_id: string | null;
      native_turn_id: string;
      selection_json: string | null;
    }>`
      SELECT json_extract(attempt.payload_json, '$.nativeThreadId') AS native_thread_id,
        json_extract(turn.payload_json, '$.nativeTurnRef.nativeId') AS native_turn_id,
        (
          SELECT json_extract(event.payload_json, '$.modelSelection')
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
        ) AS selection_json
      FROM orchestration_v2_projection_provider_turns AS turn
      JOIN orchestration_v2_projection_run_attempts AS attempt
        ON attempt.attempt_id = turn.run_attempt_id
        AND attempt.thread_id = turn.thread_id
        AND attempt.provider_thread_id = turn.provider_thread_id
      WHERE json_extract(turn.payload_json, '$.nativeTurnRef.driver') = 'codex'
        AND json_extract(turn.payload_json, '$.nativeTurnRef.nativeId') IN (
          SELECT value FROM json_each(${turnIdsJson})
        )
    `.pipe(Effect.mapError((cause) => new CodexUsageHistoryReadError({ cause })));

    const byTurn = new Map<string, typeof rows>();
    for (const row of rows) {
      const id = row.native_turn_id;
      byTurn.set(id, [...(byTurn.get(id) ?? []), row]);
    }
    for (const record of records) {
      if (record.unresolvedCodexTurnId === undefined) continue;
      const matches = byTurn.get(record.unresolvedCodexTurnId);
      // Ambiguous mappings must not turn a conservative estimate into a guess.
      if (matches?.length !== 1) continue;
      const match = matches[0]!;
      if (match.native_thread_id !== record.sessionId) continue;
      const selection = decodeSelection(match.selection_json);
      if (Option.isNone(selection) || selection.value.model !== record.model) continue;
      const tier = getCodexServiceTierOptionValue(selection.value);
      if (tier === "fast" || tier === "priority") resolved.set(record, "fast");
      else if (tier === "ultrafast") resolved.set(record, "ultrafast");
      else if (tier === undefined || tier === "default" || tier === "standard") {
        resolved.set(record, "standard");
      }
    }
    return resolved;
  });
  return CodexUsageHistory.of({ resolve });
});

export const layer = Layer.effect(CodexUsageHistory, make);
