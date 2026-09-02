import { extractTrailingElementContexts } from "../../lib/elementContext";
import { extractTrailingPreviewAnnotation } from "../../lib/previewAnnotation";
import { extractTrailingTerminalContexts } from "../../lib/terminalContext";

/**
 * Terminal-style prompt recall for the composer. ArrowUp on an empty
 * composer walks back through the active thread's sent prompts, ArrowDown
 * walks forward and restores the unsent draft past the newest entry.
 *
 * History is per thread and text only. It is derived from the thread's user
 * messages on every keypress, so there is no store to persist or sync.
 */

const CLAUDE_ULTRATHINK_PREFIX = "Ultrathink:\n";
const REVIEW_COMMENT_BLOCK_PATTERN = /<review_comment\b[^>]*>[\s\S]*?<\/review_comment>/g;

/** Text sent in place of an empty prompt when a message is attachments only. */
export const ATTACHMENT_ONLY_BOOTSTRAP_PROMPT =
  "[User attached one or more files without additional text. Respond using the conversation context and the attached files.]";

export interface ComposerPromptHistoryMessage {
  readonly id: string;
  readonly role: string;
  readonly text: string;
}

export interface ComposerPromptHistoryEntry {
  readonly id: string;
  readonly prompt: string;
}

/**
 * Active recall. `entryId` is resolved against the current entries on every
 * step, so a server ack replacing an optimistic message or an older page
 * loading cannot move the position. `recalled` is the text put in the
 * composer; once the composer no longer matches it, the user has edited or
 * sent and browsing is over.
 */
export interface ComposerPromptHistoryPosition {
  readonly entryId: string;
  readonly recalled: string;
}

/**
 * Prefer the id. A consecutive duplicate collapse can retire the recalled
 * id while the same text lives on under a newer one, so fall back to the
 * newest entry with matching text.
 */
function findActive(
  entries: ReadonlyArray<ComposerPromptHistoryEntry>,
  position: ComposerPromptHistoryPosition,
): number {
  const byId = entries.findIndex((entry) => entry.id === position.entryId);
  if (byId >= 0) return byId;
  return entries.findLastIndex((entry) => entry.prompt === position.recalled);
}

export interface ComposerPromptHistoryStep {
  readonly position: ComposerPromptHistoryPosition | null;
  readonly prompt: string;
}

/**
 * Drop only the review comments appended at send time, which sit at the
 * end. Cuts the original string at the start of the trailing run of blocks
 * so any review comment block the user typed earlier stays byte-for-byte.
 */
function stripTrailingReviewComments(prompt: string): string {
  let cut = prompt.length;
  for (const match of [...prompt.matchAll(REVIEW_COMMENT_BLOCK_PATTERN)].toReversed()) {
    const blockEnd = match.index + match[0].length;
    if (prompt.slice(blockEnd, cut).trim().length > 0) break;
    cut = match.index;
  }
  return cut === prompt.length ? prompt : prompt.slice(0, cut).trimEnd();
}

/**
 * Inline terminal chips are sent as `@terminal-1:12-13` labels in the text
 * with their content in the trailing block. Once the block is stripped the
 * label points at nothing, so remove it too. Each block entry removes one
 * label (the first match) and the single space beside it. Nothing else in
 * the prompt is touched, so indented code and typed labels survive. Block
 * headers look like `Terminal 1 lines 12-13`.
 */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripInlineTerminalLabels(prompt: string, headers: ReadonlyArray<string>): string {
  let result = prompt;
  for (const header of headers) {
    const match = /^(.+?) lines? (\d+(?:-\d+)?)$/.exec(header);
    if (!match) continue;
    const label = `@${match[1]!.trim().toLowerCase().replace(/\s+/g, "-")}:${match[2]}`;
    // Whole label only: `@terminal-1:4` must not match inside `@terminal-1:40`
    // or `@terminal-1:4-12`.
    const labelPattern = new RegExp(`${escapeRegExp(label)}(?![\\d-])`);
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

/**
 * Reduce a sent message to the text the user typed. Send-time appends
 * (terminal and element context blocks, preview annotations, review
 * comments, the Claude ultrathink prefix) are stripped so a recalled prompt
 * never carries stale context from another turn.
 */
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
      prompt = stripInlineTerminalLabels(
        terminalContexts.promptText,
        terminalContexts.contexts.map((context) => context.header),
      );
      continue;
    }
    break;
  }

  const trimmed = prompt.trim();
  return trimmed === ATTACHMENT_ONLY_BOOTSTRAP_PROMPT ? "" : trimmed;
}

/**
 * Oldest first. Consecutive identical prompts collapse into the newest one,
 * matching shell `HISTCONTROL=ignoredups`. Image-only sends have no text and
 * are skipped.
 */
export function buildComposerPromptHistoryEntries(
  messages: ReadonlyArray<ComposerPromptHistoryMessage>,
): ComposerPromptHistoryEntry[] {
  const entries: ComposerPromptHistoryEntry[] = [];
  for (const message of messages) {
    if (message.role !== "user") continue;
    const prompt = recallableComposerPrompt(message.text);
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

/**
 * Returns null when the key should fall through to normal caret movement.
 * Backward starts only from an empty composer and stops at the oldest entry.
 * Forward past the newest entry empties the composer and ends browsing. An
 * edited or sent recall no longer matches `recalled`, so browsing restarts
 * from scratch on the next backward step.
 */
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
