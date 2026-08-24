import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import type * as EffectAcpSchema from "effect-acp/compat";
import { deriveToolActivityPresentation } from "@t3tools/shared/toolActivity";
import { T3_MCP_TOOL_NAMES } from "@t3tools/shared/t3McpToolPresentation";
import type {
  OrchestrationV2ProviderThreadNativeMetadata,
  ThreadTokenUsageSnapshot,
  ToolLifecycleItemType,
} from "@t3tools/contracts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSessionModeState(value: unknown): value is EffectAcpSchema.SessionModeState {
  if (!isRecord(value) || typeof value.currentModeId !== "string") {
    return false;
  }
  if (!Array.isArray(value.availableModes)) {
    return false;
  }
  return value.availableModes.every(
    (mode) =>
      isRecord(mode) &&
      typeof mode.id === "string" &&
      typeof mode.name === "string" &&
      (mode.description === undefined || typeof mode.description === "string"),
  );
}

export interface AcpSessionMode {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
}

export interface AcpSessionModeState {
  readonly currentModeId: string;
  readonly availableModes: ReadonlyArray<AcpSessionMode>;
}

export interface AcpToolCallState {
  readonly toolCallId: string;
  readonly kind?: string;
  readonly title?: string;
  readonly status?: "pending" | "inProgress" | "requiresAction" | "completed" | "failed";
  readonly command?: string;
  readonly detail?: string;
  readonly data: Record<string, unknown>;
}

export interface AcpAgentTerminalState {
  readonly command?: string;
  readonly cwd?: string;
  readonly output: string;
  readonly exitStatus?: EffectAcpSchema.TerminalExitStatus;
  /** Incomplete trailing UTF-8 bytes retained until the next output update. */
  readonly pendingOutputBytes?: Uint8Array;
}

type AcpAgentTerminalUpdate = Extract<
  EffectAcpSchema.SessionUpdate,
  { readonly sessionUpdate: "terminal_update" | "terminal_output_chunk" }
>;

const MAX_ACP_TERMINAL_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_ACP_TERMINAL_FRAME_BYTES = MAX_ACP_TERMINAL_OUTPUT_BYTES;

function isBase64DataCode(code: number): boolean {
  return (
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    (code >= 48 && code <= 57) ||
    code === 43 ||
    code === 47
  );
}

/**
 * Decodes one bounded base64 terminal frame, or `undefined` when the frame is
 * malformed or oversized. Invalid frames are dropped rather than failed so one
 * misbehaving agent frame cannot take down session-update handling.
 */
function decodeBase64TerminalFrame(encoded: string): Uint8Array | undefined {
  if (encoded.length > Math.ceil(MAX_ACP_TERMINAL_FRAME_BYTES / 3) * 4) {
    return undefined;
  }
  const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
  const dataLength = encoded.length - padding;
  if (
    encoded.length % 4 === 1 ||
    (padding > 0 && encoded.length % 4 !== 0) ||
    (padding === 1 && dataLength % 4 !== 3) ||
    (padding === 2 && dataLength % 4 !== 2)
  ) {
    return undefined;
  }
  for (let index = 0; index < dataLength; index += 1) {
    if (!isBase64DataCode(encoded.charCodeAt(index))) return undefined;
  }
  const decoded = Buffer.from(encoded, "base64");
  return decoded.byteLength <= MAX_ACP_TERMINAL_FRAME_BYTES ? decoded : undefined;
}

function trailingIncompleteUtf8Start(bytes: Uint8Array): number {
  if (bytes.length === 0) return bytes.length;
  let leadIndex = bytes.length - 1;
  while (leadIndex >= 0 && (bytes[leadIndex]! & 0xc0) === 0x80) {
    leadIndex -= 1;
  }
  if (leadIndex < 0) return bytes.length;
  const lead = bytes[leadIndex]!;
  const expectedLength =
    lead >= 0xc2 && lead <= 0xdf
      ? 2
      : lead >= 0xe0 && lead <= 0xef
        ? 3
        : lead >= 0xf0 && lead <= 0xf4
          ? 4
          : 1;
  return bytes.length - leadIndex < expectedLength ? leadIndex : bytes.length;
}

function decodeTerminalOutputChunk(
  pending: Uint8Array | undefined,
  encoded: string,
): { readonly text: string; readonly pendingOutputBytes?: Uint8Array } | undefined {
  const frame = decodeBase64TerminalFrame(encoded);
  if (frame === undefined) return undefined;
  const bytes = Buffer.concat([...(pending === undefined ? [] : [Buffer.from(pending)]), frame]);
  const completeEnd = trailingIncompleteUtf8Start(bytes);
  const text = bytes.subarray(0, completeEnd).toString("utf8");
  return completeEnd === bytes.length
    ? { text }
    : { text, pendingOutputBytes: Uint8Array.from(bytes.subarray(completeEnd)) };
}

function truncateTerminalOutput(output: string): string {
  const bytes = Buffer.from(output, "utf8");
  if (bytes.length <= MAX_ACP_TERMINAL_OUTPUT_BYTES) return output;
  let start = bytes.length - MAX_ACP_TERMINAL_OUTPUT_BYTES;
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start += 1;
  return bytes.subarray(start).toString("utf8");
}

