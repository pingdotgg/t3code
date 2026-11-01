import { ModelSelection } from "@t3tools/contracts";
import type { UsageSpeed } from "@t3tools/provider-core/server/usage";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { getCodexServiceTierOptionValue } from "../codexModelOptions.ts";

export class CodexUsageHistoryReadError extends Schema.TaggedError<CodexUsageHistoryReadError>()(
  "CodexUsageHistoryReadError",
  { requestedTurnCount: Schema.Number, cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not read historical Codex usage tiers.";
  }
}

const decodeSelection = Schema.decodeUnknownOption(Schema.fromJsonString(ModelSelection));
const encodeTurnIds = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));

export interface CodexUsageHistoryRequest {
  readonly sessionId: string;
  readonly nativeTurnId: string;
  readonly model: string;
}

export class CodexUsageHistory extends Context.Service<
  CodexUsageHistory,
  {
    readonly resolve: (
      requests: readonly CodexUsageHistoryRequest[],
    ) => Effect.Effect<
      ReadonlyMap<CodexUsageHistoryRequest, UsageSpeed>,
      CodexUsageHistoryReadError
    >;
  }
>()("t3/usage/CodexUsageHistory") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const resolve = Effect.fn("CodexUsageHistory.resolve")(function* (
    requests: readonly CodexUsageHistoryRequest[],
  ) {
    const resolved = new Map<CodexUsageHistoryRequest, UsageSpeed>();
    if (requests.length === 0) return resolved;
    const turnIdsJson = encodeTurnIds([
      ...new Set(requests.map((request) => request.nativeTurnId)),
    ]);

    // The first running event for this attempt precedes any steering changes
    // to the selection. A missing selection there must not fall through to a later event.
    const rows = yield* sql<{
      readonly native_thread_id: string | null;
      readonly native_turn_id: string;
      readonly selection_json: string | null;
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
      LEFT JOIN orchestration_v2_projection_run_attempts AS attempt
        ON attempt.attempt_id = turn.run_attempt_id
        AND attempt.thread_id = turn.thread_id
        AND attempt.provider_thread_id = turn.provider_thread_id
      WHERE json_extract(turn.payload_json, '$.nativeTurnRef.driver') = 'codex'
        AND json_extract(turn.payload_json, '$.nativeTurnRef.nativeId') IN (
          SELECT value FROM json_each(${turnIdsJson})
        )
    `.pipe(
      NodeSqliteClient.readOnly,
      Effect.mapError(
        (cause) => new CodexUsageHistoryReadError({ requestedTurnCount: requests.length, cause }),
      ),
    );

    // Keep duplicates ambiguous even when an attempt is missing or its destination differs.
    const byTurn = new Map<string, (typeof rows)[number] | null>();
    for (const row of rows) {
      byTurn.set(row.native_turn_id, byTurn.has(row.native_turn_id) ? null : row);
    }
    for (const request of requests) {
      const match = byTurn.get(request.nativeTurnId);
      if (!match || match.native_thread_id !== request.sessionId) continue;
      const selection = decodeSelection(match.selection_json);
      if (Option.isNone(selection) || selection.value.model !== request.model) continue;
      if (
        selection.value.options?.some(
          (option) => option.id === "serviceTier" && typeof option.value !== "string",
        )
      )
        continue;
      const tier = getCodexServiceTierOptionValue(selection.value);
      if (tier === "fast" || tier === "priority") resolved.set(request, "fast");
      else if (tier === "ultrafast") resolved.set(request, "ultrafast");
      else if (tier === undefined || tier === "default" || tier === "standard") {
        resolved.set(request, "standard");
      }
    }
    return resolved;
  });
  return CodexUsageHistory.of({ resolve });
});

export const layer = Layer.effect(CodexUsageHistory, make);
