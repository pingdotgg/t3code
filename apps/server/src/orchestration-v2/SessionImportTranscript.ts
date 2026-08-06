import {
  EventId,
  MessageId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2TurnItem,
  type ProviderDriverKind,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

export const SESSION_IMPORT_EVENT_PREFIX = "import:session";
const IMPORTED_MESSAGE_INDEX_DIGITS = 6;
const IMPORTED_TOOL_OUTPUT_MAX_CHARS = 4_000;

export type ImportableSessionDriver = "claudeAgent" | "codex";

export function isImportableSessionDriver(driver: string): driver is ImportableSessionDriver {
  return driver === "claudeAgent" || driver === "codex";
}

/**
 * One transcript row read from a provider's on-disk session. `message` rows
 * become conversation messages; the other kinds become display-only turn
 * items so tool activity from the original session stays visible.
 */
export type ImportedTranscriptEntry =
  | {
      readonly kind: "message";
      readonly sourceId: string;
      readonly role: "user" | "assistant";
      readonly text: string;
      readonly timestamp: string | undefined;
    }
  | {
      readonly kind: "reasoning";
      readonly sourceId: string;
      readonly text: string;
      readonly timestamp: string | undefined;
    }
  | {
      readonly kind: "command";
      readonly sourceId: string;
      readonly input: string;
      readonly output: string | undefined;
      readonly timestamp: string | undefined;
    }
  | {
      readonly kind: "file_change";
      readonly sourceId: string;
      readonly fileName: string;
      readonly oldStr: string | undefined;
      readonly newStr: string | undefined;
      readonly timestamp: string | undefined;
    };

function joinTextParts(parts: ReadonlyArray<unknown>): string {
  return parts
    .flatMap((part) => {
      if (part === null || typeof part !== "object") return [];
      const record = part as { readonly type?: unknown; readonly text?: unknown };
      return (record.type === "text" ||
        record.type === "input_text" ||
        record.type === "output_text") &&
        typeof record.text === "string"
        ? [record.text]
        : [];
    })
    .join("\n\n")
    .trim();
}

function truncateOutput(value: string): string {
  return value.length > IMPORTED_TOOL_OUTPUT_MAX_CHARS
    ? `${value.slice(0, IMPORTED_TOOL_OUTPUT_MAX_CHARS)}\n… (truncated)`
    : value;
}

/** Synthetic context blocks providers write into their transcripts as user turns. */
function isSyntheticContextText(text: string): boolean {
  return (
    text.startsWith("<environment_context>") ||
    text.startsWith("<user_instructions>") ||
    text.startsWith("<system-reminder>")
  );
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function compactToolInput(name: string, input: unknown): string {
  let rendered = "";
  try {
    rendered = JSON.stringify(input) ?? "";
  } catch {
    rendered = "";
  }
  if (rendered.length > 300) rendered = `${rendered.slice(0, 300)}…`;
  return rendered.length > 0 && rendered !== "{}" ? `${name} ${rendered}` : name;
}

interface ClaudeContentBlock {
  readonly type?: unknown;
  readonly text?: unknown;
  readonly thinking?: unknown;
  readonly id?: unknown;
  readonly name?: unknown;
  readonly input?: unknown;
  readonly tool_use_id?: unknown;
  readonly content?: unknown;
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (globalThis.Array.isArray(content)) return joinTextParts(content);
  return "";
}

const FILE_CHANGE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

function claudeToolEntry(input: {
  readonly block: ClaudeContentBlock;
  readonly sourceId: string;
  readonly output: string | undefined;
  readonly timestamp: string | undefined;
}): ImportedTranscriptEntry {
  const name = asString(input.block.name) ?? "tool";
  const toolInput = (input.block.input ?? {}) as {
    readonly command?: unknown;
    readonly file_path?: unknown;
    readonly old_string?: unknown;
    readonly new_string?: unknown;
    readonly content?: unknown;
  };
  const filePath = asString(toolInput.file_path);
  if (FILE_CHANGE_TOOLS.has(name) && filePath !== undefined) {
    return {
      kind: "file_change",
      sourceId: input.sourceId,
      fileName: filePath,
      oldStr: asString(toolInput.old_string),
      newStr: asString(toolInput.new_string) ?? asString(toolInput.content),
      timestamp: input.timestamp,
    };
  }
  const command =
    name === "Bash" && asString(toolInput.command) !== undefined
      ? asString(toolInput.command)!
      : compactToolInput(name, input.block.input);
  return {
    kind: "command",
    sourceId: input.sourceId,
    input: command,
    output:
      input.output === undefined || input.output.length === 0
        ? undefined
        : truncateOutput(input.output),
    timestamp: input.timestamp,
  };
}

/**
 * Maps messages returned by the Claude Agent SDK's `getSessionMessages` into
 * transcript entries. Text becomes conversation messages; thinking blocks,
 * tool calls (paired with their tool results) and file edits become
 * display-only entries.
 */
export function mapClaudeSessionMessages(
  messages: ReadonlyArray<{
    readonly type: string;
    readonly uuid: string;
    readonly message: unknown;
  }>,
): Array<ImportedTranscriptEntry> {
  // Tool results arrive as later user messages; collect them first so a tool
  // call can be emitted with its output in the position of the call.
  const outputsByToolUseId = new Map<string, string>();
  for (const message of messages) {
    const content = (message.message as { readonly content?: unknown } | null)?.content;
    if (!globalThis.Array.isArray(content)) continue;
    for (const raw of content) {
      const block = raw as ClaudeContentBlock;
      const toolUseId = asString(block.tool_use_id);
      if (block.type === "tool_result" && toolUseId !== undefined) {
        outputsByToolUseId.set(toolUseId, toolResultText(block.content));
      }
    }
  }

  const entries: Array<ImportedTranscriptEntry> = [];
  for (const message of messages) {
    if (message.type !== "user" && message.type !== "assistant") continue;
    const body = message.message as { readonly content?: unknown } | null;
    const content = body?.content;
    if (typeof content === "string") {
      const text = content.trim();
      if (text.length > 0 && !isSyntheticContextText(text)) {
        entries.push({
          kind: "message",
          sourceId: message.uuid,
          role: message.type,
          text,
          timestamp: undefined,
        });
      }
      continue;
    }
    if (!globalThis.Array.isArray(content)) continue;
    const text = joinTextParts(content);
    if (text.length > 0 && !isSyntheticContextText(text)) {
      entries.push({
        kind: "message",
        sourceId: message.uuid,
        role: message.type,
        text,
        timestamp: undefined,
      });
    }
    content.forEach((raw, blockIndex) => {
      const block = raw as ClaudeContentBlock;
      if (block.type === "thinking" && typeof block.thinking === "string") {
        const thinking = block.thinking.trim();
        if (thinking.length > 0) {
          entries.push({
            kind: "reasoning",
            sourceId: `${message.uuid}:r${blockIndex}`,
            text: thinking,
            timestamp: undefined,
          });
        }
      } else if (block.type === "tool_use") {
        const toolUseId = asString(block.id) ?? `${message.uuid}:u${blockIndex}`;
        entries.push(
          claudeToolEntry({
            block,
            sourceId: toolUseId,
            output: outputsByToolUseId.get(toolUseId),
            timestamp: undefined,
          }),
        );
      }
    });
  }
  return entries;
}

interface CodexRolloutLine {
  readonly timestamp?: unknown;
  readonly type?: unknown;
  readonly payload?: unknown;
}

export interface CodexRolloutTranscript {
  readonly workspaceRoot: string | null;
  readonly entries: ReadonlyArray<ImportedTranscriptEntry>;
}

function codexCommandText(name: string, argumentsJson: unknown): string {
  const rendered = asString(argumentsJson) ?? "";
  try {
    const parsed = JSON.parse(rendered) as { readonly command?: unknown };
    if (globalThis.Array.isArray(parsed.command)) {
      return parsed.command.map(String).join(" ");
    }
    if (typeof parsed.command === "string") {
      return parsed.command;
    }
  } catch {
    // fall through to the generic rendering
  }
  return rendered.length > 0 ? compactToolInput(name, parseJsonOr(rendered, rendered)) : name;
}

function parseJsonOr(json: string, fallback: unknown): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return fallback;
  }
}

