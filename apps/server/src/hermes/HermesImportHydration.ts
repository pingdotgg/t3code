import type { HermesGatewayHistoryMessage } from "@t3tools/contracts";

/**
 * Rehydrates imported Hermes history into native T3 activity descriptors.
 *
 * Hermes `session.history` interleaves assistant reasoning, structured tool
 * calls, and tool-result rows with the plain transcript. This module pairs
 * calls with results by tool-call id, maps tool categories onto the native
 * turn-item presentations, and reports which transcript rows are subsumed by
 * a rehydrated activity so they can be hidden from the displayed
 * conversation while keeping their history ordinals stable.
 */

export const HERMES_IMPORT_MAX_OUTPUT_CHARS = 20_000;
export const HERMES_IMPORT_TRUNCATION_MARKER = "\n\n[output truncated]";

/**
 * Synthetic transcript rows Hermes injects for its own timeline (model
 * switches, delegation completion pings, auto-continue prompts). They are
 * not conversation content and are suppressed from the imported transcript.
 */
const SYNTHETIC_DISPLAY_KINDS = new Set([
  "model_switch",
  "async_delegation_complete",
  "auto_continue",
]);

export type HermesImportedActivity =
  | {
      readonly kind: "reasoning";
      readonly key: string;
      readonly ordinal: number;
      readonly text: string;
    }
  | {
      readonly kind: "command_execution";
      readonly key: string;
      readonly ordinal: number;
      readonly status: "completed" | "cancelled";
      readonly title: string | null;
      readonly input: string;
      readonly output: string | undefined;
    }
  | {
      readonly kind: "file_change";
      readonly key: string;
      readonly ordinal: number;
      readonly status: "completed" | "cancelled";
      readonly title: string | null;
      readonly fileName: string;
    }
  | {
      readonly kind: "web_search";
      readonly key: string;
      readonly ordinal: number;
      readonly status: "completed" | "cancelled";
      readonly title: string | null;
      readonly patterns: ReadonlyArray<string>;
    }
  | {
      readonly kind: "dynamic_tool";
      readonly key: string;
      readonly ordinal: number;
      readonly status: "completed" | "cancelled";
      readonly title: string | null;
      readonly toolName: string | null;
      readonly input: unknown;
      readonly output: string | undefined;
    };

export interface HermesImportHydrationResult {
  readonly activities: ReadonlyArray<HermesImportedActivity>;
  /**
   * History ordinals whose transcript rows are fully represented by a
   * rehydrated activity (tool results, synthetic notifications). They stay in
   * Hermes storage for positional stability but are hidden from the displayed
   * conversation.
   */
  readonly hiddenOrdinals: ReadonlySet<number>;
}

interface ParsedToolCall {
  readonly callId: string;
  readonly name: string;
  readonly input: unknown;
  readonly ordinal: number;
  readonly indexInMessage: number;
}

/**
 * Parses tool-call arguments without ever throwing: valid JSON becomes the
 * structured input, anything else is preserved as the raw string.
 */
export function parseHermesToolArguments(raw: unknown): unknown {
  if (typeof raw !== "string") return raw ?? {};
  const trimmed = raw.trim();
  if (trimmed.length === 0) return {};
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return { raw };
  }
}

