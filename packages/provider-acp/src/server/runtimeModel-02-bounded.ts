import { isRecord } from "./runtimeModel-03-is.ts";
import type { AcpSelectConfigOption, AcpSessionMode, AcpSessionModeState, AcpSessionSetupResponse, AcpToolCallState, AcpToolCallUpdate, ExtractedToolCallContent } from "./runtimeModel-03-is.ts";
import * as EffectAcpSchema from "effect-acp/compat";
import {
  deriveToolActivityPresentation,
  mergeToolActivityData,
} from "@t3tools/shared/toolActivity";
import type {
  OrchestrationV2ProviderThreadNativeMetadata,
  ThreadTokenUsageSnapshot,
  ToolLifecycleItemType,
} from "@t3tools/contracts";

export const boundedContentMetadata = (value: string | null | undefined, maximumLength: number): string =>
  value?.trim().slice(0, maximumLength) ?? "";

export const MAX_ACP_CONTENT_TEXT_LENGTH = 65_536;

export const boundedContentText = (value: string): string => value.slice(0, MAX_ACP_CONTENT_TEXT_LENGTH);

export const boundedContentUri = (value: string | null | undefined): string => {
  const uri = boundedContentMetadata(value, 4_096);
  return uri.toLowerCase().startsWith("data:") ? "" : uri;
};

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

