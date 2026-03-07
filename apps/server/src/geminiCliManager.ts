import { randomUUID } from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import { Readable, Writable } from "node:stream";
import { pathToFileURL } from "node:url";

import { normalizeModelSlug } from "@t3tools/shared/model";

import {
  buildPopupSafeEnv,
  resolveGeminiAcpModulePath,
  resolveGeminiCliLaunchSpec,
} from "./cliEnvironment";

export interface GeminiStreamEvent {
  readonly type: "init" | "message" | "tool_use" | "tool_result" | "error" | "result";
  readonly [key: string]: unknown;
}

type GeminiApprovalMode = "default" | "auto_edit" | "yolo" | "plan";
type GeminiSessionModeId = "default" | "autoEdit" | "yolo" | "plan";
type GeminiAcpPromptBlock =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "image"; readonly data: string; readonly mimeType: string; readonly uri?: string };

interface GeminiAcpMessageContent {
  readonly type?: unknown;
  readonly text?: unknown;
  readonly path?: unknown;
  readonly oldText?: unknown;
  readonly newText?: unknown;
  readonly terminalId?: unknown;
}

interface GeminiAcpPlanEntry {
  readonly content?: unknown;
  readonly status?: unknown;
  readonly priority?: unknown;
}

interface GeminiAcpSessionUpdate {
  readonly sessionUpdate:
    | "user_message_chunk"
    | "agent_message_chunk"
    | "agent_thought_chunk"
    | "tool_call"
    | "tool_call_update"
    | "plan"
    | "available_commands_update"
    | "current_mode_update"
    | "config_option_update"
    | "session_info_update"
    | string;
  readonly content?:
    | GeminiAcpMessageContent
    | ReadonlyArray<GeminiAcpMessageContent | Record<string, unknown>>;
  readonly toolCallId?: unknown;
  readonly title?: unknown;
  readonly kind?: unknown;
  readonly status?: unknown;
  readonly rawInput?: unknown;
  readonly rawOutput?: unknown;
  readonly locations?: unknown;
  readonly currentModeId?: unknown;
  readonly modeId?: unknown;
  readonly entries?: ReadonlyArray<GeminiAcpPlanEntry>;
  readonly updatedAt?: unknown;
}

interface GeminiAcpNotification {
  readonly sessionId: string;
  readonly update: GeminiAcpSessionUpdate;
}

interface GeminiAcpRequestPermissionOption {
  readonly optionId?: unknown;
  readonly kind?: unknown;
}

interface GeminiAcpRequestPermissionParams {
  readonly sessionId?: unknown;
  readonly options?: ReadonlyArray<GeminiAcpRequestPermissionOption>;
}

interface GeminiAcpPromptResult {
  readonly stopReason?: unknown;
}

interface GeminiAcpSessionResponse {
  readonly sessionId?: unknown;
  readonly modes?: {
    readonly currentModeId?: unknown;
  };
}

interface GeminiAcpConnection {
  initialize(params: Record<string, unknown>): Promise<Record<string, unknown>>;
  newSession(params: { cwd: string; mcpServers: ReadonlyArray<unknown> }): Promise<GeminiAcpSessionResponse>;
  loadSession(params: {
    sessionId: string;
    cwd: string;
    mcpServers: ReadonlyArray<unknown>;
  }): Promise<GeminiAcpSessionResponse>;
  setSessionMode(params: { sessionId: string; modeId: GeminiSessionModeId }): Promise<Record<string, unknown>>;
  prompt(params: {
    sessionId: string;
    prompt: ReadonlyArray<GeminiAcpPromptBlock>;
  }): Promise<GeminiAcpPromptResult>;
  cancel(params: { sessionId: string }): Promise<void>;
}

interface GeminiAcpRuntime {
  readonly model: string;
  initialize(): Promise<void>;
  newSession(cwd: string): Promise<GeminiAcpSessionResponse>;
  loadSession(sessionId: string, cwd: string): Promise<GeminiAcpSessionResponse>;
  setSessionMode(sessionId: string, modeId: GeminiSessionModeId): Promise<void>;
  prompt(sessionId: string, prompt: ReadonlyArray<GeminiAcpPromptBlock>): Promise<GeminiAcpPromptResult>;
  cancel(sessionId: string): Promise<void>;
  close(): void;
}

