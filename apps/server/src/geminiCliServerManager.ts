import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import readline from "node:readline";

import {
  ApprovalRequestId,
  EventId,
  RuntimeItemId,
  ThreadId,
  TurnId,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
  type ProviderSendTurnInput,
  type ProviderSession,
  type ProviderSessionStartInput,
  type ProviderTurnStartResult,
  type ProviderUserInputAnswers,
} from "@t3tools/contracts";
import type { ProviderSessionUsage, ProviderUsageResult } from "@t3tools/contracts";
import type { ProviderThreadSnapshot } from "./provider/Services/ProviderAdapter.ts";

const PROVIDER = "geminiCli" as const;

// ── Module-level usage tracking ──────────────────────────────────────

interface GeminiUsageAccumulator {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  totalTokens: number;
  turnCount: number;
}

let _geminiUsageAccumulator: GeminiUsageAccumulator = {
  inputTokens: 0,
  outputTokens: 0,
  cachedTokens: 0,
  totalTokens: 0,
  turnCount: 0,
};

export function fetchGeminiCliUsage(): ProviderUsageResult {
  const acc = _geminiUsageAccumulator;
  let sessionUsage: ProviderSessionUsage | undefined;
  if (acc.turnCount > 0) {
    sessionUsage = {
      inputTokens: acc.inputTokens,
      outputTokens: acc.outputTokens,
      ...(acc.cachedTokens > 0 ? { cachedTokens: acc.cachedTokens } : {}),
      totalTokens: acc.totalTokens,
      turnCount: acc.turnCount,
    };
  }
  return {
    provider: PROVIDER,
    ...(sessionUsage ? { sessionUsage } : {}),
  };
}

type GeminiCliProviderOptions = {
  readonly binaryPath?: string;
};

/** Gemini CLI stream-json event types. */
interface GeminiJsonInit {
  type: "init";
  session_id: string;
  model: string;
  timestamp: string;
}

interface GeminiJsonMessage {
  type: "message";
  role: "user" | "assistant";
  content: string;
  delta?: boolean;
  timestamp: string;
}

interface GeminiJsonToolUse {
  type: "tool_use";
  tool_name: string;
  tool_id: string;
  parameters: unknown;
  timestamp: string;
}

interface GeminiJsonToolResult {
  type: "tool_result";
  tool_id: string;
  status: string;
  output: string;
  timestamp: string;
}

interface GeminiJsonResult {
  type: "result";
  status: "success" | "error" | "interrupted";
  error_message?: string;
  /** Gemini CLI 0.32+ uses `error: { type, message }` instead of `error_message`. */
  error?: { type?: string; message?: string };
  stats?: {
    total_tokens?: number;
    input_tokens?: number;
    output_tokens?: number;
    cached?: number;
    duration_ms?: number;
    tool_calls?: number;
  };
  timestamp: string;
}

type GeminiJsonEvent =
  | GeminiJsonInit
  | GeminiJsonMessage
  | GeminiJsonToolUse
  | GeminiJsonToolResult
  | GeminiJsonResult;

interface GeminiCliSession {
  readonly threadId: ThreadId;
  model: string | undefined;
  cwd: string;
  binaryPath: string;
  runtimeMode: string;
  status: "ready" | "running" | "closed";
  /** Gemini-native session ID for --resume. */
  geminiSessionId: string | undefined;
  activeTurnId: TurnId | undefined;
  activeProcess: ChildProcess | undefined;
  /** Stable itemId for the current turn's assistant message (reused across content.delta events). */
  activeAssistantItemId: RuntimeItemId | undefined;
  /** Track active tool items by tool_id → { itemId, toolName, paramSummary } for item lifecycle events. */
  readonly activeToolItems: Map<string, { itemId: RuntimeItemId; toolName: string; paramSummary: string | undefined }>;
  readonly createdAt: string;
  updatedAt: string;
}

function defaultBinaryPath(): string {
  return "gemini";
}

/** Extract a short description from tool parameters for display. */
function summarizeToolCall(toolName: string, parameters: unknown): string {
  if (!parameters || typeof parameters !== "object") {
    return toolName;
  }
  const params = parameters as Record<string, unknown>;

  // Extract the most descriptive parameter value.
  const target =
    typeof params.file_path === "string"
      ? params.file_path
      : typeof params.dir_path === "string"
        ? params.dir_path
        : typeof params.pattern === "string"
          ? params.pattern
          : typeof params.command === "string"
            ? params.command
            : typeof params.query === "string"
              ? params.query
              : typeof params.instruction === "string"
                ? params.instruction
                : undefined;

  if (typeof target === "string" && target.length > 0) {
    const truncated = target.length > 80 ? `${target.slice(0, 77)}...` : target;
    return `${toolName} · ${truncated}`;
  }
  return toolName;
}

