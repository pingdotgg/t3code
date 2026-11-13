import { resolveUserMessagePresentation } from "@t3tools/client-runtime/user-message";
import type { OrchestrationMessageContext } from "@t3tools/contracts";
import { upgradeLegacyContextMessage } from "@t3tools/shared/composerContextLegacy";
import {
  ATTACHMENT_ONLY_BOOTSTRAP_PROMPT,
  collectComposerContextReferences,
} from "@t3tools/shared/composerContextReferences";
import { CLAUDE_ULTRATHINK_PROMPT_PREFIX } from "@t3tools/shared/model";
import { PLAN_IMPLEMENTATION_PROMPT_PREFIX } from "../../proposedPlan";

const REVIEW_COMMENT_BLOCK_PATTERN = /<review_comment\b[^>]*>[\s\S]*?<\/review_comment>/g;
const TRAILING_LEGACY_CONTEXT =
  /\n*<(terminal_context|element_context|preview_annotation)>\n([\s\S]*?)\n<\/\1>\s*$/;

type RecallContext = Pick<OrchestrationMessageContext, "effortPrefix">;

type ComposerPromptHistoryMessage = Parameters<typeof resolveUserMessagePresentation>[0] & {
  readonly id: string;
  readonly context?: RecallContext | undefined;
};

interface ComposerPromptHistoryEntry {
  readonly id: string;
  readonly prompt: string;
}

export interface ComposerPromptHistoryPosition {
  readonly entryId: string;
  readonly recalled: string;
}

function findActive(
  entries: ReadonlyArray<ComposerPromptHistoryEntry>,
  position: ComposerPromptHistoryPosition,
): number {
  const byId = entries.findIndex((entry) => entry.id === position.entryId);
  if (byId >= 0) return byId;
  return entries.findLastIndex((entry) => entry.prompt === position.recalled);
}

interface ComposerPromptHistoryStep {
  readonly position: ComposerPromptHistoryPosition | null;
  readonly prompt: string;
}

function stripTrailingReviewComments(prompt: string): string {
  let cut = prompt.length;
  for (const match of [...prompt.matchAll(REVIEW_COMMENT_BLOCK_PATTERN)].toReversed()) {
    const blockEnd = match.index + match[0].length;
    if (prompt.slice(blockEnd, cut).trim().length > 0) break;
    // Only a block the timeline shows as an attached comment was appended; any other is typed text.
    if (upgradeLegacyContextMessage(match[0]).records.length === 0) break;
    cut = match.index;
  }
  return cut === prompt.length ? prompt : prompt.slice(0, cut).trimEnd();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripInlineTerminalLabels(prompt: string, headers: ReadonlyArray<string>): string {
  let result = prompt;
  for (const header of headers) {
    const match = /^(.+?) lines? (\d+(?:-\d+)?)$/.exec(header);
    if (!match) continue;
    const label = `@${match[1]!.trim().toLowerCase().replace(/\s+/g, "-")}:${match[2]}`;
    const labelPattern = new RegExp(`(?<![\\w@.-])${escapeRegExp(label)}(?![\\d-])`);
    const index = result.search(labelPattern);
    if (index < 0) continue;
    let end = index + label.length;
    let start = index;
    if (result[end] === " ") end += 1;
    else if (result[start - 1] === " ") start -= 1;
    result = result.slice(0, start) + result.slice(end);
  }
  return result;
}

export function recallableComposerPrompt(messageText: string, context?: RecallContext): string {
  let prompt = messageText.trim();
  // The formatter keeps a typed "Ultrathink:" line, so the text alone cannot say who wrote it.
  if (context?.effortPrefix && prompt.startsWith(CLAUDE_ULTRATHINK_PROMPT_PREFIX)) {
    prompt = prompt.slice(CLAUDE_ULTRATHINK_PROMPT_PREFIX.length);
  }

  // Context went into the text only for messages without records; with them, a tag was typed.
  while (context === undefined && prompt.length > 0) {
    const withoutReviewComments = stripTrailingReviewComments(prompt);
    if (withoutReviewComments !== prompt) {
      prompt = withoutReviewComments;
      continue;
    }
    const legacy = TRAILING_LEGACY_CONTEXT.exec(prompt);
    if (legacy) {
      if (
        legacy[1] === "preview_annotation" &&
        /^<preview_annotation>\s*$/m.test(legacy[2]!) &&
        !/^(?:Id|Page|Comment|Targets): /m.test(legacy[2]!)
      )
        break;
      const headers = Array.from(legacy[2]!.matchAll(/^- (.+):$/gm), (match) => match[1]!);
      if (legacy[1] !== "preview_annotation" && headers.length === 0) break;
      prompt = prompt.slice(0, legacy.index).trimEnd();
      if (legacy[1] === "terminal_context") prompt = stripInlineTerminalLabels(prompt, headers);
      continue;
    }
    break;
  }

  // Recall strips chips because their backing records are absent.
  for (const reference of collectComposerContextReferences(prompt).toReversed()) {
    let { start, end } = reference;
    if (prompt[end] === " ") end += 1;
    else if (prompt[start - 1] === " ") start -= 1;
    prompt = prompt.slice(0, start) + prompt.slice(end);
  }

  const trimmed = prompt.trim();
  // Sends from before the prefix was recorded keep it, and it can lead a prompt that is hidden.
  const body = trimmed.startsWith(CLAUDE_ULTRATHINK_PROMPT_PREFIX)
    ? trimmed.slice(CLAUDE_ULTRATHINK_PROMPT_PREFIX.length)
    : trimmed;
  if (
    body === ATTACHMENT_ONLY_BOOTSTRAP_PROMPT ||
    body.startsWith(PLAN_IMPLEMENTATION_PROMPT_PREFIX)
  ) {
    return "";
  }
  return trimmed;
}

export function buildComposerPromptHistoryEntries(
  messages: ReadonlyArray<ComposerPromptHistoryMessage>,
): ComposerPromptHistoryEntry[] {
  const entries: ComposerPromptHistoryEntry[] = [];
  for (const message of messages) {
    if (message.role !== "user") continue;
    // Automations and other agents send user-role messages; recall only what the user typed.
    if (resolveUserMessagePresentation(message).attribution !== null) continue;
    const prompt = recallableComposerPrompt(message.text, message.context);
    if (prompt.length === 0) continue;
    const previous = entries[entries.length - 1];
    if (previous && previous.prompt === prompt) {
      entries[entries.length - 1] = { id: message.id, prompt };
      continue;
    }
    entries.push({ id: message.id, prompt });
  }
  return entries;
}

export function stepComposerPromptHistory(input: {
  readonly direction: "backward" | "forward";
  readonly entries: ReadonlyArray<ComposerPromptHistoryEntry>;
  readonly position: ComposerPromptHistoryPosition | null;
  readonly currentPrompt: string;
}): ComposerPromptHistoryStep | null {
  const { entries, position, currentPrompt } = input;
  const activeIndex =
    position && position.recalled === currentPrompt ? findActive(entries, position) : -1;

  if (input.direction === "backward") {
    if (activeIndex < 0 && currentPrompt.length > 0) return null;
    const entry = entries[activeIndex < 0 ? entries.length - 1 : activeIndex - 1];
    if (!entry) return null;
    return { position: { entryId: entry.id, recalled: entry.prompt }, prompt: entry.prompt };
  }

  if (activeIndex < 0) return null;
  const entry = entries[activeIndex + 1];
  if (!entry) return { position: null, prompt: "" };
  return { position: { entryId: entry.id, recalled: entry.prompt }, prompt: entry.prompt };
}
