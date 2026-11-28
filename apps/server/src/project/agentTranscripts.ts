import * as Schema from "effect/Schema";

export const TranscriptContentBlock = Schema.Struct({
  type: Schema.optional(Schema.String),
  text: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  input: Schema.optional(Schema.Unknown),
  content: Schema.optional(
    Schema.Union([
      Schema.String,
      Schema.Array(
        Schema.Struct({
          type: Schema.optional(Schema.String),
          text: Schema.optional(Schema.String),
        }),
      ),
    ]),
  ),
});

export const TranscriptMessage = Schema.Struct({
  role: Schema.optional(Schema.String),
  content: Schema.optional(Schema.Union([Schema.String, Schema.Array(TranscriptContentBlock)])),
  model: Schema.optional(Schema.String),
});

export const TranscriptRecord = Schema.Struct({
  type: Schema.optional(Schema.String),
  uuid: Schema.optional(Schema.String),
  entrypoint: Schema.optional(Schema.String),
  id: Schema.optional(Schema.String),
  parentId: Schema.optional(Schema.NullOr(Schema.String)),
  name: Schema.optional(Schema.String),
  timestamp: Schema.optional(Schema.String),
  cwd: Schema.optional(Schema.String),
  sessionId: Schema.optional(Schema.String),
  aiTitle: Schema.optional(Schema.String),
  customTitle: Schema.optional(Schema.String),
  isSidechain: Schema.optional(Schema.Boolean),
  isMeta: Schema.optional(Schema.Boolean),
  isCompactSummary: Schema.optional(Schema.Boolean),
  message: Schema.optional(TranscriptMessage),
  payload: Schema.optional(
    Schema.Struct({
      id: Schema.optional(Schema.String),
      session_id: Schema.optional(Schema.String),
      type: Schema.optional(Schema.String),
      role: Schema.optional(Schema.String),
      message: Schema.optional(Schema.String),
      model: Schema.optional(Schema.String),
      cwd: Schema.optional(Schema.String),
      history_base: Schema.optional(Schema.Unknown),
      content: Schema.optional(Schema.Array(TranscriptContentBlock)),
      internal_chat_message_metadata_passthrough: Schema.optional(Schema.Unknown),
    }),
  ),
});

function isTextContentBlock(block: typeof TranscriptContentBlock.Type): boolean {
  return block.type === "text" || block.type === "input_text" || block.type === "output_text";
}

const trimBlankLines = (text: string) => text.replace(/^\s*\n/, "").trimEnd();

export function extractText(
  content: string | ReadonlyArray<typeof TranscriptContentBlock.Type> | undefined,
): string {
  if (typeof content === "string") return trimBlankLines(content);
  if (content === undefined) return "";
  return content
    .filter(isTextContentBlock)
    .map((block) => trimBlankLines(block.text ?? ""))
    .filter((text) => text.length > 0)
    .join("\n");
}

export function isHiddenClaudeRecord(record: DecodedTranscriptRecord): boolean {
  return record.isSidechain === true || record.isMeta === true || record.isCompactSummary === true;
}

function leadingBlocksEnd(text: string, block: RegExp): number {
  let end = 0;
  while (block.test(text)) {
    end = block.lastIndex;
  }
  return end;
}

// Claude Code records its own UI as user turns: slash commands, `!` shell runs and
// their output, task notifications. Keep what the user typed, as they typed it.
function claudeUiOutputEnd(text: string): number {
  return leadingBlocksEnd(
    text,
    /<(local-command-stdout|local-command-stderr|local-command-caveat|bash-stdout|bash-stderr)>[\s\S]*?<\/\1>\s*/y,
  );
}

// Shell payloads can print closing tags verbatim, so a complete envelope is
// judged by its outer tags; prose after a quoted block stays visible.
function isClaudeShellOutput(text: string): boolean {
  if (text.startsWith("<bash-stderr>")) return text.endsWith("</bash-stderr>");
  if (!text.startsWith("<bash-stdout>")) return false;
  return (
    text.endsWith("</bash-stdout>") ||
    (text.endsWith("</bash-stderr>") && /<\/bash-stdout>\s*<bash-stderr>/.test(text))
  );
}

const CLAUDE_COMMAND_BLOCK = /<command-(name|message|args)>[\s\S]*?<\/command-\1>\s*/y;

/**
 * A slash command as typed. Its arguments may name the thread; a bare command
 * leaves that to a later prompt. Null for any other text.
 */
function claudeCommand(text: string): { readonly text: string; readonly titleText: string } | null {
  if (!/^<command-(?:name|message)>/.test(text)) return null;
  if (leadingBlocksEnd(text, CLAUDE_COMMAND_BLOCK) !== text.length) return null;
  const name =
    /<command-name>([^<]*)<\/command-name>/.exec(text)?.[1]?.trim() ||
    `/${/<command-message>([^<]*)<\/command-message>/.exec(text)?.[1]?.trim() ?? ""}`;
  const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1]?.trim() ?? "";
  return { text: args.length === 0 ? name : `${name} ${args}`, titleText: args };
}

