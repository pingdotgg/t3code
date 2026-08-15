import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import type * as EffectAcpSchema from "effect-acp/schema";
import { deriveToolActivityPresentation } from "@t3tools/shared/toolActivity";
import { T3_MCP_TOOL_NAMES } from "@t3tools/shared/t3McpToolPresentation";
import type { ToolLifecycleItemType } from "@t3tools/contracts";

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
  readonly status?: "pending" | "inProgress" | "completed" | "failed";
  readonly command?: string;
  readonly detail?: string;
  readonly data: Record<string, unknown>;
}

export interface AcpPlanUpdate {
  readonly explanation?: string | null;
  readonly plan: ReadonlyArray<{
    readonly step: string;
    readonly status: "pending" | "inProgress" | "completed";
  }>;
}

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
      readonly text: string;
      readonly rawPayload: unknown;
    };

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
    const nestedContent = entry.content;
    if (nestedContent.type !== "text") {
      continue;
    }
    const text = nestedContent.text.trim();
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
  if (input.content !== undefined) {
    data.content = input.content;
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
  const nextKind = typeof next.data.kind === "string" ? next.data.kind : undefined;
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
}

/** Matches an invocation of T3's `acp-mcp-call` bridge fallback CLI. */
const ACP_MCP_FALLBACK_CALL = /(?:^|[\s"'=])acp-mcp-call[\s"']+([A-Za-z0-9_.-]+)/u;

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
  const server = typeof rawInput?.server === "string" ? rawInput.server.trim() : "";
  const tool = typeof rawInput?.tool === "string" ? rawInput.tool.trim() : "";
  if (server.length > 0 && tool.length > 0) {
    return { server, tool };
  }
  // Agents without tagged rawInput identify their MCP calls through _meta
  // (goose, qwen, claude-acp) or only through the namespaced function name
  // in the title. The verbatim wire title survives merges even when a later
  // titleless or LLM-enriched update replaces the presentation title, so
  // match those rather than the summarized state title. Name-derived matches
  // are gated on the known T3 tool inventory so path-like titles (for
  // example "t3-code/README.md") never brand.
  const meta = isRecord(toolCall.data.meta) ? toolCall.data.meta : undefined;
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
      return { server: "t3-code", tool: match[1] };
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
      return update.content.type === "text" && update.content.text.length > 0;
    case "tool_call":
    case "tool_call_update":
    case "plan":
    case "available_commands_update":
    case "current_mode_update":
    case "config_option_update":
    case "session_info_update":
    case "usage_update":
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
            plan,
          },
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
      if (upd.content.type === "text" && upd.content.text.length > 0) {
        events.push({
          _tag: "ContentDelta",
          text: upd.content.text,
          rawPayload: params,
        });
      }
      break;
    }
    default:
      break;
  }

  return { ...(modeId !== undefined ? { modeId } : {}), events };
}
