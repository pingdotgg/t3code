import {
  CopilotClient,
  RuntimeConnection,
  type MCPServerConfig,
  type CopilotSession,
  type ModelInfo,
  type PermissionRequest,
  type PermissionRequestResult,
  type SessionConfig,
  type SessionEvent,
} from "@github/copilot-sdk";
import type { AcpSessionRuntimeOptions } from "@t3tools/provider-acp/server/AcpSessionRuntime";
import * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type * as AcpSchema from "effect-acp/compat";
import * as AcpErrors from "effect-acp/errors";

const COPILOT_META_KEY = "github.com/copilot";
const COPILOT_SESSION_EVENT = "github.com/copilot/sessionEvent";
export const COPILOT_SDK_STEER_METHOD = "t3/copilot/steer";
export const COPILOT_SDK_COMPACT_METHOD = "t3/copilot/compact";
export const COPILOT_SDK_ROLLBACK_METHOD = "t3/copilot/rollback";
export const COPILOT_SDK_MCP_APP_METHOD = "t3/copilot/mcp-app";
export const COPILOT_SDK_STOP_TASK_METHOD = "t3/copilot/stop-task";
const PLAN_TOOL_CALL_PREFIX = "copilot-plan:";
const PLAN_DECLINED_FEEDBACK =
  "T3 Code is showing this plan to the user. Stop now and wait for their decision.";

const MODE_URL = "https://agentclientprotocol.com/protocol/session-modes#";
const SDK_MODE_BY_ACP_MODE = {
  [`${MODE_URL}agent`]: "interactive",
  [`${MODE_URL}plan`]: "plan",
  [`${MODE_URL}autopilot`]: "autopilot",
} as const;
type AcpModeId = keyof typeof SDK_MODE_BY_ACP_MODE;
type SdkMode = (typeof SDK_MODE_BY_ACP_MODE)[AcpModeId];

const ACP_MODES = [
  {
    id: `${MODE_URL}agent`,
    name: "Agent",
    description: "Default agent mode for conversational interactions",
  },
  {
    id: `${MODE_URL}plan`,
    name: "Plan",
    description: "Plan mode for creating and executing multi-step plans",
  },
  {
    id: `${MODE_URL}autopilot`,
    name: "Autopilot",
    description:
      "Autonomous mode that enables allow-all and runs until task completion without user interaction (experimental)",
  },
] as const;

const REASONING_DESCRIPTIONS: Record<string, string> = {
  low: "Minimal reasoning before responding.",
  medium: "Balanced reasoning and speed.",
  high: "More thorough reasoning; slower responses.",
};

// The SDK exposes no connection-closed hook, so a dead runtime would otherwise hang the prompt.
const CONNECTION_WATCHDOG_INTERVAL = Duration.seconds(10);
const CONNECTION_PING_TIMEOUT = Duration.seconds(30);
const STOP_TIMEOUT = Duration.seconds(10);

const INITIALIZE_RESULT = {
  protocolVersion: 1,
  agentCapabilities: {
    loadSession: true,
    mcpCapabilities: { http: true, sse: true },
    promptCapabilities: { image: true, audio: false, embeddedContext: true },
    sessionCapabilities: { close: {}, fork: {}, list: {} },
  },
  agentInfo: { name: "Copilot", title: "Copilot", version: "sdk" },
  authMethods: [],
} satisfies AcpSchema.InitializeResponse;

export interface CopilotSdkSession {
  readonly sessionId: string;
  readonly on: (handler: (event: SessionEvent) => void) => () => void;
  readonly send: (options: {
    readonly prompt: string;
    readonly attachments?: ReadonlyArray<{
      readonly type: "blob";
      readonly data: string;
      readonly mimeType: string;
    }>;
  }) => Promise<string>;
  readonly abort: () => Promise<void>;
  readonly interruptMainTurn: (flushQueued: boolean) => Promise<void>;
  readonly currentModel: () => Promise<{
    readonly modelId?: string;
    readonly reasoningEffort?: string;
  }>;
  readonly switchModel: (modelId: string) => Promise<void>;
  readonly setReasoningEffort: (effort: string) => Promise<void>;
  readonly setMode: (mode: SdkMode) => Promise<void>;
  readonly setApproveAll: (enabled: boolean) => Promise<void>;
  readonly history: () => Promise<ReadonlyArray<SessionEvent>>;
  readonly disconnect: () => Promise<void>;
  readonly compact: () => Promise<{ readonly success: boolean }>;
  /** Removes this event and everything after it. */
  readonly truncate: (eventId: string) => Promise<void>;
  readonly commands: () => Promise<ReadonlyArray<CopilotSdkCommand>>;
  readonly invokeCommand: (
    name: string,
    input: string | undefined,
  ) => Promise<CopilotSdkCommandResult>;
  /** Copilot cancels by agent id, while T3 holds the id of the tool call that started the agent. */
  readonly cancelTask: (toolCallId: string) => Promise<boolean>;
  readonly mcpAppTools: (server: string) => Promise<ReadonlyArray<Record<string, unknown>>>;
  readonly callMcpAppTool: (input: {
    readonly server: string;
    readonly tool: string;
    readonly arguments: Record<string, unknown>;
  }) => Promise<unknown>;
  readonly readMcpAppResource: (server: string, uri: string) => Promise<unknown>;
}

export type CopilotSdkMcpAppRequest =
  | { readonly operation: "listTools"; readonly server: string }
  | {
      readonly operation: "callTool";
      readonly server: string;
      readonly tool: string;
      readonly arguments: Record<string, unknown>;
    }
  | { readonly operation: "readResource"; readonly server: string; readonly uri: string };

export interface CopilotSdkCommand {
  readonly name: string;
  readonly description: string;
  readonly input?: { readonly hint: string };
}

export type CopilotSdkCommandResult = Awaited<
  ReturnType<CopilotSession["rpc"]["commands"]["invoke"]>
>;

type CopilotSdkSessionConfig = Pick<
  SessionConfig,
  | "clientName"
  | "mcpServers"
  | "onExitPlanModeRequest"
  | "onPermissionRequest"
  | "onUserInputRequest"
  | "streaming"
  | "toolSearch"
  | "enableMcpApps"
  | "includeSubAgentStreamingEvents"
  | "workingDirectory"
>;

export interface CopilotSdkClient {
  readonly start: () => Promise<void>;
  readonly ping: () => Promise<unknown>;
  readonly authStatus: () => Promise<{
    readonly isAuthenticated: boolean;
    readonly login?: string;
  }>;
  readonly serverCommands: () => Promise<ReadonlyArray<CopilotSdkCommand>>;
  readonly listModels: () => Promise<ReadonlyArray<ModelInfo>>;
  readonly createSession: (config: CopilotSdkSessionConfig) => Promise<CopilotSdkSession>;
  readonly resumeSession: (
    sessionId: string,
    config: CopilotSdkSessionConfig,
  ) => Promise<CopilotSdkSession>;
  readonly fork: (sessionId: string, toEventId: string | undefined) => Promise<string>;
  /** A session's saved events, without resuming it. */
  readonly sessionHistory: (sessionId: string) => Promise<ReadonlyArray<SessionEvent>>;
  /** One prompt in a throwaway session with no tools, removed afterwards to keep history clean. */
  readonly generateText: (input: {
    readonly cwd: string;
    readonly model: string;
    readonly prompt: string;
    readonly timeoutMs: number;
  }) => Promise<string>;
  readonly stop: () => Promise<unknown>;
  readonly forceStop: () => Promise<void>;
}

