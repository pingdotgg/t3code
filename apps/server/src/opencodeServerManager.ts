import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";

import {
  ApprovalRequestId,
  EventId,
  RuntimeItemId,
  RuntimeRequestId,
  ThreadId,
  TurnId,
  type CanonicalRequestType,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
  type ProviderSendTurnInput,
  type ProviderSession,
  type ProviderSessionStartInput,
  type ProviderTurnStartResult,
  type ProviderUserInputAnswers,
} from "@t3tools/contracts";
import type { ProviderThreadSnapshot } from "./provider/Services/ProviderAdapter.ts";

const PROVIDER = "opencode" as const;
const DEFAULT_HOSTNAME = "127.0.0.1";
const DEFAULT_PORT = 6733;
const SERVER_START_TIMEOUT_MS = 5000;
const SERVER_PROBE_TIMEOUT_MS = 1500;

type OpenCodeProviderOptions = {
  readonly serverUrl?: string;
  readonly binaryPath?: string;
  readonly hostname?: string;
  readonly port?: number;
  readonly workspace?: string;
  readonly username?: string;
  readonly password?: string;
};

type OpenCodeSessionStartInput = ProviderSessionStartInput & {
  readonly providerOptions?: ProviderSessionStartInput["providerOptions"] & {
    readonly opencode?: OpenCodeProviderOptions;
  };
};

type OpenCodeSendTurnInput = ProviderSendTurnInput & {
  readonly modelOptions?: ProviderSendTurnInput["modelOptions"] & {
    readonly opencode?: {
      readonly providerId?: string;
      readonly modelId?: string;
      readonly variant?: string;
      readonly reasoningEffort?: string;
      readonly agent?: string;
    };
  };
};

type OpenCodeRuntimeRawSource =
  | "opencode.server.event"
  | "opencode.server.permission"
  | "opencode.server.question";

type OpenCodeProviderRuntimeEvent = Omit<ProviderRuntimeEvent, "provider" | "raw"> & {
  readonly provider: ProviderRuntimeEvent["provider"] | "opencode";
  readonly raw?: {
    readonly source: OpenCodeRuntimeRawSource;
    readonly method?: string;
    readonly messageType?: string;
    readonly payload: unknown;
  };
};

type OpenCodeProviderSession = Omit<ProviderSession, "provider"> & {
  readonly provider: ProviderSession["provider"] | "opencode";
};

type OpenCodeModel = {
  readonly id: string;
  readonly name: string;
  readonly variants?: Readonly<Record<string, unknown>>;
};

type OpenCodeListedProvider = {
  readonly id: string;
  readonly name?: string;
  readonly models: Readonly<Record<string, OpenCodeModel>>;
};

type ProviderListResponse = {
  readonly all: ReadonlyArray<OpenCodeListedProvider>;
  readonly connected: ReadonlyArray<string>;
};

type OpenCodeConfiguredProvider = {
  readonly id: string;
  readonly name?: string;
  readonly models: Readonly<Record<string, OpenCodeModel>>;
};

type ConfigProvidersResponse = {
  readonly providers: ReadonlyArray<OpenCodeConfiguredProvider>;
};

type QuestionInfo = {
  readonly header: string;
  readonly question: string;
  readonly options: ReadonlyArray<{
    readonly label: string;
    readonly description: string;
  }>;
};

type OpenCodeTodo = {
  readonly content: string;
  readonly status: "completed" | "in_progress" | string;
};

type OpenCodeToolState =
  | {
      readonly status: "pending";
    }
  | {
      readonly status: "running";
      readonly title: string;
      readonly metadata?: Record<string, unknown>;
    }
  | {
      readonly status: "completed";
      readonly title: string;
      readonly output?: string;
      readonly metadata?: Record<string, unknown>;
    }
  | {
      readonly status: "error";
      readonly error: string;
      readonly metadata?: Record<string, unknown>;
    };

type OpenCodeToolPart = {
  readonly id: string;
  readonly sessionID: string;
  readonly type: "tool";
  readonly tool?: string;
  readonly state: OpenCodeToolState;
};

type OpenCodeMessagePart =
  | {
      readonly id: string;
      readonly sessionID: string;
      readonly type: "text";
    }
  | {
      readonly id: string;
      readonly sessionID: string;
      readonly type: "reasoning";
    }
  | OpenCodeToolPart;

type EventSessionStatus = {
  readonly type: "session.status";
  readonly properties: {
    readonly sessionID: string;
    readonly status: {
      readonly type: "busy" | "retry" | "idle" | string;
    };
  };
};

type EventSessionError = {
  readonly type: "session.error";
  readonly properties: {
    readonly sessionID?: string;
    readonly error?:
      | {
          readonly name:
            | "ProviderAuthError"
            | "UnknownError"
            | "MessageAbortedError"
            | "StructuredOutputError"
            | "ContextOverflowError"
            | "APIError";
          readonly data: {
            readonly message: string;
          };
        }
      | {
          readonly name: "MessageOutputLengthError";
          readonly data?: Record<string, unknown>;
        }
      | {
          readonly name: string;
          readonly data?: {
            readonly message?: string;
          };
        };
  };
};

type EventPermissionAsked = {
  readonly type: "permission.asked";
  readonly properties: {
    readonly id: string;
    readonly sessionID: string;
    readonly permission?: string;
  };
};

type EventPermissionReplied = {
  readonly type: "permission.replied";
  readonly properties: {
    readonly requestID: string;
    readonly sessionID: string;
    readonly reply: string;
  };
};

type EventQuestionAsked = {
  readonly type: "question.asked";
  readonly properties: {
    readonly id: string;
    readonly sessionID: string;
    readonly questions: ReadonlyArray<QuestionInfo>;
  };
};

type EventQuestionReplied = {
  readonly type: "question.replied";
  readonly properties: {
    readonly requestID: string;
    readonly sessionID: string;
    readonly answers: ReadonlyArray<ReadonlyArray<string>>;
  };
};

type EventQuestionRejected = {
  readonly type: "question.rejected";
  readonly properties: {
    readonly requestID: string;
    readonly sessionID: string;
  };
};

type EventMessagePartUpdated = {
  readonly type: "message.part.updated";
  readonly properties: {
    readonly part: OpenCodeMessagePart;
  };
};

type EventMessagePartDelta = {
  readonly type: "message.part.delta";
  readonly properties: {
    readonly sessionID: string;
    readonly partID: string;
    readonly delta: string;
  };
};

type EventTodoUpdated = {
  readonly type: "todo.updated";
  readonly properties: {
    readonly sessionID: string;
    readonly todos: ReadonlyArray<OpenCodeTodo>;
  };
};

type EventSessionIdle = {
  readonly type: "session.idle";
  readonly properties: {
    readonly sessionID: string;
  };
};

type OpenCodeFileDiff = {
  readonly file: string;
  readonly before: string;
  readonly after: string;
  readonly additions: number;
  readonly deletions: number;
};

