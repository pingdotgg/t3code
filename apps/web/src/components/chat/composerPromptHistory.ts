import { extractTrailingElementContexts } from "../../lib/elementContext";
import { extractTrailingPreviewAnnotation } from "../../lib/previewAnnotation";
import { extractTrailingTerminalContexts } from "../../lib/terminalContext";
import { parseReviewCommentMessageSegments } from "../../reviewCommentContext";

/**
 * Terminal-style prompt recall for the composer. ArrowUp on an empty
 * composer walks back through the active thread's sent prompts, ArrowDown
 * walks forward and restores the unsent draft past the newest entry.
 *
 * History is per thread and text only. It is derived from the thread's user
 * messages on every keypress, so there is no store to persist or sync.
 */

const CLAUDE_ULTRATHINK_PREFIX = "Ultrathink:\n";

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
 * end. A review comment block the user typed mid-prompt stays put.
 */
function stripTrailingReviewComments(prompt: string): string {
  const segments = [...parseReviewCommentMessageSegments(prompt)];
  let changed = false;
  while (segments.length > 0) {
    const last = segments[segments.length - 1]!;
    if (last.kind === "review-comment" || (changed && last.text.trim().length === 0)) {
      segments.pop();
      changed = true;
      continue;
    }
    break;
  }
  if (!changed) return prompt;
  return segments
    .map((segment) => (segment.kind === "text" ? segment.text : ""))
    .join("")
    .trimEnd();
}

/**
 * Inline terminal chips are sent as `@terminal-1:12-13` labels in the text
 * with their content in the trailing block. Once the block is stripped the
 * label points at nothing, so remove it too. Block headers look like
 * `Terminal 1 lines 12-13`.
 */
function stripInlineTerminalLabels(prompt: string, headers: ReadonlyArray<string>): string {
  let result = prompt;
  for (const header of headers) {
    const match = /^(.+?) lines? (\d+(?:-\d+)?)$/.exec(header);
    if (!match) continue;
    const label = match[1]!.trim().toLowerCase().replace(/\s+/g, "-");
    result = result.split(`@${label}:${match[2]}`).join("");
  }
  return result.replace(/[ \t]{2,}/g, " ").replace(/ +$/gm, "");
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
