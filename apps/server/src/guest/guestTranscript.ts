import type {
  GuestShareView,
  GuestStreamEvent,
  GuestTranscriptItem,
  OrchestrationV2AppThread,
  OrchestrationV2Run,
  OrchestrationV2TurnItem,
  RunId,
} from "@t3tools/contracts";

// The kind only: tool titles and arguments can carry paths, commands, and secrets.
const TOOL_KINDS: Partial<
  Record<OrchestrationV2TurnItem["type"], Extract<GuestTranscriptItem, { kind: "tool" }>["tool"]>
> = {
  command_execution: "command",
  file_change: "file_change",
  file_search: "file_search",
  web_search: "web_search",
  dynamic_tool: "tool",
  subagent: "subagent",
};

/**
 * The guest allowlist. A guest sees conversation text, plans, the agent's questions, and fixed
 * tool labels. Every other item type, including ones added later, is dropped.
 */
export function guestTranscriptItem(item: OrchestrationV2TurnItem): GuestTranscriptItem | null {
  switch (item.type) {
    case "user_message":
      // Scheduled, cross-thread, and agent-sent messages can carry webhook bodies or other
      // threads' results, so only messages a person typed into this thread pass.
      if (
        item.createdBy !== "user" ||
        item.scheduledTaskId !== undefined ||
        item.senderThreadId !== undefined
      ) {
        return null;
      }
      if (item.context?.guest !== undefined) {
        return {
          kind: "user",
          id: item.id,
          text: item.context.guest.text,
          streaming: false,
          guestMessageId: item.context.guest.guestMessageId,
          guestName: item.context.guest.name,
        };
      }
      return { kind: "user", id: item.id, text: item.text, streaming: false };
    case "assistant_message":
      return { kind: "assistant", id: item.id, text: item.text, streaming: item.streaming };
    case "proposed_plan":
      return { kind: "plan", id: item.id, text: item.markdown, streaming: item.streaming };
    case "user_input_request":
      return {
        kind: "question",
        id: item.id,
        questions: item.questions.map((question) => ({
          header: question.header,
          question: question.question,
          options: question.options.map((option) => option.label),
        })),
      };
    default: {
      const tool = TOOL_KINDS[item.type];
      return tool === undefined ? null : { kind: "tool", id: item.id, tool };
    }
  }
}

export const isGuestVisibleRun = (
  run: Pick<OrchestrationV2Run, "ordinal">,
  historyStartRunOrdinal: number,
) => run.ordinal >= historyStartRunOrdinal;

export function guestShareView(
  thread: OrchestrationV2AppThread,
  working: boolean,
): GuestShareView | null {
  const share = thread.guestShare;
  if (!share || share.guestName === null) return null;
  return {
    shareId: share.id,
    title: thread.title,
    guestName: share.guestName,
    expiresAt: share.expiresAt,
    working,
    messages: share.messages,
  };
}

/**
 * Turns one transcript update into the smallest guest event. Streaming text usually grows, so
 * the guest gets only the new suffix instead of the whole message again.
 */
export function guestItemEvent(
  previousText: string | undefined,
  item: GuestTranscriptItem,
): GuestStreamEvent {
  if (
    previousText !== undefined &&
    (item.kind === "assistant" || item.kind === "plan" || item.kind === "user") &&
    item.text.startsWith(previousText)
  ) {
    return {
      type: "append",
      id: item.id,
      text: item.text.slice(previousText.length),
      streaming: item.streaming,
    };
  }
  return { type: "item", item };
}

export const guestItemText = (item: GuestTranscriptItem): string | undefined =>
  item.kind === "assistant" || item.kind === "plan" || item.kind === "user" ? item.text : undefined;

export type GuestVisibleRuns = ReadonlySet<RunId>;
