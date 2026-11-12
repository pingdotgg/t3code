import { RAW_OUTPUT_TEXT_FIELDS, acpContentBlockDisplayText, boundedContentMetadata, makeToolCallState, normalizePlanStepStatus, normalizeToolKind, parseSessionModeState, parseTypedToolCallState, toolCallContentText } from "./runtimeModel-02-bounded.ts";
import { isRecord, isSessionModeState, isSessionModelState } from "./runtimeModel-03-is.ts";
import type { AcpMcpToolCallIdentity, AcpParsedSessionEvent, AcpPermissionRequest, AcpToolCallEmitDecision, AcpToolCallEmitDecisionInput, AcpToolCallState, AcpToolCallUpdate, SessionLoadGate } from "./runtimeModel-03-is.ts";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as EffectAcpSchema from "effect-acp/compat";
import { T3_MCP_TOOL_NAMES } from "@t3tools/shared/t3McpToolPresentation";

export const TOOL_CALL_UPDATE_MIN_DETAIL_GROWTH_CHARS = 256;
export const TOOL_CALL_UPDATE_COALESCE_LIMIT = 10;

export function toolCallOutputUnchanged(previous: AcpToolCallState, next: AcpToolCallState): boolean {
  return (
    previous.data.content === next.data.content && previous.data.rawOutput === next.data.rawOutput
  );
}

// Command detail is static; measure stdout in content/rawOutput to detect progress.
export function toolCallProgressLength(state: AcpToolCallState): number {
  let contentChars = 0;
  const content = state.data.content;
  if (Array.isArray(content)) {
    for (const entry of content) {
      if (!isRecord(entry)) {
        continue;
      }
      const text = toolCallContentText(entry as EffectAcpSchema.ToolCallContent);
      if (text) {
        contentChars += text.length;
      }
    }
  }
  let rawOutputChars = 0;
  const rawOutput = state.data.rawOutput;
  if (isRecord(rawOutput)) {
    for (const field of RAW_OUTPUT_TEXT_FIELDS) {
      const value = rawOutput[field];
      if (typeof value === "string") {
        rawOutputChars += value.length;
      }
    }
  }
  return Math.max(state.detail?.length ?? 0, contentChars, rawOutputChars);
}

export function toolCallContentTexts(state: AcpToolCallState): string {
  const content = state.data.content;
  if (!Array.isArray(content)) return "";
  return content
    .map((entry) =>
      isRecord(entry) ? (toolCallContentText(entry as EffectAcpSchema.ToolCallContent) ?? "") : "",
    )
    .join("\u0000");
}

export function toolCallVisibleOutputChanged(
  previous: AcpToolCallState,
  next: AcpToolCallState,
): boolean {
  return (
    previous.detail !== next.detail ||
    toolCallContentTexts(previous) !== toolCallContentTexts(next) ||
    JSON.stringify(previous.data.rawOutput) !== JSON.stringify(next.data.rawOutput)
  );
}

export function decideToolCallUpdateEmission(
  input: AcpToolCallEmitDecisionInput,
): AcpToolCallEmitDecision {
  const { previous, next, lastEmittedDetailLength, skippedSinceEmit } = input;
  if (next.status === "completed" || next.status === "failed") {
    return { emit: true, skippedSinceEmit: 0 };
  }
  if (previous === undefined || previous.title !== next.title || previous.status !== next.status) {
    return { emit: true, skippedSinceEmit: 0 };
  }
  if (previous.detail === next.detail && toolCallOutputUnchanged(previous, next)) {
    return { emit: false, skippedSinceEmit };
  }
  const progressLength = toolCallProgressLength(next);
  const grewMeaningfully =
    lastEmittedDetailLength === undefined ||
    Math.abs(progressLength - lastEmittedDetailLength) >= TOOL_CALL_UPDATE_MIN_DETAIL_GROWTH_CHARS;
  if (grewMeaningfully || skippedSinceEmit + 1 >= TOOL_CALL_UPDATE_COALESCE_LIMIT) {
    return { emit: true, skippedSinceEmit: 0 };
  }
  return { emit: false, skippedSinceEmit: skippedSinceEmit + 1 };
}

export const ACP_MCP_FALLBACK_CALL = /(?:^|[\s"'=])acp-mcp-call[\s"']+([A-Za-z0-9_.-]+)(?:\s+(.+?))?\s*$/u;

export function acpMcpFallbackInput(value: string | undefined): Record<string, unknown> | undefined {
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
      // Unknown shell quoting retains MCP identity but omits unparseable input.
    }
  }
  return undefined;
}

