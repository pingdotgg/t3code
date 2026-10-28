import type { ClientSettings } from "@t3tools/contracts/settings";
import type {
  AssistantCitation,
  EnvironmentId,
  ResolvedKeybindingsConfig,
} from "@t3tools/contracts";
import type { ComposerPathSearchTarget } from "@t3tools/client-runtime/state/threads";
import {
  serializeAssistantCitation,
  withAssistantCitationComment,
} from "@t3tools/shared/assistantCitations";
import { isCurrencyAmountQuery, isPathWord } from "@t3tools/shared/composerTrigger";
import {
  splitPromptIntoComposerSegments,
  type ComposerPromptSegment,
} from "./composer-editor-mentions";

import { resolveShortcutCommand, type ShortcutEventLike } from "./keybindings";

export type ComposerTriggerKind = "path" | "pull-request" | "slash-command" | "skill";
export type ComposerSlashCommand = "model" | "plan" | "default";
export type ComposerSubmissionIntent = "foreground" | "background" | "alternate";

export interface ComposerTrigger {
  kind: ComposerTriggerKind;
  query: string;
  rangeStart: number;
  rangeEnd: number;
}

export function isPathSuggestionCurrent(
  searchTarget: ComposerPathSearchTarget,
  trigger: ComposerTrigger | null,
  environmentId: EnvironmentId | null,
  cwd: string | null,
) {
  return (
    trigger?.kind === "path" &&
    searchTarget.environmentId === environmentId &&
    searchTarget.cwd === cwd &&
    searchTarget.query === trigger.query.trim()
  );
}

export function formatAssistantCitationForComposer(citation: AssistantCitation, comment = "") {
  return `${serializeAssistantCitation(withAssistantCitationComment(citation, comment))} `;
}

export function composerRequiresModifier(
  sendShortcut: ClientSettings["sendShortcut"] | undefined,
  prompt: string,
) {
  return (
    sendShortcut === "mod-enter" ||
    (sendShortcut === "mod-enter-multiline" && /[\r\n]/.test(prompt))
  );
}

export function composerSubmissionIntentForKey(input: {
  event: ShortcutEventLike & { isComposing?: boolean; keyCode?: number; repeat?: boolean };
  keybindings: ResolvedKeybindingsConfig;
  platform?: string;
  isSoftwareKeyboardOpen: boolean;
  isDraftThread: boolean;
  isRunning?: boolean;
  sendShortcut?: ClientSettings["sendShortcut"];
  prompt?: string;
}): ComposerSubmissionIntent | null {
  const { event } = input;
  if (event.isComposing || event.keyCode === 229 || event.repeat) return null;
  if (input.isSoftwareKeyboardOpen && event.key === "Enter" && !event.metaKey && !event.ctrlKey)
    return null;
  const command = resolveShortcutCommand(event, input.keybindings, {
    ...(input.platform === undefined ? {} : { platform: input.platform }),
    context: {
      composerFocus: true,
      draftThreadRoute: input.isDraftThread,
      turnRunning: input.isRunning === true,
      composerRequiresModifier: composerRequiresModifier(input.sendShortcut, input.prompt ?? ""),
    },
  });
  if (command === "composer.sendAlternate" && input.isRunning) return "alternate";
  if (command === "composer.sendBackground" && input.isDraftThread) return "background";
  if (command === "composer.sendAndNewThread" && !input.isDraftThread) return "background";
  if (command !== null || event.key !== "Enter" || event.shiftKey || event.altKey) return null;
  if (
    composerRequiresModifier(input.sendShortcut, input.prompt ?? "") &&
    !event.metaKey &&
    !event.ctrlKey
  )
    return null;
  return "foreground";
}

function clampCursor(text: string, cursor: number): number {
  if (!Number.isFinite(cursor)) return text.length;
  return Math.max(0, Math.min(text.length, Math.floor(cursor)));
}

function isWhitespace(char: string): boolean {
  return char === " " || char === "\n" || char === "\t" || char === "\r";
}

function tokenStartForCursor(text: string, cursor: number): number {
  let index = cursor - 1;
  while (index >= 0 && !isWhitespace(text[index] ?? "")) {
    index -= 1;
  }
  return index + 1;
}

export function expandCollapsedComposerCursor(
  text: string,
  cursorInput: number,
  literalText = false,
): number {
  if (literalText) return clampCursor(text, cursorInput);
  const collapsedCursor = clampCursor(text, cursorInput);
  const segments = splitPromptIntoComposerSegments(text);
  if (segments.length === 0) {
    return collapsedCursor;
  }

  let remaining = collapsedCursor;
  let expandedCursor = 0;

  for (const segment of segments) {
    if (
      segment.type === "mention" ||
      segment.type === "citation" ||
      segment.type === "context-reference"
    ) {
      const expandedLength = segment.source.length;
      if (remaining <= 1) {
        return expandedCursor + (remaining === 0 ? 0 : expandedLength);
      }
      remaining -= 1;
      expandedCursor += expandedLength;
      continue;
    }
    if (segment.type === "skill") {
      const expandedLength = segment.source.length;
      if (remaining <= 1) {
        return expandedCursor + (remaining === 0 ? 0 : expandedLength);
      }
      remaining -= 1;
      expandedCursor += expandedLength;
      continue;
    }

    const segmentLength = segment.text.length;
    if (remaining <= segmentLength) {
      return expandedCursor + remaining;
    }
    remaining -= segmentLength;
    expandedCursor += segmentLength;
  }

  return expandedCursor;
}