function codexOutputText(output: unknown): string {
  if (typeof output === "string") {
    const parsed = parseJsonOr(output, null) as { readonly output?: unknown } | null;
    return asString(parsed?.output) ?? output;
  }
  return asString((output as { readonly output?: unknown } | null)?.output) ?? "";
}

/**
 * Parses a Codex rollout `.jsonl` transcript. Messages, reasoning and
 * function calls (paired with their outputs by call id) all survive;
 * unknown line shapes are skipped.
 */
export function parseCodexRollout(content: string): CodexRolloutTranscript {
  let workspaceRoot: string | null = null;
  const seenSourceIds = new Set<string>();
  const parsedLines: Array<{
    readonly timestamp: string | undefined;
    readonly lineType: unknown;
    readonly record: {
      readonly type?: unknown;
      readonly id?: unknown;
      readonly role?: unknown;
      readonly content?: unknown;
      readonly message?: unknown;
      readonly cwd?: unknown;
      readonly name?: unknown;
      readonly arguments?: unknown;
      readonly call_id?: unknown;
      readonly output?: unknown;
      readonly summary?: unknown;
    };
    readonly index: number;
  }> = [];

  let index = 0;
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    index += 1;
    let parsed: CodexRolloutLine;
    try {
      parsed = JSON.parse(line) as CodexRolloutLine;
    } catch {
      continue;
    }
    const payload = parsed.payload;
    if (payload === null || typeof payload !== "object") continue;
    parsedLines.push({
      timestamp: typeof parsed.timestamp === "string" ? parsed.timestamp : undefined,
      lineType: parsed.type,
      record: payload as (typeof parsedLines)[number]["record"],
      index,
    });
  }

  const outputsByCallId = new Map<string, string>();
  for (const line of parsedLines) {
    const callId = asString(line.record.call_id);
    if (
      line.lineType === "response_item" &&
      line.record.type === "function_call_output" &&
      callId !== undefined
    ) {
      outputsByCallId.set(callId, codexOutputText(line.record.output));
    }
  }

  const entries: Array<ImportedTranscriptEntry> = [];
  const push = (entry: ImportedTranscriptEntry) => {
    if (seenSourceIds.has(entry.sourceId)) return;
    if (entry.kind === "message" && (entry.text.length === 0 || isSyntheticContextText(entry.text)))
      return;
    seenSourceIds.add(entry.sourceId);
    entries.push(entry);
  };

  for (const { timestamp, lineType, record, index: lineIndex } of parsedLines) {
    if (lineType === "session_meta" && typeof record.cwd === "string") {
      workspaceRoot = record.cwd.trim() || null;
      continue;
    }
    const sourceId = asString(record.id) ?? asString(record.call_id) ?? `line-${lineIndex}`;

    if (lineType === "response_item") {
      if (record.type === "message") {
        const role = record.role;
        if (role !== "user" && role !== "assistant") continue;
        const text = globalThis.Array.isArray(record.content) ? joinTextParts(record.content) : "";
        push({ kind: "message", sourceId, role, text, timestamp });
      } else if (record.type === "reasoning") {
        const summary = globalThis.Array.isArray(record.summary)
          ? record.summary
              .map((part) => asString((part as { readonly text?: unknown }).text) ?? "")
              .join("\n\n")
              .trim()
          : "";
        if (summary.length > 0) {
          push({ kind: "reasoning", sourceId, text: summary, timestamp });
        }
      } else if (record.type === "function_call") {
        const name = asString(record.name) ?? "tool";
        const output = outputsByCallId.get(asString(record.call_id) ?? "");
        push({
          kind: "command",
          sourceId,
          input: codexCommandText(name, record.arguments),
          output: output === undefined || output.length === 0 ? undefined : truncateOutput(output),
          timestamp,
        });
      }
      continue;
    }

    if (lineType === "event_msg") {
      if (record.type === "user_message" && typeof record.message === "string") {
        push({
          kind: "message",
          sourceId,
          role: "user",
          text: record.message.trim(),
          timestamp,
        });
      } else if (record.type === "agent_message" && typeof record.message === "string") {
        push({
          kind: "message",
          sourceId,
          role: "assistant",
          text: record.message.trim(),
          timestamp,
        });
      }
    }
  }

  return { workspaceRoot, entries };
}