export function truncateHermesToolOutput(output: string): string {
  if (output.length <= HERMES_IMPORT_MAX_OUTPUT_CHARS) return output;
  return output.slice(0, HERMES_IMPORT_MAX_OUTPUT_CHARS) + HERMES_IMPORT_TRUNCATION_MARKER;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function extractToolCalls(message: HermesGatewayHistoryMessage, ordinal: number): ParsedToolCall[] {
  if (!Array.isArray(message.tool_calls)) return [];
  const calls: ParsedToolCall[] = [];
  for (const [indexInMessage, entry] of message.tool_calls.entries()) {
    const record = asRecord(entry);
    if (record === null) continue;
    const fn = asRecord(record["function"]);
    const name = (fn === null ? null : readString(fn, "name")) ?? readString(record, "name");
    if (name === null) continue;
    const callId = readString(record, "id") ?? `${ordinal}:${indexInMessage}`;
    calls.push({
      callId,
      name,
      input: parseHermesToolArguments(fn?.["arguments"]),
      ordinal,
      indexInMessage,
    });
  }
  return calls;
}

const TERMINAL_TOOL_NAMES = new Set([
  "terminal",
  "bash",
  "shell",
  "run_command",
  "execute_command",
  "run_terminal_cmd",
  "terminal_command",
  "exec",
]);

const FILE_TOOL_NAMES = new Set([
  "write_file",
  "edit_file",
  "create_file",
  "apply_patch",
  "str_replace",
  "str_replace_editor",
  "file_edit",
  "write",
  "edit",
]);

const WEB_SEARCH_TOOL_NAMES = new Set([
  "web_search",
  "search_web",
  "brave_search",
  "google_search",
  "web-search",
  "websearch",
]);

function commandFromInput(input: unknown): string | null {
  const record = asRecord(input);
  if (record === null) return typeof input === "string" ? input : null;
  return (
    readString(record, "command") ??
    readString(record, "cmd") ??
    readString(record, "input") ??
    readString(record, "script")
  );
}

function fileNameFromInput(input: unknown): string | null {
  const record = asRecord(input);
  if (record === null) return null;
  return (
    readString(record, "path") ??
    readString(record, "file_path") ??
    readString(record, "filename") ??
    readString(record, "file")
  );
}

function searchPatternFromInput(input: unknown): string | null {
  const record = asRecord(input);
  if (record === null) return typeof input === "string" ? input : null;
  return readString(record, "query") ?? readString(record, "q") ?? readString(record, "search");
}

function activityFromPairedCall(input: {
  readonly call: ParsedToolCall;
  readonly output: string | undefined;
  readonly status: "completed" | "cancelled";
  readonly ordinal: number;
}): HermesImportedActivity {
  const { call, status, ordinal } = input;
  const key = `tool:${call.ordinal}:${call.indexInMessage}:${call.callId}`;
  const normalizedName = call.name.toLowerCase();
  const output = input.output === undefined ? undefined : truncateHermesToolOutput(input.output);

  if (TERMINAL_TOOL_NAMES.has(normalizedName)) {
    const command = commandFromInput(call.input);
    if (command !== null) {
      return {
        kind: "command_execution",
        key,
        ordinal,
        status,
        title: command,
        input: command,
        output,
      };
    }
  }

  if (FILE_TOOL_NAMES.has(normalizedName)) {
    const fileName = fileNameFromInput(call.input);
    if (fileName !== null) {
      return { kind: "file_change", key, ordinal, status, title: fileName, fileName };
    }
  }

  if (WEB_SEARCH_TOOL_NAMES.has(normalizedName)) {
    const pattern = searchPatternFromInput(call.input);
    return {
      kind: "web_search",
      key,
      ordinal,
      status,
      title: pattern,
      patterns: pattern === null ? [] : [pattern],
    };
  }

  return {
    kind: "dynamic_tool",
    key,
    ordinal,
    status,
    title: call.name,
    toolName: call.name,
    input: call.input,
    output,
  };
}

function coerceReasoningText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((entry) => coerceReasoningText(entry))
      .filter((text) => text.length > 0)
      .join("\n");
  }
  const record = asRecord(value);
  if (record === null) return "";
  for (const key of ["text", "content", "summary", "reasoning"]) {
    const nested = record[key];
    if (nested !== undefined) {
      const text = coerceReasoningText(nested);
      if (text.length > 0) return text;
    }
  }
  return "";
}

export function extractHermesReasoningText(message: HermesGatewayHistoryMessage): string {
  for (const value of [
    message.reasoning,
    message.reasoning_content,
    message.reasoning_details,
    message.codex_reasoning_items,
  ]) {
    if (value === undefined || value === null) continue;
    const text = coerceReasoningText(value).trim();
    if (text.length > 0) return text;
  }
  return "";
}

/**
 * Gateway-forged notification rows (async delegation completions, background
 * process watch matches) are replayed to the model as user turns but were
 * never typed by a person.
 */
const SYNTHETIC_NOTIFICATION_PATTERN =
  /^\[(?:ASYNC DELEGATION (?:BATCH )?COMPLETE|IMPORTANT: Background process)\b/u;

export function isSyntheticHermesTranscriptRow(message: HermesGatewayHistoryMessage): boolean {
  if (message.display_kind !== undefined && SYNTHETIC_DISPLAY_KINDS.has(message.display_kind)) {
    return true;
  }
  return (
    message.role === "user" && SYNTHETIC_NOTIFICATION_PATTERN.test((message.text ?? "").trimStart())
  );
}

const OBSERVED_CONTEXT_HEADER_PATTERN = /^\[Observed [^\]\n]+ group context[^\]\n]*\]$/u;
const ADDRESSED_MESSAGE_HEADER_PATTERN = /^\[Current addressed message[^\]\n]*\]$/u;
const NEW_MESSAGE_HEADER = "[New message]";
const DELIVERED_FROM_PREFIX = /^\[Delivered from [^\]\n]+\]\s*/u;
const SENDER_PREFIX = /^\[(?<name>[^\]\n]{1,120})\]\s+/u;
const SENDER_PREFIX_EXCLUSIONS =
  /^(?:User sent |The user sent |Delivered from |New message$|Observed |Current addressed message|IMPORTANT:|ASYNC DELEGATION )/u;
const ATTACHMENT_ENVELOPE_LINE =
  /^\[User sent (?:an image|audio|a video|a file): (?<target>[^\]\n]+)\]$/u;
const ATTACHMENT_DOCUMENT_LINE =
  /^\[The user sent (?:a text document|a document|an audio file attachment|a video attachment): '(?<name>[^'\n]+)'\.[^\]]*\]$/u;