/** What a Claude user turn shows the user typed, and the part of it that may name the thread. */
function claudeUserText(text: string): { readonly text: string; readonly titleText: string } {
  const outputEnd = claudeUiOutputEnd(text);
  if (
    outputEnd === text.length ||
    // Only Claude writes task notifications, sometimes with trailing markup of its own.
    text.startsWith("<task-notification>") ||
    isClaudeShellOutput(text) ||
    /^\[Request interrupted by user(?: for tool use)?\]$/.test(text)
  ) {
    return { text: "", titleText: "" };
  }
  const shellInput = /^<bash-input>([\s\S]*)<\/bash-input>$/.exec(text)?.[1];
  if (shellInput !== undefined) return { text: `!${shellInput}`, titleText: "" };
  return (
    claudeCommand(text) ?? {
      text,
      titleText: text.slice(outputEnd || leadingBlocksEnd(text, CLAUDE_COMMAND_BLOCK)),
    }
  );
}

export function claudeVisibleText(record: DecodedTranscriptRecord) {
  const text = extractText(record.message?.content);
  return record.type === "user" ? claudeUserText(text) : { text, titleText: text };
}

/** Saved titles can be the raw markup of a user turn, such as the command that opened the session. */
function claudeTitle(title: string | undefined): string | undefined {
  const trimmed = title?.trim();
  if (!trimmed) return undefined;
  return claudeUserText(trimmed).text === trimmed ? trimmed : undefined;
}

export interface ClaudeFields {
  readonly sessionId: string | undefined;
  readonly title: string | undefined;
  readonly customTitle: string | null;
  readonly model: string | undefined;
}

export const emptyClaudeFields: ClaudeFields = {
  sessionId: undefined,
  title: undefined,
  customTitle: null,
  model: undefined,
};

export function foldClaudeFields(
  fields: ClaudeFields,
  record: DecodedTranscriptRecord,
): ClaudeFields {
  if (isHiddenClaudeRecord(record)) return fields;
  const model = record.message?.model?.trim();
  return {
    sessionId: record.sessionId?.trim() || fields.sessionId,
    title: claudeTitle(record.aiTitle) ?? fields.title,
    // Claude flushes the AI title after the user's rename; an empty rename clears it.
    customTitle:
      record.customTitle === undefined
        ? fields.customTitle
        : (claudeTitle(record.customTitle) ?? null),
    model: model && model !== "<synthetic>" ? model : fields.model,
  };
}

// Pi keeps abandoned branches in the file; its active branch runs from the last entry to the root.
export function activePiBranch(
  records: ReadonlyArray<DecodedTranscriptRecord>,
): ReadonlyArray<DecodedTranscriptRecord> {
  const entries = records.filter((record) => record.type !== "session");
  const leaf = entries.at(-1);
  // Version 1 sessions predate the tree and are linear.
  if (leaf?.id === undefined) return entries;
  const byId = new Map(
    entries.flatMap((entry) => (entry.id === undefined ? [] : [[entry.id, entry] as const])),
  );
  const branch: Array<DecodedTranscriptRecord> = [];
  const seen = new Set<string>();
  for (
    let entry: DecodedTranscriptRecord | undefined = leaf;
    entry !== undefined && branch.length < entries.length;
    entry = entry.parentId ? byId.get(entry.parentId) : undefined
  ) {
    if (entry.id && seen.has(entry.id)) break;
    if (entry.id) seen.add(entry.id);
    branch.push(entry);
  }
  return branch.toReversed();
}

export type DecodedTranscriptRecord = typeof TranscriptRecord.Type;

export interface TranscriptItem {
  readonly id: string;
  readonly role: "user" | "assistant" | "tool";
  readonly text: string;
}

export function conversationItem(record: DecodedTranscriptRecord, source: "claudeAgent" | "pi") {
  const role = source === "pi" ? record.message?.role : record.type;
  if (source === "claudeAgent" && isHiddenClaudeRecord(record)) return null;
  if (source === "pi" && record.type !== "message") return null;
  if (role !== "user" && role !== "assistant") return null;
  const text = extractText(record.message?.content);
  return text ? { id: source === "pi" ? record.id : record.uuid, role, text } : null;
}

export function transcriptItems(
  record: DecodedTranscriptRecord,
  source: "claudeAgent" | "pi",
): ReadonlyArray<TranscriptItem> {
  if (source === "claudeAgent" && isHiddenClaudeRecord(record)) return [];
  if (source === "pi" && record.type !== "message") return [];
  if (source === "claudeAgent" && record.type !== "user" && record.type !== "assistant") return [];
  const nativeId = source === "pi" ? record.id : record.uuid;
  if (!nativeId) return [];
  if (source === "pi" && record.message?.role === "toolResult") {
    const text = extractText(record.message.content);
    return text ? [{ id: nativeId, role: "tool", text }] : [];
  }
  const conversation = conversationItem(record, source);
  const items: TranscriptItem[] = conversation ? [{ ...conversation, id: nativeId }] : [];
  const content = record.message?.content;
  if (typeof content === "string" || content === undefined) return items;
  for (const [index, block] of content.entries()) {
    const text =
      block.type === "tool_result"
        ? extractText(block.content)
        : block.type === "tool_use"
          ? [block.name, JSON.stringify(block.input)].filter(Boolean).join("\n")
          : "";
    if (text) items.push({ id: `${nativeId}/tool/${index}`, role: "tool", text });
  }
  return items;
}

export function isPiConversationRecord(record: DecodedTranscriptRecord): boolean {
  return (
    record.type === "message" &&
    (record.message?.role === "user" || record.message?.role === "assistant")
  );
}