export interface ImportedThreadEventBatch {
  readonly events: ReadonlyArray<OrchestrationV2DomainEvent>;
  readonly positions: ReadonlyArray<{ readonly turnItemId: TurnItemId; readonly ordinal: number }>;
}

export function importedMessageId(input: {
  readonly driver: ImportableSessionDriver;
  readonly threadId: ThreadId;
  readonly index: number;
  readonly sourceId: string;
}): MessageId {
  return MessageId.make(
    `imported:${input.driver}:${input.threadId}:${String(input.index).padStart(IMPORTED_MESSAGE_INDEX_DIGITS, "0")}:${input.sourceId}`,
  );
}

export function importedEntryEventId(input: {
  readonly driver: ImportableSessionDriver;
  readonly threadId: ThreadId;
  readonly index: number;
  readonly entry: ImportedTranscriptEntry;
}): EventId {
  const key = importedMessageId({
    driver: input.driver,
    threadId: input.threadId,
    index: input.index,
    sourceId: input.entry.sourceId,
  });
  return input.entry.kind === "message"
    ? EventId.make(`${SESSION_IMPORT_EVENT_PREFIX}:message:${key}`)
    : EventId.make(`${SESSION_IMPORT_EVENT_PREFIX}:item:${key}`);
}

/**
 * Builds the synthetic events for each transcript entry: a
 * `message.updated` + `turn-item.updated` pair for conversation messages, a
 * single `turn-item.updated` for reasoning/tool entries. Ids are
 * deterministic in (driver, threadId, transcript index, source id), so a
 * repeated import or sync pass cannot duplicate rows. `ordinalBase` shifts
 * position ordinals so synced entries can land after existing native runs.
 */
