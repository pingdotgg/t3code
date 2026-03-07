export type ComposerPromptSegment =
  | {
      type: "text";
      text: string;
    }
  | {
      type: "mention";
      path: string;
    }
  | {
      type: "skill";
      name: string;
    };

const CHIP_TOKEN_REGEX = /(^|\s)(?:@([^\s@]+)|\$([a-zA-Z][a-zA-Z0-9_-]*))(?=\s)/g;

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
  for (const match of prompt.matchAll(CHIP_TOKEN_REGEX)) {
    const fullMatch = match[0];
    const prefix = match[1] ?? "";
    const mentionPath = match[2];
    const skillName = match[3];
    const matchIndex = match.index ?? 0;
    const tokenStart = matchIndex + prefix.length;
    const tokenEnd = tokenStart + fullMatch.length - prefix.length;

    if (tokenStart > cursor) {
      pushTextSegment(segments, prompt.slice(cursor, tokenStart));
    }

    if (mentionPath && mentionPath.length > 0) {
      segments.push({ type: "mention", path: mentionPath });
    } else if (skillName && skillName.length > 0) {
      segments.push({ type: "skill", name: skillName });
    } else {
      pushTextSegment(segments, prompt.slice(tokenStart, tokenEnd));
    }

    cursor = tokenEnd;
  }

  if (cursor < prompt.length) {
    pushTextSegment(segments, prompt.slice(cursor));
  }

  return segments;
}