export function sanitizeAcpToolCallContent(
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

export function findModelConfigOption(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
): AcpSelectConfigOption | undefined {
  return configOptions?.find(
    (option): option is AcpSelectConfigOption =>
      option.category === "model" && option.type === "select" && option.id.trim().length > 0,
  );
}

export function extractModelConfigId(sessionResponse: AcpSessionSetupResponse): string | undefined {
  return findModelConfigOption(sessionResponse.configOptions)?.id.trim();
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
  const modeConfig = sessionResponse.configOptions?.find(
    (option) => option.category === "mode" && option.type === "select",
  );
  const modes =
    sessionResponse.modes ??
    (modeConfig?.type === "select"
      ? {
          currentModeId: modeConfig.currentValue,
          availableModes: modeConfig.options
            .flatMap((option) => ("options" in option ? option.options : [option]))
            .map((option) => ({
              id: option.value,
              name: option.name,
              description: option.description,
            })),
        }
      : undefined);
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

export function normalizePlanStepStatus(
  raw: unknown,
): "pending" | "inProgress" | "completed" | "cancelled" {
  switch (raw) {
    case "completed":
      return "completed";
    case "cancelled":
      return "cancelled";
    case "in_progress":
    case "inProgress":
      return "inProgress";
    default:
      return "pending";
  }
}

export function normalizeToolCallStatus(
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
    case "cancelled":
      return "failed";
    default:
      return fallback;
  }
}

export function normalizeCommandValue(value: unknown): string | undefined {
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

export function extractCommandFromTitle(title: string | undefined): string | undefined {
  if (!title) {
    return undefined;
  }
  const match = /`([^`]+)`/.exec(title);
  return match?.[1]?.trim() || undefined;
}

export function extractToolCallCommand(
  rawInput: unknown,
  title: string | undefined,
  kind: string | undefined,
): string | undefined {
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
  // Only execute tools may treat titles as commands.
  if (kind !== "execute") {
    return undefined;
  }
  return extractCommandFromTitle(title);
}

export function filePathFromToolValue(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function locationsFromToolCallInput(input: {
  readonly locations?: ReadonlyArray<EffectAcpSchema.ToolCallLocation> | null | undefined;
  readonly content?: ReadonlyArray<EffectAcpSchema.ToolCallContent> | null | undefined;
  readonly rawInput?: unknown;
  readonly rawOutput?: unknown;
}): ReadonlyArray<EffectAcpSchema.ToolCallLocation> | undefined {
  if (input.locations === null || input.locations?.length === 0) {
    return [];
  }
  const locations: EffectAcpSchema.ToolCallLocation[] = [];
  const seen = new Set<string>();
  const pushLocation = (location: EffectAcpSchema.ToolCallLocation) => {
    const path = filePathFromToolValue(location.path);
    if (!path || seen.has(path)) {
      return;
    }
    seen.add(path);
    locations.push({ ...location, path });
  };
  const pushPath = (value: unknown) => {
    const path = filePathFromToolValue(value);
    if (!path || seen.has(path)) {
      return;
    }
    seen.add(path);
    locations.push({ path });
  };

  if (input.locations) {
    for (const location of input.locations) {
      pushLocation(location);
    }
  }
  if (input.content) {
    for (const entry of input.content) {
      if (entry.type === "diff" && "path" in entry) {
        pushPath(entry.path);
      }
    }
  }
  if (isRecord(input.rawInput)) {
    pushPath(input.rawInput.path);
    pushPath(input.rawInput.filePath);
    pushPath(input.rawInput.file_path);
  }
  if (isRecord(input.rawOutput)) {
    pushPath(input.rawOutput.path);
    pushPath(input.rawOutput.filePath);
    pushPath(input.rawOutput.file_path);
  }

  return locations.length > 0 ? locations : undefined;
}

// Agents resend cumulative output; bound it to avoid flooding event ingestion.
export const TOOL_CALL_CONTENT_MAX_CHARS = 8_000;
export const TOOL_CALL_CONTENT_TRUNCATION_MARKER = "[Earlier output truncated]\n\n";

export function boundToolCallOutputText(text: string): string {
  if (text.length <= TOOL_CALL_CONTENT_MAX_CHARS) {
    return text;
  }
  const tail = text.slice(text.length - TOOL_CALL_CONTENT_MAX_CHARS);
  return `${TOOL_CALL_CONTENT_TRUNCATION_MARKER}${tail}`;
}

export const RAW_OUTPUT_TEXT_FIELDS = ["content", "stdout", "stderr", "output"] as const;

// rawOutput can duplicate cumulative output and bypass content limits.
export function boundToolCallRawOutput(rawOutput: unknown): unknown {
  if (!isRecord(rawOutput)) {
    return rawOutput;
  }
  let changed = false;
  const bounded: Record<string, unknown> = { ...rawOutput };
  for (const field of RAW_OUTPUT_TEXT_FIELDS) {
    const value = rawOutput[field];
    if (typeof value === "string" && value.length > TOOL_CALL_CONTENT_MAX_CHARS) {
      bounded[field] = boundToolCallOutputText(value);
      changed = true;
    }
  }
  return changed ? bounded : rawOutput;
}

export function toolCallContentText(entry: EffectAcpSchema.ToolCallContent): string | undefined {
  if (entry.type !== "content" || entry.content.type !== "text") {
    return undefined;
  }
  return entry.content.text;
}

export function boundToolCallContentEntries(
  content: ReadonlyArray<EffectAcpSchema.ToolCallContent>,
): ReadonlyArray<EffectAcpSchema.ToolCallContent> {
  let changed = false;
  const bounded = content.map((entry) => {
    const text = toolCallContentText(entry);
    if (text === undefined || text.length <= TOOL_CALL_CONTENT_MAX_CHARS) {
      return entry;
    }
    changed = true;
    const trimmed = text.trim();
    return {
      type: "content",
      content: {
        type: "text",
        text: boundToolCallOutputText(trimmed.length > 0 ? trimmed : text),
      },
    } as const;
  });
  return changed ? bounded : content;
}

export function extractTextContentFromToolCallContent(
  content: ReadonlyArray<EffectAcpSchema.ToolCallContent> | null | undefined,
): ExtractedToolCallContent {
  if (!content) {
    return { text: undefined, content: undefined };
  }
  const chunks: Array<string> = [];
  for (const entry of content) {
    const text = toolCallContentText(entry)?.trim();
    if (text) {
      chunks.push(text);
    }
  }
  if (chunks.length === 0) {
    return { text: undefined, content: boundToolCallContentEntries(content) };
  }
  const joined = chunks.join("\n");
  if (joined.length <= TOOL_CALL_CONTENT_MAX_CHARS) {
    return { text: joined, content: boundToolCallContentEntries(content) };
  }
  const bounded = boundToolCallOutputText(joined);
  const tail = joined.slice(joined.length - TOOL_CALL_CONTENT_MAX_CHARS);
  return {
    text: bounded,
    content: distributeRetainedTailAcrossContent(content, tail),
  };
}

export function distributeRetainedTailAcrossContent(
  content: ReadonlyArray<EffectAcpSchema.ToolCallContent>,
  tail: string,
): ReadonlyArray<EffectAcpSchema.ToolCallContent> {
  const textRanges: Array<
    | {
        readonly start: number;
        readonly end: number;
        readonly text: string;
      }
    | undefined
  > = Array.from({ length: content.length });
  let offset = 0;
  let seenText = false;
  for (const [index, entry] of content.entries()) {
    const text = toolCallContentText(entry)?.trim();
    if (!text) {
      continue;
    }
    if (seenText) {
      offset += 1;
    }
    seenText = true;
    const start = offset;
    const end = offset + text.length;
    textRanges[index] = { start, end, text };
    offset = end;
  }
  const tailStart = Math.max(0, offset - tail.length);
  let markerPending = true;
  return content.flatMap((entry, index) => {
    if (toolCallContentText(entry) === undefined) {
      return [entry];
    }
    const range = textRanges[index];
    if (range === undefined) {
      return [];
    }
    const overlapStart = Math.max(range.start, tailStart);
    const overlapEnd = Math.min(range.end, offset);
    if (overlapEnd <= overlapStart) {
      return [];
    }
    let piece = range.text.slice(overlapStart - range.start, overlapEnd - range.start);
    if (markerPending) {
      piece = `${TOOL_CALL_CONTENT_TRUNCATION_MARKER}${piece}`;
      markerPending = false;
    }
    return [{ type: "content", content: { type: "text", text: piece } } as const];
  });
}

export function normalizeToolKind(kind: unknown): string | undefined {
  return typeof kind === "string" && kind.trim().length > 0 ? kind.trim() : undefined;
}

export function canonicalItemTypeFromAcpToolKind(kind: string | undefined): ToolLifecycleItemType {
  switch (kind) {
    case "read":
      return "dynamic_tool_call";
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

export function makeToolCallState(
  input: {
    readonly toolCallId: string;
    readonly name?: string | null | undefined;
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
  const kind = normalizeToolKind(input.kind);
  const command = extractToolCallCommand(input.rawInput, title, kind);
  const extractedContent = extractTextContentFromToolCallContent(input.content);
  const textContent = extractedContent.text;
  const normalizedTitle =
    title && title.toLowerCase() !== "terminal" && title.toLowerCase() !== "tool call"
      ? title
      : undefined;
  const data: Record<string, unknown> = { toolCallId };
  if (input.name != null) data.name = input.name;
  if (kind) {
    data.kind = kind;
  }
  if (title) {
    // Identity checks need the verbatim title; presentation summarizes the state title.
    data.title = title;
  }
  if (command) {
    data.command = command;
  }
  if (input.rawInput !== undefined) {
    data.rawInput = input.rawInput;
  }
  if (isRecord(input._meta)) {
    // goose, qwen, and claude-acp may identify MCP calls only in metadata.
    data.meta = input._meta;
  }
  if (input.rawOutput !== undefined) {
    data.rawOutput = boundToolCallRawOutput(input.rawOutput);
  }
  if (input.content != null) {
    data.content = sanitizeAcpToolCallContent(extractedContent.content ?? input.content);
  }
  const locations = locationsFromToolCallInput(input);
  if (locations !== undefined) {
    data.locations = locations;
  }
  if (isRecord(input._meta)) {
    data.meta = input._meta;
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

export function parseTypedToolCallState(
  event: AcpToolCallUpdate,
  options?: {
    readonly fallbackStatus?: "pending" | "inProgress" | "completed" | "failed";
  },
): AcpToolCallState | undefined {
  return makeToolCallState(
    {
      toolCallId: event.toolCallId,
      name: event.name,
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
  const data = mergeToolActivityData(previous?.data, next.data) ?? next.data;
  return {
    toolCallId: next.toolCallId,
    ...(kind ? { kind } : {}),
    ...(title ? { title } : {}),
    ...(status ? { status } : {}),
    ...(command ? { command } : {}),
    ...(detail ? { detail } : {}),
    data,
  };
}

// Bounded terminal tails still shift on each redraw; coalesce those updates.