export function buildImportedThreadEvents(input: {
  readonly driver: ImportableSessionDriver;
  readonly providerDriver: ProviderDriverKind;
  readonly threadId: ThreadId;
  readonly entries: ReadonlyArray<{
    readonly entry: ImportedTranscriptEntry;
    readonly index: number;
    /** Keeps an existing item's ordinal when re-emitting it with new content. */
    readonly ordinal?: number;
  }>;
  readonly fallbackAt: DateTime.Utc;
  readonly ordinalBase?: number;
}): ImportedThreadEventBatch {
  const events: Array<OrchestrationV2DomainEvent> = [];
  const positions: Array<{ readonly turnItemId: TurnItemId; readonly ordinal: number }> = [];
  const ordinalBase = input.ordinalBase ?? 0;
  let sequence = 0;
  for (const { entry, index, ordinal: explicitOrdinal } of input.entries) {
    sequence += 1;
    const occurredAt =
      entry.timestamp === undefined
        ? input.fallbackAt
        : Option.getOrElse(DateTime.make(entry.timestamp), () => input.fallbackAt);
    const entryKey = importedMessageId({
      driver: input.driver,
      threadId: input.threadId,
      index,
      sourceId: entry.sourceId,
    });
    const turnItemId = TurnItemId.make(`${SESSION_IMPORT_EVENT_PREFIX}:turn-item:${entryKey}`);
    const ordinal = explicitOrdinal ?? ordinalBase + sequence;
    const baseTurnItem = {
      id: turnItemId,
      threadId: input.threadId,
      runId: null,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: {
        driver: input.providerDriver,
        nativeId: entry.sourceId,
        strength: "weak" as const,
      },
      parentItemId: null,
      ordinal,
      status: "completed" as const,
      title: null,
      startedAt: occurredAt,
      completedAt: occurredAt,
      updatedAt: occurredAt,
    };

    let turnItem: OrchestrationV2TurnItem;
    if (entry.kind === "message") {
      const messageId = entryKey;
      const message: OrchestrationV2ConversationMessage = {
        createdBy: entry.role === "user" ? "user" : "agent",
        creationSource: "server",
        id: messageId,
        threadId: input.threadId,
        runId: null,
        nodeId: null,
        role: entry.role,
        text: entry.text,
        attachments: [],
        streaming: false,
        createdAt: occurredAt,
        updatedAt: occurredAt,
      };
      events.push({
        id: importedEntryEventId({
          driver: input.driver,
          threadId: input.threadId,
          index,
          entry,
        }),
        type: "message.updated",
        threadId: input.threadId,
        occurredAt,
        payload: message,
      });
      turnItem =
        entry.role === "user"
          ? {
              ...baseTurnItem,
              createdBy: "user",
              creationSource: "server",
              type: "user_message",
              messageId,
              inputIntent: "turn_start",
              text: entry.text,
              attachments: [],
            }
          : {
              ...baseTurnItem,
              type: "assistant_message",
              messageId,
              text: entry.text,
              streaming: false,
            };
    } else if (entry.kind === "reasoning") {
      turnItem = { ...baseTurnItem, type: "reasoning", text: entry.text, streaming: false };
    } else if (entry.kind === "command") {
      turnItem = {
        ...baseTurnItem,
        type: "command_execution",
        input: entry.input,
        ...(entry.output === undefined ? {} : { output: entry.output }),
      };
    } else {
      turnItem = {
        ...baseTurnItem,
        type: "file_change",
        fileName: entry.fileName,
        ...(entry.oldStr === undefined ? {} : { oldStr: entry.oldStr }),
        ...(entry.newStr === undefined ? {} : { newStr: entry.newStr }),
      };
    }

    events.push({
      id: EventId.make(`${SESSION_IMPORT_EVENT_PREFIX}:turn-item:${entryKey}`),
      type: "turn-item.updated",
      threadId: input.threadId,
      occurredAt,
      payload: turnItem,
    });
    positions.push({ turnItemId, ordinal });
  }
  return { events, positions };
}