interface GeminiAcpRuntimeHandlers {
  readonly onSessionUpdate: (notification: GeminiAcpNotification) => void;
  readonly onRequestPermission: (
    params: GeminiAcpRequestPermissionParams,
  ) => Promise<{ outcome: { outcome: string; optionId?: string } }>;
  readonly onClose: (error?: Error) => void;
}

type GeminiAcpRuntimeFactory = (
  model: string,
  handlers: GeminiAcpRuntimeHandlers,
) => Promise<GeminiAcpRuntime>;

export interface GeminiCliManagerOptions {
  readonly runtimeFactory?: GeminiAcpRuntimeFactory;
  readonly prewarmSessions?: boolean;
}

export interface GeminiSessionContext {
  readonly sessionId: string;
  readonly threadId: string;
  model: string;
  cwd: string;
  geminiSessionId?: string;
  status: "idle" | "running" | "stopped";
  activeTurnId: string | null;
  activeProcess: ChildProcess | null;
  currentMode: GeminiSessionModeId;
  runtimeModel: string | null;
  sessionSetupPromise: Promise<void> | null;
  hydrating: boolean;
}

export interface GeminiSessionResumeCursor {
  readonly sessionId: string;
}

export interface GeminiStartSessionInput {
  readonly threadId: string;
  readonly model: string;
  readonly cwd: string;
  readonly resumeCursor?: GeminiSessionResumeCursor;
}

export interface GeminiSendTurnInput {
  readonly threadId: string;
  readonly text: string;
  readonly prompt?: ReadonlyArray<GeminiAcpPromptBlock>;
  readonly model?: string;
  readonly cwd?: string;
  readonly approvalMode?: GeminiApprovalMode;
}

export interface GeminiTurnResult {
  readonly turnId: string;
  readonly threadId: string;
  readonly resumeCursor?: GeminiSessionResumeCursor;
}

export class GeminiCliManager extends EventEmitter {
  private readonly sessions = new Map<string, GeminiSessionContext>();
  private readonly threadIdByGeminiSessionId = new Map<string, string>();
  private readonly runtimePromises = new Map<string, Promise<GeminiAcpRuntime>>();
  private readonly runtimeFactory: GeminiAcpRuntimeFactory;
  private readonly prewarmSessions: boolean;
  private readonly acpModulePath: string | null;
  private readonly forceAcp: boolean;

  constructor(options: GeminiCliManagerOptions = {}) {
    super();
    this.runtimeFactory = options.runtimeFactory ?? createGeminiAcpRuntime;
    this.prewarmSessions = options.prewarmSessions ?? true;
    this.acpModulePath = resolveGeminiAcpModulePath();
    this.forceAcp = options.runtimeFactory !== undefined;
  }

  startSession(input: GeminiStartSessionInput): GeminiSessionContext {
    const context: GeminiSessionContext = {
      sessionId: randomUUID(),
      threadId: input.threadId,
      model: normalizeModelSlug(input.model, "gemini") ?? input.model,
      cwd: input.cwd,
      status: "idle",
      activeTurnId: null,
      activeProcess: null,
      currentMode: "default",
      runtimeModel: null,
      sessionSetupPromise: null,
      hydrating: false,
      ...(input.resumeCursor?.sessionId
        ? { geminiSessionId: input.resumeCursor.sessionId }
        : {}),
    };

    this.sessions.set(input.threadId, context);
    if (context.geminiSessionId) {
      this.threadIdByGeminiSessionId.set(context.geminiSessionId, context.threadId);
    }

    this.emit("event", {
      type: "session",
      method: "session/started",
      kind: "lifecycle",
      threadId: input.threadId,
      sessionId: context.sessionId,
      provider: "gemini",
    });

    if (context.geminiSessionId) {
      this.emit("event", {
        type: "session",
        method: "session/configured",
        kind: "lifecycle",
        threadId: input.threadId,
        sessionId: context.sessionId,
        provider: "gemini",
        resumeCursor: { sessionId: context.geminiSessionId },
      });
    }

    if (this.prewarmSessions && this.canUseAcp()) {
      void this.queueSessionSetup(context, async () => {
        const runtime = await this.ensureAcpRuntime(context.model);
        await this.prepareAcpSession(context, runtime, "yolo", { emitConfigured: false });
      }).catch(() => undefined);
    }

    return context;
  }