type EventSessionDiff = {
  readonly type: "session.diff";
  readonly properties: {
    readonly sessionID: string;
    readonly diff: ReadonlyArray<OpenCodeFileDiff>;
  };
};

type OpenCodeEvent =
  | EventSessionStatus
  | EventSessionError
  | EventSessionIdle
  | EventSessionDiff
  | EventPermissionAsked
  | EventPermissionReplied
  | EventQuestionAsked
  | EventQuestionReplied
  | EventQuestionRejected
  | EventMessagePartUpdated
  | EventMessagePartDelta
  | EventTodoUpdated;

type OpenCodeDataResponse<T> =
  | T
  | {
      readonly data: T;
      readonly error?: undefined;
    }
  | {
      readonly data?: undefined;
      readonly error: unknown;
    };

type OpencodeClientConfig = {
  readonly baseUrl: string;
  readonly directory?: string;
  readonly responseStyle?: "data" | string;
  readonly throwOnError?: boolean;
  readonly headers?: Record<string, string>;
};

type OpencodeClient = {
  readonly session: {
    readonly get: (input: {
      readonly sessionID: string;
      readonly workspace?: string;
    }) => Promise<unknown>;
    readonly create: (input: {
      readonly workspace?: string;
      readonly title: string;
    }) => Promise<unknown>;
    readonly promptAsync: (input: {
      readonly sessionID: string;
      readonly workspace?: string;
      readonly model?: {
        readonly providerID: string;
        readonly modelID: string;
      };
      readonly agent?: string;
      readonly variant?: string;
      readonly parts: ReadonlyArray<{
        readonly type: "text";
        readonly text: string;
      }>;
    }) => Promise<unknown>;
    readonly abort: (input: {
      readonly sessionID: string;
      readonly workspace?: string;
    }) => Promise<unknown>;
    readonly messages: (input: {
      readonly sessionID: string;
      readonly workspace?: string;
    }) => Promise<ReadonlyArray<unknown>>;
  };
  readonly permission: {
    readonly reply: (input: {
      readonly requestID: string;
      readonly workspace?: string;
      readonly reply: "once" | "always" | "reject";
    }) => Promise<unknown>;
  };
  readonly question: {
    readonly reply: (input: {
      readonly requestID: string;
      readonly workspace?: string;
      readonly answers: ReadonlyArray<ReadonlyArray<string>>;
    }) => Promise<unknown>;
  };
  readonly provider: {
    readonly list: (input: {
      readonly workspace?: string;
    }) => Promise<OpenCodeDataResponse<ProviderListResponse>>;
  };
  readonly config: {
    readonly providers: (input: {
      readonly workspace?: string;
    }) => Promise<OpenCodeDataResponse<ConfigProvidersResponse>>;
  };
  readonly event: {
    readonly subscribe: (
      input: {
        readonly workspace?: string;
      },
      options: {
        readonly signal?: AbortSignal;
      },
    ) => Promise<{
      readonly stream: AsyncIterable<OpenCodeEvent>;
    }>;
  };
};

type OpenCodeSdkModule = {
  createOpencodeClient(options: OpencodeClientOptions): OpencodeClient;
};

type OpencodeClientOptions = OpencodeClientConfig & {
  directory?: string;
};
type OpenCodeModelDiscoveryOptions = OpenCodeProviderOptions & {
  directory?: string;
};
type OpenCodeDiscoveredModel = {
  slug: string;
  name: string;
  variants?: ReadonlyArray<string>;
};

interface OpenCodeManagerEvents {
  event: [ProviderRuntimeEvent];
}

interface PendingPermissionRequest {
  readonly requestId: ApprovalRequestId;
  readonly requestType: CanonicalRequestType;
}

interface PendingQuestionRequest {
  readonly requestId: ApprovalRequestId;
  readonly questionIds: ReadonlyArray<string>;
  readonly questions: ReadonlyArray<{
    readonly answerIndex: number;
    readonly id: string;
    readonly header: string;
    readonly question: string;
    readonly options: ReadonlyArray<{
      readonly label: string;
      readonly description: string;
    }>;
  }>;
}

interface PartStreamState {
  readonly kind: "text" | "reasoning" | "tool";
  readonly streamKind?: "assistant_text" | "reasoning_text";
}

interface OpenCodeSessionContext {
  readonly threadId: ThreadId;
  readonly directory: string;
  readonly workspace?: string;
  readonly client: OpencodeClient;
  readonly providerSessionId: string;
  readonly pendingPermissions: Map<string, PendingPermissionRequest>;
  readonly pendingQuestions: Map<string, PendingQuestionRequest>;
  readonly partStreamById: Map<string, PartStreamState>;
  readonly streamAbortController: AbortController;
  streamTask: Promise<void>;
  session: OpenCodeProviderSession;
  activeTurnId: TurnId | undefined;
  lastError: string | undefined;
}

