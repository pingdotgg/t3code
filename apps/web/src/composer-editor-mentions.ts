import type { AssistantCitation } from "@t3tools/contracts";
import { collectAssistantCitations } from "@t3tools/shared/assistantCitations";
import { collectComposerContextReferences } from "@t3tools/shared/composerContextReferences";
import {
  collectComposerInlineTokens,
  type ComposerInlineToken,
} from "@t3tools/shared/composerInlineTokens";

export type ComposerPromptSegment =
  | {
      type: "text";
      text: string;
    }
  | {
      type: "mention";
      path: string;
      source: string;
    }
  | {
      type: "skill";
      name: string;
    }
  | {
      type: "citation";
      citation: AssistantCitation;
      source: string;
    }
  | {
      type: "context-reference";
      kind: string;
      contextId: string;
      label: string;
      source: string;
    };

function rangeIncludesIndex(start: number, end: number, index: number): boolean {
  return start <= index && index < end;
}

function pushTextSegment(segments: ComposerPromptSegment[], text: string): void {
  if (!text) return;
  const last = segments[segments.length - 1];
  if (last && last.type === "text") {
    last.text += text;
    return;
  }
  segments.push({ type: "text", text });
}

function forEachPromptTextSlice(
  prompt: string,
  visitor: (text: string, promptOffset: number) => boolean | void,
): boolean {
  return prompt.length > 0 && visitor(prompt, 0) === true;
}

function forEachMentionMatch(
  prompt: string,
  visitor: (
    match: Extract<ComposerInlineToken, { type: "mention" }>,
    promptOffset: number,
  ) => boolean | void,
): boolean {
  return forEachPromptTextSlice(prompt, (text, promptOffset) => {
    for (const match of collectComposerPromptInlineTokens(text)) {
      if (match.type !== "mention") {
        continue;
      }
      if (visitor(match, promptOffset) === true) {
        return true;
      }
    }
    return false;
  });
}

export function collectComposerPromptInlineTokens(text: string) {
  const tokens = collectComposerInlineTokens(text);
  const citations = collectAssistantCitations(text);
  const references = collectComposerContextReferences(text);
  if (citations.length === 0 && references.length === 0) return tokens;

  // An unfinished @ mention can otherwise consume the start of a link label.
  const links = [
    ...citations.map((match) => ({ ...match, type: "citation" as const })),
    ...references.map((match) => ({ ...match, type: "context-reference" as const })),
  ];
  return [
    ...tokens.filter(
      (token) => !links.some((link) => token.start < link.end && token.end > link.start),
    ),
    ...links,
  ].sort((left, right) => left.start - right.start);
}

function splitPromptTextIntoComposerSegments(text: string): ComposerPromptSegment[] {
  const segments: ComposerPromptSegment[] = [];
  if (!text) {
    return segments;
  }

  const tokenMatches = collectComposerPromptInlineTokens(text);
  let cursor = 0;
  for (const match of tokenMatches) {
    if (match.start < cursor) {
      continue;
    }

    if (match.start > cursor) {
      pushTextSegment(segments, text.slice(cursor, match.start));
    }

    if (match.type === "citation") {
      segments.push({ type: "citation", citation: match.citation, source: match.source });
    } else if (match.type === "context-reference") {
      segments.push({
        type: "context-reference",
        kind: match.kind,
        contextId: match.contextId,
        label: match.label,
        source: match.source,
      });
    } else if (match.type === "mention") {
      segments.push({
        type: "mention",
        path: match.value,
        source: match.source,
      });
    } else {
      segments.push({ type: "skill", name: match.value });
    }

    cursor = match.end;
  }

  if (cursor < text.length) {
    pushTextSegment(segments, text.slice(cursor));
  }

  return segments;
}

export function selectionTouchesMentionBoundary(
  prompt: string,
  start: number,
  end: number,
): boolean {
  if (!prompt || start >= end) {
    return false;
  }

  return forEachMentionMatch(prompt, (match, promptOffset) => {
    const mentionStart = promptOffset + match.start;
    const mentionEnd = promptOffset + match.end;
    const beforeMentionIndex = mentionStart - 1;
    const afterMentionIndex = mentionEnd;

    if (
      beforeMentionIndex >= 0 &&
      /\s/.test(prompt[beforeMentionIndex] ?? "") &&
      rangeIncludesIndex(start, end, beforeMentionIndex)
    ) {
      return true;
    }

    if (
      afterMentionIndex < prompt.length &&
      /\s/.test(prompt[afterMentionIndex] ?? "") &&
      rangeIncludesIndex(start, end, afterMentionIndex)
    ) {
      return true;
    }
    return false;
  });
}

export function splitPromptIntoComposerSegments(prompt: string): ComposerPromptSegment[] {
  return splitPromptTextIntoComposerSegments(prompt);
}
