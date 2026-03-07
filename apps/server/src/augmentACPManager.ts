import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import readline from "node:readline";

import {
  ApprovalRequestId,
  EventId,
  ProviderInteractionMode,
  ProviderItemId,
  ProviderRequestKind,
  RuntimeMode,
  ThreadId,
  TurnId,
  type ProviderApprovalDecision,
  type ProviderEvent,
  type ProviderSession,
  type ProviderSessionStartInput,
  type ProviderTurnStartResult,
} from "@t3tools/contracts";
import { normalizeModelSlug } from "@t3tools/shared/model";
import { Effect, ServiceMap } from "effect";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

type PendingRequestKey = string;

interface PendingRequest {
  method: string;
  timeout: ReturnType<typeof setTimeout>;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

interface PendingApprovalRequest {
  requestId: ApprovalRequestId;
  jsonRpcId: string | number;
  threadId: ThreadId;
  turnId?: TurnId | undefined;
  itemId?: ProviderItemId | undefined;
}

interface AugmentSessionContext {
  session: ProviderSession;
  acpSessionId: string | null;
  child: ChildProcessWithoutNullStreams;
  output: readline.Interface;
  pending: Map<PendingRequestKey, PendingRequest>;
  pendingApprovals: Map<ApprovalRequestId, PendingApprovalRequest>;
  nextRequestId: number;
  stopping: boolean;
  availableModels: Array<{ modelId: string; name: string; description?: string }>;
  currentModelId: string | null;
}

interface JsonRpcError {
  code?: number;
  message?: string;
  data?: unknown;
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number;
  result?: unknown;
  error?: JsonRpcError;
}

interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

// ACP-specific types
interface ACPInitializeResult {
  protocolVersion: number;
  agentCapabilities: {
    loadSession?: boolean;
    promptCapabilities?: { image?: boolean };
    sessionCapabilities?: { list?: object };
  };
  agentInfo: {
    name: string;
    title: string;
    version: string;
  };
  authMethods: unknown[];
}

interface ACPSessionNewResult {
  sessionId: string;
  modes: {
    currentModeId: string;
    availableModes: Array<{ id: string; name: string; description: string }>;
  };
  models: {
    currentModelId: string;
    availableModels: Array<{ modelId: string; name: string; description?: string }>;
  };
}

interface ACPSessionPromptResult {
  stopReason: "end_turn" | "cancelled" | "max_turns" | "tool_error";
}

interface ACPSessionUpdate {
  sessionId: string;
  update: {
    sessionUpdate:
      | "agent_message_chunk"
      | "agent_thought_chunk"
      | "tool_call_added"
      | "tool_call_updated"
      | "plan_update";
    content?: { type: string; text?: string };
    toolCall?: unknown;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Input types
// ─────────────────────────────────────────────────────────────────────────────

export interface AugmentACPStartSessionInput {
  readonly threadId: ThreadId;
  readonly provider?: "augment";
  readonly cwd?: string;
  readonly model?: string;
  readonly providerOptions?: ProviderSessionStartInput["providerOptions"];
  readonly runtimeMode: RuntimeMode;
}

export interface AugmentACPSendTurnInput {
  readonly threadId: ThreadId;
  readonly input?: string;
  readonly attachments?: ReadonlyArray<{ type: "image"; url: string }>;
  readonly model?: string;
  readonly interactionMode?: ProviderInteractionMode;
}

// ─────────────────────────────────────────────────────────────────────────────
// Utility functions
// ─────────────────────────────────────────────────────────────────────────────

function killChildTree(child: ChildProcessWithoutNullStreams): void {
  if (process.platform === "win32" && child.pid !== undefined) {
    const result = spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    if (result.status === 0) {
      return;
    }
  }
  child.kill();
}

function readAugmentProviderOptions(input: AugmentACPStartSessionInput): {
  binaryPath: string | undefined;
} {
  const augmentOptions = input.providerOptions?.augment;
  return {
    binaryPath: augmentOptions?.binaryPath,
  };
}

function buildACPInitializeParams() {
  return {
    protocolVersion: 1,
    clientInfo: {
      name: "t3code",
      version: "0.1.0",
    },
  } as const;
}

// ─────────────────────────────────────────────────────────────────────────────
// AugmentACPManager class
// ─────────────────────────────────────────────────────────────────────────────

export interface AugmentACPManagerEvents {
  event: [event: ProviderEvent];
}

export class AugmentACPManager extends EventEmitter<AugmentACPManagerEvents> {
  private readonly sessions = new Map<ThreadId, AugmentSessionContext>();

  private runPromise: (effect: Effect.Effect<unknown, never>) => Promise<unknown>;
  constructor(services?: ServiceMap.ServiceMap<never>) {
    super();
    this.runPromise = services ? Effect.runPromiseWith(services) : Effect.runPromise;
  }

  async startSession(input: AugmentACPStartSessionInput): Promise<ProviderSession> {
    const threadId = input.threadId;
    const now = new Date().toISOString();
    let context: AugmentSessionContext | undefined;

    try {
      const resolvedCwd = input.cwd ?? process.cwd();

      const session: ProviderSession = {
        provider: "augment",
        status: "connecting",
        runtimeMode: input.runtimeMode,
        model: normalizeModelSlug(input.model, "augment") ?? undefined,
        cwd: resolvedCwd,
        threadId,
        createdAt: now,
        updatedAt: now,
      };

      const augmentOptions = readAugmentProviderOptions(input);
      const augmentBinaryPath = augmentOptions.binaryPath ?? "auggie";
      const spawnArgs = [
        "--acp",
        "--allow-indexing", // Skip indexing confirmation prompt
        "--workspace-root",
        resolvedCwd,
      ];
      const child = spawn(augmentBinaryPath, spawnArgs, {
        cwd: resolvedCwd,
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"],
        shell: process.platform === "win32",
      });
      const output = readline.createInterface({ input: child.stdout });

      context = {
        session,
        acpSessionId: null,
        child,
        output,
        pending: new Map(),
        pendingApprovals: new Map(),
        nextRequestId: 1,
        stopping: false,
        availableModels: [],
        currentModelId: null,
      };

      this.sessions.set(threadId, context);
      this.attachProcessListeners(context);

      this.emitLifecycleEvent(context, "session/connecting", "Starting auggie --acp");

      // ACP Initialize
      const initResponse = await this.sendRequest<ACPInitializeResult>(
        context,
        "initialize",
        buildACPInitializeParams(),
      );
      await Effect.logInfo("augment ACP initialize response", initResponse).pipe(this.runPromise);

      // ACP session/new
      const sessionNewResponse = await this.sendRequest<ACPSessionNewResult>(
        context,
        "session/new",
        {
          cwd: resolvedCwd,
          mcpServers: [],
        },
      );
      await Effect.logInfo("augment ACP session/new response", sessionNewResponse).pipe(
        this.runPromise,
      );

      context.acpSessionId = sessionNewResponse.sessionId;
      context.availableModels = sessionNewResponse.models.availableModels;
      context.currentModelId = sessionNewResponse.models.currentModelId;

      // Track the requested model - it will be passed to session/prompt
      const requestedModel = normalizeModelSlug(input.model, "augment");
      if (requestedModel) {
        context.currentModelId = requestedModel;
      }

      this.updateSession(context, {
        status: "ready",
        model: context.currentModelId ?? undefined,
        resumeCursor: { sessionId: context.acpSessionId },
      });
      this.emitLifecycleEvent(
        context,
        "session/ready",
        `Connected to Augment session ${context.acpSessionId}`,
      );
      return { ...context.session };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to start Augment session.";
      if (context) {
        this.updateSession(context, {
          status: "error",
          lastError: message,
        });
        this.emitErrorEvent(context, "session/startFailed", message);
        this.stopSession(threadId);
      } else {
        this.emitEvent({
          id: EventId.makeUnsafe(randomUUID()),
          kind: "error",
          provider: "augment",
          threadId,
          createdAt: new Date().toISOString(),
          method: "session/startFailed",
          message,
        });
      }
      throw new Error(message, { cause: error });
    }
  }

  async sendTurn(input: AugmentACPSendTurnInput): Promise<ProviderTurnStartResult> {
    const context = this.requireSession(input.threadId);

    if (!context.acpSessionId) {
      throw new Error("Session is missing ACP session ID.");
    }

    // Build prompt content parts (ACP format)
    const promptParts: Array<{ type: "text"; text: string } | { type: "image"; data: string }> = [];
    if (input.input) {
      promptParts.push({ type: "text", text: input.input });
    }
    for (const attachment of input.attachments ?? []) {
      if (attachment.type === "image") {
        promptParts.push({ type: "image", data: attachment.url });
      }
    }
    if (promptParts.length === 0) {
      throw new Error("Turn input must include text or attachments.");
    }

    // Generate turn ID
    const turnId = TurnId.makeUnsafe(randomUUID());

    this.updateSession(context, {
      status: "running",
      activeTurnId: turnId,
    });

    // Emit turn started event
    this.emitEvent({
      id: EventId.makeUnsafe(randomUUID()),
      kind: "notification",
      provider: "augment",
      threadId: context.session.threadId,
      createdAt: new Date().toISOString(),
      method: "turn/started",
      turnId,
      payload: { turnId },
    });

    // Determine model for this turn
    const modelForTurn = input.model
      ? normalizeModelSlug(input.model, "augment")
      : context.currentModelId;

    // Send ACP session/prompt - this returns when the turn completes
    // Streaming updates come as notifications
    // Use a very long timeout (10 minutes) since turns can take a while
    this.sendRequest<ACPSessionPromptResult>(
      context,
      "session/prompt",
      {
        sessionId: context.acpSessionId,
        prompt: promptParts,
        ...(modelForTurn ? { model: modelForTurn } : {}),
      },
      10 * 60 * 1000, // 10 minutes
    )
      .then((result) => {
        this.updateSession(context, {
          status: "ready",
          activeTurnId: undefined,
        });

        this.emitEvent({
          id: EventId.makeUnsafe(randomUUID()),
          kind: "notification",
          provider: "augment",
          threadId: context.session.threadId,
          createdAt: new Date().toISOString(),
          method: "turn/completed",
          turnId,
          payload: { turnId, stopReason: result.stopReason },
        });
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : "Turn failed.";
        this.updateSession(context, {
          status: "error",
          activeTurnId: undefined,
          lastError: message,
        });

        this.emitErrorEvent(context, "turn/failed", message);
      });

    return {
      threadId: context.session.threadId,
      turnId,
      resumeCursor: context.session.resumeCursor,
    };
  }

  async interruptTurn(threadId: ThreadId, _turnId?: TurnId): Promise<void> {
    const context = this.requireSession(threadId);

    if (!context.acpSessionId) {
      return;
    }

    // ACP uses session/cancel notification (no response expected)
    this.writeMessage(context, {
      jsonrpc: "2.0",
      method: "session/cancel",
      params: { sessionId: context.acpSessionId },
    });
  }

  async respondToRequest(
    threadId: ThreadId,
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ): Promise<void> {
    const context = this.requireSession(threadId);
    const pendingRequest = context.pendingApprovals.get(requestId);
    if (!pendingRequest) {
      throw new Error(`Unknown pending approval request: ${requestId}`);
    }

    context.pendingApprovals.delete(requestId);

    // ACP permission response
    const outcome = decision === "accept" || decision === "acceptForSession" ? "allow" : "deny";
    this.writeMessage(context, {
      jsonrpc: "2.0",
      id: pendingRequest.jsonRpcId,
      result: { outcome },
    });

    this.emitEvent({
      id: EventId.makeUnsafe(randomUUID()),
      kind: "notification",
      provider: "augment",
      threadId: context.session.threadId,
      createdAt: new Date().toISOString(),
      method: "item/requestApproval/decision",
      turnId: pendingRequest.turnId,
      itemId: pendingRequest.itemId,
      requestId: pendingRequest.requestId,
      payload: { requestId: pendingRequest.requestId, decision },
    });
  }

  stopSession(threadId: ThreadId): void {
    const context = this.sessions.get(threadId);
    if (!context) {
      return;
    }

    context.stopping = true;

    for (const pending of context.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("Session stopped before request completed."));
    }
    context.pending.clear();
    context.pendingApprovals.clear();

    context.output.close();

    if (!context.child.killed) {
      killChildTree(context.child);
    }

    this.updateSession(context, {
      status: "closed",
      activeTurnId: undefined,
    });
    this.emitLifecycleEvent(context, "session/closed", "Session stopped");
    this.sessions.delete(threadId);
  }

  listSessions(): ProviderSession[] {
    return Array.from(this.sessions.values(), ({ session }) => ({ ...session }));
  }

  hasSession(threadId: ThreadId): boolean {
    return this.sessions.has(threadId);
  }

  stopAll(): void {
    for (const threadId of this.sessions.keys()) {
      this.stopSession(threadId);
    }
  }

  getAvailableModels(threadId: ThreadId): Array<{ modelId: string; name: string }> {
    const context = this.sessions.get(threadId);
    return context?.availableModels ?? [];
  }

  private requireSession(threadId: ThreadId): AugmentSessionContext {
    const context = this.sessions.get(threadId);
    if (!context) {
      throw new Error(`Unknown session for thread: ${threadId}`);
    }

    if (context.session.status === "closed") {
      throw new Error(`Session is closed for thread: ${threadId}`);
    }

    return context;
  }

  private attachProcessListeners(context: AugmentSessionContext): void {
    context.output.on("line", (line) => {
      this.handleStdoutLine(context, line);
    });

    context.child.stderr.on("data", (chunk: Buffer) => {
      const raw = chunk.toString();
      // Log stderr but don't emit as errors unless it looks like an error
      if (raw.toLowerCase().includes("error")) {
        this.emitErrorEvent(context, "process/stderr", raw.trim());
      }
    });

    context.child.on("error", (error) => {
      const message = error.message || "auggie --acp process errored.";
      this.updateSession(context, {
        status: "error",
        lastError: message,
      });
      this.emitErrorEvent(context, "process/error", message);
    });

    context.child.on("exit", (code, signal) => {
      if (context.stopping) {
        return;
      }

      const message = `auggie --acp exited (code=${code ?? "null"}, signal=${signal ?? "null"}).`;
      const exitError = new Error(message);
      for (const pending of context.pending.values()) {
        clearTimeout(pending.timeout);
        pending.reject(exitError);
      }
      context.pending.clear();
      context.pendingApprovals.clear();

      this.updateSession(context, {
        status: "closed",
        activeTurnId: undefined,
        lastError: code === 0 ? context.session.lastError : message,
      });
      this.emitLifecycleEvent(context, "session/exited", message);
      this.sessions.delete(context.session.threadId);
    });
  }

  private handleStdoutLine(context: AugmentSessionContext, line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // Not JSON, might be debug output
      return;
    }

    if (!parsed || typeof parsed !== "object") {
      return;
    }

    const message = parsed as Record<string, unknown>;

    // Check if it's a response (has id and result/error)
    if ("id" in message && ("result" in message || "error" in message)) {
      this.handleResponse(context, message as unknown as JsonRpcResponse);
      return;
    }

    // Check if it's a request (has id and method)
    if ("id" in message && "method" in message) {
      this.handleServerRequest(context, message as unknown as JsonRpcRequest);
      return;
    }

    // Check if it's a notification (has method, no id)
    if ("method" in message && !("id" in message)) {
      this.handleServerNotification(context, message as unknown as JsonRpcNotification);
      return;
    }
  }