function wrapSession(session: Awaited<ReturnType<CopilotClient["createSession"]>>) {
  return {
    sessionId: session.sessionId,
    on: (handler) => session.on(handler),
    send: (options) =>
      session.send({
        prompt: options.prompt,
        ...(options.attachments === undefined ? {} : { attachments: [...options.attachments] }),
      }),
    abort: () => session.abort(),
    interruptMainTurn: async (flushQueued) => {
      await session.rpc.interruptMainTurn({ flushQueued });
    },
    currentModel: () => session.rpc.model.getCurrent(),
    switchModel: async (modelId) => {
      await session.rpc.model.switchTo({ modelId });
    },
    setReasoningEffort: async (reasoningEffort) => {
      await session.rpc.model.setReasoningEffort({ reasoningEffort });
    },
    setMode: async (mode) => {
      await session.rpc.mode.set({ mode });
    },
    setApproveAll: async (enabled) => {
      await session.rpc.permissions.setApproveAll({ enabled });
    },
    history: () => session.getEvents(),
    disconnect: () => session.disconnect(),
    compact: () => session.rpc.history.compact({ trigger: "manual" }),
    truncate: async (eventId) => {
      await session.rpc.history.truncate({ eventId });
    },
    commands: async () => (await session.rpc.commands.list()).commands,
    invokeCommand: (name, input) =>
      session.rpc.commands.invoke({ name, ...(input === undefined ? {} : { input }) }),
    mcpAppTools: async (serverName) =>
      (await session.rpc.mcp.apps.listTools({ serverName, originServerName: serverName })).tools,
    callMcpAppTool: ({ server, tool, arguments: toolArguments }) =>
      session.rpc.mcp.apps.callTool({
        serverName: server,
        toolName: tool,
        arguments: toolArguments as Record<string, never>,
        originServerName: server,
      }),
    readMcpAppResource: (serverName, uri) => session.rpc.mcp.apps.readResource({ serverName, uri }),
    cancelTask: async (toolCallId) => {
      const { tasks } = await session.rpc.tasks.list();
      const task = tasks.find(
        (candidate) => "toolCallId" in candidate && candidate.toolCallId === toolCallId,
      );
      if (task === undefined) return false;
      return (await session.rpc.tasks.cancel({ id: task.id })).cancelled;
    },
  } satisfies CopilotSdkSession;
}

export async function generateCopilotText(
  client: Pick<CopilotClient, "start" | "createSession" | "deleteSession" | "stop">,
  input: {
    readonly cwd: string;
    readonly model: string;
    readonly prompt: string;
    readonly timeoutMs: number;
  },
) {
  try {
    await client.start();
    const session = await client.createSession({
      model: input.model,
      workingDirectory: input.cwd,
      availableTools: [],
      onPermissionRequest: () => ({ kind: "reject" }),
    });
    try {
      return (await session.sendAndWait(input.prompt, input.timeoutMs))?.data.content ?? "";
    } finally {
      await session.disconnect().catch(() => undefined);
      await client.deleteSession(session.sessionId).catch(() => undefined);
    }
  } finally {
    await client.stop();
  }
}

function definedEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).flatMap(([key, value]) => (value === undefined ? [] : [[key, value]])),
  );
}

export function makeCopilotSdkClient(input: {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env: NodeJS.ProcessEnv | undefined;
}): CopilotSdkClient {
  const client = new CopilotClient({
    connection: RuntimeConnection.forStdio({
      path: input.command,
      // The SDK starts the runtime in its own mode; `--acp` would select the wrong protocol.
      args: input.args.filter((arg) => arg !== "--acp"),
      // Copilot drops `enableMcpApps` unless this override or its own rollout flag is on.
      env: { ...definedEnvironment(input.env ?? {}), COPILOT_MCP_APPS: "true" },
    }),
  });
  return {
    start: () => client.start(),
    ping: () => client.ping(),
    authStatus: () => client.getAuthStatus(),
    serverCommands: async () => (await client.rpc.commands.list()).commands,
    listModels: () => client.listModels(),
    createSession: async (config) => wrapSession(await client.createSession(config)),
    resumeSession: async (sessionId, config) =>
      wrapSession(await client.resumeSession(sessionId, config)),
    fork: async (sessionId, toEventId) =>
      (
        await client.rpc.sessions.fork({
          sessionId,
          ...(toEventId === undefined ? {} : { toEventId }),
        })
      ).sessionId,
    sessionHistory: async (sessionId) => {
      const events: Array<SessionEvent> = [];
      let cursor: string | undefined;
      do {
        const page = await client.rpc.sessions.readPersistedEvents({
          sessionId,
          direction: "forward",
          max: 1000,
          ...(cursor === undefined ? {} : { cursor }),
        });
        // An expired cursor ends in an empty page, which would pass for the end of the history.
        if (page.cursorStatus !== "ok") throw new Error(`Copilot session ${sessionId} expired.`);
        events.push(...page.events);
        cursor = page.hasMore ? page.cursor : undefined;
      } while (cursor !== undefined);
      return events;
    },
    generateText: (input) => generateCopilotText(client, input),
    stop: () => client.stop(),
    forceStop: () => client.forceStop(),
  };
}

const TOOL_KINDS: Record<string, AcpSchema.ToolKind> = {
  bash: "execute",
  create: "edit",
  edit: "edit",
  fetch_copilot_cli_documentation: "fetch",
  glob: "search",
  grep: "search",
  list_bash: "execute",
  read_bash: "execute",
  stop_bash: "execute",
  str_replace_editor: "edit",
  view: "read",
  web_fetch: "fetch",
  write_bash: "execute",
};

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

const stringField = (value: Record<string, unknown> | undefined, key: string) =>
  typeof value?.[key] === "string" ? value[key] : undefined;

interface ToolIdentity {
  readonly serverId?: string;
  readonly toolName?: string;
}

/** `serverId` and `toolName` are the top-level keys ACP tool parsing reads an MCP identity from. */
function toolMeta(
  agentId: string | undefined,
  identity: ToolIdentity | undefined,
  uiResource?: unknown,
) {
  const copilot = {
    ...(agentId === undefined ? {} : { agentId }),
    ...(uiResource === undefined ? {} : { uiResource }),
  };
  const meta = {
    ...identity,
    ...(Object.keys(copilot).length === 0 ? {} : { [COPILOT_META_KEY]: copilot }),
  } as Record<string, Schema.Json>;
  return Object.keys(meta).length === 0 ? {} : { _meta: meta };
}