interface SharedServerState {
  readonly baseUrl: string;
  readonly authHeader?: string;
  readonly child?: {
    kill: () => boolean;
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function eventId(prefix: string): EventId {
  return EventId.makeUnsafe(`${prefix}:${randomUUID()}`);
}

function nowIso(): string {
  return new Date().toISOString();
}

function buildAuthHeader(username?: string, password?: string): string | undefined {
  if (!password) {
    return undefined;
  }
  const resolvedUsername = username && username.length > 0 ? username : "opencode";
  return `Basic ${Buffer.from(`${resolvedUsername}:${password}`).toString("base64")}`;
}

function parseServerUrl(output: string): string | undefined {
  const match = output.match(/opencode server listening on\s+(https?:\/\/[^\s]+)(?=\r?\n)/);
  return match?.[1];
}

async function probeServer(baseUrl: string, authHeader?: string): Promise<boolean> {
  const response = await fetch(`${baseUrl}/global/health`, {
    method: "GET",
    ...(authHeader ? { headers: { Authorization: authHeader } } : {}),
    signal: AbortSignal.timeout(SERVER_PROBE_TIMEOUT_MS),
  }).catch(() => undefined);
  return response?.ok === true;
}

function readResumeSessionId(resumeCursor: unknown): string | undefined {
  const record = asRecord(resumeCursor);
  return asString(record?.sessionId);
}

function parseOpencodeModel(model: string | undefined):
  | {
      providerId: string;
      modelId: string;
      variant?: string;
    }
  | undefined {
  const value = asString(model);
  if (!value) {
    return undefined;
  }
  const index = value.indexOf("/");
  if (index < 1 || index >= value.length - 1) {
    return undefined;
  }
  const providerId = value.slice(0, index);
  const modelAndVariant = value.slice(index + 1);
  const variantIndex = modelAndVariant.lastIndexOf("#");
  const modelId = variantIndex >= 1 ? modelAndVariant.slice(0, variantIndex) : modelAndVariant;
  const variant =
    variantIndex >= 1 && variantIndex < modelAndVariant.length - 1
      ? modelAndVariant.slice(variantIndex + 1)
      : undefined;
  return {
    providerId,
    modelId,
    ...(variant ? { variant } : {}),
  };
}

const PREFERRED_VARIANT_ORDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

function compareOpenCodeVariantNames(left: string, right: string): number {
  const leftIndex = PREFERRED_VARIANT_ORDER.indexOf(left as (typeof PREFERRED_VARIANT_ORDER)[number]);
  const rightIndex = PREFERRED_VARIANT_ORDER.indexOf(right as (typeof PREFERRED_VARIANT_ORDER)[number]);
  if (leftIndex >= 0 || rightIndex >= 0) {
    if (leftIndex < 0) return 1;
    if (rightIndex < 0) return -1;
    if (leftIndex !== rightIndex) return leftIndex - rightIndex;
  }
  return left.localeCompare(right);
}

function modelOptionsFromProvider(
  providerId: string,
  providerName: string,
  model: OpenCodeModel,
): ReadonlyArray<OpenCodeDiscoveredModel> {
  const variantNames = Object.keys(model.variants ?? {})
    .filter((variant) => variant.length > 0)
    .toSorted(compareOpenCodeVariantNames);
  return [
    {
    slug: `${providerId}/${model.id}`,
    name: `${providerName} / ${model.name}`,
      ...(variantNames.length > 0 ? { variants: variantNames } : {}),
    },
  ];
}

function parseProviderModels(
  providers: ReadonlyArray<
    Pick<OpenCodeListedProvider, "id" | "name" | "models"> | OpenCodeConfiguredProvider
  >,
): ReadonlyArray<OpenCodeDiscoveredModel> {
  return providers.flatMap((provider) => {
    const providerName = provider.name || provider.id;
    return Object.values(provider.models).flatMap((model) =>
      modelOptionsFromProvider(provider.id, providerName, model),
    );
  });
}

function toOpencodeRequestType(permission: string | undefined): CanonicalRequestType {
  switch (permission) {
    case "bash":
      return "exec_command_approval";
    case "edit":
    case "write":
      return "file_change_approval";
    case "read":
    case "glob":
    case "grep":
    case "list":
    case "codesearch":
    case "lsp":
    case "external_directory":
      return "file_read_approval";
    default:
      return "unknown";
  }
}

function toPermissionReply(decision: ProviderApprovalDecision): "once" | "always" | "reject" {
  switch (decision) {
    case "acceptForSession":
      return "always";
    case "accept":
      return "once";
    case "decline":
    case "cancel":
      return "reject";
  }
}

function createTurnId(): TurnId {
  return TurnId.makeUnsafe(`turn:${randomUUID()}`);
}

function textPart(text: string) {
  return {
    type: "text" as const,
    text,
  };
}

function readMetadataString(
  metadata: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = metadata?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function sessionErrorMessage(error: EventSessionError["properties"]["error"]): string | undefined {
  if (!error) {
    return undefined;
  }

  switch (error.name) {
    case "ProviderAuthError":
    case "UnknownError":
    case "MessageAbortedError":
    case "StructuredOutputError":
    case "ContextOverflowError":
    case "APIError":
      return error.data?.message;
    case "MessageOutputLengthError":
      return "OpenCode response exceeded output length";
  }
}

function toolStateTitle(state: OpenCodeToolState): string | undefined {
  switch (state.status) {
    case "pending":
      return undefined;
    case "running":
    case "completed":
      return state.title;
    case "error":
      return readMetadataString(state.metadata, "title");
  }
}

function toolStateDetail(state: OpenCodeToolState): string | undefined {
  switch (state.status) {
    case "pending":
      return undefined;
    case "running":
      return readMetadataString(state.metadata, "summary") ?? state.title;
    case "completed":
      return readMetadataString(state.metadata, "summary") ?? state.output;
    case "error":
      return state.error;
  }
}

function toPlanStepStatus(status: OpenCodeTodo["status"]): "pending" | "inProgress" | "completed" {
  switch (status) {
    case "completed":
      return "completed";
    case "in_progress":
      return "inProgress";
    default:
      return "pending";
  }
}

function toToolItemType(toolName: string | undefined):
  | "command_execution"
  | "file_change"
  | "web_search"
  | "collab_agent_tool_call"
  | "dynamic_tool_call" {
  switch (toolName) {
    case "bash":
      return "command_execution";
    case "write":
    case "edit":
    case "apply_patch":
      return "file_change";
    case "webfetch":
      return "web_search";
    case "task":
      return "collab_agent_tool_call";
    default:
      return "dynamic_tool_call";
  }
}

function toToolTitle(toolName: string | undefined): string {
  const value = asString(toolName) ?? "tool";
  return value.slice(0, 1).toUpperCase() + value.slice(1);
}

function toToolLifecycleEventType(
  previous: PartStreamState | undefined,
  status: OpenCodeToolState["status"],
): "item.started" | "item.updated" | "item.completed" {
  if (status === "completed" || status === "error") {
    return "item.completed";
  }
  return previous?.kind === "tool" ? "item.updated" : "item.started";
}

async function readJsonData<T>(promise: Promise<T>): Promise<T> {
  return promise;
}

function readProviderListResponse(
  value:
    | ProviderListResponse
    | { data: ProviderListResponse; error?: undefined }
    | { data?: undefined; error: unknown },
): ProviderListResponse {
  if ("all" in value && "connected" in value) {
    return value;
  }
  if (value.data !== undefined) {
    return value.data;
  }
  throw new Error("OpenCode SDK returned an empty provider list response");
}

function readConfigProvidersResponse(
  value:
    | ConfigProvidersResponse
    | { data: ConfigProvidersResponse; error?: undefined }
    | { data?: undefined; error: unknown },
): ConfigProvidersResponse {
  if ("providers" in value) {
    return value;
  }
  if (value.data !== undefined) {
    return value.data;
  }
  throw new Error("OpenCode SDK returned an empty config providers response");
}

function stripTransientSessionFields(session: OpenCodeProviderSession) {
  const { activeTurnId: _activeTurnId, lastError: _lastError, ...rest } = session;
  return rest;
}

export class OpenCodeServerManager extends EventEmitter<OpenCodeManagerEvents> {
  private readonly sessions = new Map<ThreadId, OpenCodeSessionContext>();
  private serverPromise: Promise<SharedServerState> | undefined;
  private server: SharedServerState | undefined;

  listSessions(): ReadonlyArray<ProviderSession> {
    return [...this.sessions.values()].map((entry) => entry.session as ProviderSession);
  }

  hasSession(threadId: ThreadId): boolean {
    return this.sessions.has(threadId);
  }

  async startSession(input: ProviderSessionStartInput): Promise<ProviderSession> {
    const openCodeInput = input as OpenCodeSessionStartInput;
    const existing = this.sessions.get(input.threadId);
    if (existing) {
      return existing.session as ProviderSession;
    }

    const directory = openCodeInput.cwd ?? process.cwd();
    const options = openCodeInput.providerOptions?.opencode;
    const workspace = options?.workspace;
    const sharedServer = await this.ensureServer(options);
    const client = await this.createClient({
      baseUrl: sharedServer.baseUrl,
      directory,
      responseStyle: "data",
      throwOnError: true,
      ...(sharedServer.authHeader
        ? {
            headers: {
              Authorization: sharedServer.authHeader,
            },
          }
        : {}),
    });

    const resumedSessionId = readResumeSessionId(openCodeInput.resumeCursor);
    const resumedSession = resumedSessionId
      ? await readJsonData(
          client.session.get({
            sessionID: resumedSessionId,
            ...(workspace ? { workspace } : {}),
          }),
        ).catch(() => undefined)
      : undefined;

    const createdSession =
      resumedSession ??
      (await readJsonData(
        client.session.create({
          ...(workspace ? { workspace } : {}),
          title: `T3 thread ${input.threadId}`,
        }),
      ));

    const createdAt = nowIso();
    const providerSessionId = asString(asRecord(createdSession)?.id);
    if (!providerSessionId) {
      throw new Error("OpenCode session creation did not return a session id");
    }

    const initialSession: OpenCodeProviderSession = {
      provider: PROVIDER,
      status: "ready",
      runtimeMode: openCodeInput.runtimeMode,
      ...(directory ? { cwd: directory } : {}),
      ...(openCodeInput.model ? { model: openCodeInput.model } : {}),
      threadId: openCodeInput.threadId,
      resumeCursor: {
        sessionId: providerSessionId,
        ...(workspace ? { workspace } : {}),
      },
      createdAt,
      updatedAt: createdAt,
    };

    const streamAbortController = new AbortController();
    const context: OpenCodeSessionContext = {
      threadId: openCodeInput.threadId,
      directory,
      ...(workspace ? { workspace } : {}),
      client,
      providerSessionId,
      pendingPermissions: new Map(),
      pendingQuestions: new Map(),
      partStreamById: new Map(),
      streamAbortController,
      streamTask: Promise.resolve(),
      session: initialSession,
      activeTurnId: undefined,
      lastError: undefined,
    };

    context.streamTask = this.startStream(context);
    this.sessions.set(openCodeInput.threadId, context);

    this.emitRuntimeEvent({
      type: "session.started",
      eventId: eventId("opencode-session-started"),
      provider: PROVIDER,
      threadId: openCodeInput.threadId,
      createdAt,
      payload: {
        message: resumedSession
          ? "Reattached to existing OpenCode session"
          : "Started OpenCode session",
        resume: initialSession.resumeCursor,
      },
      providerRefs: {
        providerTurnId: providerSessionId,
      },
      raw: {
        source: "opencode.server.event",
        method: resumedSession ? "session.get" : "session.create",
        payload: createdSession,
      },
    });

    this.emitRuntimeEvent({
      type: "thread.started",
      eventId: eventId("opencode-thread-started"),
      provider: PROVIDER,
      threadId: openCodeInput.threadId,
      createdAt,
      payload: {
        providerThreadId: providerSessionId,
      },
      providerRefs: {
        providerTurnId: providerSessionId,
      },
    });

    return initialSession as ProviderSession;
  }

  async sendTurn(input: ProviderSendTurnInput): Promise<ProviderTurnStartResult> {
    const openCodeInput = input as OpenCodeSendTurnInput;
    const context = this.requireSession(input.threadId);
    const turnId = createTurnId();
    const agent =
      openCodeInput.modelOptions?.opencode?.agent ??
      (openCodeInput.interactionMode === "plan" ? "plan" : undefined);
    const parsedModel = parseOpencodeModel(openCodeInput.model);
    const providerId = openCodeInput.modelOptions?.opencode?.providerId ?? parsedModel?.providerId;
    const modelId =
      openCodeInput.modelOptions?.opencode?.modelId ?? parsedModel?.modelId ?? openCodeInput.model;
    const variant =
      openCodeInput.modelOptions?.opencode?.variant ??
      openCodeInput.modelOptions?.opencode?.reasoningEffort ??
      parsedModel?.variant;
    const startedAt = nowIso();

    context.activeTurnId = turnId;
    context.lastError = undefined;
    context.session = {
      ...stripTransientSessionFields(context.session),
      status: "running",
      ...(openCodeInput.model ? { model: openCodeInput.model } : {}),
      activeTurnId: turnId,
      updatedAt: startedAt,
    };

    this.emitRuntimeEvent({
      type: "turn.started",
      eventId: eventId("opencode-turn-started"),
      provider: PROVIDER,
      threadId: openCodeInput.threadId,
      createdAt: startedAt,
      turnId,
      payload: openCodeInput.model ? { model: openCodeInput.model } : {},
    });

    this.emitRuntimeEvent({
      type: "session.state.changed",
      eventId: eventId("opencode-session-running"),
      provider: PROVIDER,
      threadId: openCodeInput.threadId,
      createdAt: startedAt,
      turnId,
      payload: {
        state: "running",
      },
    });

    try {
      await readJsonData(
        context.client.session.promptAsync({
          sessionID: context.providerSessionId,
          ...(context.workspace ? { workspace: context.workspace } : {}),
          ...(providerId && modelId
            ? {
                model: {
                  providerID: providerId,
                  modelID: modelId,
                },
              }
            : {}),
          ...(agent ? { agent } : {}),
          ...(variant ? { variant } : {}),
          parts: [textPart(openCodeInput.input ?? "")],
        }),
      );
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "OpenCode failed to start turn";
      context.activeTurnId = undefined;
      context.lastError = message;
      context.session = {
        ...stripTransientSessionFields(context.session),
        status: "error",
        updatedAt: nowIso(),
        lastError: message,
      };
      this.emitRuntimeEvent({
        type: "runtime.error",
        eventId: eventId("opencode-turn-start-error"),
        provider: PROVIDER,
        threadId: openCodeInput.threadId,
        createdAt: nowIso(),
        turnId,
        payload: {
          message,
          class: "provider_error",
        },
      });
      this.emitRuntimeEvent({
        type: "session.state.changed",
        eventId: eventId("opencode-session-start-failed"),
        provider: PROVIDER,
        threadId: openCodeInput.threadId,
        createdAt: nowIso(),
        turnId,
        payload: {
          state: "error",
          reason: message,
        },
      });
      this.emitRuntimeEvent({
        type: "turn.completed",
        eventId: eventId("opencode-turn-start-failed-completed"),
        provider: PROVIDER,
        threadId: openCodeInput.threadId,
        createdAt: nowIso(),
        turnId,
        payload: {
          state: "failed",
          errorMessage: message,
        },
      });
      throw cause;
    }

    return {
      threadId: openCodeInput.threadId,
      turnId,
      resumeCursor: context.session.resumeCursor,
    };
  }

  async interruptTurn(threadId: ThreadId): Promise<void> {
    const context = this.requireSession(threadId);
    try {
      await readJsonData(
        context.client.session.abort({
          sessionID: context.providerSessionId,
          ...(context.workspace ? { workspace: context.workspace } : {}),
        }),
      );
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "OpenCode session abort failed";
      this.emitRuntimeEvent({
        type: "runtime.error",
        eventId: eventId("opencode-interrupt-error"),
        provider: PROVIDER,
        threadId,
        createdAt: nowIso(),
        ...(context.activeTurnId ? { turnId: context.activeTurnId } : {}),
        payload: {
          message,
          class: "transport_error",
        },
      });
      // Still clean up local state even if the abort RPC failed so the UI
      // does not stay stuck in a "running" state.
    }
    const interruptedTurnId = context.activeTurnId;
    if (interruptedTurnId) {
      this.emitRuntimeEvent({
        type: "turn.completed",
        eventId: eventId("opencode-turn-interrupted"),
        provider: PROVIDER,
        threadId,
        createdAt: nowIso(),
        turnId: interruptedTurnId,
        payload: {
          state: "interrupted",
        },
      });
    }
    context.activeTurnId = undefined;
    context.session = {
      ...stripTransientSessionFields(context.session),
      status: "ready",
      updatedAt: nowIso(),
    };
  }

  async respondToRequest(
    threadId: ThreadId,
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ): Promise<void> {
    const context = this.requireSession(threadId);
    await readJsonData(
      context.client.permission.reply({
        requestID: requestId,
        ...(context.workspace ? { workspace: context.workspace } : {}),
        reply: toPermissionReply(decision),
      }),
    );
  }

  async respondToUserInput(
    threadId: ThreadId,
    requestId: ApprovalRequestId,
    answers: ProviderUserInputAnswers,
  ): Promise<void> {
    const context = this.requireSession(threadId);
    const pending = context.pendingQuestions.get(requestId);
    if (!pending) {
      throw new Error(`Unknown OpenCode question request '${requestId}'`);
    }

    const max = pending.questions.reduce(
      (result, question) => (question.answerIndex > result ? question.answerIndex : result),
      -1,
    );
    const orderedAnswers = Array.from({ length: max + 1 }, () => [] as string[]);
    for (const question of pending.questions) {
      const value = answers[question.id];
      if (Array.isArray(value)) {
        orderedAnswers[question.answerIndex] = value.map(String);
        continue;
      }
      if (typeof value === "string" && value.length > 0) {
        orderedAnswers[question.answerIndex] = [value];
      }
    }

    await readJsonData(
      context.client.question.reply({
        requestID: requestId,
        ...(context.workspace ? { workspace: context.workspace } : {}),
        answers: orderedAnswers,
      }),
    );
  }

  async readThread(threadId: ThreadId): Promise<ProviderThreadSnapshot> {
    const context = this.requireSession(threadId);
    const messages = await readJsonData(
      context.client.session.messages({
        sessionID: context.providerSessionId,
        ...(context.workspace ? { workspace: context.workspace } : {}),
      }),
    );

    const turns = (Array.isArray(messages) ? messages : []).map((entry) => {
      const info = asRecord(asRecord(entry)?.info);
      const messageId = asString(info?.id) ?? randomUUID();
      return {
        id: TurnId.makeUnsafe(messageId),
        items: [entry],
      };
    });

    return {
      threadId,
      turns,
    };
  }

  async rollbackThread(threadId: ThreadId): Promise<ProviderThreadSnapshot> {
    throw new Error(`OpenCode rollback is not implemented for thread '${threadId}'`);
  }

  async listModels(
    options?: OpenCodeModelDiscoveryOptions,
  ): Promise<ReadonlyArray<OpenCodeDiscoveredModel>> {
    const shared = await this.ensureServer(options);
    const client = await this.createClient({
      baseUrl: shared.baseUrl,
      ...(options?.directory ? { directory: options.directory } : {}),
      responseStyle: "data",
      throwOnError: true,
      ...(shared.authHeader
        ? {
            headers: {
              Authorization: shared.authHeader,
            },
          }
        : {}),
    });
    const payload = readProviderListResponse(
      await readJsonData(client.provider.list(options?.workspace ? { workspace: options.workspace } : {})),
    );
    // Show models from all configured providers, not just connected ones.
    // Connection status is a runtime concern — users want to pick from
    // everything they've set up. Fall back to config.providers if the
    // provider.list response has no entries at all.
    const listed = parseProviderModels(payload.all);
    if (listed.length > 0) {
      return listed;
    }
    const configured = readConfigProvidersResponse(
      await readJsonData(client.config.providers(options?.workspace ? { workspace: options.workspace } : {})),
    );
    return parseProviderModels(configured.providers);
  }

  stopSession(threadId: ThreadId): void {
    const context = this.sessions.get(threadId);
    if (!context) {
      return;
    }
    context.streamAbortController.abort();
    context.session = {
      ...stripTransientSessionFields(context.session),
      status: "closed",
      updatedAt: nowIso(),
    };
    this.sessions.delete(threadId);
  }

  stopAll(): void {
    for (const threadId of this.sessions.keys()) {
      this.stopSession(threadId);
    }
    this.server?.child?.kill();
    this.server = undefined;
    this.serverPromise = undefined;
  }

  private requireSession(threadId: ThreadId): OpenCodeSessionContext {
    const context = this.sessions.get(threadId);
    if (!context) {
      throw new Error(`Unknown OpenCode session for thread '${threadId}'`);
    }
    return context;
  }

  private async ensureServer(options?: OpenCodeProviderOptions): Promise<SharedServerState> {
    if (this.server) {
      return this.server;
    }
    if (this.serverPromise) {
      return this.serverPromise;
    }

    this.serverPromise = (async () => {
      const authHeader = buildAuthHeader(options?.username, options?.password);
      if (options?.serverUrl) {
        const shared = {
          baseUrl: options.serverUrl,
          ...(authHeader ? { authHeader } : {}),
        } satisfies SharedServerState;
        this.server = shared;
        return shared;
      }

      const hostname = options?.hostname ?? DEFAULT_HOSTNAME;
      const port = Math.trunc(options?.port ?? DEFAULT_PORT);
      const baseUrl = `http://${hostname}:${port}`;
      const healthy = await probeServer(baseUrl, authHeader);
      if (healthy) {
        const shared = {
          baseUrl,
          ...(authHeader ? { authHeader } : {}),
        } satisfies SharedServerState;
        this.server = shared;
        return shared;
      }

      const binaryPath = options?.binaryPath ?? "opencode";
      const child = spawn(binaryPath, ["serve", `--hostname=${hostname}`, `--port=${port}`], {
        env: {
          ...process.env,
          ...(options?.username ? { OPENCODE_SERVER_USERNAME: options.username } : {}),
          ...(options?.password ? { OPENCODE_SERVER_PASSWORD: options.password } : {}),
        },
        stdio: ["ignore", "pipe", "pipe"],
      });

      const startedBaseUrl = await new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(
            new Error(
              `Timed out waiting for OpenCode server to start after ${SERVER_START_TIMEOUT_MS}ms`,
            ),
          );
        }, SERVER_START_TIMEOUT_MS);
        let output = "";

        const onChunk = (chunk: Buffer) => {
          output += chunk.toString();
          const url = parseServerUrl(output);
          if (!url) {
            return;
          }
          clearTimeout(timeout);
          resolve(url);
        };

        child.stdout.on("data", onChunk);
        child.stderr.on("data", onChunk);
        child.once("error", (error) => {
          clearTimeout(timeout);
          reject(error);
        });
        child.once("exit", (code) => {
          clearTimeout(timeout);
          void probeServer(baseUrl, authHeader).then((reuse) => {
            if (reuse) {
              resolve(baseUrl);
              return;
            }
            const detail = output.trim().replaceAll(/\s+/g, " ").slice(0, 400);
            reject(
              new Error(
                `OpenCode server exited before startup completed (code ${code})${
                  detail.length > 0 ? `: ${detail}` : ""
                }`,
              ),
            );
          });
        });
      });

      const shared = {
        baseUrl: startedBaseUrl,
        child,
        ...(authHeader ? { authHeader } : {}),
      } satisfies SharedServerState;
      this.server = shared;
      return shared;
    })();

