import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as AcpSchema from "effect-acp/compat";
import type { AcpToolCallState } from "@t3tools/provider-acp/server/runtimeModel";
import type {
  AcpAdapterV2SubagentUpdate,
  AcpSubagentSessionEvent,
} from "@t3tools/provider-acp/server/adapter";

const decodeAgentInput = Schema.decodeUnknownOption(
  Schema.Struct({
    prompt: Schema.String,
    description: Schema.optionalKey(Schema.String),
    model: Schema.optionalKey(Schema.String),
    run_in_background: Schema.optionalKey(Schema.Boolean),
  }),
);
const decodeAsyncResponse = Schema.decodeUnknownOption(
  Schema.Struct({
    claudeCode: Schema.Struct({ toolResponse: Schema.Struct({ isAsync: Schema.Boolean }) }),
  }),
);

export function isClaudeProvisionalSubagentTool(tool: AcpToolCallState): boolean {
  return (
    (tool.data.name === "Agent" || tool.data.name === "Task") &&
    tool.status !== "failed" &&
    tool.status !== "completed" &&
    Option.isNone(decodeAgentInput(tool.data.rawInput))
  );
}

export function extractClaudeSubagentUpdate(
  tool: AcpToolCallState,
): AcpAdapterV2SubagentUpdate | undefined {
  if (tool.data.name !== "Agent" && tool.data.name !== "Task") return;
  const input = decodeAgentInput(tool.data.rawInput);
  if (Option.isNone(input)) return;
  const response = decodeAsyncResponse(tool.data.meta);
  const background =
    input.value.run_in_background === true ||
    (Option.isSome(response) && response.value.claudeCode.toolResponse.isAsync);
  return {
    nativeTaskId: tool.toolCallId,
    childSessionId: null,
    prompt: input.value.prompt,
    title: input.value.description ?? null,
    model: input.value.model ?? null,
    status:
      tool.status === "failed"
        ? "failed"
        : tool.status === "completed" && !background
          ? "completed"
          : "running",
    result: null,
  };
}

const decodeChildState = Schema.decodeUnknownOption(
  Schema.Struct({
    sessionId: Schema.String,
    state: Schema.Struct({
      state: Schema.String,
      stopReason: Schema.optionalKey(Schema.NullOr(Schema.String)),
      error: Schema.optionalKey(Schema.NullOr(Schema.Struct({ message: Schema.String }))),
    }),
  }),
);
const decodeDelegation = Schema.decodeUnknownOption(
  Schema.Struct({
    messageId: Schema.String,
    senderSessionId: Schema.optionalKey(Schema.String),
    content: Schema.Array(
      Schema.Struct({ type: Schema.String, text: Schema.optionalKey(Schema.String) }),
    ),
  }),
);

// Claude's session_message id is the Agent/Task or SendMessage tool-use id.
export function extractClaudeSubagentSessionEvent(
  notification: AcpSchema.SessionNotification,
): AcpSubagentSessionEvent | undefined {
  const update = notification.update;
  if (update.sessionUpdate !== "_t3_unknown") return;
  if (update.originalSessionUpdate === "subagent_update") {
    const child = decodeChildState(update.raw);
    if (Option.isNone(child)) return;
    const { sessionId, state } = child.value;
    return {
      type: "state",
      childSessionId: sessionId,
      parentSessionId: notification.sessionId,
      status:
        state.state === "running" || state.state === "requires_action"
          ? "running"
          : state.stopReason === "error"
            ? "failed"
            : state.stopReason === "cancelled" || state.state === "unknown"
              ? "cancelled"
              : "completed",
      result: state.error?.message ?? null,
    };
  }
  if (update.originalSessionUpdate === "session_message") {
    const delegation = decodeDelegation(update.raw);
    if (Option.isNone(delegation)) return;
    return {
      type: "delegation",
      childSessionId: notification.sessionId,
      parentSessionId: delegation.value.senderSessionId ?? null,
      delegationId: delegation.value.messageId,
      prompt: delegation.value.content
        .flatMap((block) => (block.type === "text" && block.text !== undefined ? [block.text] : []))
        .join("\n"),
    };
  }
}
