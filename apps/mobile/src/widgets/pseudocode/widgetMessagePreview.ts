import type { OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import { assistantCitationsToPlainText } from "@t3tools/shared/assistantCitations";
import { isAttachmentOnlyBootstrapPrompt } from "@t3tools/shared/composerContextReferences";
import type { WorkMessagePreview } from "./workSnapshot";

const MESSAGE_PREVIEW_LENGTH = 200;

export function selectWidgetMessagePreview(
  items: OrchestrationV2ThreadProjection["visibleTurnItems"],
): WorkMessagePreview | null {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]!.item;
    if (item.type === "assistant_message") {
      if (item.streaming || item.phase === "commentary") continue;
    } else if (item.type === "user_message") {
      if (
        item.createdBy !== "user" ||
        item.workflowScript ||
        isAttachmentOnlyBootstrapPrompt(item.text)
      ) {
        continue;
      }
    } else {
      continue;
    }
    const text = assistantCitationsToPlainText(item.text).replace(/\s+/gu, " ").trim();
    if (!text) continue;
    const characters = [...text];
    return {
      id: item.messageId,
      role: item.type === "assistant_message" ? "assistant" : "user",
      text:
        characters.length > MESSAGE_PREVIEW_LENGTH
          ? `${characters
              .slice(0, MESSAGE_PREVIEW_LENGTH - 1)
              .join("")
              .trimEnd()}…`
          : text,
    };
  }
  return null;
}
