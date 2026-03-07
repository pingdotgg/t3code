import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { Readable, Writable } from "node:stream";

import * as acp from "@agentclientprotocol/sdk";
import {
  ApprovalRequestId,
  COPILOT_REASONING_EFFORT_VALUES,
  EventId,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderSessionStartInput,
  RuntimeItemId,
  RuntimeRequestId,
  ThreadId,
  TurnId,
  type CopilotReasoningEffort,
  type ProviderTurnStartResult,
} from "@t3tools/contracts";

interface PendingApprovalRequest {
  readonly requestId: ApprovalRequestId;
  readonly toolCallId: string;
  readonly turnId: TurnId | undefined;
  readonly requestType:
    | "command_execution_approval"
    | "file_read_approval"
    | "file_change_approval";
  readonly options: ReadonlyArray<acp.PermissionOption>;
  readonly resolve: (response: acp.RequestPermissionResponse) => void;
}

interface ToolSnapshot {
  readonly kind: acp.ToolKind | null;
  readonly title: string;
}

interface CopilotSessionContext {
  session: ProviderSession;
  child: ChildProcessWithoutNullStreams;
  connection: acp.ClientSideConnection;
  acpSessionId: string;
  models: acp.SessionModelState | null;
  configOptions: ReadonlyArray<acp.SessionConfigOption> | null;
  pendingApprovals: Map<ApprovalRequestId, PendingApprovalRequest>;
  toolSnapshots: Map<string, ToolSnapshot>;
  currentTurnId: TurnId | undefined;
  stopping: boolean;
  lastStderrLine?: string;
}

export interface CopilotAppServerStartSessionInput {
  readonly threadId: ThreadId;
  readonly provider?: "copilot";
  readonly cwd?: string;
  readonly model?: string;
  readonly reasoningEffort?: CopilotReasoningEffort;
  readonly resumeCursor?: unknown;
  readonly providerOptions?: ProviderSessionStartInput["providerOptions"];
  readonly runtimeMode: ProviderSession["runtimeMode"];
}

export interface CopilotThreadTurnSnapshot {
  readonly id: TurnId;
  readonly items: ReadonlyArray<unknown>;
}

export interface CopilotThreadSnapshot {
  readonly threadId: ThreadId;
  readonly turns: ReadonlyArray<CopilotThreadTurnSnapshot>;
}

export interface CopilotAcpManagerEvents {
  event: [event: ProviderRuntimeEvent];
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function toMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return fallback;
}

const COPILOT_REASONING_EFFORT_SET = new Set<CopilotReasoningEffort>(
  COPILOT_REASONING_EFFORT_VALUES,
);

interface CopilotReasoningEffortSelector {
  readonly id: string;
  readonly currentValue: CopilotReasoningEffort | null;
  readonly options: ReadonlyArray<CopilotReasoningEffort>;
}

function isCopilotReasoningEffort(value: unknown): value is CopilotReasoningEffort {
  return typeof value === "string" && COPILOT_REASONING_EFFORT_SET.has(value as CopilotReasoningEffort);
}

function flattenSessionConfigSelectOptions(
  options: acp.SessionConfigSelectOptions,
): ReadonlyArray<acp.SessionConfigSelectOption> {
  return options.flatMap((entry) => ("value" in entry ? [entry] : entry.options));
}

export function readCopilotReasoningEffortSelector(
  configOptions: ReadonlyArray<acp.SessionConfigOption> | null | undefined,
): CopilotReasoningEffortSelector | null {
  const selector = configOptions?.find(
    (option) =>
      option.type === "select" &&
      (option.category === "thought_level" || option.id === "reasoning_effort"),
  );
  if (!selector) {
    return null;
  }

  const options: CopilotReasoningEffort[] = [];
  const seen = new Set<CopilotReasoningEffort>();
  for (const entry of flattenSessionConfigSelectOptions(selector.options)) {
    if (!isCopilotReasoningEffort(entry.value) || seen.has(entry.value)) {
      continue;
    }
    seen.add(entry.value);
    options.push(entry.value);
  }

  return {
    id: selector.id,
    currentValue: isCopilotReasoningEffort(selector.currentValue) ? selector.currentValue : null,
    options,
  };
}

export function readAvailableCopilotModelIds(
  models: acp.SessionModelState | null | undefined,
): ReadonlyArray<string> {
  return models?.availableModels.map((entry) => entry.modelId) ?? [];
}