  sendTurn(input: GeminiSendTurnInput): GeminiTurnResult {
    const context = this.sessions.get(input.threadId);
    if (!context) {
      throw new Error(`No Gemini session for thread: ${input.threadId}`);
    }
    if (context.status === "stopped") {
      throw new Error(`Gemini session is stopped for thread: ${input.threadId}`);
    }

    const trimmedText = input.text.trim();
    if (trimmedText.length === 0) {
      throw new Error("Turn input must include text.");
    }
    if (context.status === "running") {
      throw new Error(`Gemini turn already running for thread: ${input.threadId}`);
    }

    context.cwd = input.cwd ?? context.cwd;
    const nextModel = normalizeModelSlug(input.model ?? context.model, "gemini") ?? context.model;
    if (nextModel !== context.model) {
      this.clearSessionBinding(context);
      context.model = nextModel;
    }

    const turnId = `turn_${randomUUID().slice(0, 8)}`;
    const approvalMode = input.approvalMode ?? "yolo";
    const desiredMode = toSessionModeId(approvalMode);

    context.activeTurnId = turnId;
    context.status = "running";

    this.emit("event", {
      type: "session",
      method: "session/connecting",
      kind: "lifecycle",
      threadId: input.threadId,
      sessionId: context.sessionId,
      provider: "gemini",
      message: `Connecting to Gemini CLI for ${context.model}`,
    });

    this.emit("event", {
      type: "turn",
      method: "turn/started",
      kind: "lifecycle",
      threadId: input.threadId,
      turnId,
      provider: "gemini",
      model: context.model,
    });

    if (this.canUseAcp()) {
      void this.runTurnViaAcp(context, turnId, trimmedText, input.prompt, desiredMode);
    } else {
      this.runTurnViaLegacyCli(context, turnId, trimmedText, approvalMode);
    }

    return {
      turnId,
      threadId: input.threadId,
      ...(context.geminiSessionId ? { resumeCursor: { sessionId: context.geminiSessionId } } : {}),
    };
  }

  interruptTurn(threadId: string): void {
    const context = this.sessions.get(threadId);
    if (!context) {
      return;
    }

    if (context.geminiSessionId && this.canUseAcp()) {
      void this.ensureAcpRuntime(context.model)
        .then((runtime) => runtime.cancel(context.geminiSessionId!))
        .catch(() => undefined);
      return;
    }

    if (context.activeProcess) {
      killChildTree(context.activeProcess);
    }
  }

  stopSession(threadId: string): void {
    const context = this.sessions.get(threadId);
    if (!context) {
      return;
    }

    if (context.geminiSessionId && this.canUseAcp()) {
      void this.ensureAcpRuntime(context.model)
        .then((runtime) => runtime.cancel(context.geminiSessionId!))
        .catch(() => undefined);
    }

    if (context.activeProcess) {
      killChildTree(context.activeProcess);
    }

    context.status = "stopped";
    context.activeProcess = null;
    this.clearSessionBinding(context);
    this.sessions.delete(threadId);
  }

  listSessions(): GeminiSessionContext[] {
    return Array.from(this.sessions.values());
  }

  hasSession(threadId: string): boolean {
    return this.sessions.has(threadId);
  }

  stopAll(): void {
    for (const [threadId] of this.sessions) {
      this.stopSession(threadId);
    }

    for (const runtimePromise of this.runtimePromises.values()) {
      void runtimePromise.then((runtime) => runtime.close()).catch(() => undefined);
    }
    this.runtimePromises.clear();
  }

  private canUseAcp(): boolean {
    return this.forceAcp || this.acpModulePath !== null;
  }

