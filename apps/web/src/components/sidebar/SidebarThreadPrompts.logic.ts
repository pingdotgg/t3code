import type { OrchestrationV2ConversationMessage } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

type SidebarPromptMessage = Pick<
  OrchestrationV2ConversationMessage,
  "id" | "role" | "workflowScript" | "idleCompaction" | "createdAt" | "text"
>;

export function sidebarPromptMessages(
  messages: ReadonlyArray<SidebarPromptMessage>,
): SidebarPromptMessage[] {
  return messages
    .filter(
      (message) => message.role === "user" && !message.workflowScript && !message.idleCompaction,
    )
    .toSorted(
      (left, right) =>
        DateTime.toEpochMillis(left.createdAt) - DateTime.toEpochMillis(right.createdAt),
    );
}