function collapsedSegmentLength(segment: ComposerPromptSegment): number {
  if (segment.type === "text") {
    return segment.text.length;
  }
  return 1;
}

function clampCollapsedComposerCursorForSegments(
  segments: ReadonlyArray<ComposerPromptSegment>,
  cursorInput: number,
): number {
  const collapsedLength = segments.reduce(
    (total, segment) => total + collapsedSegmentLength(segment),
    0,
  );
  if (!Number.isFinite(cursorInput)) {
    return collapsedLength;
  }
  return Math.max(0, Math.min(collapsedLength, Math.floor(cursorInput)));
}

export function clampCollapsedComposerCursor(
  text: string,
  cursorInput: number,
  literalText = false,
): number {
  if (literalText) return clampCursor(text, cursorInput);
  return clampCollapsedComposerCursorForSegments(
    splitPromptIntoComposerSegments(text),
    cursorInput,
  );
}

export function collapseExpandedComposerCursor(
  text: string,
  cursorInput: number,
  literalText = false,
): number {
  if (literalText) return clampCursor(text, cursorInput);
  const expandedCursor = clampCursor(text, cursorInput);
  const segments = splitPromptIntoComposerSegments(text);
  if (segments.length === 0) {
    return expandedCursor;
  }

  let remaining = expandedCursor;
  let collapsedCursor = 0;

  for (const segment of segments) {
    if (
      segment.type === "mention" ||
      segment.type === "citation" ||
      segment.type === "context-reference"
    ) {
      const expandedLength = segment.source.length;
      if (remaining === 0) {
        return collapsedCursor;
      }
      if (remaining <= expandedLength) {
        return collapsedCursor + 1;
      }
      remaining -= expandedLength;
      collapsedCursor += 1;
      continue;
    }
    if (segment.type === "skill") {
      const expandedLength = segment.source.length;
      if (remaining === 0) {
        return collapsedCursor;
      }
      if (remaining <= expandedLength) {
        return collapsedCursor + 1;
      }
      remaining -= expandedLength;
      collapsedCursor += 1;
      continue;
    }

    const segmentLength = segment.text.length;
    if (remaining <= segmentLength) {
      return collapsedCursor + remaining;
    }
    remaining -= segmentLength;
    collapsedCursor += segmentLength;
  }

  return collapsedCursor;
}

export function detectComposerTrigger(text: string, cursorInput: number): ComposerTrigger | null {
  const cursor = clampCursor(text, cursorInput);
  const tokenStart = tokenStartForCursor(text, cursor);
  const token = text.slice(tokenStart, cursor);
  if (token.startsWith("/")) {
    if (isPathWord(text, tokenStart, cursor, isWhitespace)) return null;
    return {
      kind: "slash-command",
      query: token.slice(1),
      rangeStart: tokenStart,
      rangeEnd: cursor,
    };
  }
  const pullRequestMatch = /^#([\p{L}\p{N}][\p{L}\p{N}_-]*)?$/u.exec(token);
  if (pullRequestMatch) {
    return {
      kind: "pull-request",
      query: pullRequestMatch[1] ?? "",
      rangeStart: tokenStart,
      rangeEnd: cursor,
    };
  }
  const skillPrefix = /^\p{Sc}/u.exec(token);
  if (skillPrefix) {
    if (isCurrencyAmountQuery(token.slice(skillPrefix[0].length))) return null;
    return {
      kind: "skill",
      query: token.slice(skillPrefix[0].length),
      rangeStart: tokenStart,
      rangeEnd: cursor,
    };
  }
  if (!token.startsWith("@")) {
    return null;
  }

  return {
    kind: "path",
    query: token.slice(1),
    rangeStart: tokenStart,
    rangeEnd: cursor,
  };
}

export function pastedPathQueryLength(
  lineBefore: string,
  pasted: string,
  pathQueryActive = true,
): number {
  if (!pathQueryActive) return 0;
  if (detectComposerTrigger(lineBefore, lineBefore.length)?.kind !== "path") return 0;
  return /^\S*/.exec(pasted)![0].length;
}

export function composerStateAtPromptEnd(
  text: string,
  literalText = false,
): {
  cursor: number;
  trigger: ComposerTrigger | null;
} {
  const cursor = collapseExpandedComposerCursor(text, text.length, literalText);
  return {
    cursor,
    trigger: literalText
      ? null
      : detectComposerTrigger(text, expandCollapsedComposerCursor(text, cursor)),
  };
}

export function parseStandaloneComposerSlashCommand(
  text: string,
): Exclude<ComposerSlashCommand, "model"> | null {
  const match = /^\/(plan|default)\s*$/i.exec(text.trim());
  if (!match) {
    return null;
  }
  const command = match[1]?.toLowerCase();
  if (command === "plan") return "plan";
  return "default";
}

/**
 * A replacement ending in a space swallows one space already after the range, so inserting
 * `@file ` before existing text does not leave a double space.
 */
export function extendReplacementRangeForTrailingSpace(
  text: string,
  rangeEnd: number,
  replacement: string,
): number {
  if (!replacement.endsWith(" ")) {
    return rangeEnd;
  }
  return text[rangeEnd] === " " ? rangeEnd + 1 : rangeEnd;
}

export { replaceTextRange } from "@t3tools/shared/composerTrigger";
