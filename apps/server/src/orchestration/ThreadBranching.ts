import type { OrchestrationMessage, OrchestrationThreadActivity } from "@t3tools/contracts";

export const THREAD_BRANCH_ACTIVITY_KIND = "thread.branched";
export const THREAD_BRANCH_MAX_MESSAGES = 80;
export const THREAD_BRANCH_MAX_CONTEXT_CHARS = 48_000;

export interface ThreadBranchActivityPayload {
  readonly version: 1;
  readonly sourceThreadId: string;
  readonly sourceTitle: string;
  readonly copiedMessageCount: number;
  readonly omittedMessageCount: number;
}

export interface ThreadBranchContextSelection {
  readonly messages: ReadonlyArray<OrchestrationMessage>;
  readonly omittedMessageCount: number;
}

/**
 * Retain the newest complete messages that fit the branch budget. The newest
 * message may be truncated from the front so a single oversized tool dump
 * cannot leave the branch with no useful conversational context.
 */
export function selectThreadBranchContext(
  messages: ReadonlyArray<OrchestrationMessage>,
): ThreadBranchContextSelection {
  const candidates = messages.slice(-THREAD_BRANCH_MAX_MESSAGES);
  const selected: OrchestrationMessage[] = [];
  let remaining = THREAD_BRANCH_MAX_CONTEXT_CHARS;

  for (let index = candidates.length - 1; index >= 0 && remaining > 0; index -= 1) {
    const message = candidates[index];
    if (!message) continue;
    if (message.text.length <= remaining) {
      selected.push(message);
      remaining -= message.text.length;
      continue;
    }
    const marker = "[Earlier content omitted]\n";
    if (remaining <= marker.length) break;
    const tailLength = remaining - marker.length;
    selected.push({
      ...message,
      text: `${marker}${message.text.slice(-tailLength)}`,
    });
    remaining = 0;
  }

  selected.reverse();
  return {
    messages: selected,
    omittedMessageCount: messages.length - selected.length,
  };
}

export function readThreadBranchActivity(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ThreadBranchActivityPayload | null {
  const activity = activities.findLast((entry) => entry.kind === THREAD_BRANCH_ACTIVITY_KIND);
  if (!activity || typeof activity.payload !== "object" || activity.payload === null) return null;
  const payload = activity.payload as Record<string, unknown>;
  if (
    payload.version !== 1 ||
    typeof payload.sourceThreadId !== "string" ||
    typeof payload.sourceTitle !== "string" ||
    typeof payload.copiedMessageCount !== "number" ||
    typeof payload.omittedMessageCount !== "number"
  ) {
    return null;
  }
  return payload as unknown as ThreadBranchActivityPayload;
}

export function formatThreadBranchPrompt(input: {
  readonly sourceTitle: string;
  readonly messages: ReadonlyArray<OrchestrationMessage>;
  readonly currentMessage: string;
}): string {
  const transcript = input.messages
    .map((message) => {
      const role =
        message.role === "assistant" ? "Assistant" : message.role === "system" ? "System" : "User";
      const attachmentNote =
        message.attachments && message.attachments.length > 0
          ? `\n[${message.attachments.length} attachment(s) were present in this message]`
          : "";
      return `${role}:\n${message.text}${attachmentNote}`;
    })
    .join("\n\n");

  return [
    `This conversation was branched from "${input.sourceTitle}".`,
    "Use the following read-only transcript snapshot as prior conversation context. Continue independently; do not assume that work performed later in the source thread also happened here.",
    "<branched_conversation>",
    transcript,
    "</branched_conversation>",
    "<current_user_message>",
    input.currentMessage,
    "</current_user_message>",
  ].join("\n\n");
}