export function isCopilotModelAvailable(
  models: acp.SessionModelState | null | undefined,
  model: string,
): boolean {
  const availableModelIds = readAvailableCopilotModelIds(models);
  return availableModelIds.length === 0 || availableModelIds.includes(model);
}

function readResumeSessionId(input: {
  readonly resumeCursor?: unknown;
}): string | undefined {
  return asString(asObject(input.resumeCursor)?.sessionId);
}

function mapCopilotRuntimeMode(
  runtimeMode: ProviderSession["runtimeMode"],
): ReadonlyArray<string> {
  return runtimeMode === "full-access" ? ["--allow-all"] : [];
}

function mapToolKindToItemType(kind: acp.ToolKind | null | undefined) {
  switch (kind) {
    case "execute":
      return "command_execution" as const;
    case "edit":
    case "delete":
    case "move":
      return "file_change" as const;
    case "search":
    case "fetch":
    case "read":
      return "dynamic_tool_call" as const;
    case "think":
      return "reasoning" as const;
    default:
      return "dynamic_tool_call" as const;
  }
}

function mapToolKindToRequestType(
  kind: acp.ToolKind | null | undefined,
): PendingApprovalRequest["requestType"] {
  switch (kind) {
    case "execute":
      return "command_execution_approval";
    case "edit":
    case "delete":
    case "move":
      return "file_change_approval";
    default:
      return "file_read_approval";
  }
}

function mapToolCallStatus(
  status: acp.ToolCallStatus | null | undefined,
): "inProgress" | "completed" | "failed" | undefined {
  switch (status) {
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "pending":
    case "in_progress":
      return "inProgress";
    default:
      return undefined;
  }
}

function mapPlanEntryStatus(
  status: acp.PlanEntryStatus,
): "pending" | "inProgress" | "completed" {
  switch (status) {
    case "in_progress":
      return "inProgress";
    case "completed":
      return "completed";
    case "pending":
    default:
      return "pending";
  }
}

function extractTextFromContentBlock(block: acp.ContentBlock | undefined): string | undefined {
  if (!block || typeof block !== "object" || !("type" in block)) {
    return undefined;
  }
  if (block.type === "text") {
    return block.text;
  }
  return undefined;
}

function summarizeToolContent(content: ReadonlyArray<acp.ToolCallContent> | null | undefined) {
  if (!content) {
    return undefined;
  }

  for (const entry of content) {
    if (entry.type === "content") {
      const text = extractTextFromContentBlock(entry.content);
      if (text && text.trim().length > 0) {
        return text.trim();
      }
    }

    if (entry.type === "diff") {
      const path = entry.path?.trim();
      if (path) {
        return path;
      }
    }
  }

  return undefined;
}

function createPermissionOutcome(
  decision: ProviderApprovalDecision,
  options: ReadonlyArray<acp.PermissionOption>,
): acp.RequestPermissionResponse {
  const selectByKind = (
    expectedKind: acp.PermissionOptionKind,
  ): acp.RequestPermissionResponse | undefined => {
    const option = options.find((candidate) => candidate.kind === expectedKind);
    if (!option) {
      return undefined;
    }
    return {
      outcome: {
        outcome: "selected",
        optionId: option.optionId,
      },
    };
  };

  switch (decision) {
    case "acceptForSession":
      return (
        selectByKind("allow_always") ??
        selectByKind("allow_once") ?? {
          outcome: { outcome: "cancelled" },
        }
      );
    case "accept":
      return (
        selectByKind("allow_once") ??
        selectByKind("allow_always") ?? {
          outcome: { outcome: "cancelled" },
        }
      );
    case "decline":
      return (
        selectByKind("reject_once") ??
        selectByKind("reject_always") ?? {
          outcome: { outcome: "cancelled" },
        }
      );
    case "cancel":
    default:
      return { outcome: { outcome: "cancelled" } };
  }
}

function permissionDecisionFromOutcome(
  outcome: acp.RequestPermissionResponse["outcome"],
  options: ReadonlyArray<acp.PermissionOption>,
): ProviderApprovalDecision {
  if (outcome.outcome === "cancelled") {
    return "cancel";
  }

  const selectedOption = options.find((option) => option.optionId === outcome.optionId);
  switch (selectedOption?.kind) {
    case "allow_always":
      return "acceptForSession";
    case "reject_once":
    case "reject_always":
      return "decline";
    case "allow_once":
    default:
      return "accept";
  }
}