function resolveApprovalMode(runtimeMode: string): string {
  switch (runtimeMode) {
    case "full-access":
      return "yolo";
    case "suggest":
    case "plan":
      return "plan";
    default:
      return "default";
  }
}

export class GeminiCliServerManager extends EventEmitter<{
  event: [ProviderRuntimeEvent];
}> {
  private readonly sessions = new Map<ThreadId, GeminiCliSession>();

  startSession(input: ProviderSessionStartInput): Promise<ProviderSession> {
    const threadId = input.threadId;
    if (this.sessions.has(threadId)) {
      throw new Error(`Gemini CLI session already exists for thread ${threadId}`);
    }

    const geminiOpts = input.providerOptions?.geminiCli as GeminiCliProviderOptions | undefined;
    const binaryPath = geminiOpts?.binaryPath ?? defaultBinaryPath();
    const cwd = input.cwd ?? process.cwd();
    const now = new Date().toISOString();

    const session: GeminiCliSession = {
      threadId,
      model: input.model,
      cwd,
      binaryPath,
      runtimeMode: input.runtimeMode ?? "full-access",
      status: "ready",
      geminiSessionId: undefined,
      activeTurnId: undefined,
      activeProcess: undefined,
      activeAssistantItemId: undefined,
      activeToolItems: new Map(),
      createdAt: now,
      updatedAt: now,
    };

    this.sessions.set(threadId, session);

    const providerSession: ProviderSession = {
      provider: PROVIDER,
      status: "ready",
      runtimeMode: session.runtimeMode as ProviderSession["runtimeMode"],
      threadId,
      cwd,
      model: input.model,
      createdAt: now,
      updatedAt: now,
    };

    return Promise.resolve(providerSession);
  }

  sendTurn(input: ProviderSendTurnInput): Promise<ProviderTurnStartResult> {
    const session = this.sessions.get(input.threadId);
    if (!session) {
      throw new Error(`Unknown Gemini CLI session: ${input.threadId}`);
    }
    if (session.status === "closed") {
      throw new Error(`Gemini CLI session is closed: ${input.threadId}`);
    }
    if (session.status === "running") {
      throw new Error(`Gemini CLI session already running: ${input.threadId}`);
    }

    // Reject attachments — Gemini CLI doesn't support them.
    if (input.attachments && input.attachments.length > 0) {
      throw new Error("Gemini CLI does not support attachments");
    }

    const turnId = TurnId.makeUnsafe(randomUUID());
    session.activeTurnId = turnId;
    session.status = "running";
    session.updatedAt = new Date().toISOString();
    session.activeToolItems.clear();
    session.activeAssistantItemId = undefined;

    const prompt = input.input ?? "";

    // Use per-turn model override if provided, otherwise fall back to session model.
    const effectiveModel = input.model ?? session.model;

    // Build args for headless mode with stream-json output.
    const args: string[] = [
      "-p",
      prompt,
      "-o",
      "stream-json",
      "--approval-mode",
      resolveApprovalMode(session.runtimeMode),
    ];

    if (effectiveModel) {
      args.push("-m", effectiveModel);
    }

    // Resume previous Gemini session for follow-up turns.
    if (session.geminiSessionId) {
      args.push("--resume", session.geminiSessionId);
    }

    const child = spawn(session.binaryPath, args, {
      cwd: session.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });

    session.activeProcess = child;

    // Emit turn.started immediately.
    this.emitEvent(input.threadId, turnId, {
      type: "turn.started",
      payload: { model: effectiveModel },
    });

    const rl = readline.createInterface({ input: child.stdout });

    rl.on("line", (line) => {
      this.handleJsonLine(input.threadId, turnId, line);
    });

    // Ignore stderr (skill conflict warnings, YOLO notices, etc.)

    child.on("close", (code, signal) => {
      const s = this.sessions.get(input.threadId);
      if (!s) return;

      s.activeProcess = undefined;

      // If the turn wasn't already completed by a "result" event, emit a terminal turn.completed.
      if (s.status === "running" && s.activeTurnId === turnId) {
        s.status = "ready";
        s.updatedAt = new Date().toISOString();

        // Flush any open assistant message or tool items that never received completion.
        this.finalizeOpenItems(input.threadId, turnId, s);

        this.emitEvent(input.threadId, turnId, {
          type: "turn.completed",
          payload:
            signal === "SIGINT"
              ? { state: "interrupted" }
              : code === 0
                ? { state: "completed" }
                : {
                    state: "failed",
                    errorMessage: `Gemini CLI exited with code ${code}`,
                  },
        });
      }
    });

    child.on("error", (error) => {
      const s = this.sessions.get(input.threadId);
      if (s) {
        s.activeProcess = undefined;
        s.status = "ready";
        s.updatedAt = new Date().toISOString();

        // Flush any open assistant message or tool items that never received completion.
        this.finalizeOpenItems(input.threadId, turnId, s);
      }
      this.emitEvent(input.threadId, turnId, {
        type: "runtime.error",
        payload: { message: error.message, class: "transport_error" },
      });
      this.emitEvent(input.threadId, turnId, {
        type: "turn.completed",
        payload: {
          state: "failed",
          errorMessage: error.message,
        },
      });
    });

    return Promise.resolve({
      threadId: input.threadId,
      turnId,
    });
  }

  interruptTurn(threadId: ThreadId): Promise<void> {
    const session = this.sessions.get(threadId);
    if (!session) {
      throw new Error(`Unknown Gemini CLI session: ${threadId}`);
    }
    if (session.status === "running" && session.activeProcess) {
      session.activeProcess.kill("SIGINT");
    }
    return Promise.resolve();
  }

  respondToRequest(
    _threadId: ThreadId,
    _requestId: ApprovalRequestId,
    _decision: ProviderApprovalDecision,
  ): Promise<void> {
    return Promise.resolve();
  }

  respondToUserInput(
    _threadId: ThreadId,
    _requestId: ApprovalRequestId,
    _answers: ProviderUserInputAnswers,
  ): Promise<void> {
    return Promise.resolve();
  }

  stopSession(threadId: ThreadId): void {
    const session = this.sessions.get(threadId);
    if (!session) return;
    if (session.activeProcess) {
      try {
        session.activeProcess.kill();
      } catch {
        // Process may already be dead.
      }
    }
    session.status = "closed";
    this.sessions.delete(threadId);
  }

  listSessions(): ProviderSession[] {
    const sessions: ProviderSession[] = [];
    for (const session of this.sessions.values()) {
      sessions.push({
        provider: PROVIDER,
        status: session.status,
        runtimeMode: session.runtimeMode as ProviderSession["runtimeMode"],
        threadId: session.threadId,
        cwd: session.cwd,
        model: session.model,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
      });
    }
    return sessions;
  }

  hasSession(threadId: ThreadId): boolean {
    return this.sessions.has(threadId);
  }

  readThread(threadId: ThreadId): Promise<ProviderThreadSnapshot> {
    if (!this.sessions.has(threadId)) {
      throw new Error(`Unknown Gemini CLI session: ${threadId}`);
    }
    return Promise.resolve({ threadId, turns: [] });
  }

  rollbackThread(threadId: ThreadId): Promise<ProviderThreadSnapshot> {
    if (!this.sessions.has(threadId)) {
      throw new Error(`Unknown Gemini CLI session: ${threadId}`);
    }
    return Promise.resolve({ threadId, turns: [] });
  }

  stopAll(): void {
    for (const threadId of this.sessions.keys()) {
      this.stopSession(threadId);
    }
  }

  private handleJsonLine(threadId: ThreadId, turnId: TurnId, line: string): void {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith("{")) return;

    let event: GeminiJsonEvent;
    try {
      event = JSON.parse(trimmed) as GeminiJsonEvent;
    } catch {
      return;
    }

    const session = this.sessions.get(threadId);
    if (!session) return;

    switch (event.type) {
      case "init": {
        // Capture Gemini session ID for --resume on subsequent turns.
        session.geminiSessionId = event.session_id;
        break;
      }

      case "message": {
        if (event.role === "assistant" && event.content) {
          // Reuse a stable itemId so all deltas aggregate into one assistant message.
          if (!session.activeAssistantItemId) {
            session.activeAssistantItemId = RuntimeItemId.makeUnsafe(randomUUID());
          }
          this.emitEvent(threadId, turnId, {
            type: "content.delta",
            itemId: session.activeAssistantItemId,
            payload: {
              streamKind: "assistant_text",
              delta: event.content,
            },
          });
        }
        break;
      }

      case "tool_use": {
        // Finalize the preceding assistant text segment so it becomes its own
        // message, allowing the UI to interleave text and tool calls chronologically.
        if (session.activeAssistantItemId) {
          this.emitEvent(threadId, turnId, {
            type: "item.completed",
            itemId: session.activeAssistantItemId,
            payload: {
              itemType: "assistant_message",
              status: "completed",
            },
          });
          session.activeAssistantItemId = undefined;
        }

        const itemId = RuntimeItemId.makeUnsafe(randomUUID());
        const toolTitle = summarizeToolCall(event.tool_name, event.parameters);
        const paramSummary = typeof event.parameters === "object"
          ? JSON.stringify(event.parameters)
          : undefined;
        session.activeToolItems.set(event.tool_id, { itemId, toolName: toolTitle, paramSummary });

        this.emitEvent(threadId, turnId, {
          type: "item.started",
          itemId,
          payload: {
            itemType: "command_execution",
            title: toolTitle,
          },
        });
        break;
      }

      case "tool_result": {
        const tool = session.activeToolItems.get(event.tool_id);
        if (tool) {
          const detail = event.output && event.output.trim().length > 0
            ? event.output
            : tool.paramSummary;
          this.emitEvent(threadId, turnId, {
            type: "item.completed",
            itemId: tool.itemId,
            payload: {
              itemType: "command_execution",
              status: event.status === "success" ? "completed" : "failed",
              title: tool.toolName,
              ...(detail ? { detail } : {}),
            },
          });
          session.activeToolItems.delete(event.tool_id);
        }
        break;
      }

      case "result": {
        session.status = "ready";
        session.updatedAt = new Date().toISOString();

        // Finalize the assistant message so the ingestion layer flushes buffered text.
        if (session.activeAssistantItemId) {
          this.emitEvent(threadId, turnId, {
            type: "item.completed",
            itemId: session.activeAssistantItemId,
            payload: {
              itemType: "assistant_message",
              status: "completed",
            },
          });
          session.activeAssistantItemId = undefined;
        }

        const usage = event.stats
          ? {
              total_tokens: event.stats.total_tokens,
              input_tokens: event.stats.input_tokens,
              output_tokens: event.stats.output_tokens,
              cached_tokens: event.stats.cached,
              duration_ms: event.stats.duration_ms,
              tool_calls: event.stats.tool_calls,
            }
          : undefined;

        // Accumulate session-level usage
        if (usage) {
          _geminiUsageAccumulator.turnCount++;
          if (typeof usage.input_tokens === "number")
            _geminiUsageAccumulator.inputTokens += usage.input_tokens;
          if (typeof usage.output_tokens === "number")
            _geminiUsageAccumulator.outputTokens += usage.output_tokens;
          if (typeof usage.cached_tokens === "number")
            _geminiUsageAccumulator.cachedTokens += usage.cached_tokens;
          if (typeof usage.total_tokens === "number")
            _geminiUsageAccumulator.totalTokens += usage.total_tokens;
        }

        // Support both `error_message` (legacy) and `error.message` (0.32+).
        const errorMessage = event.error_message ?? event.error?.message;

        this.emitEvent(threadId, turnId, {
          type: "turn.completed",
          payload: {
            state:
              event.status === "success"
                ? "completed"
                : event.status === "interrupted"
                  ? "interrupted"
                  : "failed",
            ...(errorMessage ? { errorMessage } : {}),
            ...(usage ? { usage } : {}),
          },
        });
        break;
      }
    }
  }

  /** Flush any open assistant message and tool items that never received a matching completed event. */
  private finalizeOpenItems(threadId: ThreadId, turnId: TurnId, session: GeminiCliSession): void {
    if (session.activeAssistantItemId) {
      this.emitEvent(threadId, turnId, {
        type: "item.completed",
        itemId: session.activeAssistantItemId,
        payload: {
          itemType: "assistant_message",
          status: "completed",
        },
      });
      session.activeAssistantItemId = undefined;
    }

    for (const [toolId, tool] of session.activeToolItems) {
      this.emitEvent(threadId, turnId, {
        type: "item.completed",
        itemId: tool.itemId,
        payload: {
          itemType: "command_execution",
          status: "failed",
          title: tool.toolName,
        },
      });
      session.activeToolItems.delete(toolId);
    }
  }

  private emitEvent(
    threadId: ThreadId,
    turnId: TurnId | undefined,
    partial: {
      type: string;
      itemId?: RuntimeItemId;
      payload: unknown;
    },
  ): void {
    const event = {
      type: partial.type,
      eventId: EventId.makeUnsafe(randomUUID()),
      provider: PROVIDER,
      createdAt: new Date().toISOString(),
      threadId,
      ...(turnId ? { turnId } : {}),
      ...(partial.itemId ? { itemId: partial.itemId } : {}),
      payload: partial.payload,
      raw: {
        source: "gemini.cli.event",
        payload: partial.payload,
      },
    } as unknown as ProviderRuntimeEvent;

    this.emit("event", event);
  }
}