// Known T3 inventory gates matches, so server-name separators can stay loose. Kiro titles "@t3-code/<tool>".
export const T3_MCP_TITLE_CALL =
  /^(?:@|mcp[-_]{1,2})?t3[-_ ]?code[-_.:/ ]{1,3}(?<tool>[A-Za-z0-9][A-Za-z0-9_.-]*)(?::.*)?$/i;

export const T3_MCP_TITLE_SUFFIX_CALL =
  /^(?<tool>[A-Za-z0-9][A-Za-z0-9_.-]*?)(?: \(t3[-_ ]?code MCP Server\)(?::|$)|[-_.]t3[-_ ]?code$)/i;

/**
 * glm and Kimi use bare names; Antigravity uses "Running <tool>". Kimi appends
 * streamed JSON arguments. Require a name or JSON opening brace so built-ins
 * titled "<tool>: <description>" cannot impersonate an inventory entry.
 */
export const T3_MCP_BARE_TITLE_CALL = /^(?:Running )?(?<tool>[A-Za-z0-9_]+)(?::\s*\{|$)/;

/** ACP lacks typed MCP calls; recognize provider metadata and terminal fallback commands. */
export function extractMcpToolCallIdentity(
  toolCall: AcpToolCallState,
  options?: {
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
  // Kiro names the server in `_meta.kiro.serverName` and the call in `rawInput.tool_id`
  // ("<server>::<tool>"), with the tool's own input under `rawInput.arguments`.
  const kiroServer = isRecord(meta?.kiro) ? meta.kiro.serverName : undefined;
  const kiroToolId = typeof rawInput?.tool_id === "string" ? rawInput.tool_id.trim() : "";
  if (
    typeof kiroServer === "string" &&
    kiroServer.length > 0 &&
    kiroToolId.startsWith(`${kiroServer}::`) &&
    kiroToolId.length > kiroServer.length + 2
  ) {
    return { server: kiroServer, tool: kiroToolId.slice(kiroServer.length + 2) };
  }
  const claudeCode = isRecord(meta?.claudeCode) ? meta.claudeCode : undefined;
  const gooseToolCall = isRecord(meta?.goose)
    ? isRecord(meta.goose.toolCall)
      ? meta.goose.toolCall
      : undefined
    : undefined;
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
  const gooseExtension =
    typeof gooseToolCall?.extensionName === "string" ? gooseToolCall.extensionName.trim() : "";
  const assertsForeignOrigin =
    (metaServerId.length > 0 && !/^t3[-_ ]?code$/i.test(metaServerId)) ||
    (gooseExtension.length > 0 && !/^t3[-_ ]?code$/i.test(gooseExtension));
  // goose metadata also tags built-ins; retain their command/file projections instead of classifying as MCP.
  if (assertsForeignOrigin) {
    if (metaServerId.length === 0 || metaToolName.length === 0) return undefined;
    const prefix = [`mcp__${metaServerId}__`, `mcp::${metaServerId}::`].find((prefix) =>
      metaToolName.startsWith(prefix),
    );
    const tool = prefix === undefined ? metaToolName : metaToolName.slice(prefix.length);
    return tool ? { server: metaServerId, tool } : undefined;
  }
  const candidates = [
    meta?.toolName,
    claudeCode?.toolName,
    gooseToolCall?.toolName,
    toolCall.data.title,
  ].filter((value): value is string => typeof value === "string");
  for (const candidate of candidates) {
    const trimmed = candidate.trim();
    const qualified = /^mcp__(.+?)__(.+)$/i.exec(trimmed);
    if (qualified?.[1] && qualified[2] && !/^t3[-_ ]?code$/i.test(qualified[1]))
      return { server: qualified[1], tool: qualified[2] };
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
      const input = acpMcpFallbackInput(match[2]);
      return { server: "t3-code", tool: match[1], ...(input === undefined ? {} : { input }) };
    }
  }
  return undefined;
}

/** Capture IDs before resolveEmbeddedTerminalContent replaces them with text, to recover commands later. */
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

/** ACP lets a permission request name its tool call by ID only; omitted (not null) fields come from the tracked call. */
export function withTrackedPermissionToolCall(
  params: EffectAcpSchema.RequestPermissionRequest,
  tracked: AcpToolCallState | undefined,
): EffectAcpSchema.RequestPermissionRequest {
  if (tracked === undefined) return params;
  const { title, kind, rawInput } = params.toolCall;
  return {
    ...params,
    toolCall: {
      ...params.toolCall,
      ...(title === undefined && typeof tracked.data.title === "string"
        ? { title: tracked.data.title }
        : {}),
      // Unrecognised kinds map to command approvals, so only a tracked execute kind may grant execution.
      ...(kind === undefined && tracked.kind === "execute" ? { kind: "execute" as const } : {}),
      ...(rawInput === undefined && tracked.data.rawInput !== undefined
        ? { rawInput: tracked.data.rawInput }
        : {}),
    },
  };
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

export const waitForSessionLoadReplayIdle = Effect.fn(
  "AcpRuntimeModel.waitForSessionLoadReplayIdle",
)(function* (input: {
  readonly gateRef: Ref.Ref<Option.Option<SessionLoadGate>>;
}): Effect.fn.Return<EffectAcpSchema.LoadSessionResponse, never> {
  const pollInterval = Duration.millis(25);
  while (true) {
    const gate = yield* Ref.get(input.gateRef);
    if (Option.isSome(gate) && gate.value.active && gate.value.lastActivityAtMillis !== undefined) {
      const idleGapMillis = Duration.toMillis(gate.value.idleGap);
      const nowMillis = yield* Clock.currentTimeMillis;
      if (nowMillis - gate.value.lastActivityAtMillis >= idleGapMillis) {
        return syntheticLoadSessionResponseFromInitialize(gate.value.initializeResult);
      }
    }
    yield* Effect.sleep(pollInterval);
  }
});

export function sessionModelStateFromInitialize(
  initializeResult: EffectAcpSchema.InitializeResponse,
): EffectAcpSchema.SessionModelState | undefined {
  const meta = initializeResult._meta;
  const modelState = isRecord(meta) ? meta.modelState : undefined;
  return isSessionModelState(modelState) ? modelState : undefined;
}

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

// Persisted rawPayload must not bypass cumulative output limits.
export function boundToolCallRawPayload(
  params: EffectAcpSchema.SessionNotification,
  update: AcpToolCallUpdate,
  toolCall: AcpToolCallState,
): unknown {
  const boundedContent = toolCall.data.content;
  const boundedRawOutput = toolCall.data.rawOutput;
  const contentBounded = update.content !== undefined && boundedContent !== update.content;
  const rawOutputBounded = update.rawOutput !== undefined && boundedRawOutput !== update.rawOutput;
  if (!contentBounded && !rawOutputBounded) {
    return params;
  }
  return {
    ...params,
    update: {
      ...update,
      ...(contentBounded ? { content: boundedContent } : {}),
      ...(rawOutputBounded ? { rawOutput: boundedRawOutput } : {}),
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
    case "config_option_update": {
      const modes = parseSessionModeState({ configOptions: upd.configOptions });
      if (modes !== undefined) {
        modeId = modes.currentModeId;
        events.push({ _tag: "ModeChanged", modeId });
      }
      events.push({
        _tag: "ConfigOptionsUpdated",
        configOptions: upd.configOptions,
        rawPayload: params,
      });
      break;
    }
    case "available_commands_update": {
      events.push({
        _tag: "AvailableCommandsUpdated",
        availableCommands: upd.availableCommands,
        rawPayload: params,
      });
      break;
    }
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
      events.push({
        _tag: "PlanUpdated",
        payload: {
          nativePlanId: "legacy",
          kind: "items",
          plan,
        },
        rawPayload: params,
      });
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
          rawPayload: boundToolCallRawPayload(params, upd, toolCall),
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
          rawPayload: boundToolCallRawPayload(params, upd, toolCall),
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
    case "agent_thought_chunk": {
      if (upd.content.type === "text" && upd.content.text.length > 0) {
        events.push({
          _tag: "ThoughtDelta",
          text: upd.content.text,
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
    case "notice": {
      const title = upd.title.trim().slice(0, 1_024);
      const description = upd.description?.trim().slice(0, 4_096);
      if (title.length === 0) break;
      events.push({
        _tag: "NoticeReceived",
        severity: boundedContentMetadata(upd.severity, 64) || "info",
        title,
        ...(description ? { description } : {}),
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

