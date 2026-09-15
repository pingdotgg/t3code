import {
  RuntimeTaskUsage,
  type ThreadId,
  type ProviderInstanceId,
  type RuntimeTaskId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

const usageJson = Schema.fromJsonString(RuntimeTaskUsage);
const decodeUsage = Schema.decodeUnknownEffect(usageJson);
const encodeUsage = Schema.encodeEffect(usageJson);

export const recordCodexChildUsage = Effect.fn("recordCodexChildUsage")(function* (
  sql: SqlClient.SqlClient,
  input: {
    threadId: ThreadId;
    instanceId: ProviderInstanceId;
    taskId: RuntimeTaskId;
    toolItemId?: string;
    childTurnId?: string;
    usage?: RuntimeTaskUsage;
  },
) {
  const { threadId, instanceId, taskId } = input;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`
        INSERT INTO codex_child_usage (thread_id, instance_id, task_id)
        VALUES (${threadId}, ${instanceId}, ${taskId}) ON CONFLICT DO NOTHING
      `;
      const inserted =
        input.toolItemId === undefined
          ? []
          : yield* sql`
        INSERT INTO codex_child_tool_calls (thread_id, instance_id, task_id, turn_id, item_id)
        VALUES (${threadId}, ${instanceId}, ${taskId}, ${input.childTurnId ?? ""}, ${input.toolItemId})
        ON CONFLICT DO NOTHING RETURNING item_id
      `;
      const [previous] = yield* sql<{ usageJson: string }>`
        SELECT usage_json AS "usageJson" FROM codex_child_usage
        WHERE thread_id = ${threadId} AND instance_id = ${instanceId} AND task_id = ${taskId}
      `;
      const usage = { ...(yield* decodeUsage(previous!.usageJson)) };
      for (const key of [
        "totalTokens",
        "inputTokens",
        "cachedInputTokens",
        "outputTokens",
        "reasoningOutputTokens",
      ] as const) {
        const value = input.usage?.[key];
        if (value !== undefined) usage[key] = Math.max(usage[key] ?? 0, value);
      }
      const [updated] = yield* sql<{ toolUses: number }>`
        UPDATE codex_child_usage
        SET usage_json = ${yield* encodeUsage(usage)}, tool_uses = tool_uses + ${inserted.length}
        WHERE thread_id = ${threadId} AND instance_id = ${instanceId} AND task_id = ${taskId}
        RETURNING tool_uses AS "toolUses"
      `;
      return { ...usage, toolUses: updated!.toolUses };
    }),
  );
});