  private async runTurnViaAcp(
    context: GeminiSessionContext,
    turnId: string,
    text: string,
    prompt: ReadonlyArray<GeminiAcpPromptBlock> | undefined,
    desiredMode: GeminiSessionModeId,
  ): Promise<void> {
    try {
      const runtime = await this.ensureAcpRuntime(context.model);
      await this.queueSessionSetup(context, async () => {
        await this.prepareAcpSession(context, runtime, desiredMode, { emitConfigured: true });
      });

      if (context.status === "stopped" || context.activeTurnId !== turnId || !context.geminiSessionId) {
        return;
      }

      this.emit("event", {
        type: "session",
        method: "session/ready",
        kind: "lifecycle",
        threadId: context.threadId,
        sessionId: context.sessionId,
        provider: "gemini",
        ...(context.geminiSessionId
          ? { resumeCursor: { sessionId: context.geminiSessionId } }
          : {}),
        message: "Gemini CLI is ready",
      });

      const result = await runtime.prompt(
        context.geminiSessionId,
        inputPromptBlocks(text, prompt),
      );
      const stopReason = typeof result.stopReason === "string" ? result.stopReason : "end_turn";

      this.emit("event", {
        type: "result",
        method: "gemini/result",
        kind: stopReason === "cancelled" ? "error" : "data",
        threadId: context.threadId,
        turnId,
        provider: "gemini",
        status: stopReason === "cancelled" ? "error" : "completed",
        ...(stopReason === "cancelled"
          ? { error: { message: "Gemini turn cancelled." } }
          : {}),
        stopReason,
      });

      this.emit("event", {
        type: "turn",
        method: "turn/ended",
        kind: "lifecycle",
        threadId: context.threadId,
        turnId,
        provider: "gemini",
        exitCode: 0,
      });
    } catch (error) {
      this.emit("event", {
        type: "error",
        method: "turn/error",
        kind: "error",
        threadId: context.threadId,
        turnId,
        provider: "gemini",
        message: toErrorMessage(error, "Gemini ACP turn failed."),
      });

      this.emit("event", {
        type: "turn",
        method: "turn/ended",
        kind: "lifecycle",
        threadId: context.threadId,
        turnId,
        provider: "gemini",
        exitCode: 1,
      });
    } finally {
      if (context.activeTurnId === turnId) {
        context.activeTurnId = null;
        context.status = "idle";
      }
    }
  }