/** Remembers each tool's input so a completed edit can report the same diff ACP does. */
export function makeCopilotSdkEventTranslator() {
  const toolInputs = new Map<string, Record<string, unknown>>();
  const openMainTools = new Set<string>();
  const toolIdentities = new Map<string, ToolIdentity>();

  return (event: SessionEvent): ReadonlyArray<AcpSchema.SessionUpdate> => {
    switch (event.type) {
      case "assistant.message_delta":
        return [
          {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: event.data.deltaContent },
          },
        ];
      case "assistant.reasoning_delta":
        return [
          {
            sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text: event.data.deltaContent },
          },
        ];
      case "tool.execution_start": {
        const input = record(event.data.arguments) ?? {};
        toolInputs.set(event.data.toolCallId, input);
        if (event.agentId === undefined && event.data.parentToolCallId === undefined) {
          openMainTools.add(event.data.toolCallId);
        }
        const path = stringField(input, "path");
        const identity =
          event.data.mcpServerName === undefined || event.data.mcpToolName === undefined
            ? undefined
            : { serverId: event.data.mcpServerName, toolName: event.data.mcpToolName };
        if (identity !== undefined) toolIdentities.set(event.data.toolCallId, identity);
        return [
          {
            sessionUpdate: "tool_call",
            toolCallId: event.data.toolCallId,
            title: stringField(input, "description") ?? event.data.toolTitle ?? event.data.toolName,
            kind: TOOL_KINDS[event.data.toolName] ?? "other",
            status: "pending",
            rawInput: input,
            ...(path === undefined ? {} : { locations: [{ path }] }),
            ...toolMeta(event.agentId, identity),
          },
        ];
      }
      case "tool.execution_partial_result":
        return [
          {
            sessionUpdate: "tool_call_update",
            toolCallId: event.data.toolCallId,
            content: [
              { type: "content", content: { type: "text", text: event.data.partialOutput } },
            ],
            ...toolMeta(event.agentId, toolIdentities.get(event.data.toolCallId)),
          },
        ];
      case "tool.execution_complete": {
        const input = toolInputs.get(event.data.toolCallId);
        toolInputs.delete(event.data.toolCallId);
        openMainTools.delete(event.data.toolCallId);
        const path = stringField(input, "path");
        const newText = stringField(input, "new_str");
        const identity = toolIdentities.get(event.data.toolCallId);
        toolIdentities.delete(event.data.toolCallId);
        // The UI document travels in `_meta` so it never lands in the stored tool output.
        const { uiResource, ...result } = event.data.result ?? {};
        const text = event.data.result?.content ?? event.data.error?.message;
        const content: ReadonlyArray<AcpSchema.ToolCallContent> =
          event.data.success && path !== undefined && newText !== undefined
            ? [
                {
                  type: "diff",
                  path,
                  oldText: stringField(input, "old_str") ?? null,
                  newText,
                },
              ]
            : text === undefined
              ? []
              : [{ type: "content", content: { type: "text", text } }];
        return [
          {
            sessionUpdate: "tool_call_update",
            toolCallId: event.data.toolCallId,
            status: event.data.success ? "completed" : "failed",
            ...(content.length === 0 ? {} : { content: [...content] }),
            rawOutput: event.data.result === undefined ? (event.data.error ?? null) : result,
            ...toolMeta(event.agentId, identity, uiResource),
          },
        ];
      }
      case "exit_plan_mode.requested":
        return [
          {
            sessionUpdate: "tool_call",
            toolCallId: `${PLAN_TOOL_CALL_PREFIX}${event.data.requestId}`,
            title: "Plan",
            kind: "switch_mode",
            status: "completed",
            rawInput: { planContent: event.data.planContent, summary: event.data.summary },
          },
        ];
      case "abort": {
        // Copilot kills the main agent's running tools here and never reports them again.
        const interrupted = [...openMainTools];
        openMainTools.clear();
        return interrupted.map((toolCallId) => {
          toolInputs.delete(toolCallId);
          return { sessionUpdate: "tool_call_update", toolCallId, status: "failed" } as const;
        });
      }
      case "session.usage_info":
        return [
          {
            sessionUpdate: "usage_update",
            used: event.data.currentTokens,
            size: event.data.tokenLimit,
          },
        ];
      case "session.title_changed":
        return [{ sessionUpdate: "session_info_update", title: event.data.title }];
      case "assistant.message":
        return event.data.parentToolCallId === undefined
          ? [
              {
                sessionUpdate: "session_info_update",
                _meta: { [COPILOT_META_KEY]: { assistantMessageComplete: true } },
              },
            ]
          : [];
      case "user.message":
        return event.data.messageId === undefined
          ? []
          : [
              {
                sessionUpdate: "session_info_update",
                _meta: {
                  [COPILOT_META_KEY]: { userMessageId: event.data.messageId, eventId: event.id },
                },
              },
            ];
      default:
        return [];
    }
  };
}

const withoutT3Instructions = (prompt: string) =>
  prompt.replace(/^<t3_code_instructions>[\s\S]*?<\/t3_code_instructions>\s*/, "");

/** History leaves out streaming deltas, so a replay renders each complete message instead. */
export function copilotSdkHistoryMessage(event: SessionEvent): AcpSchema.SessionUpdate | undefined {
  if (event.agentId !== undefined) return undefined;
  const content = { type: "text", text: "" } as const;
  switch (event.type) {
    case "user.message":
      return {
        sessionUpdate: "user_message_chunk",
        content: { ...content, text: withoutT3Instructions(event.data.content) },
        ...(event.data.messageId === undefined ? {} : { messageId: event.data.messageId }),
      };
    case "assistant.message":
      return event.data.parentToolCallId === undefined && event.data.content.length > 0
        ? {
            sessionUpdate: "agent_message_chunk",
            content: { ...content, text: event.data.content },
            messageId: event.data.messageId,
          }
        : undefined;
    case "assistant.reasoning":
      return {
        sessionUpdate: "agent_thought_chunk",
        content: { ...content, text: event.data.content },
        messageId: event.data.reasoningId,
      };
    default:
      return undefined;
  }
}

const decodeUserMessageMeta = Schema.decodeUnknownOption(
  Schema.Struct({
    [COPILOT_META_KEY]: Schema.Struct({ userMessageId: Schema.String }),
  }),
);

export function copilotSdkInjectedSteerId(
  notification: AcpSchema.SessionNotification,
): string | undefined {
  if (notification.update.sessionUpdate !== "session_info_update") return undefined;
  const decoded = decodeUserMessageMeta(notification.update._meta);
  return decoded._tag === "Some" ? decoded.value[COPILOT_META_KEY].userMessageId : undefined;
}

const decodeUserMessageEventMeta = Schema.decodeUnknownOption(
  Schema.Struct({ [COPILOT_META_KEY]: Schema.Struct({ eventId: Schema.String }) }),
);

const FORK_EVENT_META_KEY = "copilotForkEventId";

/** `toEventId` is exclusive, so a fork through a turn ends at the following user message. */
export function copilotSdkForkBoundary(
  history: ReadonlyArray<Pick<SessionEvent, "id" | "type">>,
  turnEventId: string,
): string | undefined {
  const start = history.findIndex((event) => event.id === turnEventId);
  if (start < 0) return undefined;
  return history.slice(start + 1).find((event) => event.type === "user.message")?.id;
}

export const copilotSdkForkFromTurn = {
  supported: () => true,
  nativeTurnId: (notification: AcpSchema.SessionNotification) => {
    if (notification.update.sessionUpdate !== "session_info_update") return undefined;
    const decoded = decodeUserMessageEventMeta(notification.update._meta);
    return decoded._tag === "Some" ? decoded.value[COPILOT_META_KEY].eventId : undefined;
  },
  forkMeta: (eventId: string) => ({ [FORK_EVENT_META_KEY]: eventId }),
};

