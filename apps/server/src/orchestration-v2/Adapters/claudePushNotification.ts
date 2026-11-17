import type { HookCallback, SyncHookJSONOutput } from "@anthropic-ai/claude-agent-sdk";

export const CLAUDE_PUSH_NOTIFICATION_TOOL = "PushNotification";
// The tool asks the model for under 200 characters; phones cut longer text.
const MAX_MESSAGE_LENGTH = 200;

function readMessage(toolInput: unknown): string | null {
  if (typeof toolInput !== "object" || toolInput === null || !("message" in toolInput)) {
    return null;
  }
  if (typeof toolInput.message !== "string") return null;
  const oneLine = toolInput.message.trim().replace(/\s+/g, " ");
  if (oneLine.length === 0) return null;
  return oneLine.length > MAX_MESSAGE_LENGTH
    ? `${oneLine.slice(0, MAX_MESSAGE_LENGTH - 1)}…`
    : oneLine;
}

type ToolResponse = Readonly<Record<string, unknown>>;

function refusedAsUserPresent(toolResponse: unknown): toolResponse is ToolResponse {
  return (
    typeof toolResponse === "object" &&
    toolResponse !== null &&
    "disabledReason" in toolResponse &&
    toolResponse.disabledReason === "user_present"
  );
}

function toolOutput(toolResponse: ToolResponse, delivered: boolean): SyncHookJSONOutput {
  return {
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      // Claude Code writes the model's result text from these fields and ignores `message`.
      // `no_transport` is its closest wording: a local notification was or was not sent, and
      // no mobile push was. `additionalContext` tells the model what T3 did: it knows a client
      // took the alert, not that the client put it on screen.
      updatedToolOutput: {
        ...toolResponse,
        message: delivered
          ? "Sent through T3 Code."
          : "Not sent. No T3 Code client with notifications on is connected.",
        pushSent: false,
        localSent: delivered,
        disabledReason: "no_transport",
      },
      additionalContext: delivered
        ? "T3 Code passed this notification to a connected T3 Code client with notifications on. Whether that client put it on screen is not confirmed."
        : "This notification reached nobody: no T3 Code client with notifications on is connected.",
    },
  };
}

/**
 * Claude Code decides delivery inside the CLI and counts an Agent SDK session as an open
 * terminal, so from a T3 thread the tool always answers `user_present` and sends nothing.
 * This takes over that one refusal: T3 delivers the message and the model hears what happened.
 */
export function makeClaudePushNotificationHook(
  deliver: (alert: { readonly id: string; readonly body: string }) => Promise<boolean>,
): HookCallback {
  return async (input) => {
    if (
      input.hook_event_name !== "PostToolUse" ||
      input.tool_name !== CLAUDE_PUSH_NOTIFICATION_TOOL ||
      // A real send, or a refusal for another reason, reaches the model unchanged.
      !refusedAsUserPresent(input.tool_response)
    ) {
      return {};
    }
    const body = readMessage(input.tool_input);
    if (body === null) return {};
    return toolOutput(input.tool_response, await deliver({ id: input.tool_use_id, body }));
  };
}