  private runTurnViaLegacyCli(
    context: GeminiSessionContext,
    turnId: string,
    text: string,
    approvalMode: GeminiApprovalMode,
  ): void {
    const launch = resolveGeminiLaunch();
    const args = [
      ...launch.argsPrefix,
      "--prompt",
      text,
      "--output-format",
      "stream-json",
      "--approval-mode",
      approvalMode,
      "--model",
      context.model,
    ];

    if (approvalMode !== "plan") {
      args.push("--sandbox", "false");
    }

    if (context.geminiSessionId) {
      args.push("--resume", context.geminiSessionId);
    }

    const child = spawn(launch.command, args, {
      cwd: context.cwd,
      env: buildPopupSafeEnv(),
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });

    context.activeProcess = child;

    const stdout = child.stdout;
    if (!stdout) {
      throw new Error("Gemini CLI stdout pipe is unavailable.");
    }

    const rl: ReadlineInterface = createInterface({ input: stdout });
    let stderrBuffer = "";
    let readyEventEmitted = false;

    const emitReady = () => {
      if (readyEventEmitted) {
        return;
      }
      readyEventEmitted = true;
      this.emit("event", {
        type: "session",
        method: "session/ready",
        kind: "lifecycle",
        threadId: context.threadId,
        sessionId: context.sessionId,
        provider: "gemini",
        ...(context.geminiSessionId
          ? { resumeCursor: { sessionId: context.geminiSessionId } }
          : {}),
        message: "Gemini CLI is ready",
      });
    };

    rl.on("line", (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) {
        return;
      }

      try {
        const event = JSON.parse(trimmed) as GeminiStreamEvent & {
          readonly session_id?: unknown;
        };

        if (event.type === "init" && typeof event.session_id === "string") {
          this.updateGeminiSessionId(context, event.session_id, true);
          emitReady();
        }

        this.emit("event", {
          ...event,
          method: `gemini/${event.type}`,
          kind: event.type === "error" ? "error" : "data",
          threadId: context.threadId,
          turnId,
          provider: "gemini",
        });
      } catch {
        emitReady();
        this.emit("event", {
          type: "message",
          method: "gemini/message",
          kind: "data",
          threadId: context.threadId,
          turnId,
          provider: "gemini",
          role: "assistant",
          content: trimmed,
          delta: true,
        });
      }
    });

    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderrBuffer += chunk.toString();
    });

    child.on("close", (code: number | null) => {
      rl.close();
      context.status = "idle";
      context.activeTurnId = null;
      context.activeProcess = null;

      const trimmedStderr = stderrBuffer.trim();
      if (code !== 0 && code !== null) {
        this.emit("event", {
          type: "error",
          method: "turn/error",
          kind: "error",
          threadId: context.threadId,
          turnId,
          provider: "gemini",
          exitCode: code,
          message: trimmedStderr || `Gemini CLI exited with code ${code}.`,
        });
      }

      this.emit("event", {
        type: "turn",
        method: "turn/ended",
        kind: "lifecycle",
        threadId: context.threadId,
        turnId,
        provider: "gemini",
        exitCode: code ?? 0,
        ...(trimmedStderr ? { stderr: trimmedStderr } : {}),
      });
    });

    child.on("error", (error: Error) => {
      rl.close();
      context.status = "idle";
      context.activeTurnId = null;
      context.activeProcess = null;

      this.emit("event", {
        type: "error",
        method: "turn/error",
        kind: "error",
        threadId: context.threadId,
        turnId,
        provider: "gemini",
        message: error.message,
      });
    });
  }

  private queueSessionSetup(
    context: GeminiSessionContext,
    operation: () => Promise<void>,
  ): Promise<void> {
    const previous = context.sessionSetupPromise ?? Promise.resolve();
    const next = previous.then(operation, operation);
    let tracked: Promise<void>;
    tracked = next.finally(() => {
      if (context.sessionSetupPromise === tracked) {
        context.sessionSetupPromise = null;
      }
    });
    context.sessionSetupPromise = tracked;
    return tracked;
  }

  private async prepareAcpSession(
    context: GeminiSessionContext,
    runtime: GeminiAcpRuntime,
    desiredMode: GeminiSessionModeId,
    options: { emitConfigured: boolean },
  ): Promise<void> {
    const canReuseLoadedSession =
      context.geminiSessionId !== undefined && context.runtimeModel === runtime.model;

    if (!canReuseLoadedSession && context.geminiSessionId) {
      context.hydrating = true;
      this.threadIdByGeminiSessionId.set(context.geminiSessionId, context.threadId);
      try {
        const response = await runtime.loadSession(context.geminiSessionId, context.cwd);
        context.currentMode = asSessionModeId(response.modes?.currentModeId) ?? context.currentMode;
        context.runtimeModel = runtime.model;
      } catch {
        this.clearSessionBinding(context);
      } finally {
        context.hydrating = false;
      }
    }

    if (!context.geminiSessionId) {
      const response = await runtime.newSession(context.cwd);
      const sessionId = response.sessionId;
      if (typeof sessionId !== "string" || sessionId.length === 0) {
        throw new Error("Gemini ACP did not return a session id.");
      }

      this.updateGeminiSessionId(context, sessionId, options.emitConfigured);
      context.currentMode = asSessionModeId(response.modes?.currentModeId) ?? "default";
      context.runtimeModel = runtime.model;
    }

    if (context.currentMode !== desiredMode) {
      const sessionId = context.geminiSessionId;
      if (!sessionId) {
        throw new Error("Gemini ACP session is missing after preparation.");
      }
      await runtime.setSessionMode(sessionId, desiredMode);
      context.currentMode = desiredMode;
    }
  }

  private updateGeminiSessionId(
    context: GeminiSessionContext,
    sessionId: string,
    emitConfigured: boolean,
  ): void {
    if (context.geminiSessionId && context.geminiSessionId !== sessionId) {
      this.threadIdByGeminiSessionId.delete(context.geminiSessionId);
    }
    context.geminiSessionId = sessionId;
    this.threadIdByGeminiSessionId.set(sessionId, context.threadId);

    if (emitConfigured) {
      this.emit("event", {
        type: "session",
        method: "session/configured",
        kind: "lifecycle",
        threadId: context.threadId,
        sessionId: context.sessionId,
        provider: "gemini",
        resumeCursor: { sessionId },
      });
    }
  }

  private clearSessionBinding(context: GeminiSessionContext): void {
    if (context.geminiSessionId) {
      this.threadIdByGeminiSessionId.delete(context.geminiSessionId);
    }
    delete context.geminiSessionId;
    context.runtimeModel = null;
    context.currentMode = "default";
  }

  private async ensureAcpRuntime(model: string): Promise<GeminiAcpRuntime> {
    const normalizedModel = normalizeModelSlug(model, "gemini") ?? model;
    const existing = this.runtimePromises.get(normalizedModel);
    if (existing) {
      return existing;
    }

    const promise = this.runtimeFactory(normalizedModel, {
      onSessionUpdate: (notification) => {
        this.handleAcpSessionUpdate(notification);
      },
      onRequestPermission: async (params) => this.handleAcpPermissionRequest(params),
      onClose: (error) => {
        this.runtimePromises.delete(normalizedModel);
        this.handleRuntimeClose(normalizedModel, error);
      },
    }).catch((error) => {
      this.runtimePromises.delete(normalizedModel);
      throw error;
    });

    this.runtimePromises.set(normalizedModel, promise);
    return promise;
  }

  private handleAcpSessionUpdate(notification: GeminiAcpNotification): void {
    const threadId = this.threadIdByGeminiSessionId.get(notification.sessionId);
    if (!threadId) {
      return;
    }
    const context = this.sessions.get(threadId);
    if (!context || context.hydrating) {
      return;
    }

    const turnId = context.activeTurnId;
    const update = notification.update;
    if (!turnId) {
      return;
    }

    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        const text = readContentText(update.content);
        if (!text) {
          return;
        }
        this.emit("event", {
          type: "message",
          method: "gemini/message",
          kind: "data",
          threadId,
          turnId,
          provider: "gemini",
          role: "assistant",
          content: text,
          delta: true,
        });
        return;
      }

      case "agent_thought_chunk": {
        const text = readContentText(update.content);
        if (!text) {
          return;
        }
        this.emit("event", {
          type: "thought",
          method: "gemini/thought",
          kind: "data",
          threadId,
          turnId,
          provider: "gemini",
          content: text,
          delta: true,
        });
        return;
      }

      case "tool_call": {
        this.emit("event", {
          type: "tool_use",
          method: "gemini/tool_use",
          kind: "data",
          threadId,
          turnId,
          provider: "gemini",
          tool_id:
            typeof update.toolCallId === "string" && update.toolCallId.length > 0
              ? update.toolCallId
              : undefined,
          tool_name: typeof update.title === "string" ? update.title : "Gemini tool",
          status: update.status,
          tool_kind: update.kind,
          parameters: update.rawInput,
          locations: update.locations,
        });
        return;
      }

      case "tool_call_update": {
        const normalizedStatus = normalizeToolCallStatus(update.status);
        const toolName = typeof update.title === "string" ? update.title : "Gemini tool";
        const output =
          flattenToolCallContent(update.content) ??
          stringifyUnknown(update.rawOutput) ??
          flattenContentBlocks(update.content);

        this.emit("event", {
          type: "tool_update",
          method: "gemini/tool_update",
          kind: "data",
          threadId,
          turnId,
          provider: "gemini",
          tool_id:
            typeof update.toolCallId === "string" && update.toolCallId.length > 0
              ? update.toolCallId
              : undefined,
          tool_name: toolName,
          status: normalizedStatus,
          output,
          rawInput: update.rawInput,
          rawOutput: update.rawOutput,
          tool_kind: update.kind,
          locations: update.locations,
        });
        if (normalizedStatus === "completed" || normalizedStatus === "failed") {
          this.emit("event", {
            type: "tool_result",
            method: "gemini/tool_result",
            kind: normalizedStatus === "failed" ? "error" : "data",
            threadId,
            turnId,
            provider: "gemini",
            tool_id:
              typeof update.toolCallId === "string" && update.toolCallId.length > 0
                ? update.toolCallId
                : undefined,
            tool_name: toolName,
            status: normalizedStatus,
            output,
            rawOutput: update.rawOutput,
            tool_kind: update.kind,
            locations: update.locations,
          });
        }
        return;
      }

      case "plan": {
        this.emit("event", {
          type: "plan",
          method: "gemini/plan",
          kind: "data",
          threadId,
          turnId,
          provider: "gemini",
          entries: Array.isArray(update.entries) ? update.entries : [],
        });
        return;
      }

      case "current_mode_update": {
        context.currentMode =
          asSessionModeId(update.currentModeId ?? update.modeId) ?? context.currentMode;
        return;
      }

      case "session_info_update": {
        this.emit("event", {
          type: "session_info",
          method: "gemini/session_info",
          kind: "data",
          threadId,
          turnId,
          provider: "gemini",
          title: typeof update.title === "string" ? update.title : undefined,
          updatedAt: typeof update.updatedAt === "string" ? update.updatedAt : undefined,
        });
        return;
      }

      default:
        return;
    }
  }

  private async handleAcpPermissionRequest(
    params: GeminiAcpRequestPermissionParams,
  ): Promise<{ outcome: { outcome: string; optionId?: string } }> {
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : undefined;
    const threadId = sessionId ? this.threadIdByGeminiSessionId.get(sessionId) : undefined;
    const context = threadId ? this.sessions.get(threadId) : undefined;
    const options = Array.isArray(params.options) ? params.options : [];

    if (context?.currentMode === "plan") {
      return { outcome: { outcome: "cancelled" } };
    }

    const allowOption = options.find((option) => {
      const kind = typeof option.kind === "string" ? option.kind : "";
      return kind.includes("allow") || kind.includes("approve");
    });
    const selected = allowOption ?? options[0];
    const optionId = typeof selected?.optionId === "string" ? selected.optionId : undefined;
    return optionId
      ? { outcome: { outcome: "selected", optionId } }
      : { outcome: { outcome: "cancelled" } };
  }

  private handleRuntimeClose(model: string, error?: Error): void {
    const message = error?.message?.trim();
    for (const context of this.sessions.values()) {
      if (context.runtimeModel !== model) {
        continue;
      }

      context.runtimeModel = null;
      if (context.activeTurnId) {
        this.emit("event", {
          type: "error",
          method: "turn/error",
          kind: "error",
          threadId: context.threadId,
          turnId: context.activeTurnId,
          provider: "gemini",
          message: message || `Gemini runtime for ${model} exited unexpectedly.`,
        });

        this.emit("event", {
          type: "turn",
          method: "turn/ended",
          kind: "lifecycle",
          threadId: context.threadId,
          turnId: context.activeTurnId,
          provider: "gemini",
          exitCode: 1,
          ...(message ? { stderr: message } : {}),
        });

        context.activeTurnId = null;
        context.status = "idle";
      }
    }
  }
}