  private handleServerNotification(
    context: AugmentSessionContext,
    notification: JsonRpcNotification,
  ): void {
    const params = notification.params as Record<string, unknown> | undefined;

    if (notification.method === "session/update" && params) {
      const update = params.update as ACPSessionUpdate["update"] | undefined;
      if (!update) return;

      const turnId = context.session.activeTurnId;

      // Map ACP session updates to T3 Code events
      if (update.sessionUpdate === "agent_message_chunk") {
        const text = (update.content as { text?: string })?.text;
        if (text) {
          this.emitEvent({
            id: EventId.makeUnsafe(randomUUID()),
            kind: "notification",
            provider: "augment",
            threadId: context.session.threadId,
            createdAt: new Date().toISOString(),
            method: "item/agentMessage/delta",
            turnId,
            textDelta: text,
            payload: update,
          });
        }
      } else if (update.sessionUpdate === "agent_thought_chunk") {
        const text = (update.content as { text?: string })?.text;
        if (text) {
          this.emitEvent({
            id: EventId.makeUnsafe(randomUUID()),
            kind: "notification",
            provider: "augment",
            threadId: context.session.threadId,
            createdAt: new Date().toISOString(),
            method: "item/agentThought/delta",
            turnId,
            textDelta: text,
            payload: update,
          });
        }
      } else if (update.sessionUpdate === "tool_call_added") {
        this.emitEvent({
          id: EventId.makeUnsafe(randomUUID()),
          kind: "notification",
          provider: "augment",
          threadId: context.session.threadId,
          createdAt: new Date().toISOString(),
          method: "item/toolCall/started",
          turnId,
          payload: update,
        });
      } else if (update.sessionUpdate === "tool_call_updated") {
        this.emitEvent({
          id: EventId.makeUnsafe(randomUUID()),
          kind: "notification",
          provider: "augment",
          threadId: context.session.threadId,
          createdAt: new Date().toISOString(),
          method: "item/toolCall/updated",
          turnId,
          payload: update,
        });
      }
    }
  }