    try {
      return await this.serverPromise;
    } finally {
      if (!this.server) {
        this.serverPromise = undefined;
      }
    }
  }

  private async createClient(options: OpencodeClientOptions): Promise<OpencodeClient> {
    const sdkModuleId = "@opencode-ai/sdk/v2/client";
    const sdk = (await import(sdkModuleId)) as OpenCodeSdkModule;
    return sdk.createOpencodeClient(options);
  }

  private async startStream(context: OpenCodeSessionContext): Promise<void> {
    try {
      const result = await context.client.event.subscribe(
        context.workspace ? { workspace: context.workspace } : {},
        {
          signal: context.streamAbortController.signal,
        },
      );

      for await (const event of result.stream) {
        if (context.streamAbortController.signal.aborted) {
          break;
        }
        this.handleEvent(context, event);
      }
    } catch (cause) {
      if (context.streamAbortController.signal.aborted) {
        return;
      }
      const message = cause instanceof Error ? cause.message : "OpenCode event stream failed";
      context.lastError = message;
      context.session = {
        ...stripTransientSessionFields(context.session),
        status: "error",
        updatedAt: nowIso(),
        lastError: message,
      };
      this.emitRuntimeEvent({
        type: "runtime.error",
        eventId: eventId("opencode-stream-error"),
        provider: PROVIDER,
        threadId: context.threadId,
        createdAt: nowIso(),
        ...(context.activeTurnId ? { turnId: context.activeTurnId } : {}),
        payload: {
          message,
          class: "transport_error",
        },
      });
    }
  }

  private handleEvent(context: OpenCodeSessionContext, event: OpenCodeEvent): void {
    switch (event.type) {
      case "session.status":
        this.handleSessionStatusEvent(context, event);
        return;
      case "session.idle":
        this.handleSessionIdleEvent(context, event);
        return;
      case "session.diff":
        this.handleSessionDiffEvent(context, event);
        return;
      case "session.error":
        this.handleSessionErrorEvent(context, event);
        return;
      case "permission.asked":
        this.handlePermissionAskedEvent(context, event);
        return;
      case "permission.replied":
        this.handlePermissionRepliedEvent(context, event);
        return;
      case "question.asked":
        this.handleQuestionAskedEvent(context, event);
        return;
      case "question.replied":
        this.handleQuestionRepliedEvent(context, event);
        return;
      case "question.rejected":
        this.handleQuestionRejectedEvent(context, event);
        return;
      case "message.part.updated":
        this.handleMessagePartUpdatedEvent(context, event);
        return;
      case "message.part.delta":
        this.handleMessagePartDeltaEvent(context, event);
        return;
      case "todo.updated":
        this.handleTodoUpdatedEvent(context, event);
        return;
    }
  }

  private handleSessionStatusEvent(context: OpenCodeSessionContext, event: EventSessionStatus): void {
    const { sessionID: sessionId, status } = event.properties;
    if (sessionId !== context.providerSessionId) {
      return;
    }
    const statusType = status.type;

    if (statusType === "busy") {
      context.session = {
        ...context.session,
        status: "running",
        updatedAt: nowIso(),
      };
      this.emitRuntimeEvent({
        type: "session.state.changed",
        eventId: eventId("opencode-status-busy"),
        provider: PROVIDER,
        threadId: context.threadId,
        createdAt: nowIso(),
        ...(context.activeTurnId ? { turnId: context.activeTurnId } : {}),
        payload: {
          state: "running",
        },
        raw: {
          source: "opencode.server.event",
          messageType: statusType,
          payload: event,
        },
      });
      return;
    }

    if (statusType === "retry") {
      this.emitRuntimeEvent({
        type: "session.state.changed",
        eventId: eventId("opencode-status-retry"),
        provider: PROVIDER,
        threadId: context.threadId,
        createdAt: nowIso(),
        ...(context.activeTurnId ? { turnId: context.activeTurnId } : {}),
        payload: {
          state: "waiting",
          reason: "retry",
          detail: event,
        },
        raw: {
          source: "opencode.server.event",
          messageType: statusType,
          payload: event,
        },
      });
      return;
    }

    if (statusType === "idle") {
      const completedAt = nowIso();
      const turnId = context.activeTurnId;
      const lastError = context.lastError;
      context.activeTurnId = undefined;
      context.lastError = undefined;
      context.session = {
        ...stripTransientSessionFields(context.session),
        status: lastError ? "error" : "ready",
        updatedAt: completedAt,
        ...(lastError ? { lastError } : {}),
      };

      this.emitRuntimeEvent({
        type: "session.state.changed",
        eventId: eventId("opencode-status-idle"),
        provider: PROVIDER,
        threadId: context.threadId,
        createdAt: completedAt,
        ...(turnId ? { turnId } : {}),
        payload: {
          state: lastError ? "error" : "ready",
          ...(lastError ? { reason: lastError } : {}),
          detail: event,
        },
        raw: {
          source: "opencode.server.event",
          messageType: statusType,
          payload: event,
        },
      });

      if (turnId) {
        this.emitRuntimeEvent({
          type: "turn.completed",
          eventId: eventId("opencode-turn-completed"),
          provider: PROVIDER,
          threadId: context.threadId,
          createdAt: completedAt,
          turnId,
          payload: {
            state: lastError ? "failed" : "completed",
            ...(lastError ? { errorMessage: lastError } : {}),
          },
          raw: {
            source: "opencode.server.event",
            messageType: statusType,
            payload: event,
          },
        });
      }
    }
  }

  private handleSessionIdleEvent(context: OpenCodeSessionContext, event: EventSessionIdle): void {
    const { sessionID: sessionId } = event.properties;
    if (sessionId !== context.providerSessionId) {
      return;
    }

    // session.idle is a dedicated completion signal from newer OpenCode versions.
    // Treat it identically to session.status with type=idle.
    const completedAt = nowIso();
    const turnId = context.activeTurnId;
    const lastError = context.lastError;
    context.activeTurnId = undefined;
    context.lastError = undefined;
    context.session = {
      ...stripTransientSessionFields(context.session),
      status: lastError ? "error" : "ready",
      updatedAt: completedAt,
      ...(lastError ? { lastError } : {}),
    };

    this.emitRuntimeEvent({
      type: "session.state.changed",
      eventId: eventId("opencode-session-idle"),
      provider: PROVIDER,
      threadId: context.threadId,
      createdAt: completedAt,
      ...(turnId ? { turnId } : {}),
      payload: {
        state: lastError ? "error" : "ready",
        ...(lastError ? { reason: lastError } : {}),
      },
      raw: {
        source: "opencode.server.event",
        messageType: "session.idle",
        payload: event,
      },
    });

    if (turnId) {
      this.emitRuntimeEvent({
        type: "turn.completed",
        eventId: eventId("opencode-turn-completed-idle"),
        provider: PROVIDER,
        threadId: context.threadId,
        createdAt: completedAt,
        turnId,
        payload: {
          state: lastError ? "failed" : "completed",
          ...(lastError ? { errorMessage: lastError } : {}),
        },
        raw: {
          source: "opencode.server.event",
          messageType: "session.idle",
          payload: event,
        },
      });
    }
  }

  private handleSessionDiffEvent(context: OpenCodeSessionContext, _event: EventSessionDiff): void {
    const { sessionID: sessionId } = _event.properties;
    if (sessionId !== context.providerSessionId) {
      return;
    }
    // session.diff carries per-file change summaries from OpenCode.
    // The CheckpointReactor computes diffs via git when turn.completed fires,
    // so we don't need to forward this event. It's handled implicitly.
  }

  private handleSessionErrorEvent(context: OpenCodeSessionContext, event: EventSessionError): void {
    const { sessionID: sessionId, error } = event.properties;
    if (sessionId && sessionId !== context.providerSessionId) {
      return;
    }
    const errorMessage = sessionErrorMessage(error) ?? "OpenCode session error";
    context.lastError = errorMessage;
    context.session = {
      ...stripTransientSessionFields(context.session),
      status: "error",
      updatedAt: nowIso(),
      lastError: errorMessage,
    };
    this.emitRuntimeEvent({
      type: "runtime.error",
      eventId: eventId("opencode-session-error"),
      provider: PROVIDER,
      threadId: context.threadId,
      createdAt: nowIso(),
      ...(context.activeTurnId ? { turnId: context.activeTurnId } : {}),
      payload: {
        message: errorMessage,
        class: "provider_error",
      },
      raw: {
        source: "opencode.server.event",
        messageType: "session.error",
        payload: event,
      },
    });
  }

  private handlePermissionAskedEvent(context: OpenCodeSessionContext, event: EventPermissionAsked): void {
    const { id: requestIdValue, sessionID: sessionId, permission } = event.properties;
    if (sessionId !== context.providerSessionId) {
      return;
    }
    const requestType = toOpencodeRequestType(permission);
    const requestId = ApprovalRequestId.makeUnsafe(requestIdValue);
    context.pendingPermissions.set(requestId, { requestId, requestType });
    this.emitRuntimeEvent({
      type: "request.opened",
      eventId: eventId("opencode-request-opened"),
      provider: PROVIDER,
      threadId: context.threadId,
      createdAt: nowIso(),
      ...(context.activeTurnId ? { turnId: context.activeTurnId } : {}),
      requestId: RuntimeRequestId.makeUnsafe(requestId),
      payload: {
        requestType,
          detail: permission,
          args: event.properties,
      },
      raw: {
        source: "opencode.server.permission",
        messageType: "permission.asked",
        payload: event,
      },
    });
  }

  private handlePermissionRepliedEvent(
    context: OpenCodeSessionContext,
    event: EventPermissionReplied,
  ): void {
    const { requestID: requestIdValue, sessionID: sessionId, reply } = event.properties;
    if (sessionId !== context.providerSessionId) {
      return;
    }
    const pending = context.pendingPermissions.get(requestIdValue);
    context.pendingPermissions.delete(requestIdValue);
    this.emitRuntimeEvent({
      type: "request.resolved",
      eventId: eventId("opencode-request-resolved"),
      provider: PROVIDER,
      threadId: context.threadId,
      createdAt: nowIso(),
      ...(context.activeTurnId ? { turnId: context.activeTurnId } : {}),
      requestId: RuntimeRequestId.makeUnsafe(requestIdValue),
      payload: {
        requestType: pending?.requestType ?? "unknown",
        decision: reply,
        resolution: event.properties,
      },
      raw: {
        source: "opencode.server.permission",
        messageType: "permission.replied",
        payload: event,
      },
    });
  }

  private handleQuestionAskedEvent(context: OpenCodeSessionContext, event: EventQuestionAsked): void {
    const { id: requestIdValue, sessionID: sessionId, questions: askedQuestions } = event.properties;
    if (sessionId !== context.providerSessionId) {
      return;
    }
    const questions = askedQuestions.map((question: QuestionInfo, index) => ({
      answerIndex: index,
      id: `${requestIdValue}:${index}`,
      header: question.header,
      question: question.question,
      options: question.options.map((option) => ({
        label: option.label,
        description: option.description,
      })),
    }));
    const runtimeQuestions = questions.map((question) => ({
      id: question.id,
      header: question.header,
      question: question.question,
      options: question.options,
    }));

    const requestId = ApprovalRequestId.makeUnsafe(requestIdValue);
    context.pendingQuestions.set(requestId, {
      requestId,
      questionIds: questions.map((question) => question.id),
      questions,
    });
    this.emitRuntimeEvent({
      type: "user-input.requested",
      eventId: eventId("opencode-user-input-requested"),
      provider: PROVIDER,
      threadId: context.threadId,
      createdAt: nowIso(),
      ...(context.activeTurnId ? { turnId: context.activeTurnId } : {}),
      requestId: RuntimeRequestId.makeUnsafe(requestId),
      payload: {
        questions: runtimeQuestions,
      },
      raw: {
        source: "opencode.server.question",
        messageType: "question.asked",
        payload: event,
      },
    });
  }

  private handleQuestionRepliedEvent(
    context: OpenCodeSessionContext,
    event: EventQuestionReplied,
  ): void {
    const { requestID: requestIdValue, sessionID: sessionId, answers: answerArrays } = event.properties;
    if (sessionId !== context.providerSessionId) {
      return;
    }
    const pending = context.pendingQuestions.get(requestIdValue);
    context.pendingQuestions.delete(requestIdValue);
    const answers = Object.fromEntries(
      (pending?.questions ?? []).map((question) => {
        const answer = answerArrays[question.answerIndex];
        if (!answer) {
          return [question.id, ""];
        }
        return [question.id, answer.filter((value) => value.length > 0)];
      }),
    );
    this.emitRuntimeEvent({
      type: "user-input.resolved",
      eventId: eventId("opencode-user-input-resolved"),
      provider: PROVIDER,
      threadId: context.threadId,
      createdAt: nowIso(),
      ...(context.activeTurnId ? { turnId: context.activeTurnId } : {}),
      requestId: RuntimeRequestId.makeUnsafe(requestIdValue),
      payload: {
        answers,
      },
      raw: {
        source: "opencode.server.question",
        messageType: "question.replied",
        payload: event,
      },
    });
  }

  private handleQuestionRejectedEvent(
    context: OpenCodeSessionContext,
    event: EventQuestionRejected,
  ): void {
    const { requestID: requestIdValue, sessionID: sessionId } = event.properties;
    if (sessionId !== context.providerSessionId) {
      return;
    }
    context.pendingQuestions.delete(requestIdValue);
    this.emitRuntimeEvent({
      type: "user-input.resolved",
      eventId: eventId("opencode-user-input-rejected"),
      provider: PROVIDER,
      threadId: context.threadId,
      createdAt: nowIso(),
      ...(context.activeTurnId ? { turnId: context.activeTurnId } : {}),
      requestId: RuntimeRequestId.makeUnsafe(requestIdValue),
      payload: {
        answers: {},
      },
      raw: {
        source: "opencode.server.question",
        messageType: "question.rejected",
        payload: event,
      },
    });
  }

  private handleMessagePartUpdatedEvent(
    context: OpenCodeSessionContext,
    event: EventMessagePartUpdated,
  ): void {
    const { part } = event.properties;
    if (part.sessionID !== context.providerSessionId) {
      return;
    }
    if (part.type === "text") {
      context.partStreamById.set(part.id, { kind: "text", streamKind: "assistant_text" });
      return;
    }
    if (part.type === "reasoning") {
      context.partStreamById.set(part.id, { kind: "reasoning", streamKind: "reasoning_text" });
      return;
    }

    if (part.type === "tool") {
      this.handleToolPartUpdatedEvent(context, event, part);
    }
  }

  private handleToolPartUpdatedEvent(
    context: OpenCodeSessionContext,
    event: EventMessagePartUpdated,
    part: OpenCodeToolPart,
  ): void {
    const previous = context.partStreamById.get(part.id);
    const title = toolStateTitle(part.state);
    const detail = toolStateDetail(part.state);
    const lifecycleType = toToolLifecycleEventType(previous, part.state.status);

    context.partStreamById.set(part.id, { kind: "tool" });
    this.emitRuntimeEvent({
      type: lifecycleType,
      eventId: eventId(`opencode-tool-${lifecycleType.replace('.', '-')}`),
      provider: PROVIDER,
      threadId: context.threadId,
      createdAt: nowIso(),
      ...(context.activeTurnId ? { turnId: context.activeTurnId } : {}),
      itemId: RuntimeItemId.makeUnsafe(part.id),
      payload: {
        itemType: toToolItemType(part.tool),
        ...(lifecycleType !== "item.updated"
          ? {
              status: lifecycleType === "item.completed" ? "completed" : "inProgress",
            }
          : {}),
        title: toToolTitle(part.tool),
        ...(detail ? { detail } : {}),
        data: {
          item: part,
        },
      },
      raw: {
        source: "opencode.server.event",
        messageType: "message.part.updated",
        payload: event,
      },
    });

    if ((part.state.status === "completed" || part.state.status === "error") && title) {
      this.emitRuntimeEvent({
        type: "tool.summary",
        eventId: eventId("opencode-tool-summary"),
        provider: PROVIDER,
        threadId: context.threadId,
        createdAt: nowIso(),
        ...(context.activeTurnId ? { turnId: context.activeTurnId } : {}),
        itemId: RuntimeItemId.makeUnsafe(part.id),
        payload: {
          summary: `${part.tool}: ${title}`,
          precedingToolUseIds: [part.id],
        },
        raw: {
          source: "opencode.server.event",
          messageType: "message.part.updated",
          payload: event,
        },
      });
    }
  }

  private handleMessagePartDeltaEvent(
    context: OpenCodeSessionContext,
    event: EventMessagePartDelta,
  ): void {
    const { sessionID, partID: partId, delta } = event.properties;
    if (sessionID !== context.providerSessionId) {
      return;
    }
    if (!context.activeTurnId || delta.length === 0) {
      return;
    }
    const partState = context.partStreamById.get(partId);
    if (partState?.kind === "tool") {
      return;
    }
    this.emitRuntimeEvent({
      type: "content.delta",
      eventId: eventId("opencode-content-delta"),
      provider: PROVIDER,
      threadId: context.threadId,
      createdAt: nowIso(),
      turnId: context.activeTurnId,
      itemId: RuntimeItemId.makeUnsafe(partId),
      payload: {
        streamKind: partState?.streamKind ?? "assistant_text",
        delta,
      },
      raw: {
        source: "opencode.server.event",
        messageType: "message.part.delta",
        payload: event,
      },
    });
  }

  private handleTodoUpdatedEvent(context: OpenCodeSessionContext, event: EventTodoUpdated): void {
    const { sessionID, todos } = event.properties;
    if (sessionID !== context.providerSessionId || !context.activeTurnId) {
      return;
    }
    const plan = todos.map((todo) => ({
      step: todo.content,
      status: toPlanStepStatus(todo.status),
    }));
    this.emitRuntimeEvent({
      type: "turn.plan.updated",
      eventId: eventId("opencode-plan-updated"),
      provider: PROVIDER,
      threadId: context.threadId,
      createdAt: nowIso(),
      turnId: context.activeTurnId,
      payload: {
        plan,
      },
      raw: {
        source: "opencode.server.event",
        messageType: "todo.updated",
        payload: event,
      },
    });
  }

  private emitRuntimeEvent(event: OpenCodeProviderRuntimeEvent): void {
    this.emit("event", event as unknown as ProviderRuntimeEvent);
  }
}

export async function fetchOpenCodeModels(options?: OpenCodeModelDiscoveryOptions) {
  const manager = new OpenCodeServerManager();
  try {
    return await manager.listModels(options);
  } finally {
    manager.stopAll();
  }
}