export function copilotSdkProposedPlan(
  notification: AcpSchema.SessionNotification,
): string | undefined {
  const { update } = notification;
  return update.sessionUpdate === "tool_call" && update.toolCallId.startsWith(PLAN_TOOL_CALL_PREFIX)
    ? stringField(record(update.rawInput), "planContent")
    : undefined;
}

/** The UI document a finished MCP tool returned, shaped for T3's app snapshot. */
export function copilotSdkMcpAppDocument(meta: unknown, rawOutput: unknown) {
  const resource = record(record(record(meta)?.[COPILOT_META_KEY])?.uiResource);
  const resourceUri = stringField(resource, "uri");
  if (resource === undefined || resourceUri === undefined) return undefined;
  const output = record(rawOutput);
  const text = stringField(output, "content");
  return {
    resourceUri,
    contents: [resource],
    result: {
      content: text === undefined ? [] : [{ type: "text", text }],
      ...(output?.structuredContent === undefined
        ? {}
        : { structuredContent: output.structuredContent }),
    },
  };
}

export const requestCopilotSdkMcpApp = (
  runtime: AcpSessionRuntime.AcpSessionRuntime["Service"],
  payload: CopilotSdkMcpAppRequest,
) => runtime.request(COPILOT_SDK_MCP_APP_METHOD, payload);

export const rollbackCopilotSdkSession = (
  runtime: AcpSessionRuntime.AcpSessionRuntime["Service"],
  _sessionId: string,
  turnEventId: string,
) => runtime.request(COPILOT_SDK_ROLLBACK_METHOD, { turnEventId }).pipe(Effect.asVoid);

export const compactCopilotSdkSession = (
  runtime: AcpSessionRuntime.AcpSessionRuntime["Service"],
  sessionId: string,
) => runtime.request(COPILOT_SDK_COMPACT_METHOD, { sessionId }).pipe(Effect.asVoid);

export const stopCopilotSdkTask = (
  runtime: AcpSessionRuntime.AcpSessionRuntime["Service"],
  taskId: string,
) => runtime.request(COPILOT_SDK_STOP_TASK_METHOD, { taskId }).pipe(Effect.asVoid);

const decodeAssistantMessageMeta = Schema.decodeUnknownOption(
  Schema.Struct({
    [COPILOT_META_KEY]: Schema.Struct({ assistantMessageComplete: Schema.Literal(true) }),
  }),
);

export function copilotSdkClosesAssistantMessage(notification: AcpSchema.SessionNotification) {
  return (
    notification.update.sessionUpdate === "session_info_update" &&
    decodeAssistantMessageMeta(notification.update._meta)._tag === "Some"
  );
}

export const copilotSdkSteering = {
  send: (
    runtime: AcpSessionRuntime.AcpSessionRuntime["Service"],
    sessionId: string,
    text: string,
    images: ReadonlyArray<{ readonly data: string; readonly mimeType: string }>,
  ) =>
    runtime.request(COPILOT_SDK_STEER_METHOD, { sessionId, text, images }).pipe(
      Effect.flatMap((result) => {
        const messageId = stringField(record(result), "messageId");
        return messageId === undefined
          ? Effect.fail(
              new AcpErrors.AcpRequestError({
                code: -32603,
                errorMessage: "Copilot did not accept the steering message.",
                method: COPILOT_SDK_STEER_METHOD,
                data: result,
              }),
            )
          : Effect.succeed(messageId);
      }),
    ),
  acceptsAttachments: true,
  injectedSteerId: copilotSdkInjectedSteerId,
};

const FORWARDED_SESSION_EVENTS: ReadonlySet<string> = new Set([
  "assistant.message_delta",
  "assistant.reasoning_delta",
  "subagent.started",
  "subagent.completed",
  "subagent.failed",
]);

function copilotPermissionToolCall(
  request: PermissionRequest,
): AcpSchema.RequestPermissionRequest["toolCall"] {
  const input = record(request) ?? {};
  const toolCallId = stringField(input, "toolCallId") ?? `permission:${request.kind}`;
  const title = stringField(input, "intention") ?? request.kind;
  const kind: AcpSchema.ToolKind =
    request.kind === "shell"
      ? "execute"
      : request.kind === "write"
        ? "edit"
        : request.kind === "read"
          ? "read"
          : request.kind === "url"
            ? "fetch"
            : "other";
  return { toolCallId, title, kind, status: "pending", rawInput: input };
}

const PERMISSION_OPTIONS = [
  { optionId: "allow_once", kind: "allow_once", name: "Allow once" },
  { optionId: "allow_always", kind: "allow_always", name: "Always allow" },
  { optionId: "reject_once", kind: "reject_once", name: "Deny" },
] satisfies AcpSchema.RequestPermissionRequest["options"];

export function copilotPermissionDecision(
  response: AcpSchema.RequestPermissionResponse,
): PermissionRequestResult {
  if (response.outcome.outcome !== "selected") return { kind: "reject" };
  switch (response.outcome.optionId) {
    case "allow_once":
      return { kind: "approve-once" };
    case "allow_always":
      return { kind: "approve-for-session" };
    default: {
      const feedback = stringField(record(response._meta), "feedback");
      return { kind: "reject", ...(feedback === undefined ? {} : { feedback }) };
    }
  }
}

function copilotSdkConfigOptions(input: {
  readonly models: ReadonlyArray<ModelInfo>;
  readonly modeId: string;
  readonly modelId: string;
  readonly reasoningEffort: string | undefined;
  readonly allowAll: boolean;
}): ReadonlyArray<AcpSchema.SessionConfigOption> {
  const efforts =
    input.models.find((model) => model.id === input.modelId)?.supportedReasoningEfforts ?? [];
  return [
    {
      type: "select",
      id: "mode",
      name: "Mode",
      category: "mode",
      description:
        "Controls how Copilot responds: a conversational agent, planning multi-step work, or autonomous autopilot.",
      currentValue: input.modeId,
      options: ACP_MODES.map((mode) => ({
        value: mode.id,
        name: mode.name,
        description: mode.description,
      })),
    },
    {
      type: "select",
      id: "model",
      name: "Model",
      category: "model",
      description: "The AI model Copilot uses to generate responses.",
      currentValue: input.modelId,
      options: input.models.map((model) => ({ value: model.id, name: model.name })),
    },
    ...(efforts.length === 0
      ? []
      : [
          {
            type: "select" as const,
            id: "reasoning_effort",
            name: "Reasoning Effort",
            category: "thought_level",
            description:
              "How much reasoning the model performs before responding. Higher effort can improve quality at the cost of speed.",
            // Copilot often reports no level; an empty value still lets one be chosen.
            currentValue: input.reasoningEffort ?? "",
            options: efforts.map((effort) => ({
              value: effort,
              name: effort,
              ...(REASONING_DESCRIPTIONS[effort] === undefined
                ? {}
                : { description: REASONING_DESCRIPTIONS[effort] }),
            })),
          },
        ]),
    {
      type: "select",
      id: "allow_all",
      name: "Allow All",
      category: "permissions",
      description:
        "Controls whether Copilot prompts for approval before using tools, accessing paths, or fetching URLs.",
      currentValue: input.allowAll ? "on" : "off",
      options: [
        {
          value: "on",
          name: "On",
          description: "Automatically approve all tool, path, and URL requests",
        },
        {
          value: "off",
          name: "Off",
          description: "Require approval for tool, path, and URL requests",
        },
      ],
    },
  ];
}