  private handleServerRequest(context: AugmentSessionContext, request: JsonRpcRequest): void {
    const turnId = context.session.activeTurnId;

    // ACP permission requests
    if (request.method === "session/request_permission") {
      const requestId = ApprovalRequestId.makeUnsafe(randomUUID());
      const pendingRequest: PendingApprovalRequest = {
        requestId,
        jsonRpcId: request.id,
        threadId: context.session.threadId,
        turnId,
      };
      context.pendingApprovals.set(requestId, pendingRequest);

      this.emitEvent({
        id: EventId.makeUnsafe(randomUUID()),
        kind: "request",
        provider: "augment",
        threadId: context.session.threadId,
        createdAt: new Date().toISOString(),
        method: request.method,
        turnId,
        requestId,
        payload: request.params,
      });
      return;
    }

    // Unknown request - send error response
    this.writeMessage(context, {
      jsonrpc: "2.0",
      id: request.id,
      error: {
        code: -32601,
        message: `Unsupported server request: ${request.method}`,
      },
    });
  }

  private handleResponse(context: AugmentSessionContext, response: JsonRpcResponse): void {
    const key = String(response.id);
    const pending = context.pending.get(key);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timeout);
    context.pending.delete(key);

    if (response.error) {
      pending.reject(new Error(`${pending.method} failed: ${String(response.error.message ?? "Unknown error")}`));
      return;
    }

