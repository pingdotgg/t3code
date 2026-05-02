import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  type OrchestrationMessageRole,
  type ProviderInteractionMode,
  type RuntimeMode,
} from "@t3tools/contracts";

export interface ParsedCodexTranscriptMessage {
  readonly role: OrchestrationMessageRole;
  readonly text: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ParsedCodexTranscript {
  readonly model: string | null;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly messages: ReadonlyArray<ParsedCodexTranscriptMessage>;
}

export class CodexTranscriptParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexTranscriptParseError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function normalizeRuntimeMode(value: unknown): RuntimeMode {
  return readString(value) === "danger-full-access" ? "full-access" : "approval-required";
}

function normalizeInteractionMode(value: unknown): ProviderInteractionMode {
  return readString(value) === "plan" ? "plan" : "default";
}

function normalizeTimestamp(value: unknown, lineNumber: number): string {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      throw new CodexTranscriptParseError(
        `Invalid JSONL transcript at line ${String(lineNumber)}: response_item is missing a timestamp.`,
      );
    }
    if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) {
      return normalizeTimestamp(Number(trimmed), lineNumber);
    }
    const timestamp = new Date(trimmed);
    if (Number.isFinite(timestamp.getTime())) {
      return timestamp.toISOString();
    }
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    const timestampMs = Math.abs(value) < 1_000_000_000_000 ? value * 1_000 : value;
    const timestamp = new Date(timestampMs);
    if (Number.isFinite(timestamp.getTime())) {
      return timestamp.toISOString();
    }
  }

  throw new CodexTranscriptParseError(
    `Invalid JSONL transcript at line ${String(lineNumber)}: response_item is missing a timestamp.`,
  );
}

function extractTurnContext(record: Record<string, unknown>): Record<string, unknown> | null {
  if (readString(record.type) === "turn_context") {
    if (isRecord(record.payload)) {
      return record.payload;
    }
    return record;
  }

  if (isRecord(record.turn_context)) {
    return record.turn_context;
  }

  if (isRecord(record.payload) && isRecord(record.payload.turn_context)) {
    return record.payload.turn_context;
  }

  return null;
}

function extractResponseMessage(record: Record<string, unknown>): Record<string, unknown> | null {
  if (readString(record.type) !== "response_item") {
    return null;
  }

  if (!isRecord(record.payload)) {
    return null;
  }

  return readString(record.payload.type) === "message" ? record.payload : null;
}

function readContentText(contentItem: unknown): string {
  if (!isRecord(contentItem)) {
    return "";
  }

  const type = readString(contentItem.type);
  if (type !== "input_text" && type !== "output_text" && type !== "text") {
    return "";
  }

  return (
    readString(contentItem.text) ??
    readString(contentItem.value) ??
    readString(contentItem.content) ??
    ""
  );
}

function readMessageText(payload: Record<string, unknown>): string {
  const content = Array.isArray(payload.content) ? payload.content : [];
  return content.map(readContentText).join("");
}

function pushWithinWindow<T>(items: T[], item: T, maxItems?: number): void {
  items.push(item);
  if (maxItems !== undefined && maxItems > 0 && items.length > maxItems) {
    items.splice(0, items.length - maxItems);
  }
}

export function parseCodexTranscript(
  rawJsonl: string,
  options?: { readonly messageWindow?: number },
): ParsedCodexTranscript {
  const messages: ParsedCodexTranscriptMessage[] = [];
  let model: string | null = null;
  let runtimeMode: RuntimeMode = DEFAULT_RUNTIME_MODE;
  let interactionMode: ProviderInteractionMode = DEFAULT_PROVIDER_INTERACTION_MODE;

  const lines = rawJsonl.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.trim();
    if (!line) {
      continue;
    }

    let parsedLine: unknown;
    try {
      parsedLine = JSON.parse(line);
    } catch (error) {
      throw new CodexTranscriptParseError(
        `Invalid JSONL transcript at line ${String(index + 1)}: ${error instanceof Error ? error.message : "Unable to parse JSON."}`,
      );
    }

    if (!isRecord(parsedLine)) {
      throw new CodexTranscriptParseError(
        `Invalid JSONL transcript at line ${String(index + 1)}: expected an object record.`,
      );
    }

    const turnContext = extractTurnContext(parsedLine);
    if (turnContext) {
      model = readString(turnContext.model) ?? model;
      if (isRecord(turnContext.sandbox_policy)) {
        runtimeMode = normalizeRuntimeMode(turnContext.sandbox_policy.type);
      }
      if (isRecord(turnContext.collaboration_mode)) {
        interactionMode = normalizeInteractionMode(turnContext.collaboration_mode.mode);
      }
    }

    const payload = extractResponseMessage(parsedLine);
    if (!payload) {
      continue;
    }

    const role = readString(payload.role);
    if (role !== "user" && role !== "assistant" && role !== "system") {
      continue;
    }

    const timestamp = normalizeTimestamp(parsedLine.timestamp, index + 1);
    const text = readMessageText(payload);
    if (text.length === 0) {
      continue;
    }

    pushWithinWindow(
      messages,
      {
        role,
        text,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      options?.messageWindow,
    );
  }

  return {
    model,
    runtimeMode,
    interactionMode,
    messages,
  };
}

export function classifyCodexSessionKind(input: {
  readonly source: string | null;
  readonly messages: ReadonlyArray<ParsedCodexTranscriptMessage>;
}): "direct" | "subagent-child" | "orchestrator" {
  const lastUserMessage = input.messages.toReversed().find((message) => message.role === "user");
  if (lastUserMessage?.text.toLowerCase().includes("subagent_notification")) {
    return "orchestrator";
  }

  const normalizedSource = input.source?.toLowerCase() ?? "";
  if (normalizedSource.includes("thread_spawn") || normalizedSource.includes("subagent")) {
    return "subagent-child";
  }

  return "direct";
}