/**
 * On Windows with `shell: true`, `child.kill()` only terminates the `cmd.exe`
 * wrapper, leaving the actual command running. Use `taskkill /T` to kill the
 * entire process tree instead.
 */
function killChildTree(child: ChildProcessWithoutNullStreams): void {
  if (process.platform === "win32" && child.pid !== undefined) {
    try {
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      return;
    } catch {
      // Fallback to direct kill below.
    }
  }
  child.kill();
}

export class CopilotAcpManager extends EventEmitter<CopilotAcpManagerEvents> {
  private readonly sessions = new Map<ThreadId, CopilotSessionContext>();

  private emitRuntimeEvent(event: ProviderRuntimeEvent) {
    this.emit("event", event);
  }

  private createEventBase(context: CopilotSessionContext) {
    return {
      eventId: EventId.makeUnsafe(randomUUID()),
      provider: "copilot" as const,
      threadId: context.session.threadId,
      createdAt: new Date().toISOString(),
    };
  }

  private updateSession(
    context: CopilotSessionContext,
    patch: Partial<ProviderSession>,
  ): ProviderSession {
    context.session = {
      ...context.session,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    return context.session;
  }

  private emitSessionConfigured(context: CopilotSessionContext) {
    if (!context.models && !context.configOptions) {
      return;
    }

    this.emitRuntimeEvent({
      ...this.createEventBase(context),
      type: "session.configured",
      payload: {
        config: {
          ...(context.models
            ? {
                currentModelId: context.models.currentModelId,
                availableModels: context.models.availableModels,
              }
            : {}),
          ...(context.configOptions ? { configOptions: context.configOptions } : {}),
        },
      },
    });
  }

  private emitSessionStarted(context: CopilotSessionContext) {
    const sessionStarted: ProviderRuntimeEvent = {
      ...this.createEventBase(context),
      type: "session.started",
      payload: {
        message: "Connected to GitHub Copilot CLI ACP server.",
        resume: context.session.resumeCursor,
      },
    };
    const threadStarted: ProviderRuntimeEvent = {
      ...this.createEventBase(context),
      type: "thread.started",
      payload: {
        providerThreadId: context.acpSessionId,
      },
    };
    this.emitRuntimeEvent(sessionStarted);
    this.emitRuntimeEvent(threadStarted);

    this.emitSessionConfigured(context);
  }

  private emitSessionExit(
    context: CopilotSessionContext,
    input: {
      readonly reason?: string;
      readonly exitKind: "graceful" | "error";
      readonly recoverable?: boolean;
    },
  ) {
    this.emitRuntimeEvent({
      ...this.createEventBase(context),
      type: "session.exited",
      payload: {
        ...(input.reason ? { reason: input.reason } : {}),
        exitKind: input.exitKind,
        recoverable: input.recoverable ?? false,
      },
    });
  }

  private emitRuntimeError(context: CopilotSessionContext, message: string, turnId?: TurnId) {
    this.emitRuntimeEvent({
      ...this.createEventBase(context),
      ...(turnId ? { turnId } : {}),
      type: "runtime.error",
      payload: {
        message,
      },
    });
  }

  private resolvePendingApprovalsAsCancelled(context: CopilotSessionContext) {
    for (const pending of context.pendingApprovals.values()) {
      pending.resolve({ outcome: { outcome: "cancelled" } });
    }
    context.pendingApprovals.clear();
  }

  private handleSessionUpdate(context: CopilotSessionContext, params: acp.SessionNotification) {
    const turnId = context.currentTurnId;
    const createdAt = new Date().toISOString();
    const base = {
      ...this.createEventBase(context),
      ...(turnId ? { turnId } : {}),
      createdAt,
    };

    switch (params.update.sessionUpdate) {
      case "agent_message_chunk": {
        const delta = extractTextFromContentBlock(params.update.content);
        if (!delta || delta.length === 0) {
          return;
        }
        this.emitRuntimeEvent({
          ...base,
          ...(params.update.messageId
            ? { itemId: RuntimeItemId.makeUnsafe(params.update.messageId) }
            : {}),
          type: "content.delta",
          payload: {
            delta,
            streamKind: "assistant_text",
          },
        });
        return;
      }

      case "agent_thought_chunk": {
        const delta = extractTextFromContentBlock(params.update.content);
        if (!delta || delta.length === 0) {
          return;
        }
        this.emitRuntimeEvent({
          ...base,
          ...(params.update.messageId
            ? { itemId: RuntimeItemId.makeUnsafe(params.update.messageId) }
            : {}),
          type: "content.delta",
          payload: {
            delta,
            streamKind: "reasoning_text",
          },
        });
        return;
      }

      case "plan": {
        this.emitRuntimeEvent({
          ...base,
          type: "turn.plan.updated",
          payload: {
            plan: params.update.entries.map((entry) => ({
              step: entry.content,
              status: mapPlanEntryStatus(entry.status),
            })),
          },
        });
        return;
      }

      case "config_option_update": {
        context.configOptions = params.update.configOptions;
        this.emitSessionConfigured(context);
        return;
      }

      case "tool_call": {
        context.toolSnapshots.set(params.update.toolCallId, {
          kind: params.update.kind ?? null,
          title: params.update.title,
        });
        this.emitRuntimeEvent({
          ...base,
          itemId: RuntimeItemId.makeUnsafe(params.update.toolCallId),
          type: "item.started",
          payload: {
            itemType: mapToolKindToItemType(params.update.kind),
            title: params.update.title,
            ...(mapToolCallStatus(params.update.status)
              ? { status: mapToolCallStatus(params.update.status) }
              : {}),
            ...(summarizeToolContent(params.update.content) ? { detail: summarizeToolContent(params.update.content) } : {}),
            data: {
              ...(params.update.locations ? { locations: params.update.locations } : {}),
              ...(params.update.rawInput !== undefined ? { rawInput: params.update.rawInput } : {}),
              ...(params.update.rawOutput !== undefined ? { rawOutput: params.update.rawOutput } : {}),
            },
          },
        });
        return;
      }

      case "tool_call_update": {
        const previous = context.toolSnapshots.get(params.update.toolCallId);
        const nextSnapshot = {
          kind: params.update.kind ?? previous?.kind ?? null,
          title: params.update.title ?? previous?.title ?? "Tool call",
        } satisfies ToolSnapshot;
        context.toolSnapshots.set(params.update.toolCallId, nextSnapshot);
        const status = params.update.status ?? null;
        const eventType =
          status === "completed" || status === "failed" ? "item.completed" : "item.updated";
        this.emitRuntimeEvent({
          ...base,
          itemId: RuntimeItemId.makeUnsafe(params.update.toolCallId),
          type: eventType,
          payload: {
            itemType: mapToolKindToItemType(nextSnapshot.kind),
            title: nextSnapshot.title,
            ...(mapToolCallStatus(status) ? { status: mapToolCallStatus(status) } : {}),
            ...(summarizeToolContent(params.update.content) ? { detail: summarizeToolContent(params.update.content) } : {}),
            ...(params.update.content ? { data: { content: params.update.content } } : {}),
          },
        });
        return;
      }

      default:
        return;
    }
  }

  private async requestPermission(
    context: CopilotSessionContext,
    params: acp.RequestPermissionRequest,
  ): Promise<acp.RequestPermissionResponse> {
    const requestId = ApprovalRequestId.makeUnsafe(randomUUID());
    const requestType = mapToolKindToRequestType(params.toolCall.kind);
    const detail = params.toolCall.title?.trim() ?? "Permission requested";

    this.emitRuntimeEvent({
      ...this.createEventBase(context),
      ...(context.currentTurnId ? { turnId: context.currentTurnId } : {}),
      requestId: RuntimeRequestId.makeUnsafe(requestId),
      type: "request.opened",
      payload: {
        requestType,
        ...(detail.length > 0 ? { detail } : {}),
      },
    });

    const response = await new Promise<acp.RequestPermissionResponse>((resolve) => {
      context.pendingApprovals.set(requestId, {
        requestId,
        toolCallId: params.toolCall.toolCallId,
        turnId: context.currentTurnId,
        requestType,
        options: params.options,
        resolve,
      });
    });

    context.pendingApprovals.delete(requestId);
    this.emitRuntimeEvent({
      ...this.createEventBase(context),
      ...(context.currentTurnId ? { turnId: context.currentTurnId } : {}),
      requestId: RuntimeRequestId.makeUnsafe(requestId),
      type: "request.resolved",
      payload: {
        requestType,
        decision: permissionDecisionFromOutcome(response.outcome, params.options),
      },
    });
    return response;
  }

  private attachProcessListeners(context: CopilotSessionContext) {
    context.child.stderr.setEncoding("utf8");
    context.child.stderr.on("data", (chunk: string) => {
      const trimmed = chunk.trim();
      if (trimmed.length > 0) {
        context.lastStderrLine = trimmed.split("\n").at(-1)?.trim() ?? trimmed;
      }
    });

    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      if (!this.sessions.has(context.session.threadId)) {
        return;
      }

      this.resolvePendingApprovalsAsCancelled(context);
      this.updateSession(context, {
        status: "closed",
      });

      if (!context.stopping) {
        const reason =
          context.lastStderrLine ??
          (signal ? `Copilot CLI exited from signal ${signal}.` : undefined) ??
          (code !== null ? `Copilot CLI exited with code ${code}.` : "Copilot CLI exited.");
        this.emitSessionExit(context, {
          reason,
          exitKind: code === 0 ? "graceful" : "error",
        });
        if (code !== 0 && context.currentTurnId) {
          this.emitRuntimeError(context, reason, context.currentTurnId);
        }
      }

      this.sessions.delete(context.session.threadId);
    };

    context.child.once("exit", onExit);
    context.connection.closed.catch(() => undefined);
  }