export function copilotSdkMcpServers(
  servers: ReadonlyArray<AcpSchema.McpServer>,
): Record<string, MCPServerConfig> {
  const entries = servers.flatMap((server): ReadonlyArray<[string, MCPServerConfig]> => {
    const fields = record(server);
    const type = fields?.type;
    const name = stringField(fields, "name");
    const url = stringField(fields, "url");
    if ((type !== "http" && type !== "sse") || name === undefined || url === undefined) return [];
    const headers = Array.isArray(fields?.headers) ? fields.headers : [];
    return [
      [
        name,
        {
          type,
          url,
          headers: Object.fromEntries(
            headers.flatMap((header) => {
              const headerName = stringField(record(header), "name");
              const value = stringField(record(header), "value");
              return headerName === undefined || value === undefined ? [] : [[headerName, value]];
            }),
          ),
          tools: ["*"],
        },
      ],
    ];
  });
  return Object.fromEntries(entries);
}

function copilotSdkPrompt(prompt: ReadonlyArray<AcpSchema.ContentBlock>) {
  const text: Array<string> = [];
  const attachments: Array<{
    readonly type: "blob";
    readonly data: string;
    readonly mimeType: string;
  }> = [];
  for (const block of prompt) {
    if (block.type === "text") text.push(block.text);
    if (block.type === "image") {
      attachments.push({ type: "blob", data: block.data, mimeType: block.mimeType });
    }
    if (block.type === "resource_link") text.push(block.uri);
  }
  return {
    prompt: text.join("\n\n"),
    ...(attachments.length === 0 ? {} : { attachments }),
  };
}

/** T3 prepends its instructions to a session's first prompt; a command is what follows them. */
export function copilotSlashCommand(prompt: string) {
  const text = withoutT3Instructions(prompt);
  const match = /^\/([\w-]+)(?:\s+([\s\S]*\S))?\s*$/.exec(text);
  return match === null ? undefined : { name: match[1]!, input: match[2] };
}

function copilotCommandResultText(result: CopilotSdkCommandResult): string | undefined {
  switch (result.kind) {
    case "text":
      return result.text;
    case "completed":
      return result.message;
    case "set-plan-model":
      return result.message;
    case "select-subcommand":
      return [result.title, ...result.options.map((option) => `- ${option.name}`)].join("\n");
    case "show-dialog":
      return "Choose a model with T3 Code's model picker.";
    default:
      return undefined;
  }
}

const requestError = (method: string, cause: unknown) =>
  new AcpErrors.AcpRequestError({
    code: -32603,
    errorMessage: cause instanceof Error ? cause.message : String(cause),
    method,
    data: undefined,
  });

const unsupported = (method: string) =>
  Effect.fail(
    new AcpErrors.AcpRequestError({
      code: -32601,
      errorMessage: `Copilot's SDK transport does not support ${method}.`,
      method,
      data: undefined,
    }),
  );

interface ActivePrompt {
  readonly done: Deferred.Deferred<AcpSchema.PromptResponse, AcpErrors.AcpError>;
  steered: boolean;
}

export type CopilotSdkRuntimeOptions = Pick<
  AcpSessionRuntimeOptions,
  | "cwd"
  | "httpMcpServers"
  | "mcpServers"
  | "onIncomingRequest"
  | "onOutgoingResponse"
  | "resumeSessionId"
  | "transformSessionUpdate"
> & {
  readonly client: CopilotSdkClient;
  readonly onTermination?: (error: AcpErrors.AcpError) => Effect.Effect<void>;
};

