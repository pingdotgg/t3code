import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as AcpSchema from "effect-acp/compat";
import type { AcpToolCallState } from "@t3tools/provider-acp/server/runtimeModel";
import type { AcpAdapterV2SubagentUpdate } from "@t3tools/provider-acp/server/adapter";

// Claude Agent on ACP v2 runs each Agent/Task subagent in a child session (the
// subagents RFD). The Agent tool call stays on the parent and opens the
// subagent row. `subagent_update` on the parent announces the child and reports
// its work state. The child's first message is its delegation, whose id is the
// id of that tool call, so it ties the child session to the row. A SendMessage
// that resumes the child sends the next delegation under its own id.

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Claude's Agent tool (Task in older CLIs) launches a subagent. */
export function extractClaudeSubagentUpdate(
  tool: AcpToolCallState,
): AcpAdapterV2SubagentUpdate | undefined {
  if (tool.data.name !== "Agent" && tool.data.name !== "Task") return undefined;
  const input = record(tool.data.rawInput);
  if (typeof input?.prompt !== "string") return undefined;
  // A background launch settles its tool call at once. The subagent's own idle
  // `subagent_update` ends its row.
  const response = record(record(record(tool.data.meta)?.claudeCode)?.toolResponse);
  const background = input.run_in_background === true || response?.isAsync === true;
  const status =
    tool.status === "failed"
      ? "failed"
      : tool.status === "completed" && !background
        ? "completed"
        : "running";
  return {
    nativeTaskId: tool.toolCallId,
    childSessionId: null,
    prompt: input.prompt,
    title: typeof input.description === "string" ? input.description : null,
    model: typeof input.model === "string" ? input.model : null,
    status,
    result: null,
  };
}

const ClaudeDelegationMessage = Schema.Struct({
  messageId: Schema.String,
  content: Schema.Array(Schema.Unknown),
});
const decodeClaudeDelegationMessage = Schema.decodeUnknownOption(ClaudeDelegationMessage);

/**
 * A `session_message` delegation to a child session. Its id is the Agent call
 * that launched the child, or the SendMessage call that resumed it.
 */
export function extractClaudeSubagentDelegation(
  notification: AcpSchema.SessionNotification,
):
  | { readonly childSessionId: string; readonly delegationId: string; readonly prompt: string }
  | undefined {
  const update = notification.update;
  if (update.sessionUpdate !== "_t3_unknown") return undefined;
  if (update.originalSessionUpdate !== "session_message") return undefined;
  const message = decodeClaudeDelegationMessage(update.raw);
  if (Option.isNone(message)) return undefined;
  return {
    childSessionId: notification.sessionId,
    delegationId: message.value.messageId,
    prompt: message.value.content
      .flatMap((block) => {
        const text = record(block)?.text;
        return typeof text === "string" ? [text] : [];
      })
      .join("\n"),
  };
}
