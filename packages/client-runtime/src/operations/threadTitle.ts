import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";
import type { ChatAttachment } from "@t3tools/contracts";
import { assistantCitationsToPlainText } from "@t3tools/shared/assistantCitations";
import { replaceComposerContextReferences } from "@t3tools/shared/composerContextReferences";
import { truncate } from "@t3tools/shared/String";

import { collectComposerModelMentions } from "../composerModelMentions.ts";

export interface ThreadTitleSeedInput {
  readonly text: string;
  readonly attachments: ReadonlyArray<Pick<ChatAttachment, "type" | "name">>;
  readonly fallbackLabels?: ReadonlyArray<string | null | undefined>;
}

function normalizeTitleSeed(value: string): string {
  return assistantCitationsToPlainText(value).trim().replace(/\s+/gu, " ");
}

function modelMentionsAsSlugs(value: string): string {
  let result = "";
  let cursor = 0;
  for (const mention of collectComposerModelMentions(value)) {
    result += value.slice(cursor, mention.start) + mention.model;
    cursor = mention.end;
  }
  return result + value.slice(cursor);
}

function attachedImagesTitle(count: number, resolve: MFunctionType): string {
  return count === 1 ? resolve(msg("Attached image")) : resolve(msg("Attached images"));
}

export function threadTitleTextFromPrompt(
  value: string,
  resolve: MFunctionType = mFallback,
): string {
  const imageIds = new Set<string>();
  const prose = replaceComposerContextReferences(value, (reference) => {
    if (reference.kind === "image") {
      imageIds.add(reference.contextId);
      return "";
    }
    return reference.label;
  });
  return (
    normalizeTitleSeed(modelMentionsAsSlugs(prose)) ||
    (imageIds.size > 0 ? attachedImagesTitle(imageIds.size, resolve) : "")
  );
}

export function deriveThreadTitleSeed(
  input: ThreadTitleSeedInput,
  resolve: MFunctionType = mFallback,
): string {
  const text = threadTitleTextFromPrompt(input.text, resolve);
  if (text.length > 0) {
    return truncate(text);
  }

  const images = input.attachments.filter((attachment) => attachment.type === "image");
  if (images.length > 0) {
    return attachedImagesTitle(images.length, resolve);
  }

  const attachmentName = normalizeTitleSeed(input.attachments[0]?.name ?? "");
  if (attachmentName.length > 0) {
    return truncate(resolve(msg("File: {name}", { name: attachmentName })));
  }

  for (const label of input.fallbackLabels ?? []) {
    const normalized = normalizeTitleSeed(label ?? "");
    if (normalized.length > 0) {
      return truncate(normalized);
    }
  }

  return resolve(msg("New thread"));
}
