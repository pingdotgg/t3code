import type { HookCallback, SyncHookJSONOutput } from "@anthropic-ai/claude-agent-sdk";

const CLAUDE_PUSH_NOTIFICATION_TOOL = "PushNotification";
const MAX_PUSH_NOTIFICATION_LENGTH = 200;

export interface ClaudePushChannels {
  readonly local: boolean;
  readonly phone: boolean;
}

export interface ClaudePushNotificationOffer {
  (message: string): Promise<ClaudePushChannels>;
}

/** One line, capped the way Claude's own tool asks the model to write it. */
export function readClaudePushNotificationMessage(toolInput: unknown): string | null {
  if (typeof toolInput !== "object" || toolInput === null || !("message" in toolInput)) {
    return null;
  }
  const message = toolInput.message;
  if (typeof message !== "string") return null;
  const trimmed = message.trim().replace(/\s+/g, " ");
  if (trimmed.length === 0) return null;
  return trimmed.length > MAX_PUSH_NOTIFICATION_LENGTH
    ? `${trimmed.slice(0, MAX_PUSH_NOTIFICATION_LENGTH - 1)}…`
    : trimmed;
}

export function claudePushNotificationOutput(input: {
  readonly channels: ClaudePushChannels;
}): SyncHookJSONOutput {
  if (!input.channels.local && !input.channels.phone) {
    return {
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        updatedToolOutput: {
          message: "Not sent. No T3 client or phone accepted the notification.",
          pushSent: false,
          localSent: false,
          disabledReason: "no_transport",
        },
      },
    };
  }
  return {
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      updatedToolOutput: {
        message: "Sent through T3.",
        pushSent: input.channels.phone,
        localSent: input.channels.local,
      },
    },
  };
}

const missingMessageOutput: SyncHookJSONOutput = {
  hookSpecificOutput: {
    hookEventName: "PostToolUse",
    updatedToolOutput: {
      message: "Not sent. The notification had no message.",
      pushSent: false,
      localSent: false,
      disabledReason: "no_transport",
    },
  },
};

function claudeSuppressedPushBecauseUserPresent(toolResponse: unknown): boolean {
  return (
    typeof toolResponse === "object" &&
    toolResponse !== null &&
    "disabledReason" in toolResponse &&
    toolResponse.disabledReason === "user_present"
  );
}

export function claudePushNotificationHooks(input: {
  readonly offer: ClaudePushNotificationOffer;
}) {
  const hook: HookCallback = async (hookInput) => {
    if (
      hookInput.hook_event_name !== "PostToolUse" ||
      hookInput.tool_name !== CLAUDE_PUSH_NOTIFICATION_TOOL
    ) {
      return {};
    }
    // user_present is the SDK session looking like an open terminal. A real send
    // or another refusal has to reach the model unchanged.
    if (!claudeSuppressedPushBecauseUserPresent(hookInput.tool_response)) {
      return {};
    }
    const message = readClaudePushNotificationMessage(hookInput.tool_input);
    if (message === null) return missingMessageOutput;
    return claudePushNotificationOutput({ channels: await input.offer(message) });
  };
  return {
    PostToolUse: [{ matcher: CLAUDE_PUSH_NOTIFICATION_TOOL, hooks: [hook] }],
  };
}
