import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import type * as AcpSchema from "effect-acp/compat";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import type { AcpToolCallState } from "@t3tools/provider-acp/server/runtimeModel";
import type {
  AcpAdapterV2ExtensionContext,
  AcpAdapterV2SubagentUpdate,
} from "@t3tools/provider-acp/server/adapter";

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function normalizeDevinSessionUpdate(
  notification: AcpSchema.SessionNotification,
): AcpSchema.SessionNotification {
  const update = notification.update;
  const meta = record("_meta" in update ? update._meta : undefined);
  const parentAgentId = record(meta?.["cognition.ai/subagent_context"])?.parentAgentId;
  const routed =
    typeof parentAgentId === "string" && parentAgentId !== "root"
      ? { ...notification, sessionId: parentAgentId }
      : notification;
  const messageId = meta?.["cognition.ai/streamingMessageId"];
  if (
    (update.sessionUpdate === "agent_message_chunk" ||
      update.sessionUpdate === "agent_thought_chunk") &&
    typeof messageId === "string"
  ) {
    return { ...routed, update: { ...update, messageId } };
  }
  return routed;
}

export function normalizeDevinToolCall(tool: AcpToolCallState): AcpToolCallState {
  const name = record(tool.data.meta)?.["cognition.ai/inferenceToolName"];
  return typeof name === "string" && (!tool.title || tool.title === "Tool")
    ? { ...tool, title: name }
    : tool;
}

export function extractDevinSubagentUpdate(
  tool: AcpToolCallState,
): AcpAdapterV2SubagentUpdate | undefined {
  const meta = record(tool.data.meta);
  const completed = record(meta?.["cognition.ai/subagent_completed"]);
  const started = record(meta?.["cognition.ai/subagent_started"]);
  const data = completed ?? started;
  if (typeof data?.agentId !== "string") return undefined;
  return {
    nativeTaskId: data.agentId,
    childSessionId: data.agentId,
    prompt: typeof started?.task === "string" ? started.task : "",
    title: typeof started?.title === "string" ? started.title : null,
    model: typeof started?.model === "string" ? started.model : null,
    status: completed ? (completed.success === false ? "failed" : "completed") : "running",
    result: typeof completed?.summary === "string" ? completed.summary : null,
  };
}

// Devin's plan exit offers several allow_once options in no promised order; T3 never answers with bypass.
export function devinAnswerablePermissionOptions(
  request: AcpSchema.RequestPermissionRequest,
): ReadonlyArray<AcpSchema.PermissionOption> {
  return request.options.filter((option) => option.optionId.trim() !== "plan_bypass");
}

const DEVIN_COMPACTION_METHOD = "_cognition.ai/compaction";
const DevinCompactionNotice = Schema.Struct({ sessionId: Schema.String, status: Schema.String });
// Devin 3000.14 reports `started` within milliseconds of answering `/compact`, and nothing at all
// when there is nothing to compact. Without a notice the turn settles as it did before.
const DEVIN_COMPACTION_START_WAIT: Duration.Input = "2 seconds";
// Nothing ends the wait if Devin's process dies after `started`, so the turn fails here instead.
const DEVIN_COMPACTION_LIMIT: Duration.Input = "10 minutes";

/**
 * Devin answers `/compact` before it summarizes and reports the outcome through
 * `_cognition.ai/compaction`. Holding the turn until then keeps "Context compacted" honest and
 * queues the next message instead of letting it cancel the compaction.
 */
export const makeDevinCompaction = Effect.gen(function* () {
  const waiters = yield* Ref.make(new Map<string, Queue.Queue<string>>());
  const registerExtensions = (context: AcpAdapterV2ExtensionContext) =>
    context.runtime.handleExtNotification(
      DEVIN_COMPACTION_METHOD,
      DevinCompactionNotice,
      (notice) =>
        Ref.get(waiters).pipe(
          Effect.flatMap((current) => {
            const statuses = current.get(notice.sessionId);
            return statuses === undefined ? Effect.void : Queue.offer(statuses, notice.status);
          }),
          Effect.asVoid,
        ),
    );
  const fail = (status: string) =>
    new EffectAcpErrors.AcpRequestError({
      code: -32603,
      errorMessage:
        status === "timeout"
          ? "Devin did not report the end of the compaction."
          : "Devin could not compact the conversation.",
      method: DEVIN_COMPACTION_METHOD,
      data: { status },
    });
  const compact = Effect.fn("DevinCompaction.compact")(function* (
    runtime: AcpSessionRuntime.AcpSessionRuntime["Service"],
    sessionId: string,
  ) {
    const statuses = yield* Queue.unbounded<string>();
    yield* Ref.update(waiters, (current) => new Map(current).set(sessionId, statuses));
    return yield* Effect.gen(function* () {
      const result = yield* runtime.prompt({ prompt: [{ type: "text", text: "/compact" }] });
      if (result.stopReason !== "end_turn") return yield* fail(result.stopReason);
      const first = yield* Queue.take(statuses).pipe(
        Effect.timeoutOption(DEVIN_COMPACTION_START_WAIT),
      );
      if (Option.isNone(first)) return;
      const terminal = yield* Effect.gen(function* () {
        let status = first.value;
        while (status === "started") status = yield* Queue.take(statuses);
        return status;
      }).pipe(Effect.timeoutOption(DEVIN_COMPACTION_LIMIT));
      const status = Option.getOrElse(terminal, () => "timeout");
      if (status !== "completed") return yield* fail(status);
    }).pipe(
      Effect.ensuring(
        Ref.update(waiters, (current) => {
          if (current.get(sessionId) !== statuses) return current;
          const updated = new Map(current);
          updated.delete(sessionId);
          return updated;
        }),
      ),
    );
  });
  return {
    registerExtensions,
    compactSession: { supported: () => true, compact },
  };
});