/** Applies an ACP v2 agent-owned terminal snapshot or chunk to display state. */
export function applyAcpAgentTerminalUpdate(
  previous: AcpAgentTerminalState | undefined,
  update: AcpAgentTerminalUpdate,
): AcpAgentTerminalState {
  const current = previous ?? { output: "" };
  if (update.sessionUpdate === "terminal_output_chunk") {
    const decoded = decodeTerminalOutputChunk(current.pendingOutputBytes, update.data);
    if (decoded === undefined) return current;
    const { pendingOutputBytes: _pendingOutputBytes, ...withoutPendingOutputBytes } = current;
    return {
      ...withoutPendingOutputBytes,
      output: truncateTerminalOutput(`${current.output}${decoded.text}`),
      ...(decoded.pendingOutputBytes === undefined
        ? {}
        : { pendingOutputBytes: decoded.pendingOutputBytes }),
    };
  }
  let next: AcpAgentTerminalState = current;
  if (update.command === null) {
    const { command: _command, ...withoutCommand } = next;
    next = withoutCommand;
  } else if (update.command !== undefined) {
    next = { ...next, command: update.command };
  }
  if (update.cwd === null) {
    const { cwd: _cwd, ...withoutCwd } = next;
    next = withoutCwd;
  } else if (update.cwd !== undefined) {
    next = { ...next, cwd: update.cwd };
  }
  if (update.output !== undefined) {
    const decoded =
      update.output === null
        ? { text: "" }
        : decodeTerminalOutputChunk(undefined, update.output.data);
    if (decoded !== undefined) {
      const { pendingOutputBytes: _pendingOutputBytes, ...withoutPendingOutputBytes } = next;
      next = {
        ...withoutPendingOutputBytes,
        output: truncateTerminalOutput(decoded.text),
        ...(decoded.pendingOutputBytes === undefined
          ? {}
          : { pendingOutputBytes: decoded.pendingOutputBytes }),
      };
    }
  }
  if (update.exitStatus === null) {
    const { exitStatus: _exitStatus, ...withoutExitStatus } = next;
    next = withoutExitStatus;
  } else if (update.exitStatus !== undefined) {
    const pendingText =
      next.pendingOutputBytes === undefined
        ? ""
        : Buffer.from(next.pendingOutputBytes).toString("utf8");
    const { pendingOutputBytes: _pendingOutputBytes, ...withoutPendingOutputBytes } = next;
    next = {
      ...withoutPendingOutputBytes,
      output: truncateTerminalOutput(`${next.output}${pendingText}`),
      exitStatus: update.exitStatus,
    };
  }
  return next;
}

export type AcpPlanUpdate =
  | {
      readonly nativePlanId: string;
      readonly kind: "items";
      readonly explanation?: string | null;
      readonly plan: ReadonlyArray<{
        readonly step: string;
        readonly status: "pending" | "inProgress" | "completed";
      }>;
    }
  | { readonly nativePlanId: string; readonly kind: "markdown"; readonly markdown: string }
  | { readonly nativePlanId: string; readonly kind: "file"; readonly uri: string }
  | { readonly nativePlanId: string; readonly kind: "unknown"; readonly contentType: string }
  | { readonly nativePlanId: string; readonly kind: "removed" };

export interface AcpPermissionRequest {
  readonly kind: string | "unknown";
  readonly detail?: string;
  readonly toolCall?: AcpToolCallState;
}

export type AcpParsedSessionEvent =
  | {
      readonly _tag: "ModeChanged";
      readonly modeId: string;
    }
  | {
      readonly _tag: "AssistantItemStarted";
      readonly itemId: string;
    }
  | {
      readonly _tag: "AssistantItemCompleted";
      readonly itemId: string;
    }
  | {
      readonly _tag: "PlanUpdated";
      readonly payload: AcpPlanUpdate;
      readonly rawPayload: unknown;
    }
  | {
      readonly _tag: "ToolCallUpdated";
      readonly toolCall: AcpToolCallState;
      readonly rawPayload: unknown;
    }
  | {
      readonly _tag: "ContentDelta";
      readonly itemId?: string;
      readonly messageId?: string;
      readonly text: string;
      readonly rawPayload: unknown;
    }
  | {
      readonly _tag: "UsageUpdated";
      readonly usage: ThreadTokenUsageSnapshot;
      readonly rawPayload: unknown;
    }
  | {
      readonly _tag: "SessionInfoUpdated";
      readonly metadata: OrchestrationV2ProviderThreadNativeMetadata;
      readonly rawPayload: unknown;
    }
  | {
      readonly _tag: "UnknownUpdate";
      readonly updateType: string;
      readonly rawPayload: unknown;
    };

const boundedContentMetadata = (value: string | null | undefined, maximumLength: number): string =>
  value?.trim().slice(0, maximumLength) ?? "";

const MAX_ACP_CONTENT_TEXT_LENGTH = 65_536;

// Preserve whitespace in streamed model output while keeping one provider frame bounded.
const boundedContentText = (value: string): string => value.slice(0, MAX_ACP_CONTENT_TEXT_LENGTH);

const boundedContentUri = (value: string | null | undefined): string => {
  const uri = boundedContentMetadata(value, 4_096);
  return uri.toLowerCase().startsWith("data:") ? "" : uri;
};

