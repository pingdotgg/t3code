import { extractTrailingElementContexts } from "../../lib/elementContext";
import { extractTrailingPreviewAnnotation } from "../../lib/previewAnnotation";
import { extractTrailingTerminalContexts } from "../../lib/terminalContext";
import { parseReviewCommentMessageSegments } from "../../reviewCommentContext";
import type { ChatImageAttachment } from "../../types";

const CLAUDE_ULTRATHINK_PREFIX = "Ultrathink:\n";
const IMAGE_ONLY_BOOTSTRAP_PROMPT =
  "[User attached one or more images without additional text. Respond using the conversation context and the attached image(s).]";

export interface ComposerPromptHistoryMessage {
  readonly id: string;
  readonly role: string;
  readonly text: string;
  readonly attachments?: ReadonlyArray<ComposerPromptHistoryAttachment> | undefined;
  readonly promptHistoryText?: string | undefined;
}

export interface ComposerPromptHistoryAttachment {
  readonly type: "image";
  readonly id: string;
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly previewUrl?: string | undefined;
  readonly file?: File | undefined;
}

export interface ComposerPromptHistoryEntry {
  readonly id: string;
  readonly prompt: string;
  readonly attachments: ReadonlyArray<ComposerPromptHistoryAttachment>;
}

export interface ComposerPromptHistoryNavigation {
  readonly entryId: string | null;
  readonly offset: number | null;
  readonly draft: string;
  readonly draftAttachments: ReadonlyArray<ComposerPromptHistoryAttachment>;
  readonly prompt: string;
  readonly attachments: ReadonlyArray<ComposerPromptHistoryAttachment>;
}

export function isUnmodifiedComposerPromptHistoryKey(input: {
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly isComposing: boolean;
}): boolean {
  return !input.shiftKey && !input.altKey && !input.metaKey && !input.ctrlKey && !input.isComposing;
}

function stripTrailingReviewComments(prompt: string): string {
  const segments = parseReviewCommentMessageSegments(prompt);
  if (!segments.some((segment) => segment.kind === "review-comment")) {
    return prompt;
  }
  return segments
    .filter((segment) => segment.kind === "text")
    .map((segment) => segment.text)
    .join("")
    .trimEnd();
}

export function recallableComposerPrompt(messageText: string): string {
  let prompt = messageText.trim();
  if (prompt.startsWith(CLAUDE_ULTRATHINK_PREFIX)) {
    prompt = prompt.slice(CLAUDE_ULTRATHINK_PREFIX.length);
  }

  while (prompt.length > 0) {
    const withoutReviewComments = stripTrailingReviewComments(prompt);
    if (withoutReviewComments !== prompt) {
      prompt = withoutReviewComments;
      continue;
    }

    const previewAnnotation = extractTrailingPreviewAnnotation(prompt);
    if (previewAnnotation.annotation) {
      prompt = previewAnnotation.promptText;
      continue;
    }

    const elementContexts = extractTrailingElementContexts(prompt);
    if (elementContexts.contextCount > 0) {
      prompt = elementContexts.promptText;
      continue;
    }

    const terminalContexts = extractTrailingTerminalContexts(prompt);
    if (terminalContexts.contextCount > 0) {
      prompt = terminalContexts.promptText;
      continue;
    }

    break;
  }

  const trimmedPrompt = prompt.trim();
  return trimmedPrompt === IMAGE_ONLY_BOOTSTRAP_PROMPT ? "" : trimmedPrompt;
}

export function buildComposerPromptHistoryEntries(
  messages: ReadonlyArray<ComposerPromptHistoryMessage>,
): ComposerPromptHistoryEntry[] {
  const entries: ComposerPromptHistoryEntry[] = [];
  for (const message of messages) {
    if (message.role !== "user") continue;
    const prompt =
      message.promptHistoryText === undefined
        ? recallableComposerPrompt(message.text)
        : message.promptHistoryText.trim();
    const attachments = message.attachments ?? [];
    if (prompt.length === 0 && attachments.length === 0) continue;
    entries.push({ id: message.id, prompt, attachments });
  }
  return entries;
}

export function findComposerPromptHistoryOffset(
  entries: ReadonlyArray<ComposerPromptHistoryEntry>,
  entryId: string,
): number | null {
  const entryIndex = entries.findIndex((entry) => entry.id === entryId);
  return entryIndex < 0 ? null : entries.length - 1 - entryIndex;
}

