import type { ChatAttachment } from "@t3tools/contracts";
import { assistantCitationsToPlainText } from "@t3tools/shared/assistantCitations";
import { replaceComposerContextReferences } from "@t3tools/shared/composerContextReferences";
import { truncate } from "@t3tools/shared/String";

export interface ThreadTitleSeedInput {
  readonly text: string;
  readonly attachments: ReadonlyArray<Pick<ChatAttachment, "type" | "name">>;
  readonly fallbackLabels?: ReadonlyArray<string | null | undefined>;
}

function normalizeTitleSeed(value: string): string {
  return assistantCitationsToPlainText(value).trim().replace(/\s+/gu, " ");
}

export function threadTitleTextFromPrompt(value: string): string {
  const imageIds = new Set<string>();
  const prose = replaceComposerContextReferences(value, (reference) => {
    if (reference.kind === "image") {
      imageIds.add(reference.contextId);
      return "";
    }
    return reference.label;
  });
  return (
    normalizeTitleSeed(prose) ||
    (imageIds.size > 0 ? (imageIds.size === 1 ? "Attached image" : "Attached images") : "")
  );
}

export function deriveThreadTitleSeed(input: ThreadTitleSeedInput): string {
  const text = threadTitleTextFromPrompt(input.text);
  if (text.length > 0) {
    return truncate(text);
  }

  const images = input.attachments.filter((attachment) => attachment.type === "image");
  if (images.length > 0) {
    return images.length === 1 ? "Attached image" : "Attached images";
  }

  const attachmentName = normalizeTitleSeed(input.attachments[0]?.name ?? "");
  if (attachmentName.length > 0) {
    return truncate(`File: ${attachmentName}`);
  }

  for (const label of input.fallbackLabels ?? []) {
    const normalized = normalizeTitleSeed(label ?? "");
    if (normalized.length > 0) {
      return truncate(normalized);
    }
  }

  return "New thread";
}
