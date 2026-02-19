import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";

import {
  type CanUseTool,
  type ModelInfo,
  type PermissionMode,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
  query as claudeQuery,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  ProviderApprovalDecision,
  ProviderApprovalPolicy,
  ProviderEvent,
  ProviderModelOption,
  ProviderRequestKind,
  ProviderSendTurnInput,
  ProviderSession,
  ProviderSessionStartInput,
  ProviderTurnStartResult,
} from "@t3tools/contracts";
import { resolveClaudeModelSlug } from "@t3tools/contracts";
import type { CodexThreadSnapshot, CodexThreadTurnSnapshot } from "./codexAppServerManager";

interface PendingApprovalRequest {
  requestId: string;
  requestKind: ProviderRequestKind;
  toolName: string;
  resolve: (decision: ProviderApprovalDecision) => void;
}

interface QueuedTurnInput {
  message: SDKUserMessage;
}

interface MessageQueue {
  push: (input: QueuedTurnInput) => void;
  terminate: () => void;
  generator: AsyncIterable<SDKUserMessage>;
}

interface ClaudeTurnState {
  turnId: string;
  assistantItemId: string;
  userContent: unknown[];
  assistantText: string;
  assistantStarted: boolean;
}

interface ClaudeSessionContext {
  session: ProviderSession;
  query: Query;
  queue: MessageQueue;
  abortController: AbortController;
  pendingApprovals: Map<string, PendingApprovalRequest>;
  turns: CodexThreadTurnSnapshot[];
  approvalPolicy: ProviderApprovalPolicy;
  permissionMode: PermissionMode;
  allowAllForSession: boolean;
  stopping: boolean;
  currentTurn: ClaudeTurnState | null;
}