/** Convert every ACP output block into bounded, displayable text without retaining base64 data. */
export function acpContentBlockDisplayText(
  content: EffectAcpSchema.ContentBlock,
): string | undefined {
  switch (content.type) {
    case "text":
      return boundedContentText(content.text);
    case "resource_link": {
      const label =
        boundedContentMetadata(content.title, 512) ||
        boundedContentMetadata(content.name, 512) ||
        "resource";
      const description = boundedContentMetadata(content.description, 2_048);
      const uri = boundedContentUri(content.uri);
      return `${description ? `${label}: ${description}` : label}${uri ? `\n${uri}` : ""}`;
    }
    case "resource": {
      if ("text" in content.resource) {
        return boundedContentText(content.resource.text);
      }
      const mimeType = boundedContentMetadata(content.resource.mimeType, 256);
      const uri = boundedContentUri(content.resource.uri);
      return `[ACP binary resource${mimeType ? ` (${mimeType})` : ""}${uri ? `: ${uri}` : ""}]`;
    }
    case "image": {
      const mimeType = boundedContentMetadata(content.mimeType, 256) || "unknown type";
      const uri = boundedContentUri(content.uri);
      return `[ACP image (${mimeType})${uri ? `: ${uri}` : ""}]`;
    }
    case "audio": {
      const mimeType = boundedContentMetadata(content.mimeType, 256) || "unknown type";
      return `[ACP audio (${mimeType})]`;
    }
    case "_t3_unknown":
      return `[Unsupported ACP content: ${boundedContentMetadata(content.originalType, 128) || "unknown"}]`;
  }
}

function sanitizeAcpToolCallContent(
  content: ReadonlyArray<EffectAcpSchema.ToolCallContent>,
): ReadonlyArray<EffectAcpSchema.ToolCallContent> {
  return content.map((entry) => {
    switch (entry.type) {
      case "content":
        return {
          type: "content",
          content: {
            type: "text",
            text: acpContentBlockDisplayText(entry.content) ?? "",
          },
        };
      case "diff":
        if ("changes" in entry) {
          return {
            type: "diff",
            changes: entry.changes,
            ...(entry.patch === undefined ? {} : { patch: entry.patch }),
          };
        }
        return {
          type: "diff",
          path: entry.path,
          ...(entry.oldText !== undefined ? { oldText: entry.oldText } : {}),
          newText: entry.newText,
        };
      case "terminal":
        return { type: "terminal", terminalId: entry.terminalId };
      case "_t3_unknown":
        return {
          type: "_t3_unknown",
          originalType: boundedContentMetadata(entry.originalType, 128) || "unknown",
          raw: null,
        };
    }
  });
}

type AcpSessionSetupResponse =
  | EffectAcpSchema.ForkSessionResponse
  | EffectAcpSchema.LoadSessionResponse
  | EffectAcpSchema.NewSessionResponse
  | EffectAcpSchema.ResumeSessionResponse;

type AcpToolCallUpdate = Extract<
  EffectAcpSchema.SessionNotification["update"],
  { readonly sessionUpdate: "tool_call" | "tool_call_update" }
>;

export function extractModelConfigId(sessionResponse: AcpSessionSetupResponse): string | undefined {
  const configOptions = sessionResponse.configOptions;
  if (!configOptions) return undefined;
  for (const opt of configOptions) {
    if (opt.category === "model" && opt.id.trim().length > 0) {
      return opt.id.trim();
    }
  }
  return undefined;
}

export function findSessionConfigOption(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
  configId: string,
): EffectAcpSchema.SessionConfigOption | undefined {
  if (!configOptions) {
    return undefined;
  }
  const normalizedConfigId = configId.trim();
  if (!normalizedConfigId) {
    return undefined;
  }
  return configOptions.find((option) => option.id.trim() === normalizedConfigId);
}

export function collectSessionConfigOptionValues(
  configOption: EffectAcpSchema.SessionConfigOption,
): ReadonlyArray<string> {
  if (configOption.type !== "select") {
    return [];
  }
  return configOption.options.flatMap((entry) =>
    "value" in entry ? [entry.value] : entry.options.map((option) => option.value),
  );
}

export function parseSessionModeState(
  sessionResponse: AcpSessionSetupResponse,
): AcpSessionModeState | undefined {
  const modes = sessionResponse.modes;
  if (!modes) return undefined;
  const currentModeId = modes.currentModeId.trim();
  if (!currentModeId) {
    return undefined;
  }
  const availableModes: Array<AcpSessionMode> = [];
  for (const mode of modes.availableModes) {
    const id = mode.id.trim();
    const name = mode.name.trim();
    if (!id || !name) {
      continue;
    }
    const description = mode.description?.trim() || undefined;
    availableModes.push(
      description !== undefined
        ? ({ id, name, description } satisfies AcpSessionMode)
        : ({ id, name } satisfies AcpSessionMode),
    );
  }
  if (availableModes.length === 0) {
    return undefined;
  }
  return {
    currentModeId,
    availableModes,
  };
}

function normalizePlanStepStatus(raw: unknown): "pending" | "inProgress" | "completed" {
  switch (raw) {
    case "completed":
      return "completed";
    case "in_progress":
    case "inProgress":
      return "inProgress";
    default:
      return "pending";
  }
}