  private requireSession(threadId: ThreadId): CopilotSessionContext {
    const context = this.sessions.get(threadId);
    if (!context) {
      throw new Error(`Unknown Copilot session: ${threadId}`);
    }
    if (context.session.status === "closed") {
      throw new Error(`Copilot session is closed: ${threadId}`);
    }
    return context;
  }

  private async setSessionModel(context: CopilotSessionContext, model: string) {
    const availableModelIds = readAvailableCopilotModelIds(context.models);
    if (availableModelIds.length > 0 && !availableModelIds.includes(model)) {
      throw new Error(
        `GitHub Copilot CLI does not expose model '${model}' for this account. Available models: ${availableModelIds.join(", ")}.`,
      );
    }

    try {
      await context.connection.unstable_setSessionModel({
        sessionId: context.acpSessionId,
        modelId: model,
      });
      if (context.models) {
        context.models = {
          ...context.models,
          currentModelId: model,
        };
      }
      this.updateSession(context, { model });
      this.emitSessionConfigured(context);
    } catch (error) {
      throw new Error(
        toMessage(error, `Failed to switch GitHub Copilot model to '${model}'.`),
        { cause: error },
      );
    }
  }

  private async setSessionReasoningEffort(
    context: CopilotSessionContext,
    reasoningEffort: CopilotReasoningEffort,
  ) {
    const selector = readCopilotReasoningEffortSelector(context.configOptions);
    if (!selector) {
      throw new Error("GitHub Copilot CLI did not expose a reasoning-effort selector for this session.");
    }

    if (!selector.options.includes(reasoningEffort)) {
      throw new Error(
        `GitHub Copilot CLI does not expose reasoning effort '${reasoningEffort}' for this session. Available reasoning levels: ${selector.options.join(", ")}.`,
      );
    }

    if (selector.currentValue === reasoningEffort) {
      return;
    }

    try {
      const response = await context.connection.setSessionConfigOption({
        sessionId: context.acpSessionId,
        configId: selector.id,
        value: reasoningEffort,
      });
      context.configOptions = response.configOptions;
      this.emitSessionConfigured(context);
    } catch (error) {
      throw new Error(
        toMessage(error, `Failed to set GitHub Copilot reasoning effort to '${reasoningEffort}'.`),
        { cause: error },
      );
    }
  }