export function preserveComposerPromptHistoryAttachmentFiles(
  attachments: ReadonlyArray<ChatImageAttachment>,
  optimisticAttachments: ReadonlyArray<ChatImageAttachment>,
): ChatImageAttachment[] {
  const optimisticAttachmentsById = new Map(
    optimisticAttachments.map((attachment) => [attachment.id, attachment] as const),
  );
  return attachments.map((attachment, index) => {
    const file =
      optimisticAttachmentsById.get(attachment.id)?.file ?? optimisticAttachments[index]?.file;
    return file ? { ...attachment, file } : attachment;
  });
}

export function navigateComposerPromptHistory(input: {
  readonly direction: "backward" | "forward";
  readonly entries: ReadonlyArray<ComposerPromptHistoryEntry>;
  readonly offset: number | null;
  readonly currentPrompt: string;
  readonly currentAttachments?: ReadonlyArray<ComposerPromptHistoryAttachment>;
  readonly draft: string;
  readonly draftAttachments?: ReadonlyArray<ComposerPromptHistoryAttachment>;
}): ComposerPromptHistoryNavigation | null {
  if (input.entries.length === 0) return null;
  const currentAttachments = input.currentAttachments ?? [];
  const draftAttachments = input.draftAttachments ?? [];

  if (input.direction === "backward") {
    if (
      input.offset === null &&
      (input.currentPrompt.length > 0 || currentAttachments.length > 0)
    ) {
      return null;
    }
    if (input.offset !== null && input.offset >= input.entries.length - 1) return null;
    const offset = (input.offset ?? -1) + 1;
    const entry = input.entries[input.entries.length - 1 - offset];
    if (!entry) return null;
    return {
      entryId: entry.id,
      offset,
      draft: input.offset === null ? input.currentPrompt : input.draft,
      draftAttachments: input.offset === null ? currentAttachments : draftAttachments,
      prompt: entry.prompt,
      attachments: entry.attachments,
    };
  }

  if (input.offset === null) return null;
  if (input.offset === 0) {
    return {
      entryId: null,
      offset: null,
      draft: "",
      draftAttachments: [],
      prompt: input.draft,
      attachments: draftAttachments,
    };
  }

  const offset = input.offset - 1;
  const entry = input.entries[input.entries.length - 1 - offset];
  if (!entry) return null;
  return {
    entryId: entry.id,
    offset,
    draft: input.draft,
    draftAttachments,
    prompt: entry.prompt,
    attachments: entry.attachments,
  };
}

export async function materializeComposerPromptHistoryAttachments(
  attachments: ReadonlyArray<ComposerPromptHistoryAttachment>,
): Promise<{
  readonly attachments: Array<
    ComposerPromptHistoryAttachment & {
      readonly previewUrl: string;
      readonly file: File;
    }
  >;
  readonly failedAttachmentCount: number;
}> {
  const materialized: Array<
    ComposerPromptHistoryAttachment & {
      readonly previewUrl: string;
      readonly file: File;
    }
  > = [];
  let failedAttachmentCount = 0;

  for (const attachment of attachments) {
    try {
      let file = attachment.file;
      if (!file) {
        if (!attachment.previewUrl) {
          throw new Error(`Attachment ${attachment.id} has no readable source`);
        }
        const response = await fetch(attachment.previewUrl);
        if (!response.ok) {
          throw new Error(`Attachment ${attachment.id} could not be downloaded`);
        }
        const blob = await response.blob();
        file = new File([blob], attachment.name, {
          type: attachment.mimeType || blob.type,
        });
      }

      materialized.push({
        ...attachment,
        sizeBytes: file.size,
        previewUrl: URL.createObjectURL(file),
        file,
      });
    } catch {
      failedAttachmentCount += 1;
    }
  }
  return { attachments: materialized, failedAttachmentCount };
}

export async function restoreComposerPromptHistoryDraft(
  prompt: string,
  attachments: ReadonlyArray<ComposerPromptHistoryAttachment>,
  replaceDraft: (
    prompt: string,
    attachments: Awaited<
      ReturnType<typeof materializeComposerPromptHistoryAttachments>
    >["attachments"],
  ) => void,
): Promise<number> {
  const materialized = await materializeComposerPromptHistoryAttachments(attachments);
  replaceDraft(prompt, materialized.attachments);
  return materialized.failedAttachmentCount;
}
