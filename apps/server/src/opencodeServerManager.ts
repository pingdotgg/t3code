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
  type ServerProviderModelCatalog,
  type ProviderSession,
  type ProviderSessionStartInput,
  type ProviderTurnStartResult,
  type ProviderUserInputAnswers,
} from "@t3tools/contracts";
import type { ProviderThreadSnapshot } from "./provider/Services/ProviderAdapter.ts";
import {
  parseConfiguredOpenCodeModelCatalog,
  parseConnectedOpenCodeModelCatalog,
} from "./opencodeModelCatalog.ts";

const PROVIDER = "opencode" as const;
const DEFAULT_HOSTNAME = "127.0.0.1";
const DEFAULT_PORT = 6733;
const SERVER_START_TIMEOUT_MS = 5000;
const SERVER_PROBE_TIMEOUT_MS = 1500;

type OpenCodeProviderOptions = NonNullable<
  NonNullable<ProviderSessionStartInput["providerOptions"]>["opencode"]
>;
type OpencodeClient = ReturnType<typeof import("@opencode-ai/sdk/v2/client").createOpencodeClient>;
type OpenCodeModelDiscoveryOptions = OpenCodeProviderOptions & {
  directory?: string;
};

type OpencodeEvent = Record<string, unknown>;

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
  readonly streamKind: "assistant_text" | "reasoning_text";
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
  session: ProviderSession;
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