function resolveGeminiLaunch(): { command: string; argsPrefix: ReadonlyArray<string> } {
  const resolved = resolveGeminiCliLaunchSpec();
  if (!resolved) {
    throw new Error(
      "Gemini CLI is not installed or could not be resolved. Install `@google/gemini-cli` and ensure it is available.",
    );
  }

  return resolved;
}

async function createGeminiAcpRuntime(
  model: string,
  handlers: GeminiAcpRuntimeHandlers,
): Promise<GeminiAcpRuntime> {
  const launch = resolveGeminiLaunch();
  const acpModulePath = resolveGeminiAcpModulePath();
  if (!acpModulePath || !existsSync(acpModulePath)) {
    throw new Error("Gemini ACP runtime is unavailable on this installation.");
  }

  const child = spawn(
    launch.command,
    [...launch.argsPrefix, "--experimental-acp", "--model", model, "--sandbox", "false"],
    {
      cwd: process.cwd(),
      env: buildPopupSafeEnv(),
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    },
  );

  let stderrBuffer = "";
  let closing = false;
  let closeNotified = false;

  const notifyClose = (error?: Error) => {
    if (closeNotified) {
      return;
    }
    closeNotified = true;
    handlers.onClose(error);
  };

  child.stderr?.on("data", (chunk: Buffer | string) => {
    stderrBuffer += chunk.toString();
  });

  child.on("error", (error: Error) => {
    notifyClose(error);
  });

  child.on("close", (code) => {
    if (closing) {
      notifyClose();
      return;
    }

    const message = stderrBuffer.trim() || `Gemini ACP runtime exited with code ${code ?? "unknown"}.`;
    notifyClose(new Error(message));
  });

  const acp = (await import(pathToFileURL(acpModulePath).href)) as {
    PROTOCOL_VERSION: number;
    ndJsonStream: (
      output: WritableStream<Uint8Array>,
      input: ReadableStream<Uint8Array>,
    ) => unknown;
    ClientSideConnection: new (
      clientFactory: () => {
        requestPermission: GeminiAcpRuntimeHandlers["onRequestPermission"];
        sessionUpdate: GeminiAcpRuntimeHandlers["onSessionUpdate"];
      },
      stream: unknown,
    ) => GeminiAcpConnection;
  };

  const connection = new acp.ClientSideConnection(
    () => ({
      requestPermission: handlers.onRequestPermission,
      sessionUpdate: async (notification: GeminiAcpNotification) => {
        handlers.onSessionUpdate(notification);
      },
    }),
    acp.ndJsonStream(
      Writable.toWeb(child.stdin as NonNullable<typeof child.stdin>),
      Readable.toWeb(child.stdout as NonNullable<typeof child.stdout>),
    ),
  );

  let initializePromise: Promise<void> | null = null;
  const initialize = async () => {
    initializePromise ??= connection
      .initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      })
      .then(() => undefined);
    return initializePromise;
  };

  return {
    model,
    initialize,
    async newSession(cwd: string) {
      await initialize();
      return connection.newSession({ cwd, mcpServers: [] });
    },
    async loadSession(sessionId: string, cwd: string) {
      await initialize();
      return connection.loadSession({ sessionId, cwd, mcpServers: [] });
    },
    async setSessionMode(sessionId: string, modeId: GeminiSessionModeId) {
      await initialize();
      await connection.setSessionMode({ sessionId, modeId });
    },
    async prompt(sessionId: string, prompt: ReadonlyArray<GeminiAcpPromptBlock>) {
      await initialize();
      return connection.prompt({
        sessionId,
        prompt: prompt.length > 0 ? [...prompt] : [{ type: "text", text: "" }],
      });
    },
    async cancel(sessionId: string) {
      await initialize();
      await connection.cancel({ sessionId });
    },
    close() {
      closing = true;
      killChildTree(child);
    },
  };
}

