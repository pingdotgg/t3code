export type ComposerPromptSegment =
  | {
      type: "text";
      text: string;
    }
  | {
      type: "mention";
      path: string;
    };

const MENTION_TOKEN_REGEX = /(^|\s)@([^\s@]+)(?=\s)/g;

function pushTextSegment(segments: ComposerPromptSegment[], text: string): void {
  if (!text) return;
  const last = segments[segments.length - 1];
  if (last && last.type === "text") {
    last.text += text;
    return;
  }
  segments.push({ type: "text", text });
}

export function splitPromptIntoComposerSegments(prompt: string): ComposerPromptSegment[] {
  const segments: ComposerPromptSegment[] = [];
  if (!prompt) {
    return segments;
  }

  let cursor = 0;
  for (const match of prompt.matchAll(MENTION_TOKEN_REGEX)) {
    const fullMatch = match[0];
    const prefix = match[1] ?? "";
    const path = match[2] ?? "";
    const matchIndex = match.index ?? 0;
    const mentionStart = matchIndex + prefix.length;
    const mentionEnd = mentionStart + fullMatch.length - prefix.length;

    if (mentionStart > cursor) {
      pushTextSegment(segments, prompt.slice(cursor, mentionStart));
    }

    if (path.length > 0) {
      segments.push({ type: "mention", path });
    } else {
      pushTextSegment(segments, prompt.slice(mentionStart, mentionEnd));
    }

    cursor = mentionEnd;
  }

  if (cursor < prompt.length) {
    pushTextSegment(segments, prompt.slice(cursor));
  }

  return segments;
}