    pending.resolve(response.result);
  }

  private async sendRequest<TResponse>(
    context: AugmentSessionContext,
    method: string,
    params: unknown,
    timeoutMs = 30_000,
  ): Promise<TResponse> {
    const id = context.nextRequestId;
    context.nextRequestId += 1;

    const result = await new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        context.pending.delete(String(id));
        reject(new Error(`Timed out waiting for ${method}.`));
      }, timeoutMs);

      context.pending.set(String(id), {
        method,
        timeout,
        resolve,
        reject,
      });
      this.writeMessage(context, {
        jsonrpc: "2.0",
        method,
        id,
        params,
      });
    });

    return result as TResponse;
  }

  private writeMessage(context: AugmentSessionContext, message: unknown): void {
    const encoded = JSON.stringify(message);
    if (!context.child.stdin.writable) {
      throw new Error("Cannot write to auggie --acp stdin.");
    }

    context.child.stdin.write(`${encoded}\n`);
  }

  private emitLifecycleEvent(context: AugmentSessionContext, method: string, message: string): void {
    this.emitEvent({
      id: EventId.makeUnsafe(randomUUID()),
      kind: "session",
      provider: "augment",
      threadId: context.session.threadId,
      createdAt: new Date().toISOString(),
      method,
      message,
    });
  }

  private emitErrorEvent(context: AugmentSessionContext, method: string, message: string): void {
    this.emitEvent({
      id: EventId.makeUnsafe(randomUUID()),
      kind: "error",
      provider: "augment",
      threadId: context.session.threadId,
      createdAt: new Date().toISOString(),
      method,
      message,
    });
  }

  private emitEvent(event: ProviderEvent): void {
    this.emit("event", event);
  }

  private updateSession(
    context: AugmentSessionContext,
    updates: Partial<ProviderSession>,
  ): void {
    context.session = {
      ...context.session,
      ...updates,
      updatedAt: new Date().toISOString(),
    };
  }
}

