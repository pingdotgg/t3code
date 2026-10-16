import { assistantCitationsToPlainText } from "@t3tools/shared/assistantCitations";
import { replaceComposerContextReferences } from "@t3tools/shared/composerContextReferences";
import { truncate } from "@t3tools/shared/String";

export interface ThreadTitleSeedInput {
  readonly text: string;
  readonly attachments: ReadonlyArray<{ readonly name: string }>;
  readonly fallbackLabels?: ReadonlyArray<string | null | undefined>;
}

function normalizeTitleSeed(value: string): string {
  return assistantCitationsToPlainText(value).trim().replace(/\s+/gu, " ");
}

/** Prefer the request over image chips, with a neutral label until a title is generated. */
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

  if (input.attachments.length > 0) {
    return input.attachments.length === 1 ? "Attached image" : "Attached images";
  }

  for (const label of input.fallbackLabels ?? []) {
    const normalized = normalizeTitleSeed(label ?? "");
    if (normalized.length > 0) {
      return truncate(normalized);
    }
  }

  return "New thread";
}