/**
 * Strips Hermes gateway transport framing from an imported user message:
 * observed-group-context backfill, "[New message]" routing headers,
 * "[Delivered from ...]" mirror prefixes, shared-session "[Sender] " name
 * prefixes, and attachment delivery envelopes (reduced to a compact
 * "[Attachment: ...]" marker). Applies only to inherited transcript rows;
 * native T3 messages are never passed through this.
 */
export function normalizeImportedHermesUserText(text: string): string {
  let value = text;

  // Channel backfill blocks: keep only the addressed message.
  const newMessageIndex = value.indexOf(`\n\n${NEW_MESSAGE_HEADER}\n`);
  if (newMessageIndex !== -1) {
    value = value.slice(newMessageIndex + NEW_MESSAGE_HEADER.length + 3);
  }
  const lines = value.split("\n");
  if (lines.some((line) => OBSERVED_CONTEXT_HEADER_PATTERN.test(line.trim()))) {
    const addressedIndex = lines.findIndex((line) =>
      ADDRESSED_MESSAGE_HEADER_PATTERN.test(line.trim()),
    );
    if (addressedIndex !== -1) {
      value = lines.slice(addressedIndex + 1).join("\n");
    }
  }

  value = value.replace(DELIVERED_FROM_PREFIX, "");

  const sender = SENDER_PREFIX.exec(value);
  if (sender?.groups?.["name"] !== undefined) {
    const name = sender.groups["name"];
    if (!SENDER_PREFIX_EXCLUSIONS.test(name)) {
      value = value.slice(sender[0].length);
    }
  }

  value = value
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      const envelope = ATTACHMENT_ENVELOPE_LINE.exec(trimmed);
      if (envelope?.groups?.["target"] !== undefined) {
        return `[Attachment: ${envelope.groups["target"]}]`;
      }
      const documentEnvelope = ATTACHMENT_DOCUMENT_LINE.exec(trimmed);
      if (documentEnvelope?.groups?.["name"] !== undefined) {
        return `[Attachment: ${documentEnvelope.groups["name"]}]`;
      }
      return line;
    })
    .join("\n");

  return value.trim();
}

/**
 * Walks the inherited portion of an imported Hermes history and produces the
 * native activities plus the transcript rows they subsume. Deterministic:
 * activity keys derive from history ordinals and tool-call ids, and the
 * output is ordered by history position.
 */
export function hydrateImportedHermesActivities(
  messages: ReadonlyArray<HermesGatewayHistoryMessage>,
): HermesImportHydrationResult {
  const activities: HermesImportedActivity[] = [];
  const hiddenOrdinals = new Set<number>();
  const pendingCalls = new Map<string, ParsedToolCall>();

  for (const [ordinal, message] of messages.entries()) {
    if (isSyntheticHermesTranscriptRow(message)) {
      hiddenOrdinals.add(ordinal);
      continue;
    }

    if (message.role === "assistant") {
      const reasoningText = extractHermesReasoningText(message);
      if (reasoningText.length > 0) {
        activities.push({
          kind: "reasoning",
          key: `reasoning:${ordinal}`,
          ordinal,
          text: reasoningText,
        });
      }
      for (const call of extractToolCalls(message, ordinal)) {
        pendingCalls.set(call.callId, call);
      }
      if ((message.text ?? "").trim().length === 0) {
        hiddenOrdinals.add(ordinal);
      }
      continue;
    }

    if (message.role === "tool") {
      hiddenOrdinals.add(ordinal);
      const callId = message.tool_call_id;
      const pending = callId === undefined ? undefined : pendingCalls.get(callId);
      if (pending !== undefined && callId !== undefined) {
        pendingCalls.delete(callId);
        activities.push(
          activityFromPairedCall({
            call: pending,
            output: message.text ?? message.context,
            status: "completed",
            ordinal,
          }),
        );
        continue;
      }
      const toolName = message.tool_name ?? message.name;
      const preview = message.context ?? message.text;
      if (toolName !== undefined || preview !== undefined) {
        activities.push({
          kind: "dynamic_tool",
          key: `tool-result:${ordinal}`,
          ordinal,
          status: "completed",
          title: toolName ?? null,
          toolName: toolName ?? null,
          input: preview === undefined ? {} : { context: preview },
          output: undefined,
        });
      }
    }
  }

  // Calls that never received a result were interrupted mid-run; keep them
  // visible as stopped activities instead of silently dropping them.
  for (const call of pendingCalls.values()) {
    activities.push(
      activityFromPairedCall({
        call,
        output: undefined,
        status: "cancelled",
        ordinal: call.ordinal,
      }),
    );
  }

  activities.sort((left, right) =>
    left.ordinal !== right.ordinal
      ? left.ordinal - right.ordinal
      : left.key.localeCompare(right.key),
  );

  return { activities, hiddenOrdinals };
}