export const makeCopilotSdkRuntime = Effect.fn("makeCopilotSdkRuntime")(function* (
  options: CopilotSdkRuntimeOptions,
) {
  const scope = yield* Scope.Scope;
  const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
  const client = options.client;
  const updates = yield* Queue.unbounded<SessionEvent>();
  const configOptions = yield* SubscriptionRef.make<ReadonlyArray<AcpSchema.SessionConfigOption>>(
    [],
  );
  const started = yield* Ref.make<AcpSessionRuntime.AcpSessionRuntimeStartResult | undefined>(
    undefined,
  );

  let session: CopilotSdkSession | undefined;
  let models: ReadonlyArray<ModelInfo> = [];
  let modeId: string = `${MODE_URL}agent`;
  let modelId = "";
  let reasoningEffort: string | undefined;
  let allowAll = false;
  let activePrompt: ActivePrompt | undefined;
  // True while the main agent works. Interrupting after it finished loses the queued message.
  let mainAgentBusy = false;
  let unsubscribe: (() => void) | undefined;
  let commands: ReadonlyArray<CopilotSdkCommand> = [];
  let promptUsage:
    | { inputTokens: number; outputTokens: number; cachedReadTokens: number }
    | undefined;

  let sessionUpdateHandler:
    | ((notification: AcpSchema.SessionNotification) => Effect.Effect<void, AcpErrors.AcpError>)
    | undefined;
  let permissionHandler:
    | Parameters<AcpSessionRuntime.AcpSessionRuntime["Service"]["handleRequestPermission"]>[0]
    | undefined;
  let elicitationHandler:
    | Parameters<AcpSessionRuntime.AcpSessionRuntime["Service"]["handleElicitation"]>[0]
    | undefined;
  const extNotificationHandlers = new Map<
    string,
    (params: unknown) => Effect.Effect<void, AcpErrors.AcpError>
  >();

  const translate = makeCopilotSdkEventTranslator();
  const requestSequence = { next: 0 };
  const nextRequestContext = (method: string) => ({
    requestId: `copilot-sdk:${requestSequence.next++}`,
    method,
  });

  const sdk = <A>(method: string, run: () => Promise<A>) =>
    Effect.tryPromise({ try: run, catch: (cause) => requestError(method, cause) });

  const publishConfig = Effect.suspend(() =>
    SubscriptionRef.set(
      configOptions,
      copilotSdkConfigOptions({ models, modeId, modelId, reasoningEffort, allowAll }),
    ),
  );

  const emit = (sessionId: string, update: AcpSchema.SessionUpdate) => {
    const notification: AcpSchema.SessionNotification = { sessionId, update };
    const handler = sessionUpdateHandler;
    return handler === undefined
      ? Effect.void
      : handler(options.transformSessionUpdate?.(notification) ?? notification);
  };

  const settlePrompt = (result: Effect.Effect<AcpSchema.PromptResponse, AcpErrors.AcpError>) => {
    const prompt = activePrompt;
    if (prompt === undefined) return Effect.void;
    activePrompt = undefined;
    return Deferred.completeWith(prompt.done, result).pipe(Effect.asVoid);
  };

  const refreshCommands = Effect.gen(function* () {
    const active = session;
    if (active === undefined) return;
    commands = yield* sdk("session/commands", () => active.commands());
    yield* emit(active.sessionId, {
      sessionUpdate: "available_commands_update",
      availableCommands: commands.map((command) => ({
        name: command.name,
        description: command.description,
        ...(command.input === undefined
          ? {}
          : { input: { type: "text" as const, hint: command.input.hint } }),
      })),
    });
  });

  const dispatch = Effect.fnUntraced(function* (event: SessionEvent) {
    const sessionId = session?.sessionId;
    if (sessionId === undefined) return;
    if (FORWARDED_SESSION_EVENTS.has(event.type)) {
      yield* (
        extNotificationHandlers.get(COPILOT_SESSION_EVENT)?.({
          sessionId,
          type: event.type,
          ...(event.agentId === undefined ? {} : { agentId: event.agentId }),
          data: event.data,
        }) ?? Effect.void
      );
    }
    for (const update of translate(event)) {
      yield* emit(sessionId, update);
    }
    if (event.type === "assistant.usage" && event.data.parentToolCallId === undefined) {
      promptUsage = {
        inputTokens: (promptUsage?.inputTokens ?? 0) + (event.data.inputTokens ?? 0),
        outputTokens: (promptUsage?.outputTokens ?? 0) + (event.data.outputTokens ?? 0),
        cachedReadTokens: (promptUsage?.cachedReadTokens ?? 0) + (event.data.cacheReadTokens ?? 0),
      };
    }
    if (event.type === "commands.changed") yield* refreshCommands.pipe(Effect.ignore);
    // Settling here keeps a turn from ending ahead of its own queued output.
    if (event.type === "session.idle") {
      const cancelled = event.data.aborted === true && activePrompt?.steered !== true;
      const usage = promptUsage;
      promptUsage = undefined;
      yield* settlePrompt(
        Effect.succeed({
          stopReason: cancelled ? "cancelled" : "end_turn",
          ...(usage === undefined
            ? {}
            : { usage: { ...usage, totalTokens: usage.inputTokens + usage.outputTokens } }),
        }),
      );
    }
    if (event.type === "session.error" && event.agentId === undefined) {
      yield* settlePrompt(
        Effect.fail(
          new AcpErrors.AcpRequestError({
            code: -32603,
            errorMessage: event.data.message,
            method: "session/prompt",
            data: { errorType: event.data.errorType },
          }),
        ),
      );
    }
  });

  yield* Queue.take(updates).pipe(
    Effect.flatMap((event) => dispatch(event).pipe(Effect.ignore)),
    Effect.forever,
    Effect.forkIn(scope),
  );

  // Runs on the SDK's delivery callback so a steer always sees the current turn state.
  const observe = (event: SessionEvent) => {
    if (event.type === "assistant.turn_start") {
      mainAgentBusy = true;
      if (activePrompt !== undefined) activePrompt.steered = false;
    }
    if (event.type === "assistant.idle" || event.type === "session.idle") mainAgentBusy = false;
    Queue.offerUnsafe(updates, event);
  };

  // The adapter holds an answer as unconfirmed until its transport reports the response sent.
  const answered = <A, E>(
    method: string,
    answer: (context: ReturnType<typeof nextRequestContext>) => Effect.Effect<A, E>,
  ) => {
    const context = nextRequestContext(method);
    return (options.onIncomingRequest?.(context.requestId, method, undefined) ?? Effect.void).pipe(
      Effect.andThen(answer(context)),
      Effect.tap(() => options.onOutgoingResponse?.(context.requestId) ?? Effect.void),
    );
  };

  const onPermissionRequest: NonNullable<SessionConfig["onPermissionRequest"]> = (request) => {
    const handler = permissionHandler;
    if (handler === undefined) return { kind: "reject" };
    return runPromise(
      answered("session/request_permission", (context) =>
        handler(
          {
            sessionId: session?.sessionId ?? "",
            toolCall: copilotPermissionToolCall(request),
            options: PERMISSION_OPTIONS,
          },
          context,
        ),
      ).pipe(
        Effect.map(copilotPermissionDecision),
        Effect.orElseSucceed((): PermissionRequestResult => ({ kind: "reject" })),
      ),
    );
  };

  const onUserInputRequest: NonNullable<SessionConfig["onUserInputRequest"]> = (request) => {
    const handler = elicitationHandler;
    if (handler === undefined) {
      return Promise.reject(new Error("T3 Code cannot answer Copilot's question."));
    }
    const choices = request.choices ?? [];
    return runPromise(
      answered("session/elicitation", (context) =>
        handler(
          {
            mode: "form",
            sessionId: session?.sessionId ?? "",
            message: request.question,
            requestedSchema: {
              type: "object",
              properties: {
                answer: {
                  type: "string",
                  title: request.question,
                  ...(choices.length === 0 ? {} : { enum: [...choices] }),
                },
              },
              required: ["answer"],
            },
          } as AcpSchema.CreateElicitationRequest,
          context,
        ),
      ),
    ).then((response) => {
      const answer = stringField(record(record(response)?.content), "answer");
      if (answer === undefined) throw new Error("The question was declined.");
      return { answer, wasFreeform: !choices.includes(answer) };
    });
  };

  const sessionConfig = (activation?: AcpSessionRuntime.AcpSessionActivationOptions) =>
    ({
      clientName: "t3-code",
      streaming: true,
      includeSubAgentStreamingEvents: true,
      enableMcpApps: true,
      // Deferred tools halved how often models found the right one, and saved no tokens per task.
      toolSearch: { enabled: false },
      workingDirectory: options.cwd,
      mcpServers: copilotSdkMcpServers([
        ...(activation?.mcpServers ?? options.mcpServers ?? []),
        ...(activation?.httpMcpServers ?? options.httpMcpServers ?? []),
      ]),
      onPermissionRequest,
      onUserInputRequest,
      // T3 owns plan approval: the plan is shown as a proposal and a later turn implements it.
      onExitPlanModeRequest: () => ({ approved: false, feedback: PLAN_DECLINED_FEEDBACK }),
    }) satisfies CopilotSdkSessionConfig;

  const adopt = Effect.fnUntraced(function* (next: CopilotSdkSession) {
    unsubscribe?.();
    session = next;
    unsubscribe = next.on(observe);
    const current = yield* sdk("session/new", () => next.currentModel());
    modelId = current.modelId ?? models[0]?.id ?? "";
    const model = models.find((candidate) => candidate.id === modelId);
    reasoningEffort = current.reasoningEffort ?? model?.defaultReasoningEffort;
    yield* publishConfig;
    yield* refreshCommands.pipe(Effect.ignore);
    const result = {
      sessionId: next.sessionId,
      initializeResult: INITIALIZE_RESULT,
      sessionSetupResult: {
        sessionId: next.sessionId,
        modes: { currentModeId: modeId, availableModes: [...ACP_MODES] },
        configOptions: [...(yield* SubscriptionRef.get(configOptions))],
      },
      modelConfigId: "model",
    } satisfies AcpSessionRuntime.AcpSessionRuntimeStartResult;
    yield* Ref.set(started, result);
    return result;
  });

  const connect = sdk("initialize", async () => {
    try {
      await client.start();
    } catch (cause) {
      throw String(cause).includes("protocol version mismatch")
        ? new Error(
            "This Copilot CLI is not compatible with T3 Code's SDK transport. Update Copilot, or set Copilot transport to ACP.",
          )
        : cause;
    }
    models = await client.listModels();
  });

  const resume = Effect.fnUntraced(function* (
    sessionId: string,
    activation?: AcpSessionRuntime.AcpSessionActivationOptions,
  ) {
    const next = yield* sdk("session/load", () =>
      client.resumeSession(sessionId, sessionConfig(activation)),
    );
    const result = yield* adopt(next);
    const replay = makeCopilotSdkEventTranslator();
    for (const event of yield* sdk("session/load", () => next.history())) {
      const message = copilotSdkHistoryMessage(event);
      if (message !== undefined) yield* emit(sessionId, message);
      for (const update of replay(event)) yield* emit(sessionId, update);
    }
    return result;
  });

  const start = Effect.fnUntraced(function* () {
    const current = yield* Ref.get(started);
    if (current !== undefined) return current;
    yield* connect;
    if (options.resumeSessionId !== undefined) return yield* resume(options.resumeSessionId);
    return yield* adopt(yield* sdk("session/new", () => client.createSession(sessionConfig())));
  });

  const requireSession = Effect.suspend(() =>
    session === undefined
      ? Effect.fail(
          new AcpErrors.AcpRequestError({
            code: -32603,
            errorMessage: "Copilot's session has not started.",
            method: "session/prompt",
            data: undefined,
          }),
        )
      : Effect.succeed(session),
  );

  const setConfigOption = Effect.fn("CopilotSdkRuntime.setConfigOption")(function* (
    configId: string,
    value: string | boolean,
    configOptionsInput?: { readonly allowUnlistedValue?: boolean },
  ) {
    const active = yield* requireSession;
    const method = "session/set_config_option";
    const text = String(value);
    switch (configId) {
      case "mode": {
        const mode = SDK_MODE_BY_ACP_MODE[text as AcpModeId];
        if (mode === undefined) return yield* unsupported(`mode ${text}`);
        yield* sdk(method, () => active.setMode(mode));
        modeId = text;
        break;
      }
      case "model":
        if (
          configOptionsInput?.allowUnlistedValue !== true &&
          !models.some((model) => model.id === text)
        ) {
          return yield* unsupported(`model ${text}`);
        }
        yield* sdk(method, () => active.switchModel(text));
        modelId = text;
        reasoningEffort = models.find((model) => model.id === text)?.defaultReasoningEffort;
        break;
      case "reasoning_effort":
        yield* sdk(method, () => active.setReasoningEffort(text));
        reasoningEffort = text;
        break;
      case "allow_all":
        yield* sdk(method, () => active.setApproveAll(text === "on"));
        allowAll = text === "on";
        break;
      default:
        return yield* unsupported(`config option ${configId}`);
    }
    yield* publishConfig;
    return { configOptions: [...(yield* SubscriptionRef.get(configOptions))] };
  });

  const forkSession = Effect.fn("CopilotSdkRuntime.forkSession")(function* (
    sessionId: string,
    activation?: AcpSessionRuntime.AcpSessionActivationOptions,
    meta?: unknown,
  ) {
    const turnEventId = stringField(record(meta), FORK_EVENT_META_KEY);
    const active = yield* requireSession;
    let boundary: string | undefined;
    if (turnEventId !== undefined) {
      // After an earlier fork the active session is that fork, not the one being forked.
      const history = yield* sdk("session/fork", () =>
        active.sessionId === sessionId ? active.history() : client.sessionHistory(sessionId),
      );
      if (!history.some((event) => event.id === turnEventId)) {
        return yield* new AcpErrors.AcpRequestError({
          code: -32603,
          errorMessage: `Copilot session ${sessionId} has no turn ${turnEventId}.`,
          method: "session/fork",
        });
      }
      boundary = copilotSdkForkBoundary(history, turnEventId);
    }
    const forked = yield* sdk("session/fork", () => client.fork(sessionId, boundary));
    return yield* resume(forked, activation);
  });

  const steer = Effect.fnUntraced(function* (payload: unknown) {
    const text = stringField(record(payload), "text");
    if (text === undefined) return yield* unsupported(COPILOT_SDK_STEER_METHOD);
    const active = yield* requireSession;
    const images = record(payload)?.images;
    const attachments = (Array.isArray(images) ? images : []).flatMap((image) => {
      const data = stringField(record(image), "data");
      const mimeType = stringField(record(image), "mimeType");
      return data === undefined || mimeType === undefined
        ? []
        : [{ type: "blob" as const, data, mimeType }];
    });
    const messageId = yield* sdk(COPILOT_SDK_STEER_METHOD, () =>
      active.send({ prompt: text, ...(attachments.length === 0 ? {} : { attachments }) }),
    );
    // Only an interrupt that lands on a working main agent flushes the queue.
    if (mainAgentBusy) {
      // The interrupt's abort belongs to the steer, not to a user cancelling the prompt.
      if (activePrompt !== undefined) activePrompt.steered = true;
      yield* sdk(COPILOT_SDK_STEER_METHOD, () => active.interruptMainTurn(true));
    }
    return { messageId };
  });

  const compact = Effect.gen(function* () {
    const active = yield* requireSession;
    const result = yield* sdk(COPILOT_SDK_COMPACT_METHOD, () => active.compact());
    if (!result.success) {
      return yield* requestError(
        COPILOT_SDK_COMPACT_METHOD,
        "Copilot could not compact the conversation.",
      );
    }
    return result;
  });

  const rollback = Effect.fnUntraced(function* (payload: unknown) {
    const turnEventId = stringField(record(payload), "turnEventId");
    if (turnEventId === undefined) return yield* unsupported(COPILOT_SDK_ROLLBACK_METHOD);
    const active = yield* requireSession;
    const history = yield* sdk(COPILOT_SDK_ROLLBACK_METHOD, () => active.history());
    if (!history.some((event) => event.id === turnEventId)) {
      return yield* new AcpErrors.AcpRequestError({
        code: -32603,
        errorMessage: `Copilot session ${active.sessionId} has no turn ${turnEventId}.`,
        method: COPILOT_SDK_ROLLBACK_METHOD,
      });
    }
    const boundary = copilotSdkForkBoundary(history, turnEventId);
    // No later user message means the session already ends at this turn.
    if (boundary !== undefined) {
      yield* sdk(COPILOT_SDK_ROLLBACK_METHOD, () => active.truncate(boundary));
    }
    return {};
  });

  const mcpApp = Effect.fnUntraced(function* (payload: unknown) {
    const request = payload as CopilotSdkMcpAppRequest;
    const active = yield* requireSession;
    return yield* sdk(COPILOT_SDK_MCP_APP_METHOD, async (): Promise<unknown> => {
      switch (request.operation) {
        case "listTools":
          return await active.mcpAppTools(request.server);
        case "callTool":
          return await active.callMcpAppTool(request);
        case "readResource":
          return await active.readMcpAppResource(request.server, request.uri);
      }
    });
  });

  const stopTask = Effect.fnUntraced(function* (payload: unknown) {
    const taskId = stringField(record(payload), "taskId");
    if (taskId === undefined) return yield* unsupported(COPILOT_SDK_STOP_TASK_METHOD);
    const active = yield* requireSession;
    const cancelled = yield* sdk(COPILOT_SDK_STOP_TASK_METHOD, () => active.cancelTask(taskId));
    if (!cancelled) {
      return yield* requestError(
        COPILOT_SDK_STOP_TASK_METHOD,
        `Copilot has no running task for ${taskId}.`,
      );
    }
    return {};
  });

  const watchConnection = (prompt: ActivePrompt) =>
    Effect.sleep(CONNECTION_WATCHDOG_INTERVAL).pipe(
      Effect.andThen(
        sdk("session/prompt", () => client.ping()).pipe(
          Effect.timeoutOrElse({
            duration: CONNECTION_PING_TIMEOUT,
            orElse: () =>
              Effect.fail(
                new AcpErrors.AcpRequestError({
                  code: -32603,
                  errorMessage: "Copilot stopped responding.",
                  method: "session/prompt",
                }),
              ),
          }),
        ),
      ),
      Effect.forever,
      Effect.catch((error) =>
        // Settling ends the prompt, and with it this fiber: termination has to finish first.
        Effect.uninterruptible(
          (options.onTermination?.(error) ?? Effect.void).pipe(
            Effect.andThen(
              Effect.suspend(() =>
                activePrompt === prompt ? settlePrompt(Effect.fail(error)) : Effect.void,
              ),
            ),
          ),
        ),
      ),
    );

  const prompt = Effect.fn("CopilotSdkRuntime.prompt")(function* (
    payload: Omit<AcpSchema.PromptRequest, "sessionId">,
    promptOptions?: { readonly dispatched?: Deferred.Deferred<void> },
  ) {
    const active = yield* requireSession;
    const message = copilotSdkPrompt(payload.prompt);
    const slash = copilotSlashCommand(message.prompt);
    let outgoing = message;
    // `send` drops a slash command silently, so a known command goes through `invoke`.
    if (slash !== undefined && commands.some((command) => command.name === slash.name)) {
      const result = yield* sdk("session/prompt", () =>
        active.invokeCommand(slash.name, slash.input),
      );
      if (result.kind !== "agent-prompt") {
        if (result.kind === "set-model") yield* setConfigOption("model", result.model);
        const text = copilotCommandResultText(result);
        if (text !== undefined) {
          yield* emit(active.sessionId, {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text },
          }).pipe(Effect.ignore);
        }
        if (promptOptions?.dispatched !== undefined) {
          yield* Deferred.succeed(promptOptions.dispatched, undefined);
        }
        return { stopReason: "end_turn" } satisfies AcpSchema.PromptResponse;
      }
      outgoing = { ...message, prompt: result.prompt };
    }
    const done = yield* Deferred.make<AcpSchema.PromptResponse, AcpErrors.AcpError>();
    const current: ActivePrompt = { done, steered: false };
    activePrompt = current;
    mainAgentBusy = true;
    promptUsage = undefined;
    const watchdog = yield* watchConnection(current).pipe(Effect.forkChild);
    return yield* Effect.gen(function* () {
      yield* sdk("session/prompt", () => active.send(outgoing));
      if (promptOptions?.dispatched !== undefined) {
        yield* Deferred.succeed(promptOptions.dispatched, undefined);
      }
      return yield* Deferred.await(done);
    }).pipe(Effect.ensuring(Fiber.interrupt(watchdog)));
  });

  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      unsubscribe?.();
      yield* sdk("session/close", () => client.stop()).pipe(
        Effect.timeout(STOP_TIMEOUT),
        Effect.catch(() => sdk("session/close", () => client.forceStop()).pipe(Effect.ignore)),
      );
    }),
  );

  const ignoreHandler = () => Effect.void;

  return {
    handleRequestPermission: (handler) =>
      Effect.sync(() => {
        permissionHandler = handler;
      }),
    handleElicitation: (handler) =>
      Effect.sync(() => {
        elicitationHandler = handler;
      }),
    handleSessionUpdate: (handler) =>
      Effect.sync(() => {
        sessionUpdateHandler = handler;
      }),
    handleExtNotification: (method, payload, handler) =>
      Effect.sync(() => {
        const decode = Schema.decodeUnknownEffect(payload);
        extNotificationHandlers.set(method, (params) =>
          decode(params).pipe(
            Effect.option,
            Effect.flatMap((decoded) =>
              decoded._tag === "Some" ? handler(decoded.value) : Effect.void,
            ),
          ),
        );
      }),
    handleMcpConnect: ignoreHandler,
    handleMcpMessage: ignoreHandler,
    handleMcpDisconnect: ignoreHandler,
    handleMcpNotification: ignoreHandler,
    handleReadTextFile: ignoreHandler,
    handleWriteTextFile: ignoreHandler,
    handleCreateTerminal: ignoreHandler,
    handleTerminalOutput: ignoreHandler,
    handleTerminalWaitForExit: ignoreHandler,
    handleTerminalKill: ignoreHandler,
    handleTerminalRelease: ignoreHandler,
    handleElicitationComplete: ignoreHandler,
    handleUnknownExtRequest: ignoreHandler,
    handleUnknownExtNotification: ignoreHandler,
    handleExtRequest: ignoreHandler,
    initialize: () => Effect.succeed(INITIALIZE_RESULT),
    start,
    getEvents: () => Stream.empty,
    drainEvents: Effect.void,
    getModeState: Effect.sync(() => ({
      currentModeId: modeId,
      availableModes: ACP_MODES.map((mode) => ({ ...mode })),
    })),
    getConfigOptions: SubscriptionRef.get(configOptions),
    configOptionChanges: SubscriptionRef.changes(configOptions),
    loadSession: (sessionId, activation) =>
      connect.pipe(Effect.andThen(resume(sessionId, activation))),
    resumeSession: (sessionId, activation) =>
      connect.pipe(Effect.andThen(resume(sessionId, activation))),
    forkSession,
    listSessions: () => unsupported("session/list"),
    closeSession: () =>
      requireSession.pipe(
        Effect.flatMap((active) => sdk("session/close", () => active.disconnect())),
        Effect.as({}),
      ),
    deleteSession: () => unsupported("session/delete"),
    listProviders: unsupported("providers/list"),
    setProvider: () => unsupported("providers/set"),
    disableProvider: () => unsupported("providers/disable"),
    logout: unsupported("logout"),
    prompt,
    cancel: requireSession.pipe(
      Effect.flatMap((active) => sdk("session/cancel", () => active.abort())),
    ),
    setMode: (nextModeId) => setConfigOption("mode", nextModeId).pipe(Effect.as({})),
    setSessionModel: (nextModelId) => setConfigOption("model", nextModelId).pipe(Effect.as({})),
    setConfigOption,
    setModel: (nextModelId) => setConfigOption("model", nextModelId).pipe(Effect.asVoid),
    request: (method, payload) =>
      method === COPILOT_SDK_STEER_METHOD
        ? steer(payload)
        : method === COPILOT_SDK_COMPACT_METHOD
          ? compact
          : method === COPILOT_SDK_STOP_TASK_METHOD
            ? stopTask(payload)
            : method === COPILOT_SDK_ROLLBACK_METHOD
              ? rollback(payload)
              : method === COPILOT_SDK_MCP_APP_METHOD
                ? mcpApp(payload)
                : unsupported(method),
    notify: (method) => unsupported(method),
  } satisfies AcpSessionRuntime.AcpSessionRuntime["Service"];
});