  async startSession(input: CopilotAppServerStartSessionInput): Promise<ProviderSession> {
    const resolvedCwd = input.cwd ?? process.cwd();
    const now = new Date().toISOString();
    const session: ProviderSession = {
      provider: "copilot",
      status: "connecting",
      runtimeMode: input.runtimeMode,
      model: input.model,
      cwd: resolvedCwd,
      threadId: input.threadId,
      createdAt: now,
      updatedAt: now,
    };

    const copilotBinaryPath = input.providerOptions?.copilot?.binaryPath ?? "copilot";
    const args = ["--acp", "--no-ask-user", ...mapCopilotRuntimeMode(input.runtimeMode)];

    const child = spawn(copilotBinaryPath, args, {
      cwd: resolvedCwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: process.platform === "win32",
    });

    const stream = acp.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout));
    let context: CopilotSessionContext | undefined;

    const client: acp.Client = {
      requestPermission: async (params) => {
        if (!context) {
          return { outcome: { outcome: "cancelled" } };
        }
        return this.requestPermission(context, params);
      },
      sessionUpdate: async (params) => {
        if (!context) {
          return;
        }
        this.handleSessionUpdate(context, params);
      },
    };

    const connection = new acp.ClientSideConnection(() => client, stream);
    context = {
      session,
      child,
      connection,
      acpSessionId: "",
      models: null,
      configOptions: null,
      pendingApprovals: new Map(),
      toolSnapshots: new Map(),
      currentTurnId: undefined,
      stopping: false,
    };
    this.sessions.set(input.threadId, context);
    this.attachProcessListeners(context);

    try {
      const initializeResult = await connection.initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });

      const resumeSessionId = readResumeSessionId(input);
      const resumeSupported =
        initializeResult.agentCapabilities?.sessionCapabilities?.resume !== undefined;

      let sessionResult:
        | acp.NewSessionResponse
        | acp.ResumeSessionResponse;
      if (resumeSessionId) {
        if (!resumeSupported) {
          throw new Error(
            "GitHub Copilot CLI ACP server does not advertise session resume support.",
          );
        }

        sessionResult = await connection.unstable_resumeSession({
          sessionId: resumeSessionId,
          cwd: resolvedCwd,
          mcpServers: [],
        });
        context.acpSessionId = resumeSessionId;
      } else {
        const createdSession = await connection.newSession({
          cwd: resolvedCwd,
          mcpServers: [],
        });
        sessionResult = createdSession;
        context.acpSessionId = createdSession.sessionId;
      }

      context.models = sessionResult.models ?? null;
      context.configOptions = sessionResult.configOptions ?? null;
      this.updateSession(context, {
        status: "ready",
        model: sessionResult.models?.currentModelId ?? session.model,
        resumeCursor: { sessionId: context.acpSessionId },
      });

      const requestedModel = input.model?.trim();
      if (
        requestedModel &&
        requestedModel !== context.session.model &&
        context.models !== null &&
        isCopilotModelAvailable(context.models, requestedModel)
      ) {
        await this.setSessionModel(context, requestedModel);
      }

      if (input.reasoningEffort) {
        await this.setSessionReasoningEffort(context, input.reasoningEffort);
      }

      this.emitSessionStarted(context);
      return { ...context.session };
    } catch (error) {
      const message = toMessage(error, "Failed to start GitHub Copilot session.");
      this.updateSession(context, {
        status: "error",
        lastError: message,
      });
      this.emitRuntimeError(context, message);
      context.stopping = true;
      this.resolvePendingApprovalsAsCancelled(context);
      killChildTree(context.child);
      this.sessions.delete(input.threadId);
      throw new Error(message, { cause: error });
    }
  }

  async sendTurn(input: {
    readonly threadId: ThreadId;
    readonly input?: string;
    readonly attachments?: ReadonlyArray<unknown>;
    readonly model?: string;
    readonly reasoningEffort?: CopilotReasoningEffort;
  }): Promise<ProviderTurnStartResult> {
    const context = this.requireSession(input.threadId);
    const promptText = input.input?.trim();
    if (!promptText) {
      throw new Error("GitHub Copilot turns require a non-empty text prompt.");
    }
    if ((input.attachments?.length ?? 0) > 0) {
      throw new Error("GitHub Copilot integration currently supports text prompts only.");
    }

    const requestedModel = input.model?.trim();
    if (requestedModel && requestedModel !== context.session.model) {
      if (isCopilotModelAvailable(context.models, requestedModel)) {
        await this.setSessionModel(context, requestedModel);
      }
    }

    if (input.reasoningEffort) {
      await this.setSessionReasoningEffort(context, input.reasoningEffort);
    }

    const turnId = TurnId.makeUnsafe(randomUUID());
    context.currentTurnId = turnId;
    this.updateSession(context, {
      status: "running",
      activeTurnId: turnId,
    });

    this.emitRuntimeEvent({
      ...this.createEventBase(context),
      turnId,
      type: "turn.started",
      payload: context.session.model ? { model: context.session.model } : {},
    });

    try {
      const result = await context.connection.prompt({
        sessionId: context.acpSessionId,
        prompt: [
          {
            type: "text",
            text: promptText,
          },
        ],
      });

      this.emitRuntimeEvent({
        ...this.createEventBase(context),
        turnId,
        type: "turn.completed",
        payload: {
          state: result.stopReason === "cancelled" ? "interrupted" : "completed",
          stopReason: result.stopReason,
          ...(result.usage ? { usage: result.usage } : {}),
        },
      });

      this.updateSession(context, {
        status: "ready",
        activeTurnId: undefined,
      });

      return {
        threadId: input.threadId,
        turnId,
        resumeCursor: { sessionId: context.acpSessionId },
      };
    } catch (error) {
      const message = toMessage(error, "GitHub Copilot turn failed.");
      this.emitRuntimeEvent({
        ...this.createEventBase(context),
        turnId,
        type: "turn.completed",
        payload: {
          state: "failed",
          stopReason: null,
          errorMessage: message,
        },
      });
      this.emitRuntimeError(context, message, turnId);
      this.updateSession(context, {
        status: "error",
        activeTurnId: undefined,
        lastError: message,
      });
      throw new Error(message, { cause: error });
    } finally {
      context.currentTurnId = undefined;
    }
  }

  async interruptTurn(threadId: ThreadId, turnId?: TurnId): Promise<void> {
    const context = this.requireSession(threadId);
    if (turnId && context.currentTurnId && turnId !== context.currentTurnId) {
      return;
    }
    this.resolvePendingApprovalsAsCancelled(context);
    await context.connection.cancel({ sessionId: context.acpSessionId });
  }

  async respondToRequest(
    threadId: ThreadId,
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ): Promise<void> {
    const context = this.requireSession(threadId);
    const pending = context.pendingApprovals.get(requestId);
    if (!pending) {
      throw new Error(`Unknown pending Copilot approval request: ${requestId}`);
    }
    pending.resolve(createPermissionOutcome(decision, pending.options));
  }

  async respondToUserInput(): Promise<void> {
    throw new Error("GitHub Copilot CLI does not expose structured user input requests in T3 Code.");
  }

  async stopSession(threadId: ThreadId): Promise<void> {
    const context = this.sessions.get(threadId);
    if (!context) {
      return;
    }

    context.stopping = true;
    this.resolvePendingApprovalsAsCancelled(context);
    try {
      await context.connection.cancel({ sessionId: context.acpSessionId });
    } catch {
      // Best-effort cancellation only.
    }

    killChildTree(context.child);
    this.updateSession(context, {
      status: "closed",
      activeTurnId: undefined,
    });
    this.emitSessionExit(context, {
      reason: "GitHub Copilot session stopped.",
      exitKind: "graceful",
      recoverable: true,
    });
    this.sessions.delete(threadId);
  }

  async listSessions(): Promise<ReadonlyArray<ProviderSession>> {
    return Array.from(this.sessions.values(), (context) => context.session);
  }

  async getSessionConfiguration(threadId: ThreadId): Promise<{
    readonly models: acp.SessionModelState | null;
    readonly configOptions: ReadonlyArray<acp.SessionConfigOption> | null;
  }> {
    const context = this.requireSession(threadId);
    return {
      models: context.models,
      configOptions: context.configOptions,
    };
  }

  async hasSession(threadId: ThreadId): Promise<boolean> {
    return this.sessions.has(threadId);
  }

  async readThread(threadId: ThreadId): Promise<CopilotThreadSnapshot> {
    this.requireSession(threadId);
    throw new Error(
      "Reading historical Copilot thread snapshots is not implemented in this ACP integration yet.",
    );
  }

  async rollbackThread(threadId: ThreadId, _numTurns: number): Promise<CopilotThreadSnapshot> {
    this.requireSession(threadId);
    throw new Error("Rolling back GitHub Copilot threads is not supported by this integration.");
  }

  async stopAll(): Promise<void> {
    const threadIds = [...this.sessions.keys()];
    await Promise.all(threadIds.map((threadId) => this.stopSession(threadId)));
  }
}