function readContentText(content: unknown): string | undefined {
  if (!content || typeof content !== "object" || Array.isArray(content)) {
    return undefined;
  }

  const text = (content as GeminiAcpMessageContent).text;
  return typeof text === "string" && text.length > 0 ? text : undefined;
}

function flattenContentBlocks(content: unknown): string | undefined {
  if (!Array.isArray(content)) {
    return undefined;
  }

  const text = content
    .map((entry) => {
      if (!entry || typeof entry !== "object") {
        return "";
      }
      const contentBlock = (entry as { content?: unknown }).content;
      return readContentText(contentBlock) ?? "";
    })
    .join("");

  return text.length > 0 ? text : undefined;
}

function flattenToolCallContent(content: unknown): string | undefined {
  if (!Array.isArray(content)) {
    return undefined;
  }

  const text = content
    .map((entry) => {
      if (!entry || typeof entry !== "object") {
        return "";
      }
      const record = entry as Record<string, unknown>;
      const entryType = typeof record.type === "string" ? record.type : "";
      if (entryType === "diff") {
        const path = typeof record.path === "string" ? record.path : "file";
        return `Diff updated: ${path}`;
      }
      if (entryType === "terminal") {
        const terminalId = typeof record.terminalId === "string" ? record.terminalId : "terminal";
        return `Terminal activity: ${terminalId}`;
      }
      const contentBlock = record.content;
      return readContentText(contentBlock) ?? "";
    })
    .filter((entry) => entry.length > 0)
    .join("\n");

  return text.length > 0 ? text : undefined;
}