function normalizeToolCallStatus(
  raw: unknown,
  fallback?: "pending" | "inProgress" | "completed" | "failed",
): "pending" | "inProgress" | "completed" | "failed" | undefined {
  switch (raw) {
    case "pending":
      return "pending";
    case "in_progress":
    case "inProgress":
      return "inProgress";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    default:
      return fallback;
  }
}

function normalizeCommandValue(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  if (!Array.isArray(value)) {
    return undefined;
  }
  const parts: Array<string> = [];
  for (const entry of value) {
    if (typeof entry === "string") {
      const part = entry.trim();
      if (part.length > 0) {
        parts.push(part);
      }
    }
  }
  return parts.length > 0 ? parts.join(" ") : undefined;
}

function extractCommandFromTitle(title: string | undefined): string | undefined {
  if (!title) {
    return undefined;
  }
  const match = /`([^`]+)`/.exec(title);
  return match?.[1]?.trim() || undefined;
}

function extractToolCallCommand(rawInput: unknown, title: string | undefined): string | undefined {
  if (isRecord(rawInput)) {
    const directCommand = normalizeCommandValue(rawInput.command);
    if (directCommand) {
      return directCommand;
    }
    const executable = typeof rawInput.executable === "string" ? rawInput.executable.trim() : "";
    const args = normalizeCommandValue(rawInput.args);
    if (executable && args) {
      return `${executable} ${args}`;
    }
    if (executable) {
      return executable;
    }
  }
  return extractCommandFromTitle(title);
}

function extractTextContentFromToolCallContent(
  content: ReadonlyArray<EffectAcpSchema.ToolCallContent> | null | undefined,
): string | undefined {
  if (!content) return undefined;
  const chunks: Array<string> = [];
  for (const entry of content) {
    if (entry.type !== "content") {
      continue;
    }
    const text = acpContentBlockDisplayText(entry.content)?.trim() ?? "";
    if (text.length > 0) {
      chunks.push(text);
    }
  }
  return chunks.length > 0 ? chunks.join("\n") : undefined;
}

function normalizeToolKind(kind: unknown): string | undefined {
  return typeof kind === "string" && kind.trim().length > 0 ? kind.trim() : undefined;
}

function canonicalItemTypeFromAcpToolKind(kind: string | undefined): ToolLifecycleItemType {
  switch (kind) {
    case "execute":
      return "command_execution";
    case "edit":
    case "delete":
    case "move":
      return "file_change";
    case "search":
    case "fetch":
      return "web_search";
    default:
      return "dynamic_tool_call";
  }
}

function makeToolCallState(
  input: {
    readonly toolCallId: string;
    readonly title?: string | null | undefined;
    readonly kind?: EffectAcpSchema.ToolKind | null | undefined;
    readonly status?: EffectAcpSchema.ToolCallStatus | null | undefined;
    readonly rawInput?: unknown;
    readonly rawOutput?: unknown;
    readonly content?: ReadonlyArray<EffectAcpSchema.ToolCallContent> | null | undefined;
    readonly locations?: ReadonlyArray<EffectAcpSchema.ToolCallLocation> | null | undefined;
    readonly _meta?: unknown;
  },
  options?: {
    readonly fallbackStatus?: "pending" | "inProgress" | "completed" | "failed";
  },
): AcpToolCallState | undefined {
  const toolCallId = input.toolCallId.trim();
  if (!toolCallId) {
    return undefined;
  }
  const title = input.title?.trim() || undefined;
  const command = extractToolCallCommand(input.rawInput, title);
  const textContent = extractTextContentFromToolCallContent(input.content);
  const normalizedTitle =
    title && title.toLowerCase() !== "terminal" && title.toLowerCase() !== "tool call"
      ? title
      : undefined;
  const data: Record<string, unknown> = { toolCallId };
  const kind = normalizeToolKind(input.kind);
  if (kind) {
    data.kind = kind;
  }
  if (title) {
    // The agent's verbatim title. Presentation summarizes `title` on the
    // state (e.g. a command line becomes "Ran command"), so identity checks
    // such as MCP-fallback detection need the raw value preserved here.
    data.title = title;
  }
  if (command) {
    data.command = command;
  }
  if (input.rawInput !== undefined) {
    data.rawInput = input.rawInput;
  }
  if (isRecord(input._meta)) {
    // Some agents identify MCP calls only here (goose `goose.toolCall`,
    // qwen `toolName`/`serverId`, claude-acp `claudeCode.toolName`).
    data.meta = input._meta;
  }
  if (input.rawOutput !== undefined) {
    data.rawOutput = input.rawOutput;
  }
  if (input.content != null) {
    data.content = sanitizeAcpToolCallContent(input.content);
  }
  if (input.locations !== undefined) {
    data.locations = input.locations;
  }
  const fallbackDetail = command ?? normalizedTitle ?? textContent;
  const hasPresentationSeed =
    title !== undefined ||
    kind !== undefined ||
    command !== undefined ||
    normalizedTitle !== undefined ||
    textContent !== undefined;
  const presentation = hasPresentationSeed
    ? deriveToolActivityPresentation({
        itemType: canonicalItemTypeFromAcpToolKind(kind),
        title,
        detail: fallbackDetail,
        data,
        fallbackSummary: title ?? "Tool",
      })
    : undefined;
  const status = normalizeToolCallStatus(input.status, options?.fallbackStatus);
  return {
    toolCallId,
    ...(kind ? { kind } : {}),
    ...(presentation?.summary ? { title: presentation.summary } : {}),
    ...(status ? { status } : {}),
    ...(command ? { command } : {}),
    ...(presentation?.detail ? { detail: presentation.detail } : {}),
    data,
  };
}

function parseTypedToolCallState(
  event: AcpToolCallUpdate,
  options?: {
    readonly fallbackStatus?: "pending" | "inProgress" | "completed" | "failed";
  },
): AcpToolCallState | undefined {
  return makeToolCallState(
    {
      toolCallId: event.toolCallId,
      title: event.title,
      kind: event.kind,
      status: event.status,
      rawInput: event.rawInput,
      rawOutput: event.rawOutput,
      content: event.content,
      locations: event.locations,
      _meta: event._meta,
    },
    options,
  );
}

export function mergeToolCallState(
  previous: AcpToolCallState | undefined,
  next: AcpToolCallState,
): AcpToolCallState {
  const nextKind = next.kind ?? (typeof next.data.kind === "string" ? next.data.kind : undefined);
  const kind = nextKind ?? previous?.kind;
  const title = next.title ?? previous?.title;
  const status = next.status ?? previous?.status;
  const command = next.command ?? previous?.command;
  const detail = next.detail ?? previous?.detail;
  return {
    toolCallId: next.toolCallId,
    ...(kind ? { kind } : {}),
    ...(title ? { title } : {}),
    ...(status ? { status } : {}),
    ...(command ? { command } : {}),
    ...(detail ? { detail } : {}),
    data: {
      ...previous?.data,
      ...next.data,
    },
  };
}

export interface AcpMcpToolCallIdentity {
  readonly server: string;
  readonly tool: string;
  readonly input?: Record<string, unknown>;
}

/** Matches an invocation of T3's `acp-mcp-call` bridge fallback CLI. */
const ACP_MCP_FALLBACK_CALL = /(?:^|[\s"'=])acp-mcp-call[\s"']+([A-Za-z0-9_.-]+)(?:\s+(.+?))?\s*$/u;

function acpMcpFallbackInput(value: string | undefined): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  const candidates = [
    trimmed,
    ...(trimmed.startsWith("'") && trimmed.endsWith("'") ? [trimmed.slice(1, -1)] : []),
  ];
  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      const unwrapped = typeof parsed === "string" ? JSON.parse(parsed) : parsed;
      if (isRecord(unwrapped)) return unwrapped;
    } catch {
      // ACP agents choose their own shell quoting. An unrecognized form keeps
      // the MCP identity but leaves the input empty instead of misreporting it.
    }
  }
  return undefined;
}

/**
 * Agents flatten injected MCP tools into model-facing function names with no
 * shared convention (survey of the 2026-08 registry builds): Kilo and
 * opencode use `t3-code_<tool>`, claude-acp and qwen `mcp__t3-code__<tool>`,
 * Amp `mcp__t3_code__<tool>` (hyphens mangled), droid `t3-code___<tool>`,
 * Copilot `t3-code-<tool>`, cline appends `: <args json>`. T3 always injects
 * its server as "t3-code", and matches are additionally gated on the known
 * T3 tool inventory, so the separator match can stay loose.
 */
const T3_MCP_TITLE_CALL =
  /^(?:mcp[-_]{1,2})?t3[-_ ]?code[-_.:/ ]{1,3}(?<tool>[A-Za-z0-9][A-Za-z0-9_.-]*)(?::.*)?$/i;

/**
 * Gemini CLI titles injected MCP calls "<tool> (<server> MCP Server)" and
 * qwen-code appends ": <args json>" to the same template; Auggie namespaces
 * tool-first as "<tool>_t3-code".
 */
const T3_MCP_TITLE_SUFFIX_CALL =
  /^(?<tool>[A-Za-z0-9][A-Za-z0-9_.-]*?)(?: \(t3[-_ ]?code MCP Server\)(?::|$)|[-_.]t3[-_ ]?code$)/i;

/**
 * glm-acp-agent and Kimi CLI register injected MCP tools under their bare
 * names; Kimi additionally appends ": <raw args json>". Safe only because the
 * match is gated on the known T3 tool inventory.
 */
const T3_MCP_BARE_TITLE_CALL = /^(?<tool>[A-Za-z0-9_]+)(?::\s|$)/;

/**
 * Best-effort recovery of MCP identity from a generic ACP tool call.
 *
 * ACP has no typed MCP tool-call item, so agents surface MCP calls in
 * agent-specific shapes: codex-acp tags execute calls with
 * `rawInput.server`/`rawInput.tool`, while agents on T3's terminal fallback
 * run the `acp-mcp-call <tool>` CLI through their command or an embedded
 * client terminal. Recovered identity lets the projection render the same
 * branded MCP item that native providers produce.
 */
export function extractMcpToolCallIdentity(
  toolCall: AcpToolCallState,
  options?: {
    /** Command lines of client terminals embedded in this tool call. */
    readonly embeddedTerminalCommands?: ReadonlyArray<string>;
  },
): AcpMcpToolCallIdentity | undefined {
  const rawInput = isRecord(toolCall.data.rawInput) ? toolCall.data.rawInput : undefined;
  const meta = isRecord(toolCall.data.meta) ? toolCall.data.meta : undefined;
  const server = typeof rawInput?.server === "string" ? rawInput.server.trim() : "";
  const tool = typeof rawInput?.tool === "string" ? rawInput.tool.trim() : "";
  if (meta?.is_mcp_tool_call === true && server.length > 0 && tool.length > 0) {
    return { server, tool };
  }
  // Agents without tagged rawInput identify their MCP calls through _meta
  // (goose, qwen, claude-acp) or only through the namespaced function name
  // in the title. The verbatim wire title survives merges even when a later
  // titleless or LLM-enriched update replaces the presentation title, so
  // match those rather than the summarized state title. Name-derived matches
  // are gated on the known T3 tool inventory so path-like titles (for
  // example "t3-code/README.md") never brand.
  const claudeCode = isRecord(meta?.claudeCode) ? meta.claudeCode : undefined;
  const gooseToolCall = isRecord(meta?.goose)
    ? isRecord(meta.goose.toolCall)
      ? meta.goose.toolCall
      : undefined
    : undefined;
  // qwen asserts the origin server explicitly, so any known tool suffix in
  // its toolName identifies the call even under future prefix formats.
  const metaServerId = typeof meta?.serverId === "string" ? meta.serverId.trim() : "";
  const metaToolName = typeof meta?.toolName === "string" ? meta.toolName.trim() : "";
  if (/^t3[-_ ]?code$/i.test(metaServerId) && metaToolName.length > 0) {
    for (const knownTool of T3_MCP_TOOL_NAMES) {
      const boundary = metaToolName.length - knownTool.length - 1;
      if (
        metaToolName === knownTool ||
        (metaToolName.endsWith(knownTool) &&
          boundary >= 0 &&
          !/[A-Za-z0-9]/.test(metaToolName.charAt(boundary)))
      ) {
        return { server: "t3-code", tool: knownTool };
      }
    }
  }
  // A present-but-foreign origin assertion marks the whole call as another
  // server's MCP call, so no loose name matching (meta or title) may brand it.
  const gooseExtension =
    typeof gooseToolCall?.extensionName === "string" ? gooseToolCall.extensionName.trim() : "";
  const assertsForeignOrigin =
    (metaServerId.length > 0 && !/^t3[-_ ]?code$/i.test(metaServerId)) ||
    (gooseExtension.length > 0 && !/^t3[-_ ]?code$/i.test(gooseExtension));
  if (assertsForeignOrigin) {
    return undefined;
  }
  const candidates = [
    meta?.toolName,
    claudeCode?.toolName,
    gooseToolCall?.toolName,
    toolCall.data.title,
  ].filter((value): value is string => typeof value === "string");
  for (const candidate of candidates) {
    const trimmed = candidate.trim();
    const match =
      T3_MCP_TITLE_CALL.exec(trimmed) ??
      T3_MCP_TITLE_SUFFIX_CALL.exec(trimmed) ??
      T3_MCP_BARE_TITLE_CALL.exec(trimmed);
    const candidateTool = match?.groups?.tool;
    if (candidateTool !== undefined && T3_MCP_TOOL_NAMES.has(candidateTool)) {
      return { server: "t3-code", tool: candidateTool };
    }
  }
  const commands = [
    ...(toolCall.command === undefined ? [] : [toolCall.command]),
    // pi-acp reports the exec command line only as the verbatim title.
    ...(typeof toolCall.data.title === "string" ? [toolCall.data.title] : []),
    ...(options?.embeddedTerminalCommands ?? []),
  ];
  for (const command of commands) {
    const match = ACP_MCP_FALLBACK_CALL.exec(command);
    if (match?.[1] !== undefined) {
      // The acp-mcp-call CLI exists only as T3's bridge fallback, so the
      // server identity is T3's by construction.
      const input = acpMcpFallbackInput(match[2]);
      return { server: "t3-code", tool: match[1], ...(input === undefined ? {} : { input }) };
    }
  }
  return undefined;
}

/**
 * Terminal ids embedded in a raw tool_call update, captured before
 * {@link resolveEmbeddedTerminalContent} rewrites them into plain text, so the
 * projection can still resolve the terminal's command line.
 */
export function embeddedTerminalIdsFromSessionUpdate(
  notification: EffectAcpSchema.SessionNotification,
): { readonly toolCallId: string; readonly terminalIds: ReadonlyArray<string> } | undefined {
  const update = notification.update;
  if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") {
    return undefined;
  }
  const terminalIds = (update.content ?? [])
    .filter((entry) => entry.type === "terminal")
    .map((entry) => entry.terminalId);
  return terminalIds.length === 0 ? undefined : { toolCallId: update.toolCallId, terminalIds };
}

export function parsePermissionRequest(
  params: EffectAcpSchema.RequestPermissionRequest,
): AcpPermissionRequest {
  const toolCall = makeToolCallState(
    {
      toolCallId: params.toolCall.toolCallId,
      title: params.toolCall.title,
      kind: params.toolCall.kind,
      status: params.toolCall.status,
      rawInput: params.toolCall.rawInput,
      rawOutput: params.toolCall.rawOutput,
      content: params.toolCall.content,
      locations: params.toolCall.locations,
    },
    { fallbackStatus: "pending" },
  );
  const kind = normalizeToolKind(params.toolCall.kind) ?? "unknown";
  const detail =
    toolCall?.command ??
    toolCall?.title ??
    toolCall?.detail ??
    (typeof params.sessionId === "string" ? `Session ${params.sessionId}` : undefined);
  return {
    kind,
    ...(detail ? { detail } : {}),
    ...(toolCall ? { toolCall } : {}),
  };
}

export function sessionUpdateIsReplay(params: EffectAcpSchema.SessionNotification): boolean {
  const meta = params._meta;
  return isRecord(meta) && meta.isReplay === true;
}

/** Replay chunks and substantive updates during session/load; not Grok keepalives. */
export function sessionUpdateCountsAsLoadReplayActivity(
  params: EffectAcpSchema.SessionNotification,
  gatedSessionId?: string,
): boolean {
  if (gatedSessionId !== undefined && params.sessionId !== gatedSessionId) {
    return false;
  }
  if (sessionUpdateIsReplay(params)) return true;
  const update = params.update;
  switch (update.sessionUpdate) {
    case "agent_message_chunk":
    case "agent_thought_chunk":
      return (acpContentBlockDisplayText(update.content)?.length ?? 0) > 0;
    case "agent_message":
    case "agent_thought":
      return (update.content ?? []).some(
        (content) => (acpContentBlockDisplayText(content)?.length ?? 0) > 0,
      );
    case "tool_call":
    case "tool_call_update":
    case "plan":
    case "plan_update":
    case "plan_removed":
    case "available_commands_update":
    case "current_mode_update":
    case "config_option_update":
    case "session_info_update":
    case "usage_update":
    case "compaction_update":
    case "compaction_summary_chunk":
      return true;
    default:
      return false;
  }
}

export interface SessionLoadGate {
  readonly active: boolean;
  /** Only notifications for this session refresh load-replay idle activity. */
  readonly sessionId: string;
  readonly lastActivityAtMillis: number | undefined;
  readonly idleGap: Duration.Duration;
  readonly initializeResult: EffectAcpSchema.InitializeResponse;
  readonly candidateConfigOptions?: ReadonlyArray<EffectAcpSchema.SessionConfigOption>;
}

export const waitForSessionLoadReplayIdle = (input: {
  readonly gateRef: Ref.Ref<Option.Option<SessionLoadGate>>;
}): Effect.Effect<EffectAcpSchema.LoadSessionResponse, never> =>
  Effect.gen(function* () {
    const pollInterval = Duration.millis(25);
    while (true) {
      const gate = yield* Ref.get(input.gateRef);
      if (
        Option.isSome(gate) &&
        gate.value.active &&
        gate.value.lastActivityAtMillis !== undefined
      ) {
        const idleGapMillis = Duration.toMillis(gate.value.idleGap);
        const nowMillis = yield* Clock.currentTimeMillis;
        if (nowMillis - gate.value.lastActivityAtMillis >= idleGapMillis) {
          return syntheticLoadSessionResponseFromInitialize(gate.value.initializeResult);
        }
      }
      yield* Effect.sleep(pollInterval);
    }
  });

export function syntheticLoadSessionResponseFromInitialize(
  initializeResult: EffectAcpSchema.InitializeResponse,
): EffectAcpSchema.LoadSessionResponse {
  const meta = initializeResult._meta;
  const modeState = isRecord(meta) ? meta.modeState : undefined;
  const modes = isSessionModeState(modeState) ? modeState : undefined;

  return {
    ...(modes ? { modes } : {}),
    _meta: {
      t3SessionLoadReady: "replay_idle",
    },
  };
}

export function parseSessionUpdateEvent(params: EffectAcpSchema.SessionNotification): {
  readonly modeId?: string;
  readonly events: ReadonlyArray<AcpParsedSessionEvent>;
} {
  const upd = params.update;
  const events: Array<AcpParsedSessionEvent> = [];
  let modeId: string | undefined;

  switch (upd.sessionUpdate) {
    case "current_mode_update": {
      modeId = upd.currentModeId.trim();
      if (modeId) {
        events.push({
          _tag: "ModeChanged",
          modeId,
        });
      }
      break;
    }
    case "plan": {
      const plan = upd.entries.map((entry, index) => ({
        step: entry.content.trim().length > 0 ? entry.content.trim() : `Step ${index + 1}`,
        status: normalizePlanStepStatus(entry.status),
      }));
      if (plan.length > 0) {
        events.push({
          _tag: "PlanUpdated",
          payload: {
            nativePlanId: "legacy",
            kind: "items",
            plan,
          },
          rawPayload: params,
        });
      }
      break;
    }
    case "plan_update": {
      const nativePlanId = upd.plan.planId.trim();
      if (nativePlanId.length === 0) {
        break;
      }
      if (upd.plan.type === "items" && "entries" in upd.plan && Array.isArray(upd.plan.entries)) {
        const entries: ReadonlyArray<unknown> = upd.plan.entries;
        const plan = entries.flatMap((entry, index) => {
          if (!isRecord(entry) || typeof entry.content !== "string") return [];
          const status = typeof entry.status === "string" ? entry.status : "pending";
          return [
            {
              step: entry.content.trim().length > 0 ? entry.content.trim() : `Step ${index + 1}`,
              status: normalizePlanStepStatus(status),
            },
          ];
        });
        events.push({
          _tag: "PlanUpdated",
          payload: { nativePlanId, kind: "items", plan },
          rawPayload: params,
        });
      } else if (
        upd.plan.type === "markdown" &&
        "content" in upd.plan &&
        typeof upd.plan.content === "string"
      ) {
        events.push({
          _tag: "PlanUpdated",
          payload: { nativePlanId, kind: "markdown", markdown: upd.plan.content },
          rawPayload: params,
        });
      } else if (
        upd.plan.type === "file" &&
        "uri" in upd.plan &&
        typeof upd.plan.uri === "string"
      ) {
        events.push({
          _tag: "PlanUpdated",
          payload: { nativePlanId, kind: "file", uri: upd.plan.uri },
          rawPayload: params,
        });
      } else {
        events.push({
          _tag: "PlanUpdated",
          payload: { nativePlanId, kind: "unknown", contentType: upd.plan.type },
          rawPayload: params,
        });
      }
      break;
    }
    case "plan_removed": {
      const nativePlanId = upd.planId.trim();
      if (nativePlanId.length > 0) {
        events.push({
          _tag: "PlanUpdated",
          payload: { nativePlanId, kind: "removed" },
          rawPayload: params,
        });
      }
      break;
    }
    case "tool_call": {
      const toolCall = parseTypedToolCallState(upd, {
        fallbackStatus: "pending",
      });
      if (toolCall) {
        events.push({
          _tag: "ToolCallUpdated",
          toolCall,
          rawPayload: params,
        });
      }
      break;
    }
    case "tool_call_update": {
      const toolCall = parseTypedToolCallState(upd);
      if (toolCall) {
        events.push({
          _tag: "ToolCallUpdated",
          toolCall,
          rawPayload: params,
        });
      }
      break;
    }
    case "agent_message_chunk": {
      const text = acpContentBlockDisplayText(upd.content);
      if (text !== undefined && text.length > 0) {
        events.push({
          _tag: "ContentDelta",
          ...(upd.messageId ? { messageId: upd.messageId } : {}),
          text,
          rawPayload: params,
        });
      }
      break;
    }
    case "compaction_update": {
      const summary = (upd.summary ?? [])
        .flatMap((content) => {
          const text = acpContentBlockDisplayText(content);
          return text === undefined || text.length === 0 ? [] : [text];
        })
        .join("\n");
      const status =
        upd.status === "completed"
          ? ("completed" as const)
          : upd.status === "failed" || upd.status === "cancelled"
            ? ("failed" as const)
            : ("inProgress" as const);
      const toolCall = makeToolCallState({
        toolCallId: `acp-compaction:${upd.compactionId}`,
        title: "Compact context",
        kind: "think",
        status,
        rawOutput: (upd.error ?? summary) || undefined,
        _meta: upd._meta,
      });
      if (toolCall !== undefined) {
        events.push({ _tag: "ToolCallUpdated", toolCall, rawPayload: params });
      }
      break;
    }
    case "compaction_summary_chunk": {
      const text = acpContentBlockDisplayText(upd.content);
      const toolCall = makeToolCallState({
        toolCallId: `acp-compaction:${upd.compactionId}`,
        title: "Compact context",
        kind: "think",
        status: "inProgress",
        ...(text === undefined ? {} : { rawOutput: text }),
        _meta: upd._meta,
      });
      if (toolCall !== undefined) {
        events.push({ _tag: "ToolCallUpdated", toolCall, rawPayload: params });
      }
      break;
    }
    case "state_update": {
      if (upd.state === "idle" && upd.usage !== undefined && upd.usage !== null) {
        events.push({
          _tag: "UsageUpdated",
          usage: { usedTokens: upd.usage.totalTokens },
          rawPayload: params,
        });
      }
      break;
    }
    case "usage_update": {
      const currency = upd.cost?.currency.trim().slice(0, 32);
      events.push({
        _tag: "UsageUpdated",
        usage: {
          usedTokens: upd.used,
          ...(upd.size > 0 ? { maxTokens: upd.size } : {}),
          ...(upd.cost && currency ? { cost: { amount: upd.cost.amount, currency } } : {}),
        },
        rawPayload: params,
      });
      break;
    }
    case "session_info_update": {
      const title = upd.title?.trim().slice(0, 1_024);
      const updatedAt = upd.updatedAt?.trim().slice(0, 128);
      events.push({
        _tag: "SessionInfoUpdated",
        metadata: {
          ...(upd.title === null ? { title: null } : title ? { title } : {}),
          ...(upd.updatedAt === null ? { updatedAt: null } : updatedAt ? { updatedAt } : {}),
        },
        rawPayload: params,
      });
      break;
    }
    case "_t3_unknown": {
      events.push({
        _tag: "UnknownUpdate",
        updateType: boundedContentMetadata(upd.originalSessionUpdate, 128) || "unknown",
        rawPayload: params,
      });
      break;
    }
    default:
      break;
  }

  return { ...(modeId !== undefined ? { modeId } : {}), events };
}