function asArray(value: unknown): ReadonlyArray<unknown> | undefined {
  return Array.isArray(value) ? value : undefined;
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
    headers: authHeader ? { Authorization: authHeader } : undefined,
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
  return {
    providerId: value.slice(0, index),
    modelId: value.slice(index + 1),
  };
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

async function readJsonData<T>(promise: Promise<T>): Promise<T> {
  return promise;
}

function stripTransientSessionFields(session: ProviderSession) {
  const { activeTurnId: _activeTurnId, lastError: _lastError, ...rest } = session;
  return rest;
}

export class OpenCodeServerManager extends EventEmitter<OpenCodeManagerEvents> {
  private readonly sessions = new Map<ThreadId, OpenCodeSessionContext>();
  private serverPromise: Promise<SharedServerState> | undefined;
  private server: SharedServerState | undefined;

  listSessions(): ReadonlyArray<ProviderSession> {
    return [...this.sessions.values()].map((entry) => entry.session);
  }

  hasSession(threadId: ThreadId): boolean {
    return this.sessions.has(threadId);
  }

  async startSession(input: ProviderSessionStartInput): Promise<ProviderSession> {
    const existing = this.sessions.get(input.threadId);
    if (existing) {
      return existing.session;
    }

    const directory = input.cwd ?? process.cwd();
    const options = input.providerOptions?.opencode;
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

    const resumedSessionId = readResumeSessionId(input.resumeCursor);
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

    const initialSession: ProviderSession = {
      provider: PROVIDER,
      status: "ready",
      runtimeMode: input.runtimeMode,
      ...(directory ? { cwd: directory } : {}),
      ...(input.model ? { model: input.model } : {}),
      threadId: input.threadId,
      resumeCursor: {
        sessionId: providerSessionId,
        ...(workspace ? { workspace } : {}),
      },
      createdAt,
      updatedAt: createdAt,
    };

    const streamAbortController = new AbortController();
    const context: OpenCodeSessionContext = {
      threadId: input.threadId,
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
    this.sessions.set(input.threadId, context);

    this.emitRuntimeEvent({
      type: "session.started",
      eventId: eventId("opencode-session-started"),
      provider: PROVIDER,
      threadId: input.threadId,
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
      threadId: input.threadId,
      createdAt,
      payload: {
        providerThreadId: providerSessionId,
      },
      providerRefs: {
        providerTurnId: providerSessionId,
      },
    });

    return initialSession;
  }

  async sendTurn(input: ProviderSendTurnInput): Promise<ProviderTurnStartResult> {
    const context = this.requireSession(input.threadId);
    const turnId = createTurnId();
    const agent =
      input.modelOptions?.opencode?.agent ??
      (input.interactionMode === "plan" ? "plan" : undefined);
    const parsedModel = parseOpencodeModel(input.model);
    const providerId = input.modelOptions?.opencode?.providerId ?? parsedModel?.providerId;
    const modelId = input.modelOptions?.opencode?.modelId ?? parsedModel?.modelId ?? input.model;
    const startedAt = nowIso();

    context.activeTurnId = turnId;
    context.lastError = undefined;
    context.session = {
      ...stripTransientSessionFields(context.session),
      status: "running",
      ...(input.model ? { model: input.model } : {}),
      activeTurnId: turnId,
      updatedAt: startedAt,
    };

    this.emitRuntimeEvent({
      type: "turn.started",
      eventId: eventId("opencode-turn-started"),
      provider: PROVIDER,
      threadId: input.threadId,
      createdAt: startedAt,
      turnId,
      payload: input.model ? { model: input.model } : {},
    });

    this.emitRuntimeEvent({
      type: "session.state.changed",
      eventId: eventId("opencode-session-running"),
      provider: PROVIDER,
      threadId: input.threadId,
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
          parts: [textPart(input.input ?? "")],
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
        threadId: input.threadId,
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
        threadId: input.threadId,
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
        threadId: input.threadId,
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
      threadId: input.threadId,
      turnId,
      resumeCursor: context.session.resumeCursor,
    };
  }

  async interruptTurn(threadId: ThreadId): Promise<void> {
    const context = this.requireSession(threadId);
    await readJsonData(
      context.client.session.abort({
        sessionID: context.providerSessionId,
        ...(context.workspace ? { workspace: context.workspace } : {}),
      }),
    );
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

  async listModels(options?: OpenCodeModelDiscoveryOptions): Promise<{
    readonly models: ReadonlyArray<{ slug: string; name: string }>;
    readonly modelCatalog?: ServerProviderModelCatalog;
  }> {
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
    const payload = await readJsonData(
      client.provider.list(options?.workspace ? { workspace: options.workspace } : {}),
    );
    const listed = parseConnectedOpenCodeModelCatalog(payload);
    if (listed.models.length > 0) {
      return listed;
    }
    const configured = await readJsonData(
      client.config.providers(options?.workspace ? { workspace: options.workspace } : {}),
    );
    return parseConfiguredOpenCodeModelCatalog(configured);
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

  private async createClient(options: Record<string, unknown>): Promise<OpencodeClient> {
    const sdk = await import("@opencode-ai/sdk/v2/client");
    return sdk.createOpencodeClient(options) as unknown as OpencodeClient;
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
        this.handleEvent(context, asRecord(event));
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

  private handleEvent(context: OpenCodeSessionContext, event: OpencodeEvent | undefined): void {
    if (!event) {
      return;
    }
    const type = asString(event.type);
    if (!type) {
      return;
    }
    const props = asRecord(event.properties);
    const data = props
      ? {
          type,
          ...props,
        }
      : event;

    switch (type) {
      case "session.status":
        this.handleSessionStatusEvent(context, data);
        return;
      case "session.error":
        this.handleSessionErrorEvent(context, data);
        return;
      case "permission.asked":
        this.handlePermissionAskedEvent(context, data);
        return;
      case "permission.replied":
        this.handlePermissionRepliedEvent(context, data);
        return;
      case "question.asked":
        this.handleQuestionAskedEvent(context, data);
        return;
      case "question.replied":
        this.handleQuestionRepliedEvent(context, data);
        return;
      case "question.rejected":
        this.handleQuestionRejectedEvent(context, data);
        return;
      case "message.part.updated":
        this.handleMessagePartUpdatedEvent(context, data);
        return;
      case "message.part.delta":
        this.handleMessagePartDeltaEvent(context, data);
        return;
      case "todo.updated":
        this.handleTodoUpdatedEvent(context, data);
        return;
    }
  }

  private handleSessionStatusEvent(context: OpenCodeSessionContext, event: OpencodeEvent): void {
    const sessionId = asString(event.sessionID);
    if (sessionId !== context.providerSessionId) {
      return;
    }
    const status = asRecord(event.status);
    const statusType = asString(status?.type);
    if (!statusType) {
      return;
    }

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

  private handleSessionErrorEvent(context: OpenCodeSessionContext, event: OpencodeEvent): void {
    const sessionId = asString(event.sessionID);
    if (sessionId && sessionId !== context.providerSessionId) {
      return;
    }
    const errorMessage =
      asString(asRecord(event.error)?.message) ??
      asString(event.message) ??
      "OpenCode session error";
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

  private handlePermissionAskedEvent(context: OpenCodeSessionContext, event: OpencodeEvent): void {
    const requestIdValue = asString(event.id);
    const sessionId = asString(event.sessionID);
    if (!requestIdValue || sessionId !== context.providerSessionId) {
      return;
    }
    const permission = asString(event.permission);
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
        ...(permission ? { detail: permission } : {}),
        args: event,
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
    event: OpencodeEvent,
  ): void {
    const requestIdValue = asString(event.requestID);
    const sessionId = asString(event.sessionID);
    if (!requestIdValue || sessionId !== context.providerSessionId) {
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
        ...(asString(event.reply) ? { decision: asString(event.reply) } : {}),
        resolution: event,
      },
      raw: {
        source: "opencode.server.permission",
        messageType: "permission.replied",
        payload: event,
      },
    });
  }

  private handleQuestionAskedEvent(context: OpenCodeSessionContext, event: OpencodeEvent): void {
    const requestIdValue = asString(event.id);
    const sessionId = asString(event.sessionID);
    if (!requestIdValue || sessionId !== context.providerSessionId) {
      return;
    }
    const questions = (asArray(event.questions) ?? []).flatMap((entry, index) => {
      const question = asRecord(entry);
      const header = asString(question?.header);
      const prompt = asString(question?.question);
      if (!header || !prompt) {
        return [];
      }
      const options = (asArray(question?.options) ?? []).flatMap((option) => {
        const record = asRecord(option);
        const label = asString(record?.label);
        const description = asString(record?.description);
        if (!label || !description) {
          return [];
        }
        return [{ label, description }];
      });
      return [
        {
          answerIndex: index,
          id: `${requestIdValue}:${index}`,
          header,
          question: prompt,
          options,
        },
      ];
    });
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

  private handleQuestionRepliedEvent(context: OpenCodeSessionContext, event: OpencodeEvent): void {
    const requestIdValue = asString(event.requestID);
    const sessionId = asString(event.sessionID);
    if (!requestIdValue || sessionId !== context.providerSessionId) {
      return;
    }
    const pending = context.pendingQuestions.get(requestIdValue);
    context.pendingQuestions.delete(requestIdValue);
    const answerArrays = asArray(event.answers) ?? [];
    const answers = Object.fromEntries(
      (pending?.questions ?? []).map((question) => {
        const answer = asArray(answerArrays[question.answerIndex]);
        if (!answer) {
          return [question.id, ""];
        }
        return [
          question.id,
          answer.map((value) => String(value)).filter((value) => value.length > 0),
        ];
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

  private handleQuestionRejectedEvent(context: OpenCodeSessionContext, event: OpencodeEvent): void {
    const requestIdValue = asString(event.requestID);
    const sessionId = asString(event.sessionID);
    if (!requestIdValue || sessionId !== context.providerSessionId) {
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
    event: OpencodeEvent,
  ): void {
    const part = asRecord(event.part);
    const sessionId = asString(event.sessionID) ?? asString(part?.sessionID);
    if (sessionId !== context.providerSessionId) {
      return;
    }
    const partId = asString(part?.id);
    const partType = asString(part?.type);
    if (!partId || !partType) {
      return;
    }
    if (partType === "text") {
      context.partStreamById.set(partId, { streamKind: "assistant_text" });
      return;
    }
    if (partType === "reasoning") {
      context.partStreamById.set(partId, { streamKind: "reasoning_text" });
      return;
    }

    if (partType === "tool") {
      const state = asRecord(part?.state);
      const toolName = asString(part?.tool) ?? "tool";
      const summary = asString(asRecord(state?.metadata)?.title) ?? asString(state?.title);
      const status = asString(state?.status);
      if ((status === "completed" || status === "error") && summary) {
        this.emitRuntimeEvent({
          type: "tool.summary",
          eventId: eventId("opencode-tool-summary"),
          provider: PROVIDER,
          threadId: context.threadId,
          createdAt: nowIso(),
          ...(context.activeTurnId ? { turnId: context.activeTurnId } : {}),
          itemId: RuntimeItemId.makeUnsafe(partId),
          payload: {
            summary: `${toolName}: ${summary}`,
            precedingToolUseIds: [partId],
          },
          raw: {
            source: "opencode.server.event",
            messageType: "message.part.updated",
            payload: event,
          },
        });
      }
    }
  }

  private handleMessagePartDeltaEvent(context: OpenCodeSessionContext, event: OpencodeEvent): void {
    if (asString(event.sessionID) !== context.providerSessionId) {
      return;
    }
    const partId = asString(event.partID);
    const delta = asString(event.delta);
    if (!partId || !delta || !context.activeTurnId) {
      return;
    }
    const partState = context.partStreamById.get(partId);
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

  private handleTodoUpdatedEvent(context: OpenCodeSessionContext, event: OpencodeEvent): void {
    if (asString(event.sessionID) !== context.providerSessionId || !context.activeTurnId) {
      return;
    }
    const todos = asArray(event.todos) ?? [];
    const plan = todos.flatMap((entry) => {
      const todo = asRecord(entry);
      const step = asString(todo?.content);
      const status = asString(todo?.status);
      if (!step || !status) {
        return [];
      }
      return [
        {
          step,
          status:
            status === "completed"
              ? "completed"
              : status === "in_progress"
                ? "inProgress"
                : "pending",
        } as const,
      ];
    });
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

  private emitRuntimeEvent(event: ProviderRuntimeEvent): void {
    this.emit("event", event);
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
