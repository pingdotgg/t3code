import { extractTrailingElementContexts } from "../../lib/elementContext";
import { extractTrailingPreviewAnnotation } from "../../lib/previewAnnotation";
import { extractTrailingTerminalContexts } from "../../lib/terminalContext";
import { parseReviewCommentMessageSegments } from "../../reviewCommentContext";

const CLAUDE_ULTRATHINK_PREFIX = "Ultrathink:\n";
const IMAGE_ONLY_BOOTSTRAP_PROMPT =
  "[User attached one or more images without additional text. Respond using the conversation context and the attached image(s).]";

export interface ComposerPromptHistoryMessage {
  readonly role: string;
  readonly text: string;
  readonly promptHistoryText?: string | undefined;
}

export interface ComposerPromptHistoryNavigation {
  readonly offset: number | null;
  readonly draft: string;
  readonly prompt: string;
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
): string[] {
  const entries: string[] = [];
  for (const message of messages) {
    if (message.role !== "user") continue;
    const prompt =
      message.promptHistoryText === undefined
        ? recallableComposerPrompt(message.text)
        : message.promptHistoryText.trim();
    if (prompt.length === 0 || entries.at(-1) === prompt) continue;
    entries.push(prompt);
  }
  return entries;
}

export function findComposerPromptHistoryOffset(
  entries: ReadonlyArray<string>,
  recalledPrompt: string,
): number | null {
  const entryIndex = entries.lastIndexOf(recalledPrompt);
  return entryIndex < 0 ? null : entries.length - 1 - entryIndex;
}

export function navigateComposerPromptHistory(input: {
  readonly direction: "backward" | "forward";
  readonly entries: ReadonlyArray<string>;
  readonly offset: number | null;
  readonly currentPrompt: string;
  readonly draft: string;
}): ComposerPromptHistoryNavigation | null {
  if (input.entries.length === 0) return null;

  if (input.direction === "backward") {
    if (input.offset === null && input.currentPrompt.length > 0) return null;
    const offset = Math.min((input.offset ?? -1) + 1, input.entries.length - 1);
    return {
      offset,
      draft: input.offset === null ? input.currentPrompt : input.draft,
      prompt: input.entries[input.entries.length - 1 - offset] ?? "",
    };
  }

  if (input.offset === null) return null;
  if (input.offset === 0) {
    return {
      offset: null,
      draft: "",
      prompt: input.draft,
    };
  }

  const offset = input.offset - 1;
  return {
    offset,
    draft: input.draft,
    prompt: input.entries[input.entries.length - 1 - offset] ?? "",
  };
}