function createMessageQueue(): MessageQueue {
  const queue: QueuedTurnInput[] = [];
  let waiter: ((value: QueuedTurnInput | null) => void) | null = null;
  let terminated = false;

  const push = (input: QueuedTurnInput) => {
    if (terminated) {
      throw new Error("Claude input stream is closed.");
    }

    if (waiter) {
      const resolve = waiter;
      waiter = null;
      resolve(input);
      return;
    }

    queue.push(input);
  };

  const terminate = () => {
    terminated = true;
    if (waiter) {
      const resolve = waiter;
      waiter = null;
      resolve(null);
    }
  };

  const generator = (async function* streamMessages(): AsyncIterable<SDKUserMessage> {
    while (!terminated) {
      const next = queue.shift();
      if (next) {
        yield next.message;
        continue;
      }

      const awaited = await new Promise<QueuedTurnInput | null>((resolve) => {
        waiter = resolve;
      });
      if (!awaited) {
        break;
      }
      yield awaited.message;
    }
  })();

  return { push, terminate, generator };
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function parseDataUrl(dataUrl: string): { mimeType: string; base64Data: string } | null {
  const match = dataUrl.match(/^data:([^;,]+);base64,(.+)$/i);
  if (!match) {
    return null;
  }

  const mimeType = match[1];
  const base64Data = match[2];
  if (!mimeType || !base64Data) {
    return null;
  }

  return { mimeType, base64Data };
}

function inferRequestKindForTool(toolName: string): ProviderRequestKind {
  const normalized = toolName.toLowerCase();
  if (
    normalized.includes("edit") ||
    normalized.includes("write") ||
    normalized.includes("file") ||
    normalized.includes("patch")
  ) {
    return "file-change";
  }

  return "command";
}

export interface ClaudeCodeManagerEvents {
  event: [event: ProviderEvent];
}

export class ClaudeCodeManager extends EventEmitter<ClaudeCodeManagerEvents> {
  private readonly sessions = new Map<string, ClaudeSessionContext>();

  async startSession(input: ProviderSessionStartInput): Promise<ProviderSession> {
    const sessionId = randomUUID();
    const now = new Date().toISOString();
    const cwd = input.cwd ?? process.cwd();
    const claudeBinaryPath = input.claudeBinaryPath?.trim();
    const initialThreadId = input.claudeSessionId ?? input.resumeThreadId;
    const model = resolveClaudeModelSlug(input.model);
    const permissionMode = this.resolvePermissionMode(input);

    if (claudeBinaryPath) {
      this.assertClaudeAvailable(claudeBinaryPath);
    }

    const session: ProviderSession = {
      sessionId,
      provider: "claudeCode",
      status: "connecting",
      cwd,
      model,
      ...(initialThreadId ? { threadId: initialThreadId } : {}),
      createdAt: now,
      updatedAt: now,
    };

    const abortController = new AbortController();
    const queue = createMessageQueue();
    const query = claudeQuery({
      prompt: queue.generator,
      options: {
        cwd,
        model,
        ...(claudeBinaryPath ? { pathToClaudeCodeExecutable: claudeBinaryPath } : {}),
        permissionMode,
        allowDangerouslySkipPermissions: permissionMode === "bypassPermissions",
        ...(typeof input.maxThinkingTokens === "number"
          ? { maxThinkingTokens: input.maxThinkingTokens }
          : {}),
        ...(initialThreadId ? { resume: initialThreadId } : {}),
        includePartialMessages: true,
        abortController,
        canUseTool: (toolName, toolInput, options) =>
          this.handleCanUseTool(sessionId, toolName, toolInput, options),
      },
    });

    const context: ClaudeSessionContext = {
      session,
      query,
      queue,
      abortController,
      pendingApprovals: new Map(),
      turns: [],
      approvalPolicy: input.approvalPolicy ?? "never",
      permissionMode,
      allowAllForSession: input.approvalPolicy === "never",
      stopping: false,
      currentTurn: null,
    };
    this.sessions.set(sessionId, context);

    this.emitLifecycleEvent(context, "session/connecting", "Starting Claude Code session");
    this.consumeMessages(context);

    try {
      const initialization = await context.query.initializationResult();
      const availableModels = this.normalizeSupportedModels(initialization.models);
      this.updateSession(context, {
        status: "ready",
        ...(availableModels.length > 0 ? { availableModels } : {}),
      });
      this.emitLifecycleEvent(
        context,
        "session/ready",
        `Connected to session ${context.session.threadId ?? context.session.sessionId}`,
      );
      return { ...context.session };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to start Claude session.";
      this.updateSession(context, {
        status: "error",
        lastError: message,
      });
      this.emitErrorEvent(context, "session/startFailed", message);
      this.stopSession(sessionId);
      throw new Error(message, { cause: error });
    }
  }

  async sendTurn(input: ProviderSendTurnInput): Promise<ProviderTurnStartResult> {
    const context = this.requireSession(input.sessionId);
    const turnId = randomUUID();
    const assistantItemId = randomUUID();
    const userContent: unknown[] = [];

    if (input.input) {
      userContent.push({
        type: "text",
        text: input.input,
      });
    }
    for (const attachment of input.attachments ?? []) {
      if (attachment.type !== "image") {
        continue;
      }

      const parsed = parseDataUrl(attachment.dataUrl);
      if (!parsed) {
        throw new Error(`Attachment '${attachment.name}' is not a valid base64 data URL.`);
      }

      userContent.push({
        type: "image",
      });
    }

    if (userContent.length === 0) {
      throw new Error("Turn input must include text or attachments.");
    }

    if (input.model) {
      const model = resolveClaudeModelSlug(input.model);
      await context.query.setModel(model);
      this.updateSession(context, { model });
    }

    const messageContent: Array<Record<string, unknown>> = [];
    if (input.input) {
      messageContent.push({
        type: "text",
        text: input.input,
      });
    }
    for (const attachment of input.attachments ?? []) {
      if (attachment.type !== "image") {
        continue;
      }
      const parsed = parseDataUrl(attachment.dataUrl);
      if (!parsed) {
        throw new Error(`Attachment '${attachment.name}' is not a valid base64 data URL.`);
      }
      messageContent.push({
        type: "image",
        source: {
          type: "base64",
          media_type: parsed.mimeType,
          data: parsed.base64Data,
        },
      });
    }

    context.currentTurn = {
      turnId,
      assistantItemId,
      userContent,
      assistantText: "",
      assistantStarted: false,
    };

    this.updateSession(context, {
      status: "running",
      activeTurnId: turnId,
    });
    this.emitEvent({
      id: randomUUID(),
      kind: "notification",
      provider: "claudeCode",
      sessionId: context.session.sessionId,
      createdAt: new Date().toISOString(),
      method: "turn/started",
      threadId: context.session.threadId,
      turnId,
      payload: {
        turn: { id: turnId },
      },
    });

    context.queue.push({
      message: {
        type: "user",
        session_id: context.session.threadId ?? "",
        parent_tool_use_id: null,
        message: {
          role: "user",
          content: messageContent,
        },
      },
    });

    return {
      threadId: context.session.threadId ?? context.session.sessionId,
      turnId,
    };
  }

  async interruptTurn(sessionId: string): Promise<void> {
    const context = this.requireSession(sessionId);
    await context.query.interrupt();
  }

  async readThread(sessionId: string): Promise<CodexThreadSnapshot> {
    const context = this.requireSession(sessionId);
    return {
      threadId: context.session.threadId ?? context.session.sessionId,
      turns: context.turns.map((turn) => ({
        id: turn.id,
        items: [...turn.items],
      })),
    };
  }

  async rollbackThread(sessionId: string, numTurns: number): Promise<CodexThreadSnapshot> {
    const context = this.requireSession(sessionId);
    if (!Number.isInteger(numTurns) || numTurns < 1) {
      throw new Error("numTurns must be an integer >= 1.");
    }

    const nextLength = Math.max(0, context.turns.length - numTurns);
    context.turns = context.turns.slice(0, nextLength);
    this.updateSession(context, {
      status: "ready",
      activeTurnId: undefined,
    });

    return this.readThread(sessionId);
  }

  async respondToRequest(
    sessionId: string,
    requestId: string,
    decision: ProviderApprovalDecision,
  ): Promise<void> {
    const context = this.requireSession(sessionId);
    const pending = context.pendingApprovals.get(requestId);
    if (!pending) {
      throw new Error(`Unknown pending approval request: ${requestId}`);
    }

    context.pendingApprovals.delete(requestId);
    pending.resolve(decision);

    this.emitEvent({
      id: randomUUID(),
      kind: "notification",
      provider: "claudeCode",
      sessionId,
      createdAt: new Date().toISOString(),
      method: "item/requestApproval/decision",
      threadId: context.session.threadId,
      turnId: context.currentTurn?.turnId,
      requestId,
      requestKind: pending.requestKind,
      payload: {
        requestId,
        requestKind: pending.requestKind,
        decision,
        toolName: pending.toolName,
      },
    });
  }

  stopSession(sessionId: string): void {
    const context = this.sessions.get(sessionId);
    if (!context) {
      return;
    }

    context.stopping = true;
    for (const pending of context.pendingApprovals.values()) {
      pending.resolve("cancel");
    }
    context.pendingApprovals.clear();
    context.queue.terminate();
    context.abortController.abort();
    context.query.close();

    this.updateSession(context, {
      status: "closed",
      activeTurnId: undefined,
    });
    this.emitLifecycleEvent(context, "session/closed", "Session stopped");
    this.sessions.delete(sessionId);
  }

  listSessions(): ProviderSession[] {
    return Array.from(this.sessions.values(), ({ session }) => ({ ...session }));
  }

  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  stopAll(): void {
    for (const sessionId of this.sessions.keys()) {
      this.stopSession(sessionId);
    }
  }

  private resolvePermissionMode(input: ProviderSessionStartInput): PermissionMode {
    if (input.permissionMode) {
      return input.permissionMode;
    }
    return input.approvalPolicy === "never" ? "bypassPermissions" : "default";
  }

  private assertClaudeAvailable(binaryPath: string): void {
    if (binaryPath !== "claude" && !fs.existsSync(binaryPath)) {
      throw new Error(`Claude Code binary not found at '${binaryPath}'.`);
    }

    const probe = spawnSync(binaryPath, ["--version"], {
      stdio: "ignore",
    });
    if (probe.error || probe.status !== 0) {
      const reason = probe.error?.message ?? `exit code ${probe.status ?? "unknown"}`;
      throw new Error(`Failed to execute Claude Code binary '${binaryPath}' (${reason}).`);
    }
  }

  private async consumeMessages(context: ClaudeSessionContext): Promise<void> {
    try {
      for await (const message of context.query) {
        this.handleMessage(context, message);
      }
    } catch (error) {
      if (context.stopping) {
        return;
      }
      const message = error instanceof Error ? error.message : "Claude session crashed.";
      this.updateSession(context, {
        status: "error",
        lastError: message,
      });
      this.emitErrorEvent(context, "session/exited", message);
      this.sessions.delete(context.session.sessionId);
      return;
    }

    if (!context.stopping && this.sessions.has(context.session.sessionId)) {
      this.updateSession(context, {
        status: "closed",
        activeTurnId: undefined,
      });
      this.emitLifecycleEvent(context, "session/exited", "Claude session ended.");
      this.sessions.delete(context.session.sessionId);
    }
  }

  private handleMessage(context: ClaudeSessionContext, message: SDKMessage): void {
    const sessionThreadId = asString(asObject(message)?.session_id);
    if (sessionThreadId && sessionThreadId !== context.session.threadId) {
      this.updateSession(context, { threadId: sessionThreadId });
    }

    if (message.type === "system" && message.subtype === "init") {
      this.emitEvent({
        id: randomUUID(),
        kind: "notification",
        provider: "claudeCode",
        sessionId: context.session.sessionId,
        createdAt: new Date().toISOString(),
        method: "thread/started",
        threadId: context.session.threadId,
        payload: {
          thread: {
            id: context.session.threadId,
          },
          raw: message,
        },
      });
      return;
    }

    if (message.type === "stream_event") {
      this.handleStreamEvent(context, message);
      return;
    }

    if (message.type === "assistant") {
      this.handleAssistantMessage(context, message);
      return;
    }

    if (message.type === "tool_progress") {
      this.emitToolStartEvent(context, message.tool_use_id, message.tool_name, undefined);
      return;
    }

    if (message.type === "tool_use_summary") {
      this.emitToolResultEvent(context, message.summary, message.preceding_tool_use_ids);
      return;
    }

    if (message.type === "result") {
      this.completeTurn(context, message);
    }
  }

  private handleStreamEvent(
    context: ClaudeSessionContext,
    message: Extract<SDKMessage, { type: "stream_event" }>,
  ): void {
    const event = asObject(message.event);
    const eventType = asString(event?.type);
    if (eventType !== "content_block_delta") {
      return;
    }

    const delta = asObject(event?.delta);
    const deltaType = asString(delta?.type);
    if (deltaType === "text_delta") {
      const text = asString(delta?.text);
      if (text) {
        this.appendAssistantDelta(context, text);
      }
      return;
    }

    if (deltaType === "thinking_delta") {
      const thinking = asString(delta?.thinking);
      if (thinking) {
        this.emitEvent({
          id: randomUUID(),
          kind: "notification",
          provider: "claudeCode",
          sessionId: context.session.sessionId,
          createdAt: new Date().toISOString(),
          method: "assistant/thinking",
          threadId: context.session.threadId,
          turnId: context.currentTurn?.turnId,
          textDelta: thinking,
          payload: {
            raw: message,
          },
        });
      }
    }
  }

  private handleAssistantMessage(
    context: ClaudeSessionContext,
    message: Extract<SDKMessage, { type: "assistant" }>,
  ): void {
    const rawContent = asObject(message.message)?.content;
    const content = Array.isArray(rawContent) ? rawContent : [];
    let collectedText = "";

    for (const blockValue of content) {
      const block = asObject(blockValue);
      const type = asString(block?.type);
      if (!type) {
        continue;
      }

      if (type === "text") {
        const text = asString(block?.text);
        if (text) {
          collectedText += text;
        }
        continue;
      }

      if (type === "thinking") {
        const thinking = asString(block?.thinking);
        if (thinking) {
          this.emitEvent({
            id: randomUUID(),
            kind: "notification",
            provider: "claudeCode",
            sessionId: context.session.sessionId,
            createdAt: new Date().toISOString(),
            method: "assistant/thinking",
            threadId: context.session.threadId,
            turnId: context.currentTurn?.turnId,
            payload: {
              text: thinking,
            },
          });
        }
        continue;
      }

      if (type === "tool_use") {
        const toolUseId = asString(block?.id) ?? randomUUID();
        const toolName = asString(block?.name) ?? "tool";
        this.emitToolStartEvent(context, toolUseId, toolName, block?.input);
      }
    }

    if (collectedText.length > 0) {
      const existing = context.currentTurn?.assistantText ?? "";
      const delta = collectedText.startsWith(existing)
        ? collectedText.slice(existing.length)
        : collectedText;
      if (delta.length > 0) {
        this.appendAssistantDelta(context, delta);
      }
    }
  }

  private emitToolStartEvent(
    context: ClaudeSessionContext,
    toolUseId: string,
    toolName: string,
    input: unknown,
  ): void {
    this.emitEvent({
      id: randomUUID(),
      kind: "notification",
      provider: "claudeCode",
      sessionId: context.session.sessionId,
      createdAt: new Date().toISOString(),
      method: "tool_use/start",
      threadId: context.session.threadId,
      turnId: context.currentTurn?.turnId,
      itemId: toolUseId,
      payload: {
        toolUseId,
        toolName,
        input,
      },
    });

    this.emitEvent({
      id: randomUUID(),
      kind: "notification",
      provider: "claudeCode",
      sessionId: context.session.sessionId,
      createdAt: new Date().toISOString(),
      method: "item/started",
      threadId: context.session.threadId,
      turnId: context.currentTurn?.turnId,
      itemId: toolUseId,
      payload: {
        item: {
          id: toolUseId,
          type: "toolUse",
          tool: toolName,
          input,
        },
      },
    });
  }

  private emitToolResultEvent(
    context: ClaudeSessionContext,
    summary: string,
    toolUseIds: string[],
  ): void {
    this.emitEvent({
      id: randomUUID(),
      kind: "notification",
      provider: "claudeCode",
      sessionId: context.session.sessionId,
      createdAt: new Date().toISOString(),
      method: "tool_use/result",
      threadId: context.session.threadId,
      turnId: context.currentTurn?.turnId,
      payload: {
        summary,
        toolUseIds,
      },
    });

    for (const toolUseId of toolUseIds) {
      this.emitEvent({
        id: randomUUID(),
        kind: "notification",
        provider: "claudeCode",
        sessionId: context.session.sessionId,
        createdAt: new Date().toISOString(),
        method: "item/completed",
        threadId: context.session.threadId,
        turnId: context.currentTurn?.turnId,
        itemId: toolUseId,
        payload: {
          item: {
            id: toolUseId,
            type: "toolUse",
            summary,
          },
        },
      });
    }
  }

  private appendAssistantDelta(context: ClaudeSessionContext, delta: string): void {
    if (!delta) {
      return;
    }

    if (!context.currentTurn) {
      context.currentTurn = {
        turnId: context.session.activeTurnId ?? randomUUID(),
        assistantItemId: randomUUID(),
        userContent: [],
        assistantText: "",
        assistantStarted: false,
      };
    }

    if (!context.currentTurn.assistantStarted) {
      context.currentTurn.assistantStarted = true;
      this.emitEvent({
        id: randomUUID(),
        kind: "notification",
        provider: "claudeCode",
        sessionId: context.session.sessionId,
        createdAt: new Date().toISOString(),
        method: "item/started",
        threadId: context.session.threadId,
        turnId: context.currentTurn.turnId,
        itemId: context.currentTurn.assistantItemId,
        payload: {
          item: {
            id: context.currentTurn.assistantItemId,
            type: "agentMessage",
            text: context.currentTurn.assistantText,
          },
        },
      });
    }

    context.currentTurn.assistantText += delta;
    this.emitEvent({
      id: randomUUID(),
      kind: "notification",
      provider: "claudeCode",
      sessionId: context.session.sessionId,
      createdAt: new Date().toISOString(),
      method: "item/agentMessage/delta",
      threadId: context.session.threadId,
      turnId: context.currentTurn.turnId,
      itemId: context.currentTurn.assistantItemId,
      textDelta: delta,
      payload: {
        itemId: context.currentTurn.assistantItemId,
        delta,
      },
    });
  }

  private completeTurn(
    context: ClaudeSessionContext,
    result: Extract<SDKMessage, { type: "result" }>,
  ): void {
    const turn = context.currentTurn;
    const turnId = turn?.turnId ?? context.session.activeTurnId ?? randomUUID();

    if (turn?.assistantStarted) {
      this.emitEvent({
        id: randomUUID(),
        kind: "notification",
        provider: "claudeCode",
        sessionId: context.session.sessionId,
        createdAt: new Date().toISOString(),
        method: "item/completed",
        threadId: context.session.threadId,
        turnId,
        itemId: turn.assistantItemId,
        payload: {
          item: {
            id: turn.assistantItemId,
            type: "agentMessage",
            text: turn.assistantText,
          },
        },
      });
    }

    if (turn) {
      const turnItems: unknown[] = [
        {
          type: "userMessage",
          content: turn.userContent,
        },
      ];
      if (turn.assistantText.trim().length > 0) {
        turnItems.push({
          type: "agentMessage",
          text: turn.assistantText,
        });
      }
      context.turns.push({
        id: turn.turnId,
        items: turnItems,
      });
    }

    const isError = result.subtype !== "success";
    const errorMessage =
      isError && Array.isArray(result.errors) && result.errors.length > 0 ? result.errors[0] : undefined;

    this.updateSession(context, {
      status: isError ? "error" : "ready",
      activeTurnId: undefined,
      ...(errorMessage ? { lastError: errorMessage } : {}),
    });
    this.emitEvent({
      id: randomUUID(),
      kind: "notification",
      provider: "claudeCode",
      sessionId: context.session.sessionId,
      createdAt: new Date().toISOString(),
      method: "turn/completed",
      threadId: context.session.threadId,
      turnId,
      payload: {
        turn: {
          id: turnId,
          status: isError ? "failed" : "completed",
          ...(errorMessage ? { error: { message: errorMessage } } : {}),
        },
        raw: result,
      },
    });

    context.currentTurn = null;
  }

  private async handleCanUseTool(
    sessionId: string,
    toolName: Parameters<CanUseTool>[0],
    toolInput: Parameters<CanUseTool>[1],
    options: Parameters<CanUseTool>[2],
  ): Promise<{
    behavior: "allow";
    updatedInput?: Record<string, unknown>;
    updatedPermissions?: NonNullable<Parameters<CanUseTool>[2]["suggestions"]>;
  } | {
    behavior: "deny";
    message: string;
  }> {
    const context = this.requireSession(sessionId);
    if (
      context.allowAllForSession ||
      context.approvalPolicy === "never" ||
      context.permissionMode === "bypassPermissions"
    ) {
      return { behavior: "allow", updatedInput: toolInput };
    }

    const requestKind = inferRequestKindForTool(toolName);
    const requestId = randomUUID();
    const decision = await new Promise<ProviderApprovalDecision>((resolve, reject) => {
      let settled = false;
      const pending: PendingApprovalRequest = {
        requestId,
        requestKind,
        toolName,
        resolve: (value) => {
          if (settled) {
            return;
          }
          settled = true;
          options.signal.removeEventListener("abort", onAbort);
          resolve(value);
        },
      };
      context.pendingApprovals.set(requestId, pending);

      this.emitEvent({
        id: randomUUID(),
        kind: "request",
        provider: "claudeCode",
        sessionId: context.session.sessionId,
        createdAt: new Date().toISOString(),
        method:
          requestKind === "file-change"
            ? "item/fileChange/requestApproval"
            : "item/commandExecution/requestApproval",
        threadId: context.session.threadId,
        turnId: context.currentTurn?.turnId,
        requestId,
        requestKind,
        payload: {
          toolName,
          input: toolInput,
          toolUseId: options.toolUseID,
          blockedPath: options.blockedPath,
          reason: options.decisionReason,
        },
      });

      const onAbort = () => {
        if (settled) {
          return;
        }
        settled = true;
        context.pendingApprovals.delete(requestId);
        reject(new Error("Permission request was cancelled."));
      };
      options.signal.addEventListener("abort", onAbort, { once: true });
    });

    if (decision === "acceptForSession") {
      context.allowAllForSession = true;
      return {
        behavior: "allow",
        updatedInput: toolInput,
        ...(Array.isArray(options.suggestions) && options.suggestions.length > 0
          ? { updatedPermissions: options.suggestions }
          : {}),
      };
    }

    if (decision === "accept") {
      return {
        behavior: "allow",
        updatedInput: toolInput,
      };
    }

    return {
      behavior: "deny",
      message: "User declined.",
    };
  }

  private requireSession(sessionId: string): ClaudeSessionContext {
    const context = this.sessions.get(sessionId);
    if (!context) {
      throw new Error(`Unknown session: ${sessionId}`);
    }
    if (context.session.status === "closed") {
      throw new Error(`Session is closed: ${sessionId}`);
    }
    return context;
  }

  private updateSession(context: ClaudeSessionContext, updates: Partial<ProviderSession>): void {
    context.session = {
      ...context.session,
      ...updates,
      updatedAt: new Date().toISOString(),
    };
  }

  private emitLifecycleEvent(context: ClaudeSessionContext, method: string, message: string): void {
    this.emitEvent({
      id: randomUUID(),
      kind: "session",
      provider: "claudeCode",
      sessionId: context.session.sessionId,
      createdAt: new Date().toISOString(),
      method,
      message,
      threadId: context.session.threadId,
    });
  }

  private emitErrorEvent(context: ClaudeSessionContext, method: string, message: string): void {
    this.emitEvent({
      id: randomUUID(),
      kind: "error",
      provider: "claudeCode",
      sessionId: context.session.sessionId,
      createdAt: new Date().toISOString(),
      method,
      message,
      threadId: context.session.threadId,
    });
  }

  private emitEvent(event: ProviderEvent): void {
    this.emit("event", event);
  }

  private normalizeSupportedModels(models: ModelInfo[]): ProviderModelOption[] {
    const normalized: ProviderModelOption[] = [];
    const seenSlugs = new Set<string>();

    for (const model of models) {
      const slug = asString(model.value)?.trim();
      const name = asString(model.displayName)?.trim();
      const description = asString(model.description)?.trim();
      if (!slug || !name || seenSlugs.has(slug)) {
        continue;
      }

      normalized.push({
        slug,
        name,
        ...(description ? { description } : {}),
      });
      seenSlugs.add(slug);
    }

    return normalized;
  }
}
