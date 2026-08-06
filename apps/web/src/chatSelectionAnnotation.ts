import * as Schema from "effect/Schema";

export const ChatSelectionAnnotationSchema = Schema.Struct({
  id: Schema.String,
  selectedText: Schema.String,
  comment: Schema.String,
});

export type ChatSelectionAnnotation = typeof ChatSelectionAnnotationSchema.Type;

export type ChatSelectionMessageSegment =
  | { readonly kind: "text"; readonly id: string; readonly text: string }
  | { readonly kind: "selection"; readonly annotation: ChatSelectionAnnotation };

const CHAT_SELECTION_BLOCK_PATTERN =
  /<chat_selection\b([^<>\n]*)>\s*<selected_text>\s*([\s\S]*?)\s*<\/selected_text>\s*<user_comment>\s*([\s\S]*?)\s*<\/user_comment>\s*<\/chat_selection>/g;
const CHAT_SELECTION_ATTRIBUTE_PATTERN = /([a-zA-Z][a-zA-Z0-9_-]*)="([^"]*)"/g;
const CHAT_SELECTION_APP_MARKER_NAME = "data-t3code-appended";
const CHAT_SELECTION_APP_MARKER_VALUE = "true";
const CHAT_SELECTION_APP_MARKER = `${CHAT_SELECTION_APP_MARKER_NAME}="${CHAT_SELECTION_APP_MARKER_VALUE}"`;

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function unescapeXml(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&");
}

function readId(rawAttributes: string, fallback: string): string {
  for (const match of rawAttributes.matchAll(CHAT_SELECTION_ATTRIBUTE_PATTERN)) {
    if (match[1] === "id" && match[2]) return unescapeXml(match[2]);
  }
  return fallback;
}

function isAppendedChatSelection(rawAttributes: string): boolean {
  for (const match of rawAttributes.matchAll(CHAT_SELECTION_ATTRIBUTE_PATTERN)) {
    if (
      match[1] === CHAT_SELECTION_APP_MARKER_NAME &&
      match[2] === CHAT_SELECTION_APP_MARKER_VALUE
    ) {
      return true;
    }
  }
  return false;
}

export function formatChatSelectionAnnotation(annotation: ChatSelectionAnnotation): string {
  return [
    `<chat_selection id="${escapeXml(annotation.id)}" ${CHAT_SELECTION_APP_MARKER}>`,
    "<selected_text>",
    escapeXml(annotation.selectedText.trim()),
    "</selected_text>",
    "<user_comment>",
    escapeXml(annotation.comment.trim()),
    "</user_comment>",
    "</chat_selection>",
  ].join("\n");
}

export function appendChatSelectionAnnotationsToPrompt(
  prompt: string,
  annotations: ReadonlyArray<ChatSelectionAnnotation>,
): string {
  if (annotations.length === 0) return prompt;
  const blocks = annotations.map(formatChatSelectionAnnotation).join("\n\n");
  const trimmedPrompt = prompt.trim();
  return trimmedPrompt.length > 0 ? `${prompt}\n\n${blocks}` : blocks;
}

export function parseChatSelectionMessageSegments(
  value: string,
): ReadonlyArray<ChatSelectionMessageSegment> {
  const segments: ChatSelectionMessageSegment[] = [];
  let cursor = 0;
  let parsedIndex = 0;

  for (const match of value.matchAll(CHAT_SELECTION_BLOCK_PATTERN)) {
    const matchIndex = match.index ?? 0;
    const beforeText = value.slice(cursor, matchIndex);
    if (beforeText.length > 0) {
      segments.push({ kind: "text", id: `chat-selection-text:${cursor}`, text: beforeText });
    }

    if (!isAppendedChatSelection(match[1] ?? "")) {
      segments.push({ kind: "text", id: `chat-selection-text:${matchIndex}`, text: match[0] });
      cursor = matchIndex + match[0].length;
      continue;
    }

    const selectedText = unescapeXml(match[2] ?? "").trim();
    if (selectedText.length === 0) {
      segments.push({ kind: "text", id: `chat-selection-invalid:${matchIndex}`, text: match[0] });
    } else {
      segments.push({
        kind: "selection",
        annotation: {
          id: readId(match[1] ?? "", `chat-selection:${parsedIndex}`),
          selectedText,
          comment: unescapeXml(match[3] ?? "").trim(),
        },
      });
      parsedIndex += 1;
    }
    cursor = matchIndex + match[0].length;
  }

  const rest = value.slice(cursor);
  if (rest.length > 0) {
    segments.push({ kind: "text", id: `chat-selection-text:${cursor}`, text: rest });
  }
  return segments;
}

export function stripAppendedChatSelectionAnnotations(value: string): string {
  return parseChatSelectionMessageSegments(value)
    .flatMap((segment) => (segment.kind === "text" ? [segment.text] : []))
    .join("");
}
