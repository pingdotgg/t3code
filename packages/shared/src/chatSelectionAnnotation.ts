import * as Schema from "effect/Schema";

export const ChatSelectionAnnotationSchema = Schema.Struct({
  id: Schema.String,
  messageId: Schema.optionalKey(Schema.String),
  selectedText: Schema.String,
  comment: Schema.String,
  /** UTF-16 offsets in the rendered source message, when available. */
  sourceStart: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  sourceEnd: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
});

export type ChatSelectionAnnotation = typeof ChatSelectionAnnotationSchema.Type;

export type ChatSelectionIndicatorKind = "text-selection" | "text-comment";

export interface ChatSelectionIndicator {
  readonly id: string;
  readonly kind: ChatSelectionIndicatorKind;
  readonly number: number;
  readonly annotation: ChatSelectionAnnotation;
}

export type ChatSelectionMessageSegment =
  | { readonly kind: "text"; readonly id: string; readonly text: string }
  | { readonly kind: "selection"; readonly annotation: ChatSelectionAnnotation };

const CHAT_SELECTION_BLOCK_PATTERN =
  /<chat_selection\b([^>\r\n<]*)>\s*<selected_text>\s*([\s\S]*?)\s*<\/selected_text>\s*<user_comment>\s*([\s\S]*?)\s*<\/user_comment>\s*<\/chat_selection>/g;
const CHAT_SELECTION_ATTRIBUTE_PATTERN = /([a-zA-Z][a-zA-Z0-9_-]*)="([^"]*)"/g;
const CHAT_SELECTION_APP_MARKER_NAME = "data-t3code-appended";
const CHAT_SELECTION_APP_MARKER_PREFIX = "t3code:";

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

function readAttribute(rawAttributes: string, name: string): string | undefined {
  for (const match of rawAttributes.matchAll(CHAT_SELECTION_ATTRIBUTE_PATTERN)) {
    if (match[1] === name && match[2]) return unescapeXml(match[2]);
  }
  return undefined;
}

function readNonNegativeIntegerAttribute(rawAttributes: string, name: string): number | undefined {
  const value = readAttribute(rawAttributes, name);
  if (value === undefined || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function readId(rawAttributes: string, fallback: string): string {
  return readAttribute(rawAttributes, "id") ?? fallback;
}

function isAppendedChatSelection(rawAttributes: string): boolean {
  const id = readAttribute(rawAttributes, "id");
  const marker = readAttribute(rawAttributes, CHAT_SELECTION_APP_MARKER_NAME);
  return id !== undefined && marker === `${CHAT_SELECTION_APP_MARKER_PREFIX}${id}`;
}

export function formatChatSelectionAnnotation(annotation: ChatSelectionAnnotation): string {
  const sourceStart = annotation.sourceStart;
  const sourceEnd = annotation.sourceEnd;
  const sourceOffsets =
    typeof sourceStart === "number" &&
    typeof sourceEnd === "number" &&
    Number.isSafeInteger(sourceStart) &&
    Number.isSafeInteger(sourceEnd) &&
    sourceStart >= 0 &&
    sourceEnd >= sourceStart
      ? ` source_start="${sourceStart}" source_end="${sourceEnd}"`
      : "";

  return [
    `<chat_selection id="${escapeXml(annotation.id)}" ${CHAT_SELECTION_APP_MARKER_NAME}="${escapeXml(
      `${CHAT_SELECTION_APP_MARKER_PREFIX}${annotation.id}`,
    )}"${
      annotation.messageId ? ` message_id="${escapeXml(annotation.messageId)}"` : ""
    }${sourceOffsets}>`,
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
  return prompt.trim().length > 0 ? `${prompt}\n\n${blocks}` : blocks;
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

    const rawAttributes = match[1] ?? "";
    if (!isAppendedChatSelection(rawAttributes)) {
      segments.push({ kind: "text", id: `chat-selection-text:${matchIndex}`, text: match[0] });
      cursor = matchIndex + match[0].length;
      continue;
    }

    const selectedText = unescapeXml(match[2] ?? "").trim();
    if (selectedText.length === 0) {
      segments.push({ kind: "text", id: `chat-selection-invalid:${matchIndex}`, text: match[0] });
    } else {
      const sourceMessageId =
        readAttribute(rawAttributes, "message_id") ?? readAttribute(rawAttributes, "messageId");
      const sourceStart = readNonNegativeIntegerAttribute(rawAttributes, "source_start");
      const sourceEnd = readNonNegativeIntegerAttribute(rawAttributes, "source_end");
      segments.push({
        kind: "selection",
        annotation: {
          id: readId(rawAttributes, `chat-selection:${parsedIndex}`),
          ...(sourceMessageId ? { messageId: sourceMessageId } : {}),
          selectedText,
          comment: unescapeXml(match[3] ?? "").trim(),
          ...(sourceStart !== undefined && sourceEnd !== undefined && sourceEnd >= sourceStart
            ? { sourceStart, sourceEnd }
            : {}),
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

export function hasChatSelectionMessageSegments(value: string): boolean {
  return parseChatSelectionMessageSegments(value).some((segment) => segment.kind === "selection");
}

export function countChatSelectionAnnotationsForMessage(
  annotations: ReadonlyArray<ChatSelectionAnnotation>,
  messageId: string,
): number {
  return annotations.filter((annotation) => annotation.messageId === messageId).length;
}

export function deriveChatSelectionIndicators(
  annotations: ReadonlyArray<ChatSelectionAnnotation>,
  numberByAnnotationId?: ReadonlyMap<string, number>,
): ReadonlyArray<ChatSelectionIndicator> {
  return annotations.map((annotation, index) => ({
    id: annotation.id,
    kind: annotation.comment.trim() ? "text-comment" : "text-selection",
    number: numberByAnnotationId?.get(annotation.id) ?? index + 1,
    annotation,
  }));
}

export function collectChatSelectionAnnotationsByMessageId(
  pendingAnnotations: ReadonlyArray<ChatSelectionAnnotation>,
): ReadonlyMap<string, ReadonlyArray<ChatSelectionAnnotation>> {
  const annotationsByMessageId = new Map<string, ReadonlyArray<ChatSelectionAnnotation>>();
  for (const annotation of pendingAnnotations) {
    if (!annotation.messageId) continue;
    const existing = annotationsByMessageId.get(annotation.messageId) ?? [];
    annotationsByMessageId.set(annotation.messageId, [...existing, annotation]);
  }
  return annotationsByMessageId;
}