function normalizeToolCallStatus(value: unknown): "pending" | "in_progress" | "completed" | "failed" {
  switch (value) {
    case "pending":
    case "in_progress":
    case "completed":
    case "failed":
      return value;
    default:
      return "in_progress";
  }
}

function inputPromptBlocks(
  text: string,
  prompt: ReadonlyArray<GeminiAcpPromptBlock> | undefined,
): ReadonlyArray<GeminiAcpPromptBlock> {
  if (prompt && prompt.length > 0) {
    const promptHasText = prompt.some(
      (entry): entry is Extract<GeminiAcpPromptBlock, { type: "text" }> =>
        entry.type === "text" && entry.text.trim().length > 0,
    );
    return promptHasText ? prompt : [{ type: "text", text }, ...prompt];
  }
  return [{ type: "text", text }];
}

function stringifyUnknown(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  if (value === null || value === undefined) {
    return undefined;
  }

  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function toSessionModeId(approvalMode: GeminiApprovalMode): GeminiSessionModeId {
  switch (approvalMode) {
    case "auto_edit":
      return "autoEdit";
    case "plan":
      return "plan";
    case "default":
      return "default";
    case "yolo":
    default:
      return "yolo";
  }
}

function asSessionModeId(value: unknown): GeminiSessionModeId | undefined {
  return value === "default" || value === "autoEdit" || value === "yolo" || value === "plan"
    ? value
    : undefined;
}

function toErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message.trim();
  }
  if (typeof error === "string" && error.trim().length > 0) {
    return error.trim();
  }
  return fallback;
}

function killChildTree(child: ChildProcess): void {
  if (process.platform === "win32" && child.pid !== undefined) {
    try {
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      return;
    } catch {
      // Fall through to direct kill.
    }
  }

  try {
    child.kill("SIGTERM");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // Process is already dead.
    }
  }
}
